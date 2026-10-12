import {
    getCashfreePayments,
    resolveCashfreePaymentStatus,
    verifyCashfreeWebhookSignature,
} from '../services/cashfree.service.js';

import {
    markPaymentSuccess,
    markPaymentFailed,
} from '../services/payment.service.js';


/*
|--------------------------------------------------------------------------
| Get Payment Status
|--------------------------------------------------------------------------
|
| GET /api/payments/status/:orderId
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


        const payments =
            await getCashfreePayments(
                orderId
            );


        const status =
            resolveCashfreePaymentStatus(
                payments
            );


        return res.json({
            success: true,

            orderId,

            status,

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
            await markPaymentSuccess({
                providerOrderId,

                providerPaymentId,

                rawResponse:
                    payload,
            });
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