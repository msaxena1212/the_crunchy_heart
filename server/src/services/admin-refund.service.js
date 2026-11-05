import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { approveRefund, REFUND_STATUS } from './refund.service.js';
import { retryPaymentReconciliation } from './payment-reconciliation-retry.service.js';
import { reconcileManualReviewRefund } from './refund.service.js';

/*
|--------------------------------------------------------------------------
| Admin Refund & Reconciliation Operations
|--------------------------------------------------------------------------
| Read models return only sanitised columns. Raw provider payloads and
| secrets are never selected. Every write is server-enforced and audited.
| Identity always comes from the authenticated session, never the body.
|--------------------------------------------------------------------------
*/

export const MAX_PAGE_SIZE = 50;
export const REFUND_LIST_STATUSES = Object.freeze(Object.values(REFUND_STATUS));
export const QUEUE_LIST_STATUSES = Object.freeze(['pending', 'processing', 'pending_admin', 'resolved', 'skipped', 'failed']);
export const INCIDENT_TYPES = Object.freeze(['IDEMPOTENCY_CONFLICT', 'UNIDENTIFIED_PROVIDER_PAYMENT']);
export const MIN_NOTE_LENGTH = 10;

function adminError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

export function parsePaging({ page, limit } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(limit, 10) || 20));
    return { page: pageNum, limit: limitNum, offset: (pageNum - 1) * limitNum };
}

/*
 * The product has a single administrator role: the session token carries 'ADMIN'
 * (see utils/admin-token.js), and provisioning creates admins with role 'ADMIN'.
 * Writes therefore require an authenticated ADMIN session AND a currently active
 * admin_users row. The row is re-checked here because a session can outlive a
 * deactivation. Identity always comes from the session, never the request body.
 */
async function requireActiveAdmin(actor) {
    if (!actor?.id) {
        throw adminError('AUTH_REQUIRED', 'An authenticated admin is required.', 401);
    }
    if (String(actor.role || '').toUpperCase() !== 'ADMIN') {
        throw adminError('FORBIDDEN', 'Administrator access is required.', 403);
    }
    const row = await query(
        `SELECT id FROM admin_users WHERE id = $1 AND is_active = true`,
        [actor.id]
    );
    if (!row.rows.length) {
        throw adminError('FORBIDDEN', 'Administrator account is not active.', 403);
    }
}

function validateNote(note) {
    const text = String(note || '').trim();
    if (text.length < MIN_NOTE_LENGTH) {
        throw adminError('NOTE_REQUIRED', `A resolution note of at least ${MIN_NOTE_LENGTH} characters is required.`, 400);
    }
    return text.slice(0, 1000);
}

/*
|--------------------------------------------------------------------------
| Read models
|--------------------------------------------------------------------------
*/
export async function listRefundsAdmin({ status, page, limit } = {}) {
    if (status && !REFUND_LIST_STATUSES.includes(status)) {
        throw adminError('VALIDATION', 'Unknown refund status filter.', 400);
    }

    const paging = parsePaging({ page, limit });
    const params = [status || null, paging.limit, paging.offset];

    const rows = await query(
        `
        SELECT id, order_id, payment_id, amount, currency, origin, status,
               attempt_count, max_attempts, next_attempt_at, last_error,
               provider_refund_id, approved_at, resolved_at, created_at
        FROM refunds
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC, id
        LIMIT $2 OFFSET $3
        `,
        params
    );

    const total = await query(
        `SELECT COUNT(*)::int AS n FROM refunds WHERE ($1::text IS NULL OR status = $1)`,
        [status || null]
    );

    return { items: rows.rows, page: paging.page, limit: paging.limit, total: total.rows[0].n };
}

export async function getRefundAdmin(refundId) {
    const row = await query(
        `
        SELECT id, order_id, payment_id, amount, currency, origin, status, reason,
               attempt_count, max_attempts, next_attempt_at, last_error,
               provider_refund_id, approved_by_admin_id, approved_at, resolved_at,
               created_at, updated_at
        FROM refunds WHERE id = $1
        `,
        [refundId]
    );

    if (!row.rows.length) {
        throw adminError('REFUND_NOT_FOUND', 'Refund not found.', 404);
    }

    const history = await auditHistory('refund', refundId);
    return { refund: row.rows[0], history };
}

export async function listQueueAdmin({ status, page, limit } = {}) {
    if (status && !QUEUE_LIST_STATUSES.includes(status)) {
        throw adminError('VALIDATION', 'Unknown queue status filter.', 400);
    }

    const paging = parsePaging({ page, limit });
    const rows = await query(
        `
        SELECT id, order_id, payment_id, provider_order_id, provider_payment_id,
               verified_amount, verified_currency, status, event_type,
               attempt_count, max_attempts, next_retry_after, last_error,
               resolution_action, created_at, resolved_at
        FROM payment_reconciliation_queue
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC, id
        LIMIT $2 OFFSET $3
        `,
        [status || null, paging.limit, paging.offset]
    );
    const total = await query(
        `SELECT COUNT(*)::int AS n FROM payment_reconciliation_queue WHERE ($1::text IS NULL OR status = $1)`,
        [status || null]
    );

    return { items: rows.rows, page: paging.page, limit: paging.limit, total: total.rows[0].n };
}

/*
 * Incidents include UNIDENTIFIED_PROVIDER_PAYMENT rows, which have no queue row.
 */
