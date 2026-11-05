import {
    ATTEMPT_LEASE_MS,
    createOrder,
    retryPaymentAttempt,
} from '../services/order.service.js';

import {
    createCashfreeOrder,
} from '../services/cashfree.service.js';

import {
    CREATE_OUTCOME,
    isCreateLeaseExpired,
    loadOrderAttempts,
    summarizeAttempts,
    isDefinitiveRefusal,
    isOrderAlreadyPresent,
    claimCreateForProvider,
    markCreateAmbiguous,
    markCreateRejected,
    recordCreateSession,
    resolveCreateByLookup,
} from '../services/payment-creation.service.js';

const AMBIGUOUS_CREATE_MESSAGE =
    'Payment gateway did not confirm the transaction session. The order has been saved and is awaiting gateway verification.';

const AMBIGUOUS_REPLAY_MESSAGE =
    'Payment gateway verification is in progress for this order.';

/*
 * Response for an unknown create outcome. The provider may hold the order, so the client
 * must not start a new attempt. Status is resolved by lookup, not by creating again.
 */
function ambiguousCreateBody(result, guestAccessToken, message) {
    return {
        success: false,
        existing: result.existing,
        code: 'GATEWAY_AMBIGUOUS_TIMEOUT',
        message,
        orderNumber: result.order.order_number,
        order: {
            id: result.order.id,
            order_number: result.order.order_number,
            customer_name: result.order.customer_name,
            phone: result.order.phone,
            email: result.order.email,
            subtotal: Number(result.order.subtotal),
            discount_amount: Number(result.order.discount_amount),
            shipping_amount: Number(result.order.shipping_amount),
            tax_amount: Number(result.order.tax_amount),
            total_amount: Number(result.order.total_amount),
            currency: result.order.currency,
            status: result.order.status,
            payment_status: result.order.payment_status,
            payment_method: result.order.payment_method,
            created_at: result.order.created_at,
        },
        payment: {
            id: result.payment.id,
            provider: 'cashfree',
            provider_order_id: result.order.order_number,
            status: result.payment.status,
            gateway_status: 'GATEWAY_AMBIGUOUS_TIMEOUT',
        },
        guestAccessToken,
        gatewayStatus: 'GATEWAY_AMBIGUOUS_TIMEOUT',
        requiresVerification: true,
    };
}

/*
 * Decides what a replay of an existing ONLINE order may do. It never creates a provider
 * order. Only a stored session, or a lookup that finds one, returns a session.
 */
async function replayExistingCashfreeCreate(payment, order) {
    const saved = payment.raw_response || {};

    if (saved.payment_session_id) {
        return { kind: 'session', cashfreeOrder: saved };
    }

    if (payment.gateway_status === 'CASHFREE_PENDING' && !payment.provider_order_id) {
        // Written before the create lifecycle was durable. The provider may already hold the
        // order, so resolve by lookup. Creating here would risk a second provider order.
        const resolved = await resolveCreateByLookup({
            paymentId: payment.id,
            orderNumber: order.order_number,
        });
        if (resolved.outcome === CREATE_OUTCOME.ORDER_CREATED) {
            return { kind: 'session', cashfreeOrder: resolved.cashfreeOrder };
        }
        return { kind: 'ambiguous' };
    }

    if (payment.gateway_status === 'CREATE_PENDING') {
        // The first request has not reached Cashfree yet. It will claim this row or fail to.
        return { kind: 'in_progress' };
    }

    if (payment.gateway_status === 'ATTEMPT_INITIATED') {
        const expired = await isCreateLeaseExpired({
            paymentId: payment.id,
            leaseMs: ATTEMPT_LEASE_MS,
        });
        if (!expired) {
            return { kind: 'in_progress' };
        }
        await markCreateAmbiguous({ paymentId: payment.id, orderNumber: order.order_number });
        return { kind: 'ambiguous' };
    }

    if (payment.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT') {
        return { kind: 'ambiguous' };
    }

    return { kind: 'unresolved' };
}

import {
    generateGuestAccessToken,
    verifyGuestAccessToken,
} from '../utils/order-token.js';

