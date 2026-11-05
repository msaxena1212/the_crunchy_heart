import {
    getCashfreePayments,
    resolveCashfreePaymentStatus,
    verifyCashfreeWebhookSignature,
} from '../services/cashfree.service.js';

import {
    markPaymentSuccess,
    markPaymentFailed,
} from '../services/payment.service.js';

import { query } from '../db/pool.js';
import { loadOrderAttempts, summarizeAttempts } from '../services/payment-creation.service.js';

import {
    enqueuePaymentReconciliationEvent,
    isQueueableSettlementError,
} from '../services/payment-reconciliation.service.js';
import { verifyGuestAccessToken } from '../utils/order-token.js';


/*
|--------------------------------------------------------------------------
| Get Payment Status
|--------------------------------------------------------------------------
|
| GET /api/payments/status/:orderId
|
| Secure payment status inquiry.
| Requires x-guest-access-token header bound to the target order.
|
|--------------------------------------------------------------------------
*/

export async function getPaymentStatus(
    req,
    res,
    next
) {
    try {
        const {
            orderId,
        } = req.params;


        if (!orderId) {
            return res.status(400).json({
                success: false,

                message:
                    'orderId is required.',
            });
        }

        const authHeader = req.headers.authorization;
        const bearerToken =
            typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
                ? authHeader.slice(7).trim()
                : null;

        const guestAccessToken =
            req.headers['x-guest-access-token'] || bearerToken || null;

        // 1. Look up order in local database:
        // orderId could be the order_number (e.g. TCH-20261017-ABCDEF)
        // or a provider_order_id (e.g. TCH-20261017-ABCDEF-R1).
        const orderResult = await query(
            `
            SELECT o.id, o.order_number, o.phone, o.created_at
            FROM orders o
            LEFT JOIN payments p ON p.order_id = o.id
            WHERE o.order_number = $1 OR p.provider_order_id = $1
            LIMIT 1
            `,
            [orderId]
        );

        if (!orderResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: `Order ${orderId} not found.`,
            });
        }

        const order = orderResult.rows[0];

        // 2. Authorize guest token
        const verification = verifyGuestAccessToken({
            token: guestAccessToken,
            orderNumber: order.order_number,
            order,
        });

        if (!verification.valid) {
            return res.status(401).json({
                success: false,
                message: 'Valid guest access token is required to view payment status.',
            });
        }


        // 3. Authorized - fetch local attempts and query Cashfree for relevant attempt
        const attemptsResult = await query(
            `
            SELECT id, provider, provider_order_id, amount, currency, status, gateway_status, created_at, updated_at
            FROM payments
            WHERE order_id = $1
            ORDER BY created_at DESC
            `,
            [order.id]
        );
        const localAttempts = attemptsResult.rows;

        // The authoritative attempt is chosen by state from every row, not by creation time alone.
        const authoritativeAttempt = summarizeAttempts(await loadOrderAttempts(order.id)).authoritative;

        // If caller passed base order number (e.g. TCH-xxxx), query the authoritative attempt.
        // If caller passed a specific provider_order_id (e.g. TCH-xxxx-R2), query that specific attempt.
        const targetProviderOrderId =
            orderId === order.order_number && authoritativeAttempt?.provider_order_id
                ? authoritativeAttempt.provider_order_id
                : orderId;

        let payments = [];
        let status = 'UNKNOWN';

        try {
            payments = await getCashfreePayments(targetProviderOrderId);
            status = resolveCashfreePaymentStatus(payments);
        } catch (fetchErr) {
            // If Cashfree returns 404 for an uninitiated or missing attempt, reflect gracefully
            if (fetchErr.statusCode !== 404) {
                throw fetchErr;
            }
        }

        const latestAttempt = authoritativeAttempt
            ? {
                  providerOrderId: authoritativeAttempt.provider_order_id,
                  gatewayStatus: authoritativeAttempt.gateway_status,
                  status: authoritativeAttempt.status,
                  createdAt: authoritativeAttempt.created_at,
              }
            : null;

        return res.json({
            success: true,
            orderId,
            orderNumber: order.order_number,
            status,
            latestAttempt,
            attempts: localAttempts.map(a => ({
                providerOrderId: a.provider_order_id,
                gatewayStatus: a.gateway_status,
                status: a.status,
                createdAt: a.created_at,
            })),
            payments,
        });

    } catch (error) {
        next(error);
    }
}


/*
|--------------------------------------------------------------------------
| Cashfree Webhook
|--------------------------------------------------------------------------
|
| POST /api/payments/cashfree/webhook
|
| IMPORTANT:
| The server.js webhook middleware must populate:
|
| req.rawBody
| req.body
|
|--------------------------------------------------------------------------
*/

