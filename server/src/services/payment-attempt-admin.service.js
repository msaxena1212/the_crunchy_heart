import { query } from '../db/pool.js';
import { getCashfreeOrder } from './cashfree.service.js';
import { reconcilePaymentAttempt } from './reconciliation.service.js';
import { assertActiveAdmin } from './admin-refund.service.js';
import { summarizeAttempts } from './payment-creation.service.js';

/*
|--------------------------------------------------------------------------
| Operator resolution of unresolved payment attempts
|--------------------------------------------------------------------------
| Attempts reach this queue when the outcome of a provider create is unknown (ambiguous),
| or when a row predates the durable create lifecycle (legacy CASHFREE_PENDING without a
| provider id). Every action here is:
|   - restricted to an active ADMIN (assertActiveAdmin);
|   - a state-checked transition, written with a conditional UPDATE;
|   - recorded in admin_audit_logs with the actor and the outcome.
|
| Rules:
|   - An inconclusive lookup (404, or a result with no payment session) is never treated as
|     proof that no provider order exists. It changes nothing.
|   - No action creates a provider order. Retries are the only way to create one, and
|     retries stay refused while an attempt is unresolved.
|   - No action marks an order paid or refunded from an operator's word. Payment is
|     recorded only through reconcilePaymentAttempt, which checks provider payment evidence.
|   - Closing an attempt as not submitted is allowed only after a fresh lookup returns 404
|     and the operator attests, in the provider dashboard, that the order is absent. The
|     attestation and its note are stored in the audit log.
|
| Responses carry identifiers and statuses only. Raw provider payloads, sessions, tokens,
| and secrets are never returned.
|--------------------------------------------------------------------------
*/

export const OPERATOR_ACTION = Object.freeze({
    RESOLVED_BY_LOOKUP: 'payment_attempt.resolved_by_lookup',
    LOOKUP_INCONCLUSIVE: 'payment_attempt.lookup_inconclusive',
    RECONCILED: 'payment_attempt.reconciled',
    CLOSED_NOT_SUBMITTED: 'payment_attempt.closed_not_submitted',
});

export const ABSENCE_CONFIRMATION = 'ABSENT_IN_PROVIDER_DASHBOARD';

