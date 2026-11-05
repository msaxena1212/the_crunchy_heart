import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { getCashfreePayments } from './cashfree.service.js';
import { settlePaymentSuccess } from './payment.service.js';

/*
|--------------------------------------------------------------------------
| Settlement Retry for Durable Payment Reconciliation
|--------------------------------------------------------------------------
| Re-attempts settlement of a queued verified payment. The only settlement
| logic is settlePaymentSuccess(); this module adds claiming, provider
| re-verification, and atomic queue resolution.
|
| Transaction shape (never nested, never open during a network call):
|   1. claim   short transaction: pending/processing -> processing (lease)
|   2. verify  no transaction: provider payment identity re-checked
|   3. settle  one transaction: order/payment settlement + queue resolution
|              + audit row, all or nothing
|   4. fail    short transaction: retry schedule or manual-review state
|
| Lock order: orders -> payments -> payment_reconciliation_queue.
|--------------------------------------------------------------------------
*/

export const LEASE_MS = 5 * 60 * 1000;
export const BASE_BACKOFF_MS = 30 * 1000;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

// Terminal order states that must never be settled by a retry.
const TERMINAL_ORDER_STATUSES = new Set(['cancelled', 'refunded']);

// Errors that will not change on retry. They go to manual review.
const DETERMINISTIC_ERROR_CODES = new Set([
    'INVENTORY_RECONCILIATION_REQUIRED',
    'ORDER_TERMINAL_STATE',
    'PROVIDER_IDENTITY_MISMATCH',
]);

/*
 * Exponential backoff with bounded jitter: between half and the full capped
 * delay. `random` is injectable for deterministic tests.
 */
export function computeBackoffMs(attemptCount, random = Math.random) {
    const exponent = Math.max(0, attemptCount - 1);
    const capped = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent);
    return Math.round(capped / 2 + random() * (capped / 2));
}

/*
 * Default provider re-verification. Confirms that Cashfree still reports this
 * exact payment attempt as SUCCESS with the expected amount and currency.
 * Returns { verified: true } or { verified: false, reason, deterministic }.
 */
export async function verifyCashfreePaymentIdentity({
    providerOrderId,
    providerPaymentId,
    amount,
    currency,
}) {
    const payments = await getCashfreePayments(providerOrderId);
    const list = Array.isArray(payments) ? payments : [];

    const match = list.find(
        payment => String(payment?.cf_payment_id) === String(providerPaymentId)
    );

    if (!match) {
        return { verified: false, reason: 'PAYMENT_NOT_FOUND', deterministic: false };
    }

    if (match.payment_status !== 'SUCCESS') {
        return { verified: false, reason: 'PAYMENT_NOT_SUCCESS', deterministic: false };
    }

    const providerAmount = Number(match.payment_amount);
    const providerCurrency = String(match.payment_currency || '').toUpperCase();

    if (
        !Number.isFinite(providerAmount) ||
        Math.abs(providerAmount - Number(amount)) > 0.01 ||
        providerCurrency !== String(currency).toUpperCase()
    ) {
        return { verified: false, reason: 'PROVIDER_IDENTITY_MISMATCH', deterministic: true };
    }

    return { verified: true };
}

function sanitiseMessage(message) {
    return String(message || 'unknown error').replace(/\s+/g, ' ').slice(0, 500);
}

/*
 * Atomically claims one queue item. Returns the claimed row, or null when the
 * item is not eligible. Two concurrent callers cannot both receive the row
 * because the UPDATE re-checks status under the row lock.
 */