export async function cashfreeWebhook(
    req,
    res,
    next
) {
    try {
        const signature =
            req.headers[
            'x-webhook-signature'
            ];


        const timestamp =
            req.headers[
            'x-webhook-timestamp'
            ];


        const rawBody =
            req.rawBody || '';


        /*
        |--------------------------------------------------------------------------
        | Verify Signature
        |--------------------------------------------------------------------------
        */

        const isValid =
            verifyCashfreeWebhookSignature({
                signature,

                timestamp,

                rawBody,
            });


        if (!isValid) {
            console.warn(
                'Invalid Cashfree webhook signature.'
            );


            return res.status(401).json({
                success: false,

                message:
                    'Invalid Cashfree webhook signature.',
            });
        }


        /*
        |--------------------------------------------------------------------------
        | Payload
        |--------------------------------------------------------------------------
        */

        const payload =
            req.body || {};


        const eventType =
            payload.type || '';


        const data =
            payload.data || {};


        const payment =
            data.payment || {};


        const order =
            data.order || {};


        /*
        |--------------------------------------------------------------------------
        | Cashfree Order ID
        |--------------------------------------------------------------------------
        */

        const providerOrderId =
            order.order_id ||
            data.order_id ||
            null;


        /*
        |--------------------------------------------------------------------------
        | Cashfree Payment ID
        |--------------------------------------------------------------------------
        */

        const providerPaymentId =
            payment.cf_payment_id
                ? String(
                    payment.cf_payment_id
                )
                : null;


        /*
        |--------------------------------------------------------------------------
        | Payment Status
        |--------------------------------------------------------------------------
        */

        const paymentStatus =
            payment.payment_status ||
            '';


        console.log(
            'Cashfree webhook received:',
            {
                eventType,
                providerOrderId,
                providerPaymentId,
                paymentStatus,
            }
        );


        /*
        |--------------------------------------------------------------------------
        | SUCCESS
        |--------------------------------------------------------------------------
        */

        if (
            paymentStatus ===
            'SUCCESS'
        ) {
            const paymentAmount =
                payment.payment_amount ??
                order.order_amount ??
                null;

            const paymentCurrency =
                payment.payment_currency ??
                order.order_currency ??
                null;

            try {
                await markPaymentSuccess({
                    providerOrderId,

                    providerPaymentId,

                    paymentAmount,

                    paymentCurrency,

                    rawResponse:
                        payload,
                });
            } catch (settlementError) {
                // The settlement transaction has already rolled back. A
                // verified provider success is still a real payment, so the
                // exception is persisted in its own transaction before we
                // acknowledge. If that persistence fails, the error propagates
                // and the provider retries the webhook (non-2xx).
                if (!isQueueableSettlementError(settlementError)) {
                    throw settlementError;
                }

                const queued = await enqueuePaymentReconciliationEvent({
                    providerOrderId,

                    providerPaymentId,

                    paymentAmount,

                    paymentCurrency,

                    failureCode: settlementError.code,

                    failureMessage: settlementError.message,
                });

                if (queued.result === 'conflict') {
                    // High severity: a signed event contradicts the stored case.
                    // The incident is already committed, so acknowledging is safe.
                    console.error(
                        '[HIGH] Payment reconciliation idempotency conflict:',
                        {
                            providerOrderId,
                            queueId: queued.queueId,
                            incidentId: queued.incidentId,
                        }
                    );
                } else if (queued.result === 'manual_review') {
                    console.error(
                        '[HIGH] Verified payment success without provider payment ID; manual review:',
                        {
                            providerOrderId,
                            incidentId: queued.incidentId,
                        }
                    );
                } else {
                    console.error(
                        'Payment success queued for reconciliation:',
                        {
                            providerOrderId,
                            queueId: queued.queueId,
                            result: queued.result,
                            failureCode: settlementError.code,
                        }
                    );
                }

                const reconciliationStatus = {
                    conflict: 'conflict_recorded',
                    manual_review: 'manual_review_recorded',
                }[queued.result] || 'queued';

                return res.status(200).json({
                    success: true,

                    received: true,

                    event:
                        eventType,

                    paymentStatus,

                    reconciliation: {
                        status: reconciliationStatus,

                        result: queued.result,
                    },
                });
            }
        }


        /*
        |--------------------------------------------------------------------------
        | FAILED
        |--------------------------------------------------------------------------
        */

        else if (
            [
                'FAILED',
                'USER_DROPPED',
                'CANCELLED',
            ].includes(
                paymentStatus
            )
        ) {
            await markPaymentFailed({
                providerOrderId,

                providerPaymentId,

                rawResponse:
                    payload,
            });
        }


        /*
        |--------------------------------------------------------------------------
        | Other statuses
        |--------------------------------------------------------------------------
        |
        | We acknowledge the webhook but don't
        | change the payment state yet.
        |
        */

        return res.status(200).json({
            success: true,

            received: true,

            event:
                eventType,

            paymentStatus,
        });

    } catch (error) {
        next(error);
    }
}