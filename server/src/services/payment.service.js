import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';


export async function attachCashfreeOrderToPayment({
    paymentId,
    cashfreeOrder,
}) {
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
            cashfreeOrder.cf_order_id ||
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


export async function markPaymentSuccess({
    providerOrderId,
    providerPaymentId = null,
    rawResponse = null,
}) {
    return withTransaction(async client => {

        const paymentResult =
            await client.query(
                `
                SELECT
                    id,
                    order_id,
                    status
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

        const payment =
            paymentResult.rows[0];

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
        };
    });
}


export async function markPaymentFailed({
    providerOrderId,
    providerPaymentId = null,
    rawResponse = null,
}) {
    return withTransaction(async client => {

        const paymentResult =
            await client.query(
                `
                SELECT
                    id,
                    order_id,
                    status
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

        const payment =
            paymentResult.rows[0];

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
                rawResponse
                    ? JSON.stringify(rawResponse)
                    : null,
            ]
        );

        await client.query(
            `
            UPDATE orders
            SET
                payment_status = 'failed',
                status = 'cancelled',
                updated_at = NOW()
            WHERE id = $1
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