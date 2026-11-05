import { pool, query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { computeBackoffMs, LEASE_MS } from './payment-reconciliation-retry.service.js';

/*
|--------------------------------------------------------------------------
| Durable Refund Orchestration
|--------------------------------------------------------------------------
| Extends the existing refunds table. No parallel refund system.
|
| Status meanings (refunds.status):
|   pending                  intent recorded; awaiting operator approval
|   approved                 authorised; eligible for provider submission
|   processing               claimed; a provider call is in flight (lease held)
|   reconciliation_required  outcome unknown, or provider accepted but not final
|   refunded                 provider CONFIRMED the refund (existing status)
|   failed                   compatibility only; automation never sets it
|   manual_review            permanent rejection, conflict, or retries exhausted
|
| Safety rules implemented here:
|   - Intent is persisted before any provider call.
|   - The provider refund key is the stable logical idempotency key.
|   - A timeout or unreadable response is AMBIGUOUS. It is never retried by
|     submission. It is reconciled with a provider lookup instead.
|   - A refund becomes 'refunded' only on a provider SUCCEEDED result.
|   - Every state write is fenced by claim_token. A stale worker cannot
|     overwrite a newer owner's state.
|   - No provider call happens inside a database transaction.
|   - Refund processing never touches inventory.
|
| Lock order: orders -> payments -> refunds (rows locked by primary key).
|--------------------------------------------------------------------------
*/

export const REFUND_STATUS = Object.freeze({
    PENDING: 'pending',
    APPROVED: 'approved',
    PROCESSING: 'processing',
    RECONCILIATION_REQUIRED: 'reconciliation_required',
    REFUNDED: 'refunded',
    FAILED: 'failed',
    MANUAL_REVIEW: 'manual_review',
});

// Amounts counted against the payment's refundable total.
export const IN_FLIGHT_REFUND_STATUSES = [
    'pending',
    'approved',
    'processing',
    'reconciliation_required',
    'refunded',
    'manual_review',
];

export const REFUND_ORIGINS = new Set(['stock_shortage', 'duplicate_capture', 'operator']);

export const REFUND_SWEEP_LOCK_KEY = 738412020;

// Retry budget per refund. Provider-pending refunds can stay pending for minutes
// or longer, so the budget must outlast that window. With the capped backoff in
// payment-reconciliation-retry.service.js this spans well over a day before
// escalation to manual review. Exhaustion never resolves a refund silently.
export const REFUND_MAX_ATTEMPTS = 20;

function refundError(code, message, statusCode = 409) {
    return Object.assign(new Error(message), { code, statusCode });
}

function toCents(value) {
    return Math.round(Number(value) * 100);
}

function sanitiseMessage(message) {
    return String(message || 'unknown error').replace(/\s+/g, ' ').slice(0, 500);
}

/*
 * Provider adapter contract.
 *
 *   createRefund({ providerOrderId, refundKey, amount, currency })
 *     -> { status: 'SUCCEEDED' | 'PENDING' | 'FAILED', providerRefundId }
 *     Throws with error.definitive = true only when the provider certainly
 *     did not act (for example, a validation error before processing).
 *     Any other throw is AMBIGUOUS.
 *
 *   getRefund({ providerOrderId, refundKey })
 *     -> { found: false } | { found: true, status, providerRefundId }
 *
 * No real Cashfree refund endpoint is implemented. The default adapter fails
 * closed with a definitive error, so nothing is submitted. Tests inject mocks.
 */
export const refundProvider = {
    async createRefund() {
        throw Object.assign(
            new Error('Cashfree refund submission is not implemented; refund not submitted.'),
            { code: 'PROVIDER_NOT_IMPLEMENTED', definitive: true }
        );
    },

    async getRefund() {
        throw Object.assign(
            new Error('Cashfree refund lookup is not implemented; outcome cannot be verified.'),
            { code: 'PROVIDER_NOT_IMPLEMENTED', definitive: true }
        );
    },
};

async function audit(client, actorAdminId, action, refundId, details) {
    await client.query(
        `
        INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
        VALUES ($1, $2, 'refund', $3, $4::jsonb)
        `,
        [actorAdminId, action, String(refundId), JSON.stringify(details)]
    );
}

/*
|--------------------------------------------------------------------------
| Stage B/C: intent creation (idempotent, over-refund safe)
|--------------------------------------------------------------------------
| Returns { result: 'created' | 'duplicate', refundId, status }.
| Throws 400/404/409 for invalid input, mismatch, conflict, or over-refund.
| A conflicting idempotency key is rejected and the original row is kept.
*/
export async function createRefundIntent({
    orderId,
    paymentId,
    amount,
    currency,
    reason,
    origin,
    idempotencyKey,
    actorAdminId = null,
}) {
    if (!orderId || !paymentId || !idempotencyKey) {
        throw refundError('VALIDATION', 'orderId, paymentId and idempotencyKey are required.', 400);
    }

    if (!REFUND_ORIGINS.has(origin)) {
        throw refundError('VALIDATION', 'Unknown refund origin.', 400);
    }

    const amountCents = toCents(amount);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
        throw refundError('VALIDATION', 'Refund amount must be a positive amount.', 400);
    }

    const requestedCurrency = String(currency || '').trim().toUpperCase();

    return withTransaction(async client => {
        // Lock order: order first, then payment.
        const orderLock = await client.query(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
        if (!orderLock.rows.length) {
            throw refundError('ORDER_NOT_FOUND', 'Order not found.', 404);
        }

        const paymentLock = await client.query(
            `SELECT id, order_id, amount, currency, status FROM payments WHERE id = $1 FOR UPDATE`,
            [paymentId]
        );
        const payment = paymentLock.rows[0];

        if (!payment || payment.order_id !== orderId) {
            throw refundError('PAYMENT_ORDER_MISMATCH', 'Payment does not belong to this order.', 400);
        }

        if (payment.status !== 'paid') {
            throw refundError('PAYMENT_NOT_SETTLED', 'Only a settled payment can be refunded.', 409);
        }

        if (String(payment.currency).toUpperCase() !== requestedCurrency) {
            throw refundError('CURRENCY_MISMATCH', 'Refund currency does not match the payment.', 400);
        }

        // Idempotency: same logical refund returns the existing intent.
        const existing = await client.query(
            `SELECT id, payment_id, order_id, amount, currency, status
             FROM refunds WHERE idempotency_key = $1`,
            [idempotencyKey]
        );

        if (existing.rows.length) {
            const row = existing.rows[0];
            const same =
                row.payment_id === paymentId &&
                row.order_id === orderId &&
                toCents(row.amount) === amountCents &&
                row.currency === requestedCurrency;

            if (!same) {
                throw refundError(
                    'IDEMPOTENCY_CONFLICT',
                    'Idempotency key already used for different refund details.',
                    409
                );
            }

            return { result: 'duplicate', refundId: row.id, status: row.status };
        }

        // Over-refund guard: sums everything that could still complete.
        const inFlight = await client.query(
            `SELECT COALESCE(SUM(amount), 0) AS total
             FROM refunds
             WHERE payment_id = $1 AND status = ANY($2::text[])`,
            [paymentId, IN_FLIGHT_REFUND_STATUSES]
        );

        const inFlightCents = toCents(inFlight.rows[0].total);
        if (inFlightCents + amountCents > toCents(payment.amount)) {
            throw refundError(
                'REFUND_EXCEEDS_PAYMENT',
                'Requested refund would exceed the refundable amount of the payment.',
                409
            );
        }

        const inserted = await client.query(
            `
            INSERT INTO refunds (
                payment_id, order_id, amount, currency, reason, origin,
                status, idempotency_key, max_attempts
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
            RETURNING id, status
            `,
            [paymentId, orderId, Number(amount), requestedCurrency, reason || null, origin, idempotencyKey, REFUND_MAX_ATTEMPTS]
        );

        await audit(client, actorAdminId, 'refund.intent_created', inserted.rows[0].id, {
            paymentId,
            orderId,
            origin,
            amountCents,
        });

        return { result: 'created', refundId: inserted.rows[0].id, status: 'pending' };
    });
}

/*
|--------------------------------------------------------------------------
| Operator approval: pending -> approved
|--------------------------------------------------------------------------
| Approval authorises submission. It never marks the refund complete.
*/
export async function approveRefund({ refundId, actorAdminId }) {
    if (!actorAdminId) {
        throw refundError('AUTH_REQUIRED', 'An authenticated admin is required to approve a refund.', 401);
    }

    return withTransaction(async client => {
        const locked = await client.query(
            `SELECT id, status FROM refunds WHERE id = $1 FOR UPDATE`,
            [refundId]
        );
        if (!locked.rows.length) {
            throw refundError('REFUND_NOT_FOUND', 'Refund not found.', 404);
        }
        if (locked.rows[0].status !== REFUND_STATUS.PENDING) {
            throw refundError('INVALID_TRANSITION', `Cannot approve a refund in status '${locked.rows[0].status}'.`, 409);
        }

        await client.query(
            `
            UPDATE refunds
            SET status = 'approved',
                approved_by_admin_id = $2,
                approved_at = NOW(),
                next_attempt_at = NOW()
            WHERE id = $1
            `,
            [refundId, actorAdminId]
        );

        await audit(client, actorAdminId, 'refund.approved', refundId, { from: 'pending', to: 'approved' });

        return { refundId, status: REFUND_STATUS.APPROVED };
    });
}

/*
|--------------------------------------------------------------------------
| Claiming (atomic, short transaction, no provider call)
|--------------------------------------------------------------------------
*/
async function claimRefund(refundId, phase) {
    const fromStatus = phase === 'submit' ? 'approved' : 'reconciliation_required';

    return withTransaction(async client => {
        const claimed = await client.query(
            `
            UPDATE refunds
            SET status = 'processing',
                claim_token = gen_random_uuid(),
                claimed_at = NOW(),
                attempt_count = attempt_count + 1
            WHERE id = $1
              AND status = $2
              AND attempt_count < max_attempts
              AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
            RETURNING *
            `,
            [refundId, fromStatus]
        );

        const row = claimed.rows[0];
        if (!row) {
            return null;
        }

        const payment = await client.query(
            `SELECT provider_order_id FROM payments WHERE id = $1`,
            [row.payment_id]
        );

        return { ...row, providerOrderId: payment.rows[0]?.provider_order_id || null };
    });
}

/*
|--------------------------------------------------------------------------
| Fenced finalisation: writes only if this worker still owns the claim
|--------------------------------------------------------------------------
*/
async function finalizeRefund(refundId, claimToken, {
    targetStatus,
    providerRefundId = null,
    lastError = null,
    nextAttemptAt = null,
    actorAdminId = null,
    phase,
}) {
    return withTransaction(async client => {
        const locked = await client.query(
            `SELECT status, claim_token, attempt_count, max_attempts
             FROM refunds WHERE id = $1 FOR UPDATE`,
            [refundId]
        );
        const row = locked.rows[0];

        if (!row || row.status !== REFUND_STATUS.PROCESSING || row.claim_token !== claimToken) {
            await audit(client, actorAdminId, 'refund.lease_lost', refundId, { phase, attemptedStatus: targetStatus });
            return { fenced: true, status: row?.status || null };
        }

        // Exhausted reconciliation attempts become manual review, never silent.
        let finalStatus = targetStatus;
        if (
            targetStatus === REFUND_STATUS.RECONCILIATION_REQUIRED &&
            row.attempt_count >= row.max_attempts
        ) {
            finalStatus = REFUND_STATUS.MANUAL_REVIEW;
        }

        // A provider reference already attached to ANOTHER local refund is an
        // integrity conflict. Never attach it twice; send this refund to review.
        let conflictingRefundId = null;
        if (providerRefundId) {
            const clash = await client.query(
                `SELECT id FROM refunds WHERE provider_refund_id = $1 AND id <> $2`,
                [providerRefundId, refundId]
            );
            conflictingRefundId = clash.rows[0]?.id || null;
        }

        if (conflictingRefundId) {
            finalStatus = REFUND_STATUS.MANUAL_REVIEW;
            lastError = `PROVIDER_REFUND_ID_CONFLICT with refund ${conflictingRefundId}`;
            providerRefundId = null;
        }

        const terminal = finalStatus === REFUND_STATUS.REFUNDED ||
            finalStatus === REFUND_STATUS.MANUAL_REVIEW ||
            finalStatus === REFUND_STATUS.FAILED;

        await client.query(
            `
            UPDATE refunds
            SET status = $2,
                provider_refund_id = COALESCE($3, provider_refund_id),
                last_error = $4,
                next_attempt_at = $5,
                claim_token = NULL,
                claimed_at = NULL,
                resolved_at = CASE WHEN $6 THEN NOW() ELSE NULL END
            WHERE id = $1
            `,
            [
                refundId,
                finalStatus,
                providerRefundId,
                lastError ? sanitiseMessage(lastError) : null,
                finalStatus === REFUND_STATUS.RECONCILIATION_REQUIRED ? nextAttemptAt : null,
                terminal,
            ]
        );

        await audit(client, actorAdminId, 'refund.transition', refundId, {
            phase,
            from: REFUND_STATUS.PROCESSING,
            to: finalStatus,
            providerRefundIdPresent: Boolean(providerRefundId),
        });

        return { fenced: false, status: finalStatus };
    });
}

function statusFromProviderResult(result) {
    if (result?.status === 'SUCCEEDED') return REFUND_STATUS.REFUNDED;
    if (result?.status === 'FAILED') return REFUND_STATUS.MANUAL_REVIEW;
    return REFUND_STATUS.RECONCILIATION_REQUIRED; // PENDING or unrecognised: keep reconciling
}

/*
|--------------------------------------------------------------------------
| Submission: approved -> processing -> (refunded | reconciliation | manual)
|--------------------------------------------------------------------------
*/
export async function processRefund({ refundId, provider = refundProvider }) {
    const item = await claimRefund(refundId, 'submit');
    if (!item) {
        return { outcome: 'not_claimed' };
    }

    const nextAttemptAt = () => new Date(Date.now() + computeBackoffMs(item.attempt_count));
    let targetStatus;
    let providerRefundId = null;
    let lastError = null;

    try {
        const result = await provider.createRefund({
            providerOrderId: item.providerOrderId,
            refundKey: item.idempotency_key,
            amount: Number(item.amount),
            currency: item.currency,
        });
        targetStatus = statusFromProviderResult(result);
        providerRefundId = result?.providerRefundId || null;
        lastError = targetStatus === REFUND_STATUS.RECONCILIATION_REQUIRED ? `provider status ${result?.status}` : null;
    } catch (error) {
        // Definitive rejection is permanent. Anything else may have reached the provider.
        targetStatus = error.definitive ? REFUND_STATUS.MANUAL_REVIEW : REFUND_STATUS.RECONCILIATION_REQUIRED;
        lastError = `${error.code || 'SUBMIT_ERROR'}: ${error.message}`;
    }

    const finalized = await finalizeRefund(refundId, item.claim_token, {
        targetStatus,
        providerRefundId,
        lastError,
        nextAttemptAt: nextAttemptAt(),
        phase: 'submit',
    });

    return finalized.fenced
        ? { outcome: 'lease_lost' }
        : { outcome: finalized.status };
}

/*
|--------------------------------------------------------------------------
| Reconciliation: never resubmits. Asks the provider what happened.
|--------------------------------------------------------------------------
*/
export async function reconcileRefund({ refundId, provider = refundProvider }) {
    const item = await claimRefund(refundId, 'reconcile');
    if (!item) {
        return { outcome: 'not_claimed' };
    }

    const nextAttemptAt = () => new Date(Date.now() + computeBackoffMs(item.attempt_count));
    let targetStatus;
    let providerRefundId = null;
    let lastError = null;

    try {
        const lookup = await provider.getRefund({
            providerOrderId: item.providerOrderId,
            refundKey: item.idempotency_key,
        });

        if (!lookup?.found) {
            // Not visible at the provider yet. Keep reconciling; never resubmit.
            targetStatus = REFUND_STATUS.RECONCILIATION_REQUIRED;
            lastError = 'provider has no record of this refund yet';
        } else {
            targetStatus = statusFromProviderResult(lookup);
            providerRefundId = lookup.providerRefundId || null;
            lastError = targetStatus === REFUND_STATUS.RECONCILIATION_REQUIRED ? `provider status ${lookup.status}` : null;
        }
    } catch (error) {
        targetStatus = error.definitive ? REFUND_STATUS.MANUAL_REVIEW : REFUND_STATUS.RECONCILIATION_REQUIRED;
        lastError = `${error.code || 'LOOKUP_ERROR'}: ${error.message}`;
    }

    const finalized = await finalizeRefund(refundId, item.claim_token, {
        targetStatus,
        providerRefundId,
        lastError,
        nextAttemptAt: nextAttemptAt(),
        phase: 'reconcile',
    });

    return finalized.fenced
        ? { outcome: 'lease_lost' }
        : { outcome: finalized.status };
}

/*
|--------------------------------------------------------------------------
| Worker maintenance
|--------------------------------------------------------------------------
| A 'processing' claim whose lease expired means the worker died during a
| provider call. Its outcome is unknown, so it moves to reconciliation.
| Reconciliation items with exhausted attempts move to manual review.
*/
export async function expireStaleRefundClaims() {
    return withTransaction(async client => {
        const stale = await client.query(
            `
            UPDATE refunds
            SET status = 'reconciliation_required',
                claim_token = NULL,
                claimed_at = NULL,
                next_attempt_at = NOW(),
                last_error = 'LEASE_EXPIRED_DURING_PROVIDER_CALL'
            WHERE status = 'processing'
              AND claimed_at < NOW() - ($1::int * INTERVAL '1 millisecond')
            RETURNING id
            `,
            [LEASE_MS]
        );

        for (const row of stale.rows) {
            await audit(client, null, 'refund.lease_expired', row.id, {
                from: 'processing',
                to: 'reconciliation_required',
            });
        }

        const exhausted = await client.query(
            `
            UPDATE refunds
            SET status = 'manual_review',
                resolved_at = NOW(),
                last_error = COALESCE(last_error, '') || ' [retries exhausted]'
            WHERE status = 'reconciliation_required'
              AND attempt_count >= max_attempts
            RETURNING id
            `
        );

        for (const row of exhausted.rows) {
            await audit(client, null, 'refund.transition', row.id, {
                from: 'reconciliation_required',
                to: 'manual_review',
                reason: 'retries_exhausted',
            });
        }

        return {
            leaseExpired: stale.rows.map(r => r.id),
            escalated: exhausted.rows.map(r => r.id),
        };
    });
}

/*
 * Due work only: approved refunds, and reconciliation items whose backoff ended.
 */
async function listDueRefunds(limit) {
    const res = await query(
        `
        SELECT id, status
        FROM refunds
        WHERE attempt_count < max_attempts
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
          AND status IN ('approved', 'reconciliation_required')
        ORDER BY next_attempt_at NULLS FIRST, created_at
        LIMIT $1
        `,
        [limit]
    );
    return res.rows;
}

/*
 * One sweep. Guarded by an advisory lock so only one instance sweeps at a
 * time. Item-level correctness still rests on the claim and fencing above.
 */
export async function runRefundSweep({ limit = 10, provider = refundProvider } = {}) {
    const client = await pool.connect();

    try {
        const locked = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [REFUND_SWEEP_LOCK_KEY]);
        if (!locked.rows[0].acquired) {
            return { skipped: true, results: [] };
        }

        try {
            const maintenance = await expireStaleRefundClaims();
            const results = [];

            for (const due of await listDueRefunds(limit)) {
                try {
                    const outcome = due.status === 'approved'
                        ? await processRefund({ refundId: due.id, provider })
                        : await reconcileRefund({ refundId: due.id, provider });
                    results.push({ refundId: due.id, ...outcome });
                } catch (error) {
                    // Item-level failure: record it and continue with the next refund.
                    console.error('[HIGH] Refund sweep item failed:', due.id, error.code || '', error.message);
                    results.push({ refundId: due.id, outcome: 'item_error' });
                }
            }

            return { skipped: false, maintenance, results };
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [REFUND_SWEEP_LOCK_KEY]);
        }
    } finally {
        client.release();
    }
}

