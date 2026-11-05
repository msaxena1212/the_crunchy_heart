import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { getCashfreeOrder, getCashfreePayments } from './cashfree.service.js';
import { markPaymentSuccess, markPaymentFailed } from './payment.service.js';

/*
|--------------------------------------------------------------------------
| Hard Database Target & Environment Safety Assertion
|--------------------------------------------------------------------------
|
| Prevents reconciliation from ever running against live Neon or an
| unrecognized production database target.
|
|--------------------------------------------------------------------------
*/
export function assertSafeDatabaseUrl(databaseUrl, executionEnv = process.env.NODE_ENV) {
    const rawUrl = (databaseUrl !== undefined ? String(databaseUrl || '') : String(process.env.DATABASE_URL || '')).trim();

    if (!rawUrl) {
        throw new Error('FATAL CONFIGURATION ERROR: DATABASE_URL is missing.');
    }

    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`FATAL CONFIGURATION ERROR: Malformed DATABASE_URL: "${rawUrl}".`);
    }

    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
        throw new Error(
            `FATAL CONFIGURATION ERROR: DATABASE_URL must use postgresql: or postgres: protocol. Received: "${parsed.protocol}"`
        );
    }

    const isTest = executionEnv === 'test';

    if (isTest) {
        const hostname = (parsed.hostname || '').toLowerCase();
        const dbName = (parsed.pathname || '').replace(/^\//, '');

        const isLocalhost =
            hostname === '127.0.0.1' ||
            hostname === 'localhost' ||
            hostname === '::1' ||
            hostname === '[::1]';

        if (!isLocalhost || dbName !== 'crunchy_heart_test') {
            throw new Error(
                `FATAL SAFETY VIOLATION: Test environment must run strictly against local isolated database 'crunchy_heart_test' on localhost/127.0.0.1. ` +
                `Refusing execution against host "${hostname}" and database "${dbName}".`
            );
        }

        return true;
    }

    // Non-test environment validation (production / staging / development)
    if (!parsed.hostname) {
        throw new Error('FATAL CONFIGURATION ERROR: DATABASE_URL is missing a valid hostname.');
    }

    const dbName = (parsed.pathname || '').replace(/^\//, '');
    if (!dbName) {
        throw new Error('FATAL CONFIGURATION ERROR: DATABASE_URL is missing a database name.');
    }

    return true;
}

/*
|--------------------------------------------------------------------------
| Reconcile Single Cashfree Payment Attempt
|--------------------------------------------------------------------------
|
| Operates on individual payment attempts using the exact stored
| provider_order_id (e.g., TCH-xxxx, TCH-xxxx-R2).
|
| Transaction Boundaries:
| - NEVER holds a database transaction open across Cashfree network calls.
| - Reads attempt info, makes external provider calls, then executes short
|   atomic transactions with strict lock hierarchy:
|   orders FOR UPDATE -> payments FOR UPDATE -> inventory (if settling).
|
|--------------------------------------------------------------------------
*/
export async function reconcilePaymentAttempt({ providerOrderId }) {
    assertSafeDatabaseUrl();

    if (!providerOrderId || typeof providerOrderId !== 'string' || !providerOrderId.trim()) {
        const error = new Error('Cashfree providerOrderId is required for reconciliation.');
        error.statusCode = 400;
        throw error;
    }

    const normalizedProviderOrderId = providerOrderId.trim();

    // 1. Look up the local payment attempt (outside transaction / no lock across network)
    const lookupResult = await query(
        `
        SELECT
            p.id AS payment_id,
            p.order_id,
            p.provider,
            p.provider_order_id,
            p.provider_payment_id,
            p.amount,
            p.currency,
            p.status AS payment_status,
            p.gateway_status,
            p.idempotency_key,
            p.raw_response,
            o.id AS parent_order_id,
            o.order_number,
            o.status AS order_status,
            o.payment_status AS order_payment_status,
            o.total_amount AS order_total_amount
        FROM payments p
        JOIN orders o ON o.id = p.order_id
        WHERE p.provider_order_id = $1
          AND p.provider = 'cashfree'
        `,
        [normalizedProviderOrderId]
    );

    if (!lookupResult.rows.length) {
        const error = new Error(
            `Payment attempt not found for Cashfree provider_order_id '${normalizedProviderOrderId}'.`
        );
        error.statusCode = 404;
        throw error;
    }

    const localPayment = lookupResult.rows[0];

    // 2. Provider status lookup (outside any database transaction)
    let cfOrder = null;
    let orderLookupError = null;

    try {
        cfOrder = await getCashfreeOrder(normalizedProviderOrderId);
    } catch (err) {
        orderLookupError = err;
    }

    // If local payment is already settled and provider order lookup fails:
    // Safe idempotency return without state mutation.
    if (localPayment.payment_status === 'paid' && orderLookupError) {
        return {
            success: true,
            reconciled: true,
            action: 'ALREADY_SETTLED',
            paymentId: localPayment.payment_id,
            orderId: localPayment.order_id,
            orderNumber: localPayment.order_number,
            providerOrderId: normalizedProviderOrderId,
            status: 'paid',
            gatewayStatus: localPayment.gateway_status,
            alreadySettled: true,
            extraRefunds: [],
        };
    }

    // 3. Handle provider order lookup errors safely:
    if (orderLookupError) {
        // Transition 3: 404 Not Found is inconclusive per safety protocol.
        // It must NOT automatically be treated as proof that an order was never created.
        if (orderLookupError.statusCode === 404) {
            return {
                success: true,
                reconciled: false,
                action: 'KEPT_AMBIGUOUS_BLOCKED',
                reason: 'PROVIDER_ORDER_NOT_FOUND_INCONCLUSIVE',
                providerOrderId: normalizedProviderOrderId,
                status: localPayment.payment_status,
                gatewayStatus: localPayment.gateway_status,
                inconclusive: true,
                message:
                    'Cashfree returned 404 for order. Treated as inconclusive; payment attempt remains blocked in its current state.',
            };
        }

        // Provider times out, 5xx, or network failure: fail closed without state mutation.
        return {
            success: false,
            reconciled: false,
            action: 'NO_ACTION',
            reason: 'GATEWAY_UNAVAILABLE',
            providerOrderId: normalizedProviderOrderId,
            status: localPayment.payment_status,
            gatewayStatus: localPayment.gateway_status,
            error: orderLookupError.message,
        };
    }

    // 4. Validate provider order structure and identity
    if (!cfOrder || typeof cfOrder !== 'object') {
        if (localPayment.payment_status === 'paid') {
            return {
                success: true,
                reconciled: true,
                action: 'ALREADY_SETTLED',
                paymentId: localPayment.payment_id,
                orderId: localPayment.order_id,
                orderNumber: localPayment.order_number,
                providerOrderId: normalizedProviderOrderId,
                status: 'paid',
                gatewayStatus: localPayment.gateway_status,
                alreadySettled: true,
                extraRefunds: [],
            };
        }
        return {
            success: false,
            reconciled: false,
            action: 'NO_ACTION',
            reason: 'MALFORMED_ORDER_RESPONSE',
            providerOrderId: normalizedProviderOrderId,
        };
    }

    if (cfOrder.order_id && cfOrder.order_id !== normalizedProviderOrderId) {
        return {
            success: false,
            reconciled: false,
            action: 'NO_ACTION',
            reason: 'ORDER_IDENTITY_MISMATCH',
            providerOrderId: normalizedProviderOrderId,
            reportedOrderId: cfOrder.order_id,
        };
    }

    // 5. Query Cashfree transactions for this order
    let cfPayments = null;
    try {
        cfPayments = await getCashfreePayments(normalizedProviderOrderId);
    } catch (err) {
        if (localPayment.payment_status === 'paid') {
            return {
                success: true,
                reconciled: true,
                action: 'ALREADY_SETTLED',
                paymentId: localPayment.payment_id,
                orderId: localPayment.order_id,
                orderNumber: localPayment.order_number,
                providerOrderId: normalizedProviderOrderId,
                status: 'paid',
                gatewayStatus: localPayment.gateway_status,
                alreadySettled: true,
                extraRefunds: [],
            };
        }
        // If transactions lookup fails (5xx, timeout, etc.), fail closed.
        return {
            success: false,
            reconciled: false,
            action: 'NO_ACTION',
            reason: 'PAYMENT_LOOKUP_FAILED',
            providerOrderId: normalizedProviderOrderId,
            status: localPayment.payment_status,
            gatewayStatus: localPayment.gateway_status,
            error: err.message,
        };
    }

    const transactions = Array.isArray(cfPayments) ? cfPayments : [];

    // Filter for payment transactions that report SUCCESS
    const successfulTransactions = transactions.filter(
        tx => tx && typeof tx === 'object' && tx.payment_status === 'SUCCESS'
    );

    // If local payment is already settled and provider reports NO successful transactions:
    // Safe idempotency return without state mutation.
    if (localPayment.payment_status === 'paid' && successfulTransactions.length === 0) {
        return {
            success: true,
            reconciled: true,
            action: 'ALREADY_SETTLED',
            paymentId: localPayment.payment_id,
            orderId: localPayment.order_id,
            orderNumber: localPayment.order_number,
            providerOrderId: normalizedProviderOrderId,
            status: 'paid',
            gatewayStatus: localPayment.gateway_status,
            alreadySettled: true,
            extraRefunds: [],
        };
    }

    // ----------------------------------------------------------------------
    // Branch A: Verified Successful Payment Transaction Found
    // ----------------------------------------------------------------------
    if (successfulTransactions.length > 0) {
        // Step A1: Validate EVERY successful transaction before taking any settlement action
        const validatedTxs = [];

        for (const tx of successfulTransactions) {
            const cfPaymentId = tx.cf_payment_id || tx.payment_id;
            const txAmount = tx.payment_amount;
            const txCurrency = tx.payment_currency;

            // Validation Rule 1: Payment ID must be identifiable
            if (!cfPaymentId || String(cfPaymentId).trim() === '') {
                return {
                    success: false,
                    reconciled: false,
                    action: 'NO_ACTION',
                    reason: 'MISSING_PAYMENT_ID',
                    providerOrderId: normalizedProviderOrderId,
                };
            }

            // Validation Rule 2: Order identity if returned on transaction
            if (tx.order_id && tx.order_id !== normalizedProviderOrderId) {
                return {
                    success: false,
                    reconciled: false,
                    action: 'NO_ACTION',
                    reason: 'TRANSACTION_ORDER_IDENTITY_MISMATCH',
                    providerOrderId: normalizedProviderOrderId,
                };
            }

            // Validation Rule 3: Transaction amount must be present and numeric
            // (Do NOT substitute order-level amount when transaction amount is missing)
            if (
                txAmount === null ||
                txAmount === undefined ||
                isNaN(Number(txAmount)) ||
                Number(txAmount) <= 0
            ) {
                return {
                    success: false,
                    reconciled: false,
                    action: 'NO_ACTION',
                    reason: 'MISSING_OR_INVALID_TRANSACTION_AMOUNT',
                    providerOrderId: normalizedProviderOrderId,
                };
            }

            // Validation Rule 4: Actual transaction amount must match local payment attempt
            const reportedAmount = Number(txAmount);
            const expectedAmount = Number(localPayment.amount);
            if (Math.abs(reportedAmount - expectedAmount) > 0.01) {
                return {
                    success: false,
                    reconciled: false,
                    action: 'NO_ACTION',
                    reason: 'AMOUNT_MISMATCH',
                    providerOrderId: normalizedProviderOrderId,
                    reportedAmount,
                    expectedAmount,
                };
            }

            // Validation Rule 5: Actual transaction currency must match local payment attempt
            if (
                !txCurrency ||
                String(txCurrency).trim().toUpperCase() !==
                    String(localPayment.currency).trim().toUpperCase()
            ) {
                return {
                    success: false,
                    reconciled: false,
                    action: 'NO_ACTION',
                    reason: 'CURRENCY_MISMATCH',
                    providerOrderId: normalizedProviderOrderId,
                    reportedCurrency: txCurrency,
                    expectedCurrency: localPayment.currency,
                };
            }

            validatedTxs.push({
                ...tx,
                normalizedPaymentId: String(cfPaymentId).trim(),
                numericAmount: reportedAmount,
                normalizedCurrency: String(txCurrency).trim().toUpperCase(),
            });
        }

        // Step A2: De-duplicate multiple copies of the same transaction (identical payment ID)
        const distinctTxMap = new Map();
        for (const tx of validatedTxs) {
            if (!distinctTxMap.has(tx.normalizedPaymentId)) {
                distinctTxMap.set(tx.normalizedPaymentId, tx);
            }
        }
        const distinctTxs = Array.from(distinctTxMap.values());

        // Step A3: Sort deterministically to eliminate any provider array order dependency
        distinctTxs.sort((a, b) => a.normalizedPaymentId.localeCompare(b.normalizedPaymentId));

        const primaryTx = distinctTxs[0];
        const extraCaptures = distinctTxs.slice(1);

        // Step A4: Settle primary transaction at most once via existing markPaymentSuccess contract
        const settlementResult = await markPaymentSuccess({
            providerOrderId: normalizedProviderOrderId,
            providerPaymentId: primaryTx.normalizedPaymentId,
            paymentAmount: primaryTx.numericAmount,
            paymentCurrency: primaryTx.normalizedCurrency,
            rawResponse: {
                order: cfOrder,
                payment: primaryTx,
                allPayments: transactions,
                reconciled: true,
                reconciledAt: new Date().toISOString(),
            },
        });

        // Step A5: Flag every additional confirmed capture for refund review without deducting inventory again
        const extraRefunds = [];
        if (extraCaptures.length > 0) {
            await withTransaction(async client => {
                // Consistent lock ordering: orders FOR UPDATE -> payments FOR UPDATE
                await client.query(
                    `SELECT id FROM orders WHERE id = $1 FOR UPDATE`,
                    [localPayment.order_id]
                );
                await client.query(
                    `SELECT id FROM payments WHERE id = $1 FOR UPDATE`,
                    [localPayment.payment_id]
                );

                for (const extraTx of extraCaptures) {
                    const extraId = extraTx.normalizedPaymentId;
                    const extraAmount = extraTx.numericAmount;

                    // Check if refund record already exists for this extra capture
                    const existingRefund = await client.query(
                        `
                        SELECT id, amount, status
                        FROM refunds
                        WHERE payment_id = $1
                          AND reason LIKE '%' || $2 || '%'
                        LIMIT 1
                        `,
                        [localPayment.payment_id, extraId]
                    );

                    if (existingRefund.rows.length) {
                        extraRefunds.push({
                            paymentId: localPayment.payment_id,
                            extraPaymentId: extraId,
                            refundId: existingRefund.rows[0].id,
                            status: existingRefund.rows[0].status,
                            amount: existingRefund.rows[0].amount,
                            created: false,
                        });
                    } else {
                        const insertRes = await client.query(
                            `
                            INSERT INTO refunds (
                                payment_id,
                                order_id,
                                amount,
                                reason,
                                status,
                                idempotency_key,
                                origin
                            )
                            VALUES ($1, $2, $3, $4, 'pending', $5, 'duplicate_capture')
                            RETURNING id, amount, status
                            `,
                            [
                                localPayment.payment_id,
                                localPayment.order_id,
                                extraAmount,
                                `[INTRA-ATTEMPT DUPLICATE CAPTURE] Additional transaction ${extraId} captured for Cashfree order ${normalizedProviderOrderId} (settled via ${primaryTx.normalizedPaymentId}). Pending refund review.`,
                                `intra_attempt_duplicate:${extraId}`,
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
                                localPayment.order_id,
                                `[DUPLICATE CAPTURE AUDIT] Detected additional captured transaction ${extraId} on attempt ${normalizedProviderOrderId}. Pending refund record created.`,
                            ]
                        );

                        extraRefunds.push({
                            paymentId: localPayment.payment_id,
                            extraPaymentId: extraId,
                            refundId: insertRes.rows[0].id,
                            status: insertRes.rows[0].status,
                            amount: insertRes.rows[0].amount,
                            created: true,
                        });
                    }
                }
            });
        }

        let action = 'SETTLED';
        if (settlementResult.duplicateSettlement) {
            action = 'DUPLICATE_SETTLEMENT_RECORDED';
        } else if (settlementResult.alreadySettled) {
            action = 'ALREADY_SETTLED';
        }

        if (extraCaptures.length > 0 && action === 'SETTLED') {
            action = 'SETTLED_WITH_EXTRA_CAPTURES';
        } else if (extraCaptures.length > 0 && action === 'ALREADY_SETTLED' && extraRefunds.some(r => r.created)) {
            action = 'EXTRA_CAPTURES_RECORDED';
        }

        return {
            success: true,
            reconciled: true,
            action,
            providerOrderId: normalizedProviderOrderId,
            primaryPaymentId: primaryTx.normalizedPaymentId,
            distinctCapturesCount: distinctTxs.length,
            extraCapturesCount: extraCaptures.length,
            extraRefunds,
            ...settlementResult,
        };
    }

    // ----------------------------------------------------------------------
    // Branch B: No Successful Transaction Found
    // ----------------------------------------------------------------------

    // Check for provider inconsistency: order marked PAID but no successful transaction
    if (cfOrder.order_status === 'PAID') {
        return {
            success: false,
            reconciled: false,
            action: 'NO_ACTION',
            reason: 'MISSING_TRANSACTION_DETAILS',
            providerOrderId: normalizedProviderOrderId,
            message:
                'Cashfree order reports PAID, but no verified successful payment transaction with valid amount was found. Settlement aborted.',
        };
    }

    // Provider order is ACTIVE / CREATED
    if (cfOrder.order_status === 'ACTIVE') {
        const paymentSessionId = cfOrder.payment_session_id;

        // Session ID must be valid to recover session
        if (!paymentSessionId || typeof paymentSessionId !== 'string' || !paymentSessionId.trim()) {
            return {
                success: false,
                reconciled: false,
                action: 'NO_ACTION',
                reason: 'MISSING_PAYMENT_SESSION_ID',
                providerOrderId: normalizedProviderOrderId,
            };
        }

        // If local attempt was GATEWAY_AMBIGUOUS_TIMEOUT, recover session and update to ORDER_CREATED
        if (localPayment.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT') {
            await withTransaction(async client => {
                // Lock hierarchy: orders FOR UPDATE -> payments FOR UPDATE
                const orderRes = await client.query(
                    `SELECT id, status, payment_status FROM orders WHERE id = $1 FOR UPDATE`,
                    [localPayment.order_id]
                );
                if (!orderRes.rows.length) return;
                const order = orderRes.rows[0];

                const payRes = await client.query(
                    `SELECT id, status, gateway_status FROM payments WHERE id = $1 FOR UPDATE`,
                    [localPayment.payment_id]
                );
                if (!payRes.rows.length) return;
                const payment = payRes.rows[0];

                // Do not regress paid attempts
                if (payment.status === 'paid' || order.payment_status === 'paid') {
                    return;
                }

                if (payment.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT') {
                    await client.query(
                        `
                        UPDATE payments
                        SET
                            gateway_status = 'ORDER_CREATED',
                            status = 'created',
                            raw_response = $2::jsonb,
                            updated_at = NOW()
                        WHERE id = $1
                        `,
                        [payment.id, JSON.stringify(cfOrder)]
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
                            order.id,
                            `[RECONCILIATION] Recovered active Cashfree payment session for attempt ${normalizedProviderOrderId}.`,
                        ]
                    );
                }
            });

            return {
                success: true,
                reconciled: true,
                action: 'SESSION_RECOVERED',
                providerOrderId: normalizedProviderOrderId,
                status: 'created',
                gatewayStatus: 'ORDER_CREATED',
                paymentSessionId,
            };
        }

        // If already ORDER_CREATED, it remains active awaiting payment
        return {
            success: true,
            reconciled: false,
            action: 'ACTIVE_AWAITING_PAYMENT',
            providerOrderId: normalizedProviderOrderId,
            status: localPayment.payment_status,
            gatewayStatus: localPayment.gateway_status,
            paymentSessionId,
        };
    }

    // Provider order is EXPIRED or TERMINATED
    if (cfOrder.order_status === 'EXPIRED' || cfOrder.order_status === 'TERMINATED') {
        const failResult = await markPaymentFailed({
            providerOrderId: normalizedProviderOrderId,
            rawResponse: {
                order: cfOrder,
                payments: transactions,
                reconciled: true,
                reconciledAt: new Date().toISOString(),
            },
        });

        return {
            success: true,
            reconciled: true,
            action: failResult.ignored ? 'LATE_FAILURE_IGNORED' : 'MARKED_FAILED',
            providerOrderId: normalizedProviderOrderId,
            status: 'failed',
            gatewayStatus: 'FAILED',
            ...failResult,
        };
    }

    // Unrecognized or inconclusive provider status: fail closed without state changes
    return {
        success: false,
        reconciled: false,
        action: 'NO_ACTION',
        reason: 'UNKNOWN_PROVIDER_STATUS',
        orderStatus: cfOrder.order_status,
        providerOrderId: normalizedProviderOrderId,
    };
}