async function claimQueueItem(queueId, mode) {
    return withTransaction(async client => {
        const eligibleStatuses = mode === 'admin'
            ? ['pending', 'pending_admin']
            : ['pending'];

        const claimed = await client.query(
            `
            UPDATE payment_reconciliation_queue
            SET
                status = 'processing',
                attempt_count = attempt_count + 1,
                last_attempted_at = NOW(),
                claim_token = gen_random_uuid()
            WHERE id = $1
              AND ($4 = 'admin' OR attempt_count < max_attempts)
              AND (
                    (status = ANY($2::text[])
                        AND (next_retry_after IS NULL OR next_retry_after <= NOW()))
                 OR (status = 'processing'
                        AND last_attempted_at < NOW() - ($3::int * INTERVAL '1 millisecond'))
              )
            RETURNING *
            `,
            [queueId, eligibleStatuses, LEASE_MS, mode]
        );

        return claimed.rows[0] || null;
    });
}

// Maps a recorded failure to the caller-facing outcome.
function failureResult(result) {
    if (result.outcome === 'lease_lost') {
        return { outcome: 'lease_lost', nextRetryAt: null };
    }
    if (result.outcome === 'pending_admin') {
        return { outcome: 'manual_review', nextRetryAt: null };
    }
    if (result.outcome === 'failed') {
        return { outcome: 'failed', nextRetryAt: null };
    }
    return { outcome: 'retry_scheduled', nextRetryAt: result.nextRetryAt };
}

async function recordFailure(queueId, { claimToken, error, deterministic, actorAdminId, mode }) {
    return withTransaction(async client => {
        const current = await client.query(
            `SELECT id, attempt_count, max_attempts, order_id, claim_token
             FROM payment_reconciliation_queue WHERE id = $1 FOR UPDATE`,
            [queueId]
        );
        const row = current.rows[0];

        // Another worker now owns this item (our lease expired). Do not touch it.
        if (!row || row.claim_token !== claimToken) {
            return { outcome: 'lease_lost', nextRetryAt: null };
        }

        const message = sanitiseMessage(`${error.code || 'RETRY_ERROR'}: ${error.message}`);

        let nextStatus;
        let nextRetryAt = null;

        if (deterministic) {
            nextStatus = 'pending_admin';
        } else if (row.attempt_count >= row.max_attempts) {
            // Retries exhausted: visible to operators, never silently dropped.
            nextStatus = 'pending_admin';
        } else {
            nextStatus = 'pending';
            nextRetryAt = new Date(Date.now() + computeBackoffMs(row.attempt_count));
        }

        await client.query(
            `
            UPDATE payment_reconciliation_queue
            SET
                status = $2,
                next_retry_after = $3,
                last_error = $4,
                claim_token = NULL
            WHERE id = $1
            `,
            [queueId, nextStatus, nextRetryAt, message]
        );

        await client.query(
            `
            INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
            VALUES ($1, $2, 'payment_reconciliation_queue', $3, $4::jsonb)
            `,
            [
                actorAdminId,
                'reconciliation.settlement_attempt_failed',
                String(queueId),
                JSON.stringify({ mode, outcome: nextStatus, errorCode: error.code || 'RETRY_ERROR', orderId: row.order_id }),
            ]
        );

        return { outcome: nextStatus, nextRetryAt };
    });
}

/*
 * Retries settlement for one queue item.
 *   mode 'auto'  worker: only status 'pending' and due
 *   mode 'admin' operator: also 'pending_admin'; requires actorAdminId
 *
 * Returns { outcome } where outcome is one of:
 *   settled | already_settled | stock_shortage | not_claimed |
 *   retry_scheduled | manual_review | failed
 */
