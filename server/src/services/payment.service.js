import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';


export async function attachCashfreeOrderToPayment({
    paymentId,
    cashfreeOrder,
}) {
    // Cashfree's order_id is the merchant-supplied ID used in webhook
    // payloads. cf_order_id is a separate Cashfree-generated identifier.
    const providerOrderId = cashfreeOrder.order_id;

    if (!providerOrderId) {
        const error = new Error(
            'Cashfree response did not include the merchant order_id.'
        );
        error.statusCode = 502;
        throw error;
    }

    const result = await query(
        `
        UPDATE payments
        SET
            provider = 'cashfree',
            provider_order_id = $2,
            gateway_status = 'ORDER_CREATED',
            status = 'created',
            raw_response = $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
        RETURNING
            id,
            order_id,
            provider,
            provider_order_id,
            amount,
            currency,
            status,
            payment_method,
            gateway_status,
            created_at,
            updated_at
        `,
        [
            paymentId,
            providerOrderId,
            JSON.stringify(cashfreeOrder),
        ]
    );

    if (!result.rows.length) {
        const error = new Error('Payment record not found.');
        error.statusCode = 404;
        throw error;
    }

    return result.rows[0];
}


export async function markPaymentSuccess({
    providerOrderId,
    providerPaymentId = null,
    rawResponse = null,
}) {
    return withTransaction(async client => {
        const paymentResult = await client.query(
            `
            SELECT id, order_id, status
            FROM payments
            WHERE provider_order_id = $1
            FOR UPDATE
            `,
            [providerOrderId]
        );

        if (!paymentResult.rows.length) {
            const error = new Error(
                `Payment not found for Cashfree order ${providerOrderId}.`
            );
            error.statusCode = 404;
            throw error;
        }

        const payment = paymentResult.rows[0];

        const orderResult = await client.query(
            `
            SELECT id, payment_status
            FROM orders
            WHERE id = $1
            FOR UPDATE
            `,
            [payment.order_id]
        );

        if (!orderResult.rows.length) {
            const error = new Error('Order for payment was not found.');
            error.statusCode = 404;
            throw error;
        }

        const alreadyPaid =
            String(orderResult.rows[0].payment_status).toLowerCase() === 'paid';

        await client.query(
            `
            UPDATE payments
            SET
                status = 'paid',
                provider_payment_id = COALESCE($2, provider_payment_id),
                gateway_status = 'SUCCESS',
                raw_response = COALESCE($3::jsonb, raw_response),
                updated_at = NOW()
            WHERE id = $1
            `,
            [
                payment.id,
                providerPaymentId,
                rawResponse ? JSON.stringify(rawResponse) : null,
            ]
        );

        // Convert the order's reservation into a sale exactly once. Repeated
        // Cashfree webhook deliveries must never decrement stock twice.
        if (!alreadyPaid) {
            const itemsResult = await client.query(
                `
                SELECT variant_id, quantity
                FROM order_items
                WHERE order_id = $1
                  AND variant_id IS NOT NULL
                ORDER BY variant_id
                `,
                [payment.order_id]
            );

            for (const item of itemsResult.rows) {
                const stockResult = await client.query(
                    `
                    UPDATE inventory
                    SET
                        quantity_on_hand = quantity_on_hand - $2,
                        quantity_reserved = quantity_reserved - $2,
                        updated_at = NOW()
                    WHERE variant_id = $1
                      AND quantity_on_hand >= $2
                      AND quantity_reserved >= $2
                    RETURNING variant_id
                    `,
                    [item.variant_id, item.quantity]
                );

                if (!stockResult.rows.length) {
                    const error = new Error(
                        `Unable to finalize inventory reservation for variant ${item.variant_id}.`
                    );
                    error.statusCode = 409;
                    throw error;
                }

                await client.query(
                    `
                    INSERT INTO inventory_transactions (
                        variant_id,
                        transaction_type,
                        quantity,
                        reference_type,
                        reference_id,
                        notes
                    )
                    VALUES ($1, 'SALE', $2, 'ORDER', $3, 'Inventory sold after successful payment')
                    `,
                    [item.variant_id, item.quantity, payment.order_id]
                );
            }
        }

        await client.query(
            `
            UPDATE orders
            SET
                payment_status = 'paid',
                status = CASE
                    WHEN LOWER(status) = 'cancelled' THEN status
                    ELSE 'confirmed'
                END,
                updated_at = NOW()
            WHERE id = $1
            `,
            [payment.order_id]
        );

        return {
            paymentId: payment.id,
            orderId: payment.order_id,
            status: 'paid',
            inventoryFinalized: !alreadyPaid,
        };
    });
}


export async function markPaymentFailed({
    providerOrderId,
    providerPaymentId = null,
    rawResponse = null,
}) {
    return withTransaction(async client => {
        const paymentResult = await client.query(
            `
            SELECT id, order_id, status
            FROM payments
            WHERE provider_order_id = $1
            FOR UPDATE
            `,
            [providerOrderId]
        );

        if (!paymentResult.rows.length) {
            const error = new Error(
                `Payment not found for Cashfree order ${providerOrderId}.`
            );
            error.statusCode = 404;
            throw error;
        }

        const payment = paymentResult.rows[0];

        // A delayed failure event must not overwrite a successful payment.
        if (String(payment.status).toLowerCase() === 'paid') {
            return {
                paymentId: payment.id,
                orderId: payment.order_id,
                status: 'paid',
                ignoredLateFailure: true,
            };
        }

        await client.query(
            `
            UPDATE payments
            SET
                status = 'failed',
                provider_payment_id = COALESCE($2, provider_payment_id),
                gateway_status = 'FAILED',
                raw_response = COALESCE($3::jsonb, raw_response),
                updated_at = NOW()
            WHERE id = $1
            `,
            [
                payment.id,
                providerPaymentId,
                rawResponse ? JSON.stringify(rawResponse) : null,
            ]
        );

        // Keep the order pending and its stock reserved: a failed payment
        // attempt is not proof that the customer will not retry. A separate
        // expiry/cancellation workflow should release reservations.
        await client.query(
            `
            UPDATE orders
            SET
                payment_status = CASE
                    WHEN LOWER(payment_status) = 'paid' THEN payment_status
                    ELSE 'pending'
                END,
                status = CASE
                    WHEN LOWER(status) = 'cancelled' THEN status
                    ELSE 'pending'
                END,
                updated_at = NOW()
            WHERE id = $1
            `,
            [payment.order_id]
        );

        return {
            paymentId: payment.id,
            orderId: payment.order_id,
            status: 'failed',
            inventoryReleased: false,
        };
    });
}