const REVIEWABLE_GATEWAY_STATES = ['ATTEMPT_INITIATED', 'GATEWAY_AMBIGUOUS_TIMEOUT'];
const CLOSABLE_GATEWAY_STATES = ['GATEWAY_AMBIGUOUS_TIMEOUT', 'CASHFREE_PENDING'];
const LOOKUP_RESOLVABLE_STATES = ['ATTEMPT_INITIATED', 'GATEWAY_AMBIGUOUS_TIMEOUT', 'CASHFREE_PENDING'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function opError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

function assertPaymentId(paymentId) {
    if (!UUID_PATTERN.test(String(paymentId || ''))) {
        throw opError('INVALID_PAYMENT_ID', 'A valid payment attempt id is required.', 400);
    }
}

async function loadAttempt(paymentId) {
    const result = await query(
        `SELECT p.id, p.order_id, p.provider, p.provider_order_id, p.status, p.gateway_status,
                p.created_at, p.updated_at, o.order_number
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.id = $1`,
        [paymentId]
    );
    if (!result.rows.length) {
        throw opError('ATTEMPT_NOT_FOUND', 'Payment attempt not found.', 404);
    }
    return result.rows[0];
}

// The provider id to look up. Legacy rows have none, so the merchant order_id (order number) is used.
const lookupKeyOf = attempt => attempt.provider_order_id || attempt.order_number;

/*
 * Read-only list of attempts that need an operator, and orders with conflicting live sessions.
 */
export async function listAttemptsForReview({ actor, limit = 50 }) {
    await assertActiveAdmin(actor);
    const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const attempts = await query(
        `SELECT p.id AS payment_id, o.order_number, p.provider_order_id, p.gateway_status, p.status,
                p.created_at, p.updated_at
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.gateway_status = ANY($1::text[])
            OR (p.gateway_status = 'CASHFREE_PENDING' AND p.provider_order_id IS NULL)
         ORDER BY p.created_at ASC
         LIMIT $2`,
        [REVIEWABLE_GATEWAY_STATES.concat(['CASHFREE_PENDING']), cappedLimit]
    );

    const conflicts = await query(
        `SELECT o.order_number, COUNT(*)::int AS live_sessions
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.gateway_status = 'ORDER_CREATED'
           AND (p.raw_response->>'payment_session_id') IS NOT NULL
           AND p.status <> 'paid'
         GROUP BY o.order_number
         HAVING COUNT(*) > 1
         ORDER BY o.order_number
         LIMIT $1`,
        [cappedLimit]
    );

    return {
        attempts: attempts.rows.map(row => ({
            paymentId: row.payment_id,
            orderNumber: row.order_number,
            providerOrderId: row.provider_order_id,
            gatewayStatus: row.gateway_status,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            legacyUnbound: row.gateway_status === 'CASHFREE_PENDING' && !row.provider_order_id,
        })),
        conflicts: conflicts.rows.map(row => ({ orderNumber: row.order_number, liveSessions: row.live_sessions })),
    };
}

/*
 * Lookup-only resolution. Attaches a session only when the provider returns the same order with
 * one. It never creates an order and never marks payment.
 */
export async function resolveAttemptByLookup({ actor, paymentId }) {
    await assertActiveAdmin(actor);
    assertPaymentId(paymentId);
    const attempt = await loadAttempt(paymentId);

    if (!LOOKUP_RESOLVABLE_STATES.includes(attempt.gateway_status)) {
        throw opError('INVALID_TRANSITION', `Attempt is '${attempt.gateway_status}' and cannot be resolved by lookup.`, 409);
    }

    const lookupKey = lookupKeyOf(attempt);
    let providerOrder = null;
    let reason = null;
    try {
        providerOrder = await getCashfreeOrder(lookupKey);
    } catch (error) {
        reason = error.statusCode === 404 ? 'PROVIDER_ORDER_NOT_FOUND' : 'LOOKUP_FAILED';
    }

    if (providerOrder && providerOrder.order_id !== lookupKey) {
        reason = 'LOOKUP_MISMATCH';
    } else if (providerOrder && !reason) {
        const sessionId = providerOrder.payment_session_id;
        if (!sessionId || typeof sessionId !== 'string') {
            reason = 'NO_RESUMABLE_SESSION';
        }
    }

    if (reason) {
        await withAudit(actor, OPERATOR_ACTION.LOOKUP_INCONCLUSIVE, paymentId, { reason, state: attempt.gateway_status });
        return { paymentId, outcome: 'INCONCLUSIVE', reason, changed: false };
    }

    if (providerOrder.order_status === 'PAID') {
        // Payment is recorded only by reconciliation, which checks payment evidence.
        await withAudit(actor, OPERATOR_ACTION.LOOKUP_INCONCLUSIVE, paymentId, { reason: 'PROVIDER_REPORTS_PAID', state: attempt.gateway_status });
        return { paymentId, outcome: 'RUN_RECONCILE', reason: 'PROVIDER_REPORTS_PAID', changed: false };
    }

    const sessionId = providerOrder.payment_session_id;
    const expectedState = attempt.gateway_status;
    const updated = await query(
        `UPDATE payments
         SET provider = 'cashfree',
             provider_order_id = $2,
             gateway_status = 'ORDER_CREATED',
             status = 'created',
             raw_response = $3::jsonb,
             updated_at = NOW()
         WHERE id = $1
           AND gateway_status = $4
           AND (provider_order_id IS NULL OR provider_order_id = $2)
           AND (raw_response->>'payment_session_id') IS NULL
         RETURNING id`,
        [paymentId, lookupKey, JSON.stringify(providerOrder), expectedState]
    );

    if (!updated.rows.length) {
        throw opError('STATE_CHANGED', 'The attempt changed while it was being resolved. Refresh and try again.', 409);
    }

    await withAudit(actor, OPERATOR_ACTION.RESOLVED_BY_LOOKUP, paymentId, { from: expectedState, to: 'ORDER_CREATED' });
    return { paymentId, outcome: 'ORDER_CREATED', changed: true, sessionAttached: Boolean(sessionId) };
}

/*
 * Runs the verified reconciliation for one attempt. Payment is recorded only from provider
 * payment evidence, inside reconcilePaymentAttempt.
 */
export async function reconcileAttempt({ actor, paymentId }) {
    await assertActiveAdmin(actor);
    assertPaymentId(paymentId);
    const attempt = await loadAttempt(paymentId);
    const providerOrderId = attempt.provider_order_id || attempt.order_number;

    const result = await reconcilePaymentAttempt({ providerOrderId });
    await withAudit(actor, OPERATOR_ACTION.RECONCILED, paymentId, {
        action: result.action || null,
        reason: result.reason || null,
        reconciled: Boolean(result.reconciled),
    });

    return {
        paymentId,
        action: result.action || null,
        reason: result.reason || null,
        reconciled: Boolean(result.reconciled),
        status: result.status || null,
        gatewayStatus: result.gatewayStatus || null,
    };
}

/*
 * Closes an attempt as not submitted. Requires a fresh 404 from the provider and the operator's
 * attestation. The attestation and note are stored in the audit log.
 */
export async function closeAttemptNotSubmitted({ actor, paymentId, confirmation, note }) {
    await assertActiveAdmin(actor);
    assertPaymentId(paymentId);

    if (confirmation !== ABSENCE_CONFIRMATION) {
        throw opError('CONFIRMATION_REQUIRED', `Confirmation '${ABSENCE_CONFIRMATION}' is required after checking the provider dashboard.`, 400);
    }
    const trimmedNote = String(note || '').trim();
    if (trimmedNote.length < 10 || trimmedNote.length > 500) {
        throw opError('NOTE_REQUIRED', 'A note of 10 to 500 characters describing the dashboard check is required.', 400);
    }

    const attempt = await loadAttempt(paymentId);
    if (!CLOSABLE_GATEWAY_STATES.includes(attempt.gateway_status)) {
        throw opError('INVALID_TRANSITION', `Attempt is '${attempt.gateway_status}' and cannot be closed.`, 409);
    }

    // Re-check the provider now. A found order means the attempt must be resolved, not closed.
    const lookupKey = lookupKeyOf(attempt);
    try {
        await getCashfreeOrder(lookupKey);
        throw opError('PROVIDER_ORDER_EXISTS', 'The provider holds this order. Resolve it by lookup instead of closing it.', 409);
    } catch (error) {
        if (error.code === 'PROVIDER_ORDER_EXISTS') throw error;
        if (error.statusCode !== 404) {
            throw opError('LOOKUP_INCONCLUSIVE', 'The provider lookup was inconclusive, so the attempt was not closed.', 409);
        }
    }

    const expectedState = attempt.gateway_status;
    const updated = await query(
        `UPDATE payments
         SET gateway_status = 'CREATE_NOT_SUBMITTED',
             status = 'failed',
             updated_at = NOW()
         WHERE id = $1
           AND gateway_status = $2
           AND (raw_response->>'payment_session_id') IS NULL
         RETURNING id`,
        [paymentId, expectedState]
    );

    if (!updated.rows.length) {
        throw opError('STATE_CHANGED', 'The attempt changed while it was being closed. Refresh and try again.', 409);
    }

    await withAudit(actor, OPERATOR_ACTION.CLOSED_NOT_SUBMITTED, paymentId, {
        from: expectedState,
        to: 'CREATE_NOT_SUBMITTED',
        providerCheck: 'NOT_FOUND',
        attestation: ABSENCE_CONFIRMATION,
        note: trimmedNote,
    });

    return { paymentId, outcome: 'CREATE_NOT_SUBMITTED', changed: true };
}

/*
 * Read-only overview: recent online orders with the authoritative payment state of each, derived
 * by the same rules as checkout (summarizeAttempts). Optionally filtered by state. Attempts carry
 * identifiers and statuses only.
 */
export async function listOrderPaymentStates({ actor, state, limit = 50 }) {
    await assertActiveAdmin(actor);
    const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const orders = await query(
        `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.total_amount, o.created_at
         FROM orders o
         WHERE o.payment_method = 'ONLINE'
           AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
         ORDER BY o.created_at DESC
         LIMIT $1`,
        [cappedLimit]
    );

    const attemptRows = await query(
        `SELECT p.id, p.order_id, p.provider_order_id, p.status, p.gateway_status, p.raw_response, p.created_at
         FROM payments p
         WHERE p.order_id = ANY($1::uuid[])
         ORDER BY p.created_at ASC`,
        [orders.rows.map(o => o.id)]
    );

    const byOrder = new Map();
    for (const row of attemptRows.rows) {
        if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
        byOrder.get(row.order_id).push(row);
    }

    const wanted = state ? String(state).toUpperCase() : null;
    const items = orders.rows.map(order => {
        const rows = byOrder.get(order.id) || [];
        const summary = summarizeAttempts(rows);
        return {
            orderNumber: order.order_number,
            orderStatus: order.status,
            paymentStatus: order.payment_status,
            totalAmount: Number(order.total_amount),
            createdAt: order.created_at,
            paymentState: summary.state,
            reasons: summary.reasons,
            attempts: rows.map(row => ({
                paymentId: row.id,
                providerOrderId: row.provider_order_id,
                gatewayStatus: row.gateway_status,
                status: row.status,
                hasSession: Boolean(row.raw_response?.payment_session_id),
                createdAt: row.created_at,
                legacyUnbound: row.gateway_status === 'CASHFREE_PENDING' && !row.provider_order_id,
            })),
        };
    });

    return { orders: wanted ? items.filter(item => item.paymentState === wanted) : items };
}

// Audit is written outside a transaction here, because the state change is already committed.
async function withAudit(actor, action, paymentId, details) {
    await query(
        `INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'payment_attempt', $3, $4::jsonb)`,
        [actor.id, action, String(paymentId), JSON.stringify(details || {})]
    );
}