export async function retryPaymentReconciliation({
    queueId,
    mode = 'auto',
    actorAdminId = null,
    verifyProvider = verifyCashfreePaymentIdentity,
}) {
    if (!queueId) {
        throw new Error('queueId is required.');
    }

    if (mode === 'admin' && !actorAdminId) {
        const error = new Error('An admin actor is required for an admin retry.');
        error.statusCode = 400;
        throw error;
    }

    const item = await claimQueueItem(queueId, mode);

    if (!item) {
        return { outcome: 'not_claimed' };
    }

    // 2. Provider re-verification, outside any transaction.
    let verification;
    try {
        verification = await verifyProvider({
            providerOrderId: item.provider_order_id,
            providerPaymentId: item.provider_payment_id,
            amount: Number(item.verified_amount),
            currency: item.verified_currency,
        });
    } catch (error) {
        // Timeout or provider outage: ambiguous, so retry later. Never fail.
        const result = await recordFailure(queueId, {
            claimToken: item.claim_token,
            error: Object.assign(new Error(`Provider verification unavailable: ${error.message}`), { code: 'PROVIDER_UNAVAILABLE' }),
            deterministic: false,
            actorAdminId,
            mode,
        });
        return failureResult(result);
    }

    if (!verification?.verified) {
        const reason = verification?.reason || 'PROVIDER_NOT_VERIFIED';
        const result = await recordFailure(queueId, {
            claimToken: item.claim_token,
            error: Object.assign(new Error(`Provider verification not confirmed: ${reason}`), { code: reason }),
            deterministic: Boolean(verification?.deterministic),
            actorAdminId,
            mode,
        });
        return failureResult(result);
    }

    // 3. Settlement and queue resolution: one transaction.
    try {
        return await withTransaction(async client => {
            const orderLock = await client.query(
                `SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`,
                [item.order_id]
            );

            if (!orderLock.rows.length) {
                throw Object.assign(new Error('Order not found for reconciliation item.'), { code: 'ORDER_NOT_FOUND' });
            }

            if (TERMINAL_ORDER_STATUSES.has(orderLock.rows[0].status)) {
                throw Object.assign(
                    new Error(`Order is in terminal state '${orderLock.rows[0].status}'.`),
                    { code: 'ORDER_TERMINAL_STATE' }
                );
            }

            // Lock order: orders -> queue -> payments. Prove this worker still
            // holds the claim before any settlement. If the lease expired during
            // the provider call, another worker owns the item: roll back.
            const ownership = await client.query(
                `SELECT status, claim_token FROM payment_reconciliation_queue WHERE id = $1 FOR UPDATE`,
                [queueId]
            );

            if (
                !ownership.rows.length ||
                ownership.rows[0].status !== 'processing' ||
                ownership.rows[0].claim_token !== item.claim_token
            ) {
                throw Object.assign(new Error('Claim lease was lost before settlement.'), { code: 'LEASE_LOST' });
            }

            const settled = await settlePaymentSuccess(client, {
                providerOrderId: item.provider_order_id,
                providerPaymentId: item.provider_payment_id,
                paymentAmount: Number(item.verified_amount),
                paymentCurrency: item.verified_currency,
                rawResponse: null,
            });

            if (settled.stockShortage) {
                // Settlement committed the existing stock-shortage exception.
                // The queue item is not resolved; an operator must act.
                await client.query(
                    `
                    UPDATE payment_reconciliation_queue
                    SET status = 'pending_admin',
                        next_retry_after = NULL,
                        claim_token = NULL,
                        last_error = 'STOCK_SHORTAGE: settlement committed as stock exception'
                    WHERE id = $1
                    `,
                    [queueId]
                );

                await client.query(
                    `
                    INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
                    VALUES ($1, 'reconciliation.settlement_stock_shortage', 'payment_reconciliation_queue', $2, $3::jsonb)
                    `,
                    [actorAdminId, String(queueId), JSON.stringify({ mode, orderId: item.order_id })]
                );

                return { outcome: 'stock_shortage' };
            }

            const alreadySettled = Boolean(settled.alreadySettled || settled.duplicateSettlement);
            const resolutionAction = alreadySettled
                ? 'no_action_required'
                : mode === 'admin' ? 'admin_retry_settled' : 'auto_retry_settled';

            await client.query(
                `
                UPDATE payment_reconciliation_queue
                SET
                    status = 'resolved',
                    resolution_action = $2,
                    resolved_by_admin_id = $3,
                    resolution_note = $4,
                    resolved_at = NOW(),
                    next_retry_after = NULL,
                    last_error = NULL,
                    claim_token = NULL
                WHERE id = $1
                `,
                [
                    queueId,
                    resolutionAction,
                    mode === 'admin' ? actorAdminId : null,
                    alreadySettled
                        ? 'Order was already settled by another path; no inventory change made.'
                        : null,
                ]
            );

            await client.query(
                `
                INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
                VALUES ($1, $2, 'payment_reconciliation_queue', $3, $4::jsonb)
                `,
                [
                    actorAdminId,
                    'reconciliation.settled',
                    String(queueId),
                    JSON.stringify({ mode, resolutionAction, orderId: item.order_id, paymentId: item.payment_id }),
                ]
            );

            return { outcome: alreadySettled ? 'already_settled' : 'settled' };
        });
    } catch (error) {
        // The settlement transaction rolled back. Record the attempt outcome.
        // A lost lease means another worker owns the item: leave it alone.
        if (error.code === 'LEASE_LOST') {
            return { outcome: 'lease_lost' };
        }

        const deterministic = DETERMINISTIC_ERROR_CODES.has(error.code);
        const result = await recordFailure(queueId, {
            claimToken: item.claim_token,
            error,
            deterministic,
            actorAdminId,
            mode,
        });

        return failureResult(result);
    }
}