export async function listIncidentsAdmin({ type, resolved = false, page, limit } = {}) {
    if (type && !INCIDENT_TYPES.includes(type)) {
        throw adminError('VALIDATION', 'Unknown incident type filter.', 400);
    }

    const paging = parsePaging({ page, limit });
    const where = `
        ($1::text IS NULL OR incident_type = $1)
        AND ($2::boolean IS TRUE AND resolved_at IS NOT NULL
             OR $2::boolean IS FALSE AND resolved_at IS NULL)`;

    const rows = await query(
        `
        SELECT id, incident_type, severity, order_id, queue_id, provider_order_id,
               provider_payment_id, incoming_details, existing_details,
               created_at, resolved_at
        FROM payment_reconciliation_incidents
        WHERE ${where}
        ORDER BY created_at DESC, id
        LIMIT $3 OFFSET $4
        `,
        [type || null, Boolean(resolved), paging.limit, paging.offset]
    );
    const total = await query(
        `SELECT COUNT(*)::int AS n FROM payment_reconciliation_incidents WHERE ${where}`,
        [type || null, Boolean(resolved)]
    );

    return { items: rows.rows, page: paging.page, limit: paging.limit, total: total.rows[0].n };
}

export async function auditHistory(entityType, entityId, { limit = MAX_PAGE_SIZE } = {}) {
    const res = await query(
        `
        SELECT id, admin_user_id, action, entity_type, entity_id, details, created_at
        FROM admin_audit_logs
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY created_at DESC, id
        LIMIT $3
        `,
        [entityType, String(entityId), Math.min(MAX_PAGE_SIZE, limit)]
    );
    return res.rows;
}

/*
|--------------------------------------------------------------------------
| Writes (owner only, audited, state-validated)
|--------------------------------------------------------------------------
*/
// Exported for read-only operational routes that need the same administrator check.
export async function assertActiveAdmin(actor) {
    await requireActiveAdmin(actor);
}

export async function approveRefundAdmin({ actor, refundId }) {
    await requireActiveAdmin(actor);
    return approveRefund({ refundId, actorAdminId: actor.id });
}

/*
 * Reconcile-now only moves a due-now marker. It never calls the provider
 * itself and never resubmits. The sweep performs the provider lookup.
 */
export async function requestReconcileRefundAdmin({ actor, refundId }) {
    await requireActiveAdmin(actor);

    return withTransaction(async client => {
        const locked = await client.query(`SELECT status FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
        if (!locked.rows.length) {
            throw adminError('REFUND_NOT_FOUND', 'Refund not found.', 404);
        }
        if (locked.rows[0].status !== 'reconciliation_required') {
            throw adminError('INVALID_TRANSITION', `Only reconciliation_required refunds can be reconciled (status is '${locked.rows[0].status}').`, 409);
        }

        await client.query(`UPDATE refunds SET next_attempt_at = NOW() WHERE id = $1`, [refundId]);
        await client.query(
            `INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
             VALUES ($1, 'refund.reconcile_requested', 'refund', $2, '{"from":"reconciliation_required"}'::jsonb)`,
            [actor.id, String(refundId)]
        );

        return { refundId, status: 'reconciliation_required', reconcileScheduled: true };
    });
}

/*
 * Lookup-only late reconciliation for a refund in manual review. The provider
 * is asked what happened. It is never asked to create a refund. Uses the
 * fail-closed default provider unless one is wired in.
 */
export async function lateReconcileRefundAdmin({ actor, refundId }) {
    await requireActiveAdmin(actor);

    const row = await query(`SELECT status FROM refunds WHERE id = $1`, [refundId]);
    if (!row.rows.length) {
        throw adminError('REFUND_NOT_FOUND', 'Refund not found.', 404);
    }
    if (row.rows[0].status !== 'manual_review') {
        throw adminError('INVALID_TRANSITION', `Late reconciliation applies only to manual_review refunds (status is '${row.rows[0].status}').`, 409);
    }

    await query(
        `INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'refund.late_reconcile_requested', 'refund', $2, '{"from":"manual_review"}'::jsonb)`,
        [actor.id, String(refundId)]
    );

    return reconcileManualReviewRefund({ refundId, actorAdminId: actor.id });
}

export async function retryQueueItemAdmin({ actor, queueId }) {
    await requireActiveAdmin(actor);

    const row = await query(`SELECT id FROM payment_reconciliation_queue WHERE id = $1`, [queueId]);
    if (!row.rows.length) {
        throw adminError('QUEUE_ITEM_NOT_FOUND', 'Reconciliation item not found.', 404);
    }

    return retryPaymentReconciliation({ queueId, mode: 'admin', actorAdminId: actor.id });
}

export async function resolveIncidentAdmin({ actor, incidentId, note }) {
    await requireActiveAdmin(actor);
    const text = validateNote(note);

    return withTransaction(async client => {
        const locked = await client.query(
            `SELECT id, incident_type, resolved_at FROM payment_reconciliation_incidents WHERE id = $1 FOR UPDATE`,
            [incidentId]
        );
        if (!locked.rows.length) {
            throw adminError('INCIDENT_NOT_FOUND', 'Incident not found.', 404);
        }
        if (locked.rows[0].resolved_at) {
            throw adminError('INVALID_TRANSITION', 'Incident is already resolved.', 409);
        }

        // Resolving an incident records a human decision. It never settles or refunds.
        await client.query(
            `UPDATE payment_reconciliation_incidents SET resolved_at = NOW() WHERE id = $1`,
            [incidentId]
        );
        await client.query(
            `INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
             VALUES ($1, 'reconciliation.incident_resolved', 'payment_reconciliation_incident', $2, $3::jsonb)`,
            [actor.id, String(incidentId), JSON.stringify({ incidentType: locked.rows[0].incident_type, note: text })]
        );

        return { incidentId, resolved: true };
    });
}
