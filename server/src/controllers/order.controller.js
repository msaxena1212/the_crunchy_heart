import { createOrder } from '../services/order.service.js';

import {
    createCashfreeOrder,
} from '../services/cashfree.service.js';

import {
    attachCashfreeOrderToPayment,
} from '../services/payment.service.js';


/*
|--------------------------------------------------------------------------
| Create Checkout Order
|--------------------------------------------------------------------------
|
| POST /api/orders/create
|
| Supports:
|
| COD
| ONLINE / Cashfree
|
|--------------------------------------------------------------------------
*/

export async function createCheckoutOrder(
    req,
    res,
    next
) {
    try {
        const {
            customer,
            shippingAddress,
            billingAddress,
            items,
            paymentMethod,
            notes,
            idempotencyKey,
        } = req.body;


        /*
        |--------------------------------------------------------------------------
        | Validate payment method
        |--------------------------------------------------------------------------
        */

        const normalizedPaymentMethod =
            String(
                paymentMethod || ''
            )
                .trim()
                .toUpperCase();


        if (
            ![
                'COD',
                'ONLINE',
            ].includes(
                normalizedPaymentMethod
            )
        ) {
            return res.status(400).json({
                success: false,

                message:
                    'paymentMethod must be COD or ONLINE.',
            });
        }


        /*
        |--------------------------------------------------------------------------
        | Create local order
        |--------------------------------------------------------------------------
        */

        const result =
            await createOrder({
                customer,
                shippingAddress,
                billingAddress,
                items,

                paymentMethod:
                    normalizedPaymentMethod,

                notes,

                idempotencyKey,
            });


        /*
        |--------------------------------------------------------------------------
        | COD
        |--------------------------------------------------------------------------
        |
        | COD does not require Cashfree.
        |
        */

        if (
            normalizedPaymentMethod ===
            'COD'
        ) {
            return res
                .status(
                    result.existing
                        ? 200
                        : 201
                )
                .json({
                    success: true,

                    existing:
                        result.existing,

                    order:
                        result.order,

                    payment:
                        result.payment,

                    items:
                        result.items,
                });
        }


        /*
        |--------------------------------------------------------------------------
        | ONLINE
        |--------------------------------------------------------------------------
        */

        if (
            normalizedPaymentMethod !==
            'ONLINE'
        ) {
            return res.status(400).json({
                success: false,

                message:
                    'Unsupported payment method.',
            });
        }


        /*
        |--------------------------------------------------------------------------
        | Existing ONLINE order
        |--------------------------------------------------------------------------
        |
        | If idempotency caused an existing order
        | to be returned and it already has a
        | Cashfree provider order, don't create
        | another Cashfree order.
        |
        */

        if (
            result.existing &&
            result.payment?.provider ===
            'cashfree' &&
            result.payment
                ?.provider_order_id
        ) {
            let paymentSessionId =
                null;


            if (
                result.payment
                    ?.raw_response
                    ?.payment_session_id
            ) {
                paymentSessionId =
                    result.payment
                        .raw_response
                        .payment_session_id;
            }


            return res.json({
                success: true,

                existing: true,

                order:
                    result.order,

                payment:
                    result.payment,

                items:
                    result.items,

                cashfree: {
                    orderId:
                        result.payment
                            .provider_order_id,

                    cfOrderId:
                        result.payment
                            .raw_response
                            ?.cf_order_id || null,

                    paymentSessionId,
                },
            });
        }


        /*
        |--------------------------------------------------------------------------
        | Create Cashfree order
        |--------------------------------------------------------------------------
        */

        const cashfreeOrder =
            await createCashfreeOrder({
                orderId:
                    result.order.order_number,

                orderAmount:
                    Number(
                        result.order.total_amount
                    ),

                customer,

                orderNote:
                    notes ||
                    `The Crunchy Heart order ${result.order.order_number}`,
            });


        /*
        |--------------------------------------------------------------------------
        | Save Cashfree response
        |--------------------------------------------------------------------------
        */

        const updatedPayment =
            await attachCashfreeOrderToPayment({
                paymentId:
                    result.payment.id,

                cashfreeOrder,
            });


        /*
        |--------------------------------------------------------------------------
        | Return payment session
        |--------------------------------------------------------------------------
        */

        return res
            .status(
                result.existing
                    ? 200
                    : 201
            )
            .json({
                success: true,

                existing:
                    result.existing,

                order:
                    result.order,

                payment:
                    updatedPayment,

                items:
                    result.items,

                cashfree: {
                    orderId:
                        cashfreeOrder.order_id,

                    cfOrderId:
                        cashfreeOrder.cf_order_id,

                    paymentSessionId:
                        cashfreeOrder.payment_session_id,

                    orderStatus:
                        cashfreeOrder.order_status,
                },
            });

    } catch (error) {
        next(error);
    }
}