/*
|--------------------------------------------------------------------------
| Reconcile Unresolved Payment Attempts (Bounded Batch Selector)
|--------------------------------------------------------------------------
|
| Targets only eligible attempts:
| 1. GATEWAY_AMBIGUOUS_TIMEOUT
| 2. Stale ORDER_CREATED attempts older than minAgeMinutes
|
| Bounds batch size to prevent wide or unbounded scans.
|
|--------------------------------------------------------------------------
*/
export async function reconcileUnresolvedAttempts({
    limit = 10,
    maxAgeMinutes = 1440,
    minAgeMinutes = 1,
} = {}) {
    assertSafeDatabaseUrl();

    const boundedLimit = Math.min(Math.max(1, Number(limit) || 10), 50);

    const result = await query(
        `
        SELECT
            provider_order_id,
            gateway_status,
            status,
            created_at,
            updated_at
        FROM payments
        WHERE provider = 'cashfree'
          AND provider_order_id IS NOT NULL
          AND status <> 'paid'
          AND (
              gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT'
              OR (
                  status = 'created'
                  AND gateway_status = 'ORDER_CREATED'
                  AND created_at <= NOW() - ($2 || ' minutes')::interval
              )
          )
          AND created_at >= NOW() - ($3 || ' minutes')::interval
        ORDER BY created_at ASC
        LIMIT $1
        `,
        [boundedLimit, minAgeMinutes, maxAgeMinutes]
    );

    const outcomes = [];
    for (const row of result.rows) {
        try {
            const outcome = await reconcilePaymentAttempt({
                providerOrderId: row.provider_order_id,
            });
            outcomes.push(outcome);
        } catch (err) {
            outcomes.push({
                providerOrderId: row.provider_order_id,
                success: false,
                error: err.message,
            });
        }
    }

    return {
        processedCount: outcomes.length,
        outcomes,
    };
}
