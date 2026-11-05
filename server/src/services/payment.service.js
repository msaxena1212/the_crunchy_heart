import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { deductOrderInventory } from './inventory.service.js';


/*
|--------------------------------------------------------------------------
| Attach Cashfree Order to Payment
|--------------------------------------------------------------------------
|
| Store Cashfree's merchant order_id in provider_order_id.
| The webhook uses the merchant order_id to find the payment.
|
|--------------------------------------------------------------------------
*/

export async function attachCashfreeOrderToPayment({
    paymentId,
    cashfreeOrder,
}) {
    if (!cashfreeOrder?.order_id) {
        const error = new Error(
            'Cashfree did not return the merchant order_id.'
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
            cashfreeOrder.order_id,
            JSON.stringify(cashfreeOrder),
        ]
    );

    if (!result.rows.length) {
        const error = new Error(
            'Payment record not found.'
        );

        error.statusCode = 404;
        throw error;
    }

    return result.rows[0];
}


/*
|--------------------------------------------------------------------------
| Mark Payment Successful
|--------------------------------------------------------------------------
|
| Updates the payment, atomically settles inventory, and updates the order
| in a single PostgreSQL transaction.
|
| Guarantees:
| 1. Idempotency: duplicate webhooks never deduct inventory twice.
| 2. Verification: validates payment amount and currency.
| 3. Atomic deduction: locks inventory rows deterministically.
| 4. Shortage safety: if stock is unavailable, captures payment, flags
|    order as exception_stock_shortage, and persists a durable pending refund.
| 5. Retry safety: if a transient DB error occurs, rolls back cleanly.
|
|--------------------------------------------------------------------------
*/