import { query } from '../db/pool.js';


/*
|--------------------------------------------------------------------------
| Create Checkout Order
|--------------------------------------------------------------------------
|
| POST /api/orders/create
|
| Supports:
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

        const effectiveIdempotencyKey =
            req.headers['idempotency-key'] ||
            idempotencyKey ||
            null;

        const authHeader = req.headers.authorization;
        const bearerToken =
            typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
                ? authHeader.slice(7).trim()
                : null;
        const providedGuestToken =
            req.headers['x-guest-access-token'] || bearerToken || null;

        /*
        |--------------------------------------------------------------------------
        | Validate payment method
        |--------------------------------------------------------------------------
        */

        const normalizedPaymentMethod =
            String(paymentMethod || '')
                .trim()
                .toUpperCase();

        if (
            !['COD', 'ONLINE'].includes(
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

        /*
        |--------------------------------------------------------------------------
        | Idempotency key (required)
        |--------------------------------------------------------------------------
        | Without a key, a retry after a lost response creates a second order.
        | The storefront always sends one (a UUID per checkout attempt).
        */

        if (!effectiveIdempotencyKey) {
            return res.status(400).json({
                success: false,
                code: 'IDEMPOTENCY_KEY_REQUIRED',
                message: 'An Idempotency-Key header or idempotencyKey field is required.',
            });
        }

        if (!/^[A-Za-z0-9_-]{8,100}$/.test(String(effectiveIdempotencyKey))) {
            return res.status(400).json({
                success: false,
                code: 'IDEMPOTENCY_KEY_INVALID',
                message: 'Idempotency key must be 8 to 100 letters, digits, hyphens, or underscores.',
            });
        }

        let result;
        try {
            result = await createOrder({
                customer,
                shippingAddress,
                billingAddress,
                items,
                paymentMethod: normalizedPaymentMethod,
                notes,
                idempotencyKey: effectiveIdempotencyKey,
            });
        } catch (error) {
            // A key reused for a different request is answered exactly like an
            // unauthenticated replay, so the response does not reveal that the key exists.
            if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
                return res.status(409).json({
                    success: false,
                    code: 'IDEMPOTENCY_REPLAY_UNAUTHORIZED',
                    message:
                        'An order already exists for this idempotency key. A valid guest access token is required to access an existing order. If the original response was lost, verified OTP-based ownership confirmation is required.',
                });
            }
            throw error;
        }


        /*
        |--------------------------------------------------------------------------
        | Guest Access Token & Idempotency Replay Authorization (SEC-01)
        |--------------------------------------------------------------------------
        |
        | If an order with this idempotency key already exists, NEVER mint a new
        | guest access token or disclose private order details (PII, items, session)
        | unless the caller presents a verified guest access token for this order.
        |
        |--------------------------------------------------------------------------
        */

        let guestAccessToken;

        if (result.existing) {
            if (!providedGuestToken) {
                return res.status(409).json({
                    success: false,
                    code: 'IDEMPOTENCY_REPLAY_UNAUTHORIZED',
                    message:
                        'An order already exists for this idempotency key. A valid guest access token is required to access an existing order. If the original response was lost, verified OTP-based ownership confirmation is required.',
                });
            }

            const verification = verifyGuestAccessToken({
                token: providedGuestToken,
                orderNumber: result.order.order_number,
                order: result.order,
            });

            if (!verification.valid) {
                return res.status(409).json({
                    success: false,
                    code: 'IDEMPOTENCY_REPLAY_UNAUTHORIZED',
                    message:
                        'An order already exists for this idempotency key. A valid guest access token is required to access an existing order. If the original response was lost, verified OTP-based ownership confirmation is required.',
                });
            }

            // Legitimate authorized replay: preserve caller's verified token
            guestAccessToken = providedGuestToken;
        } else {
            // First-time guest checkout: securely generate initial guest access token
            guestAccessToken = generateGuestAccessToken(result.order);
        }

        // Several attempts on this order disagree (for example, two live sessions). Fail closed:
        // no session is returned and no new attempt is created. Support resolves it.
        if (result.existing && result.paymentState === 'CONFLICT') {
            return res.status(409).json({
                success: false,
                code: 'PAYMENT_STATE_CONFLICT',
                retryable: false,
                message: 'The payment records for this order need manual review. Please contact customer care.',
            });
        }

        // A paid order never returns a payment session, so it cannot be paid twice from a replay.
        if (result.existing && result.paymentState === 'PAID') {
            return res.status(200).json({
                success: true,
                existing: true,
                paymentStatus: 'paid',
                order: result.order,
                payment: result.payment,
                items: result.items,
                guestAccessToken,
            });
        }


        /*
        |--------------------------------------------------------------------------
        | COD
        |--------------------------------------------------------------------------
        */

        if (normalizedPaymentMethod === 'COD') {
            return res
                .status(result.existing ? 200 : 201)
                .json({
                    success: true,
                    existing: result.existing,
                    order: result.order,
                    payment: result.payment,
                    items: result.items,
                    guestAccessToken,
                });
        }


        /*
        |--------------------------------------------------------------------------
        | Existing ONLINE order
        |--------------------------------------------------------------------------
        |
        | Reuse the saved Cashfree session when available.
        | Do not create another Cashfree order simply because
        | the customer retried the same checkout request.
        |
        |--------------------------------------------------------------------------
        */

        if (
            result.existing &&
            result.payment?.provider === 'cashfree'
        ) {
            const replay = await replayExistingCashfreeCreate(
                result.payment,
                result.order
            );

            if (replay.kind === 'ambiguous') {
                return res.status(202).json(
                    ambiguousCreateBody(result, guestAccessToken, AMBIGUOUS_REPLAY_MESSAGE)
                );
            }

            if (replay.kind === 'in_progress') {
                return res.status(409).json({
                    success: false,
                    code: 'PAYMENT_CREATION_IN_PROGRESS',
                    retryable: true,
                    message: 'A payment session is being created for this order. Retry shortly.',
                });
            }

            if (replay.kind === 'unresolved') {
                const error = new Error(
                    'The existing Cashfree order has no saved payment session. Please verify its status before retrying checkout.'
                );

                error.statusCode = 409;
                throw error;
            }

            const savedCashfreeOrder = replay.cashfreeOrder;

            const paymentSessionId =
                savedCashfreeOrder.payment_session_id;

            return res.status(200).json({
                success: true,
                existing: true,
                order: result.order,
                payment: result.payment,
                items: result.items,
                guestAccessToken,
                cashfree: {
                    orderId:
                        savedCashfreeOrder.order_id ||
                        result.payment.provider_order_id,

                    cfOrderId:
                        savedCashfreeOrder.cf_order_id ||
                        null,

                    paymentSessionId,

                    orderStatus:
                        savedCashfreeOrder.order_status ||
                        null,
                },
            });
        }


        /*
        |--------------------------------------------------------------------------
        | Create Cashfree order
        |--------------------------------------------------------------------------
        */

        // An existing order never reaches this point: a replay returns above or fails closed.
        if (result.existing) {
            return res.status(409).json({
                success: false,
                code: 'PAYMENT_STATE_UNKNOWN',
                message: 'The payment state for this order could not be determined. Please check payment status.',
            });
        }

        // Claim the create row before contacting Cashfree. The claim is conditional: it fails
        // if a retry has already closed the row. Only a successful claim may call the provider.
        const claimed = await claimCreateForProvider({
            paymentId: result.payment.id,
            orderNumber: result.order.order_number,
        });
        if (!claimed) {
            return res.status(409).json({
                success: false,
                code: 'PAYMENT_CREATION_CLOSED',
                retryable: true,
                message: 'This payment attempt was closed before it was sent. Start a new payment attempt from the order page.',
            });
        }

        // Every outcome below writes a conditional state change, so a stale request cannot
        // overwrite a newer one.
        let cashfreeOrder = null;
        let updatedPayment = null;
        try {
            cashfreeOrder = await createCashfreeOrder({
                orderId: result.order.order_number,

                orderAmount: Number(
                    result.order.total_amount
                ),

                customer,

                orderNote:
                    notes ||
                    `The Crunchy Heart order ${result.order.order_number}`,
            });
        } catch (cfErr) {
            // A 4xx other than 409 is a refusal: no provider order exists, so the attempt is closed.
            if (isDefinitiveRefusal(cfErr)) {
                await markCreateRejected({
                    paymentId: result.payment.id,
                    rawResponse: cfErr?.cashfreeResponse || { error: cfErr?.message },
                });
                throw cfErr;
            }

            // 409 means the provider already holds this merchant order_id. Find out what it is
            // by lookup. Never create a second order under a new id from here.
            if (isOrderAlreadyPresent(cfErr)) {
                const resolved = await resolveCreateByLookup({
                    paymentId: result.payment.id,
                    orderNumber: result.order.order_number,
                });
                if (resolved.outcome !== CREATE_OUTCOME.ORDER_CREATED) {
                    return res.status(202).json(
                        ambiguousCreateBody(result, guestAccessToken, AMBIGUOUS_CREATE_MESSAGE)
                    );
                }
                cashfreeOrder = resolved.cashfreeOrder;
                updatedPayment = resolved.payment;
            } else {
                // Timeout, network failure, 5xx, or an unusable success response. The provider may
                // have created the order, so the outcome is unknown.
                await markCreateAmbiguous({
                    paymentId: result.payment.id,
                    orderNumber: result.order.order_number,
                });
                return res.status(202).json(
                    ambiguousCreateBody(result, guestAccessToken, AMBIGUOUS_CREATE_MESSAGE)
                );
            }
        }

        /*
        |--------------------------------------------------------------------------
        | Save Cashfree response
        |--------------------------------------------------------------------------
        | Conditional: succeeds only while the create row still awaits a result. A stale
        | request never overwrites a state set by reconciliation.
        */

        if (!updatedPayment) {
            try {
                updatedPayment = await recordCreateSession({
                    paymentId: result.payment.id,
                    orderNumber: result.order.order_number,
                    cashfreeOrder,
                });
            } catch (persistError) {
                // The provider created the order, but the session could not be stored. Mark the
                // outcome unknown. Lookup will then recover the session without a second order.
                await markCreateAmbiguous({
                    paymentId: result.payment.id,
                    orderNumber: result.order.order_number,
                }).catch(() => {});
                return res.status(202).json(
                    ambiguousCreateBody(result, guestAccessToken, AMBIGUOUS_CREATE_MESSAGE)
                );
            }

            if (!updatedPayment) {
                return res.status(202).json(
                    ambiguousCreateBody(result, guestAccessToken, AMBIGUOUS_CREATE_MESSAGE)
                );
            }
        }



        /*
        |--------------------------------------------------------------------------
        | Return payment session
        |--------------------------------------------------------------------------
        */

        return res
            .status(result.existing ? 200 : 201)
            .json({
                success: true,
                existing: result.existing,
                order: result.order,
                payment: updatedPayment,
                items: result.items,
                guestAccessToken,
                cashfree: {
                    orderId: cashfreeOrder.order_id,
                    cfOrderId:
                        cashfreeOrder.cf_order_id || null,
                    paymentSessionId:
                        cashfreeOrder.payment_session_id,
                    orderStatus:
                        cashfreeOrder.order_status || null,
                },
            });

    } catch (error) {
        next(error);
    }
}