/*
 * Worker entry point: processes due pending items. Claims are atomic, so
 * several workers can run this safely at once.
 */
export async function processDueReconciliationItems({ limit = 10 } = {}) {
    const due = await withTransaction(async client => {
        const res = await client.query(
            `
            SELECT id
            FROM payment_reconciliation_queue
            WHERE attempt_count < max_attempts
              AND (
                    (status = 'pending'
                        AND (next_retry_after IS NULL OR next_retry_after <= NOW()))
                 OR (status = 'processing'
                        AND last_attempted_at < NOW() - ($2::int * INTERVAL '1 millisecond'))
              )
            ORDER BY next_retry_after NULLS FIRST, created_at
            LIMIT $1
            `,
            [limit, LEASE_MS]
        );
        return res.rows.map(row => row.id);
    });

    const results = [];
    for (const queueId of due) {
        results.push({ queueId, ...(await retryPaymentReconciliation({ queueId, mode: 'auto' })) });
    }
    return results;
}


/*
|--------------------------------------------------------------------------
| Scheduled Sweep (single active sweeper across instances)
|--------------------------------------------------------------------------
| A session-level PostgreSQL advisory lock lets only one application
| instance run a sweep at a time. Item claims remain atomic, so the lock is
| an efficiency guard, not the correctness guarantee. The lock is held on a
| dedicated connection and released in finally.
|--------------------------------------------------------------------------
*/
export const SWEEP_LOCK_KEY = 738412019;

export async function runReconciliationSweep({ limit = 10 } = {}) {
    const client = await pool.connect();

    try {
        const locked = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [SWEEP_LOCK_KEY]);

        if (!locked.rows[0].acquired) {
            return { skipped: true, reason: 'another_instance_sweeping', results: [] };
        }

        try {
            const results = await processDueReconciliationItems({ limit });
            return { skipped: false, results };
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]);
        }
    } finally {
        client.release();
    }
}

/*
 * Starts a recurring sweep. Errors are logged at high severity, never
 * swallowed, and the next tick still runs. Returns a stop function.
 */
export function startReconciliationScheduler({ intervalMs = 60 * 1000, limit = 10 } = {}) {
    let running = false;

    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const outcome = await runReconciliationSweep({ limit });
            if (!outcome.skipped && outcome.results.length) {
                console.log('Reconciliation sweep processed items:', outcome.results.length);
            }
        } catch (error) {
            console.error('[HIGH] Reconciliation sweep failed:', error.code || '', error.message);
        } finally {
            running = false;
        }
    };

    const handle = setInterval(tick, intervalMs);
    handle.unref?.();

    return () => clearInterval(handle);
}