export async function settlePaymentSuccess(client, {
    providerOrderId,
    providerPaymentId = null,
    paymentAmount = null,
    paymentCurrency = null,
    rawResponse = null,
}) {
    if (!providerOrderId) {
        const error = new Error(
            'Cashfree merchant order ID is required.'
        );

        error.statusCode = 400;
        throw error;
    }

    {
        // 1. Look up payment attempt to identify the parent order
        const lookupResult = await client.query(
            `
            SELECT id, order_id
            FROM payments
            WHERE provider_order_id = $1
              AND provider = 'cashfree'
            `,
            [providerOrderId]
        );

        if (!lookupResult.rows.length) {
            const error = new Error(
                `Payment not found for Cashfree order ${providerOrderId}.`
            );
            error.statusCode = 404;
            throw error;
        }

        const { id: paymentId, order_id: orderId } = lookupResult.rows[0];

        // 2. Consistent lock ordering: Lock parent order FIRST
        const orderResult = await client.query(
            `
            SELECT id, status, payment_status, total_amount, notes
            FROM orders
            WHERE id = $1
            FOR UPDATE
            `,
            [orderId]
        );

        if (!orderResult.rows.length) {
            const error = new Error(`Order ${orderId} not found.`);
            error.statusCode = 404;
            throw error;
        }

        const order = orderResult.rows[0];

        // 3. Consistent lock ordering: Lock payment attempt SECOND
        const paymentResult = await client.query(
            `
            SELECT
                id,
                order_id,
                amount,
                currency,
                status,
                gateway_status,
                provider_payment_id
            FROM payments
            WHERE id = $1
            FOR UPDATE
            `,
            [paymentId]
        );

        const payment = paymentResult.rows[0];

        // 4. Idempotency check:
        // If payment has already been marked 'paid', do NOT deduct stock again.
        if (payment.status === 'paid') {
            return {
                paymentId: payment.id,
                orderId: payment.order_id,
                status: 'paid',
                gatewayStatus: payment.gateway_status,
                alreadySettled: true,
            };
        }

        // 5. Amount verification
        if (paymentAmount !== null && paymentAmount !== undefined) {
            const reportedAmount = Number(paymentAmount);
            const expectedAmount = Number(payment.amount);

            if (Math.abs(reportedAmount - expectedAmount) > 0.01) {
                const error = new Error(
                    `Payment amount mismatch: Cashfree reported ${paymentAmount}, expected ${payment.amount}.`
                );
                error.statusCode = 400;
                throw error;
            }
        }

        // 6. Currency verification
        if (paymentCurrency !== null && paymentCurrency !== undefined) {
            const reportedCurrency = String(paymentCurrency).trim().toUpperCase();
            const expectedCurrency = String(payment.currency).trim().toUpperCase();

            if (reportedCurrency !== expectedCurrency) {
                const error = new Error(
                    `Payment currency mismatch: Cashfree reported ${paymentCurrency}, expected ${payment.currency}.`
                );
                error.statusCode = 400;
                throw error;
            }
        }

        // CONC-01: Cross-attempt duplicate settlement guard.
        // If the order has already been settled by a sibling payment attempt:
        // - Do NOT deduct inventory again.
        // - Do NOT reconfirm or re-fulfil the order.
        // - Truthfully record that THIS payment was successfully captured at the gateway.
        // - Set gateway_status = 'PAID_DUPLICATE_ORDER_SETTLED'.
        // - Create or reuse a durable refund-review record (status: pending) for the duplicate payment.
        if (order.payment_status === 'paid' || order.status === 'confirmed') {
            await client.query(
                `
                UPDATE payments
                SET
                    status = 'paid',
                    provider_payment_id = COALESCE($2, provider_payment_id),
                    gateway_status = 'PAID_DUPLICATE_ORDER_SETTLED',
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

            await client.query(
                `
                UPDATE orders
                SET
                    notes = COALESCE(notes || E'\n', '') || $2,
                    updated_at = NOW()
                WHERE id = $1
                `,
                [
                    payment.order_id,
                    `[DUPLICATE PAYMENT CAPTURED] Sibling payment attempt ${providerOrderId} was successfully captured after order was already settled. Pending refund-review record created.`,
                ]
            );

            const existingRefund = await client.query(
                `
                SELECT id, amount, status
                FROM refunds
                WHERE payment_id = $1
                LIMIT 1
                `,
                [payment.id]
            );

            let refundRecord;
            if (existingRefund.rows.length) {
                refundRecord = existingRefund.rows[0];
            } else {
                const insertRefund = await client.query(
                    `
                    INSERT INTO refunds (
                        payment_id,
                        order_id,
                        amount,
                        reason,
                        status,
                        idempotency_key,
                        currency,
                        origin
                    )
                    VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
                    RETURNING id, amount, status
                    `,
                    [
                        payment.id,
                        payment.order_id,
                        payment.amount,
                        `Duplicate payment captured on sibling attempt ${providerOrderId} for already-settled order`,
                        `duplicate_capture:${payment.id}`,
                        payment.currency,
                        'duplicate_capture',
                    ]
                );
                refundRecord = insertRefund.rows[0];
            }

            return {
                paymentId: payment.id,
                orderId: payment.order_id,
                status: 'paid',
                gatewayStatus: 'PAID_DUPLICATE_ORDER_SETTLED',
                inventoryDeducted: false,
                duplicateSettlement: true,
                refundId: refundRecord.id,
                refundStatus: refundRecord.status,
            };
        }

        const itemsResult = await client.query(
            `
            SELECT
                variant_id,
                quantity
            FROM order_items
            WHERE order_id = $1
            `,
            [payment.order_id]
        );

        const items = itemsResult.rows;

        try {
            // 5. Attempt atomic inventory deduction
            await deductOrderInventory(client, {
                orderId: payment.order_id,
                items,
            });

            // 6. Normal success: stock deducted, mark payment paid and order confirmed
            await client.query(
                `
                UPDATE payments
                SET
                    status = 'paid',
                    provider_payment_id =
                        COALESCE($2, provider_payment_id),
                    gateway_status = 'SUCCESS',
                    raw_response =
                        COALESCE($3::jsonb, raw_response),
                    updated_at = NOW()
                WHERE id = $1
                `,
                [
                    payment.id,
                    providerPaymentId,
                    rawResponse
                        ? JSON.stringify(rawResponse)
                        : null,
                ]
            );

            await client.query(
                `
                UPDATE orders
                SET
                    payment_status = 'paid',
                    status = 'confirmed',
                    updated_at = NOW()
                WHERE id = $1
                `,
                [payment.order_id]
            );

            return {
                paymentId: payment.id,
                orderId: payment.order_id,
                status: 'paid',
                inventoryDeducted: true,
                alreadySettled: false,
            };

        } catch (error) {
            if (error.code === 'INSUFFICIENT_STOCK') {
                // Stock exhausted by concurrent order!
                // Durable handling:
                // - Mark payment as paid with gateway_status 'PAID_STOCK_UNAVAILABLE'
                // - Mark order payment_status = 'paid', status = 'exception_stock_shortage'
                // - Persist a durable pending refund record
                await client.query(
                    `
                    UPDATE payments
                    SET
                        status = 'paid',
                        provider_payment_id =
                            COALESCE($2, provider_payment_id),
                        gateway_status = 'PAID_STOCK_UNAVAILABLE',
                        raw_response =
                            COALESCE($3::jsonb, raw_response),
                        updated_at = NOW()
                    WHERE id = $1
                    `,
                    [
                        payment.id,
                        providerPaymentId,
                        rawResponse
                            ? JSON.stringify(rawResponse)
                            : null,
                    ]
                );

                await client.query(
                    `
                    UPDATE orders
                    SET
                        payment_status = 'paid',
                        status = 'exception_stock_shortage',
                        notes = COALESCE(notes || E'\n', '') || $2,
                        updated_at = NOW()
                    WHERE id = $1
                    `,
                    [
                        payment.order_id,
                        '[STOCK SHORTAGE EXCEPTION] Payment captured by Cashfree, but requested variant stock was exhausted. Requires customer refund or stock allocation.',
                    ]
                );

                const existingRefund = await client.query(
                    `
                    SELECT id, amount, status
                    FROM refunds
                    WHERE payment_id = $1
                    LIMIT 1
                    `,
                    [payment.id]
                );

                let refundRecord;
                if (existingRefund.rows.length) {
                    refundRecord = existingRefund.rows[0];
                } else {
                    const insertRefund = await client.query(
                        `
                        INSERT INTO refunds (
                            payment_id,
                            order_id,
                            amount,
                            reason,
                            status,
                            idempotency_key,
                            currency,
                            origin
                        )
                        VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
                        RETURNING id, amount, status
                        `,
                        [
                            payment.id,
                            payment.order_id,
                            payment.amount,
                            'Stock shortage after successful payment: requires customer refund or manual stock allocation',
                            `stock_shortage:${payment.id}`,
                            payment.currency,
                            'stock_shortage',
                        ]
                    );
                    refundRecord = insertRefund.rows[0];
                }

                return {
                    paymentId: payment.id,
                    orderId: payment.order_id,
                    status: 'paid',
                    stockShortage: true,
                    refundId: refundRecord.id,
                    refundStatus: refundRecord.status,
                };
            }

            // Re-throw any other unexpected error to roll back transaction cleanly
            throw error;
        }
    }
}

/*
|--------------------------------------------------------------------------
| Mark Payment Success (own transaction)
|--------------------------------------------------------------------------
| Runs settlePaymentSuccess() in its own transaction. Callers that must
| commit additional state atomically (reconciliation) pass their own client
| to settlePaymentSuccess() instead.
|--------------------------------------------------------------------------
*/
export async function markPaymentSuccess(params) {
    return withTransaction(client => settlePaymentSuccess(client, params));
}


/*
|--------------------------------------------------------------------------
| Mark Payment Failed
|--------------------------------------------------------------------------
|
| Updates the payment attempt to failed.
| Does NOT cancel the order, allowing the customer to retry payment.
| Never overrides a payment that is already 'paid'.
|
|--------------------------------------------------------------------------
*/

export async function markPaymentFailed({
    providerOrderId,
    providerPaymentId = null,
    rawResponse = null,
}) {
    if (!providerOrderId) {
        const error = new Error(
            'Cashfree merchant order ID is required.'
        );

        error.statusCode = 400;
        throw error;
    }

    return withTransaction(async client => {
        // 1. Look up payment attempt to identify parent order
        const lookupResult = await client.query(
            `
            SELECT id, order_id
            FROM payments
            WHERE provider_order_id = $1
              AND provider = 'cashfree'
            `,
            [providerOrderId]
        );

        if (!lookupResult.rows.length) {
            const error = new Error(
                `Payment not found for Cashfree order ${providerOrderId}.`
            );
            error.statusCode = 404;
            throw error;
        }

        const { id: paymentId, order_id: orderId } = lookupResult.rows[0];

        // 2. Consistent lock ordering: Lock parent order FIRST
        const orderResult = await client.query(
            `
            SELECT id, status, payment_status
            FROM orders
            WHERE id = $1
            FOR UPDATE
            `,
            [orderId]
        );

        if (!orderResult.rows.length) {
            const error = new Error(`Order ${orderId} not found.`);
            error.statusCode = 404;
            throw error;
        }

        // 3. Consistent lock ordering: Lock payment attempt SECOND
        const paymentResult = await client.query(
            `
            SELECT
                id,
                order_id,
                status
            FROM payments
            WHERE id = $1
            FOR UPDATE
            `,
            [paymentId]
        );

        const payment = paymentResult.rows[0];

        // Never let a delayed failure event overwrite a
        // payment that has already been marked successful.
        if (payment.status === 'paid') {
            return {
                paymentId: payment.id,
                orderId: payment.order_id,
                status: 'paid',
                ignored: true,
            };
        }

        await client.query(
            `
            UPDATE payments
            SET
                status = 'failed',
                provider_payment_id =
                    COALESCE($2, provider_payment_id),
                gateway_status = 'FAILED',
                raw_response =
                    COALESCE($3::jsonb, raw_response),
                updated_at = NOW()
            WHERE id = $1
            `,
            [
                payment.id,
                providerPaymentId,
                rawResponse
                    ? JSON.stringify(rawResponse)
                    : null,
            ]
        );

        // A failed payment attempt must NOT cancel the order.
        // It leaves the order open (payment_status = 'failed') so the customer can retry.
        await client.query(
            `
            UPDATE orders
            SET
                payment_status = 'failed',
                notes = COALESCE(notes || E'\n', '') || '[PAYMENT ATTEMPT FAILED] Payment attempt failed; order remains open for retry.',
                updated_at = NOW()
            WHERE id = $1
              AND payment_status <> 'paid'
            `,
            [payment.order_id]
        );

        return {
            paymentId: payment.id,
            orderId: payment.order_id,
            status: 'failed',
        };
    });
}