/*
|--------------------------------------------------------------------------
| Retry Order Payment
|--------------------------------------------------------------------------
|
| POST /api/orders/:orderNumber/retry-payment
|
| Secure, idempotent retry for existing orders whose online payment
| attempt failed or whose Cashfree payment session expired.
|
| Requires:
| Header: x-guest-access-token (or Authorization: Bearer <token>)
| Header / Body: Idempotency-Key (optional)
|
|--------------------------------------------------------------------------
*/

export async function retryOrderPayment(
    req,
    res,
    next
) {
    try {
        const {
            orderNumber,
        } = req.params;

        if (!orderNumber) {
            return res.status(400).json({
                success: false,
                message: 'orderNumber is required.',
            });
        }

        const authHeader =
            req.headers.authorization;

        const bearerToken =
            typeof authHeader === 'string' &&
            authHeader.startsWith('Bearer ')
                ? authHeader.slice(7).trim()
                : null;

        const guestAccessToken =
            req.headers['x-guest-access-token'] ||
            bearerToken ||
            null;

        const idempotencyKey =
            req.headers['idempotency-key'] ||
            req.body?.idempotencyKey ||
            null;

        const result =
            await retryPaymentAttempt({
                orderNumber,
                guestAccessToken,
                idempotencyKey,
            });

        return res.status(200).json({
            success: true,
            existing: Boolean(result.existing),
            order: result.order,
            payment: result.payment,
            items: result.items,
            cashfree: result.cashfree,
        });

    } catch (error) {
        next(error);
    }
}