/*
|--------------------------------------------------------------------------
| Late reconciliation from manual review (lookup only, never submits)
|--------------------------------------------------------------------------
| A refund that was escalated to manual review may still be completed by the
| provider. The retry budget controls escalation only. It never authorises a
| new submission. This path asks the provider what happened and can move the
| refund to refunded, but it never calls createRefund.
*/
async function claimForLateReconcile(refundId) {
    return withTransaction(async client => {
        const claimed = await client.query(
            `
            UPDATE refunds
            SET status = 'processing',
                claim_token = gen_random_uuid(),
                claimed_at = NOW(),
                attempt_count = attempt_count + 1
            WHERE id = $1
              AND status = 'manual_review'
            RETURNING *
            `,
            [refundId]
        );

        const row = claimed.rows[0];
        if (!row) {
            return null;
        }

        const payment = await client.query(
            `SELECT provider_order_id FROM payments WHERE id = $1`,
            [row.payment_id]
        );

        return { ...row, providerOrderId: payment.rows[0]?.provider_order_id || null };
    });
}

export async function reconcileManualReviewRefund({ refundId, provider = refundProvider, actorAdminId = null }) {
    const item = await claimForLateReconcile(refundId);
    if (!item) {
        return { outcome: 'not_claimed' };
    }

    let targetStatus = REFUND_STATUS.MANUAL_REVIEW;
    let providerRefundId = null;
    let lastError = null;

    try {
        const lookup = await provider.getRefund({
            providerOrderId: item.providerOrderId,
            refundKey: item.idempotency_key,
        });

        if (!lookup?.found) {
            lastError = 'late reconciliation: provider has no record of this refund';
        } else if (lookup.status === 'SUCCEEDED' || normalizedSucceeded(lookup)) {
            targetStatus = REFUND_STATUS.REFUNDED;
            providerRefundId = lookup.providerRefundId || null;
        } else {
            lastError = `late reconciliation: provider status ${lookup.status ?? 'unknown'}`;
            providerRefundId = lookup.providerRefundId || null;
        }
    } catch (error) {
        lastError = `late reconciliation lookup failed: ${error.code || 'LOOKUP_ERROR'}`;
    }

    // finalizeRefund writes a provider reference only if it is not already used.
    // It never sends the refund again.
    const finalized = await finalizeRefund(refundId, item.claim_token, {
        targetStatus,
        providerRefundId,
        lastError,
        actorAdminId,
        phase: 'late_reconcile',
    });

    return finalized.fenced ? { outcome: 'lease_lost' } : { outcome: finalized.status };
}

function normalizedSucceeded(lookup) {
    return statusFromProviderResult(lookup) === REFUND_STATUS.REFUNDED;
}