/*
|--------------------------------------------------------------------------
| Get Order Details
|--------------------------------------------------------------------------
|
| GET /api/orders/:orderNumber
|
| Secure order lookup for customer order confirmation and status.
| Requires x-guest-access-token header bound to the target order.
| Returns order information, items, pricing summary, and latest payment attempt.
|
|--------------------------------------------------------------------------
*/

export async function getOrderDetails(req, res, next) {
    try {
        const { orderNumber } = req.params;

        if (!orderNumber) {
            return res.status(400).json({
                success: false,
                message: 'orderNumber is required.',
            });
        }

        const authHeader = req.headers.authorization;
        const bearerToken =
            typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
                ? authHeader.slice(7).trim()
                : null;

        const guestAccessToken =
            req.headers['x-guest-access-token'] || bearerToken || null;

        const orderResult = await query(
            `
            SELECT
                id,
                order_number,
                customer_name,
                phone,
                email,
                shipping_address,
                billing_address,
                subtotal,
                discount_amount,
                shipping_amount,
                tax_amount,
                total_amount,
                currency,
                status,
                payment_status,
                payment_method,
                notes,
                created_at,
                updated_at
            FROM orders
            WHERE order_number = $1
            LIMIT 1
            `,
            [orderNumber]
        );

        if (!orderResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: `Order ${orderNumber} not found.`,
            });
        }

        const order = orderResult.rows[0];

        // Authorize via guest token
        const verification = verifyGuestAccessToken({
            token: guestAccessToken,
            orderNumber: order.order_number,
            order,
        });

        if (!verification.valid) {
            return res.status(401).json({
                success: false,
                message: 'Valid guest access token is required to view order details.',
            });
        }

        // Fetch order items
        const itemResult = await query(
            `
            SELECT
                id,
                variant_id,
                product_name,
                variant_name,
                sku,
                quantity,
                unit_price,
                total_price,
                taxable_value,
                tax_rate,
                tax_amount
            FROM order_items
            WHERE order_id = $1
            ORDER BY created_at ASC
            `,
            [order.id]
        );

        // The payment shown is the authoritative attempt, chosen by state from every row.
        const attemptSummary = summarizeAttempts(await loadOrderAttempts(order.id));
        const latestPayment = attemptSummary.authoritative || null;

        // Fetch refund record if any (authoritative backend confirmation)
        const refundResult = await query(
            `
            SELECT id, amount, status, reason, created_at
            FROM refunds
            WHERE order_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [order.id]
        );

        const refund = refundResult.rows[0]
            ? {
                id: refundResult.rows[0].id,
                amount: Number(refundResult.rows[0].amount),
                status: refundResult.rows[0].status,
                reason: refundResult.rows[0].reason,
                createdAt: refundResult.rows[0].created_at,
            }
            : null;

        const isPaid = order.payment_status === 'paid' || order.status === 'paid';
        const isAmbiguous =
            attemptSummary.state === 'UNRESOLVED' ||
            latestPayment?.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT' ||
            latestPayment?.gateway_status === 'SETTLEMENT_AMBIGUOUS';
        // Retry is offered only when no attempt is unresolved or in conflict. The server
        // enforces the same rule, so a disabled retry matches a refused one.
        const canRetry =
            order.payment_method === 'ONLINE' &&
            !isPaid &&
            !isAmbiguous &&
            attemptSummary.state !== 'CONFLICT' &&
            attemptSummary.state !== 'PAID';

        return res.json({
            success: true,
            order: {
                id: order.id,
                orderNumber: order.order_number,
                customerName: order.customer_name,
                phone: order.phone,
                email: order.email,
                shippingAddress: order.shipping_address,
                billingAddress: order.billing_address,
                subtotal: Number(order.subtotal),
                discountAmount: Number(order.discount_amount),
                shippingAmount: Number(order.shipping_amount),
                taxAmount: Number(order.tax_amount),
                totalAmount: Number(order.total_amount),
                currency: order.currency,
                status: order.status,
                paymentStatus: order.payment_status,
                paymentMethod: order.payment_method,
                notes: order.notes,
                refund,
                createdAt: order.created_at,
                updatedAt: order.updated_at,
            },
            items: itemResult.rows.map((row) => ({
                id: row.id,
                variantId: row.variant_id,
                productName: row.product_name,
                variantName: row.variant_name,
                sku: row.sku,
                quantity: Number(row.quantity),
                unitPrice: Number(row.unit_price),
                totalPrice: Number(row.total_price),
                taxableValue: Number(row.taxable_value),
                taxRate: Number(row.tax_rate),
                taxAmount: Number(row.tax_amount),
            })),
            payment: latestPayment
                ? {
                    id: latestPayment.id,
                    provider: latestPayment.provider,
                    providerOrderId: latestPayment.provider_order_id,
                    providerPaymentId: latestPayment.provider_payment_id,
                    amount: Number(latestPayment.amount),
                    currency: latestPayment.currency,
                    status: latestPayment.status,
                    gatewayStatus: latestPayment.gateway_status,
                    createdAt: latestPayment.created_at,
                    updatedAt: latestPayment.updated_at,
                }
                : null,
            refund,
            canRetry,
            paymentState: attemptSummary.state,
        });
    } catch (error) {
        next(error);
    }
}

/*
|--------------------------------------------------------------------------
| Guest order recovery (lost checkout response)
|--------------------------------------------------------------------------
| The request reply is always generic. It never reveals whether an order exists,
| whether a code was sent, or why a verification failed. The code and the guest
| token are never logged.
*/

// Every recovery response, success or failure, takes at least this long. Without it,
// a request with a match returns faster than one without, which would reveal the match.
export const RECOVERY_MIN_RESPONSE_MS = 400;

async function holdMinimumDuration(startedAt) {
    const remaining = RECOVERY_MIN_RESPONSE_MS - (Date.now() - startedAt);
    if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, remaining));
    }
}

export async function requestOrderRecoveryController(req, res, next) {
    const startedAt = Date.now();
    try {
        const { requestOrderRecovery } = await import('../services/order-recovery.service.js');
        const result = await requestOrderRecovery({
            contact: { email: req.body?.email, phone: req.body?.phone },
            ipAddress: req.ip || null,
        });
        // Operational signal only: the outcome and no contact or IP details.
        console.info('[recovery] request processed:', result.outcome);
        await holdMinimumDuration(startedAt);
        return res.status(202).json({ success: true, message: result.message });
    } catch (error) {
        await holdMinimumDuration(startedAt);
        next(error);
    }
}

export async function verifyOrderRecoveryController(req, res, next) {
    const startedAt = Date.now();
    try {
        const { verifyOrderRecovery } = await import('../services/order-recovery.service.js');
        const result = await verifyOrderRecovery({
            contact: { email: req.body?.email, phone: req.body?.phone },
            code: req.body?.code,
            ipAddress: req.ip || null,
        });
        await holdMinimumDuration(startedAt);
        return res.json({ success: true, order: result.order, guestAccessToken: result.guestAccessToken });
    } catch (error) {
        await holdMinimumDuration(startedAt);
        next(error);
    }
}
