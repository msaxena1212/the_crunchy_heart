import { pool, query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { computeBackoffMs } from './payment-reconciliation-retry.service.js';

/*
|--------------------------------------------------------------------------
| Operational alerts for refunds
|--------------------------------------------------------------------------
| Raising an alert is a database write only. It never changes a refund or
| payment. Delivery is separate: a failed delivery is recorded, retried with
| backoff, and becomes 'undeliverable' after MAX_DELIVERY_ATTEMPTS. Nothing
| in this module calls a provider.
|
| Payloads are allowlisted. Provider payloads, idempotency keys, claim tokens,
| and secrets are never included. Error text is redacted before storage.
|--------------------------------------------------------------------------
*/

export const ALERT_SWEEP_LOCK_KEY = 738412021;
export const MAX_DELIVERY_ATTEMPTS = 10;
export const DEFAULT_PENDING_ALERT_MINUTES = 60;

const SECRET_WORD = /(secret|token|password|passwd|apikey|api_key|authorization|signature)[^\s,;]*/gi;
const LONG_DIGITS = /\b\d{9,}\b/g;

/*
 * Removes credential-like words and long digit runs (card, account, or
 * provider-looking numbers) from free text, then truncates it.
 */
export function redactErrorText(text) {
    return String(text || 'unknown error')
        .replace(SECRET_WORD, '[redacted]')
        .replace(LONG_DIGITS, '[redacted]')
        .replace(/\s+/g, ' ')
        .slice(0, 240);
}

function pendingThresholdMinutes(override) {
    const value = Number(override ?? process.env.REFUND_ALERT_PENDING_MINUTES ?? DEFAULT_PENDING_ALERT_MINUTES);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_PENDING_ALERT_MINUTES;
}

/*
 * Raises alerts for overdue pending refunds and refunds in manual review.
 * One alert per refund per condition, enforced by the unique alert_key.
 */
export async function raiseRefundAlerts({ pendingAfterMinutes } = {}) {
    const threshold = pendingThresholdMinutes(pendingAfterMinutes);

    return withTransaction(async client => {
        const pending = await client.query(
            `
            INSERT INTO operational_alerts (alert_key, alert_type, severity, entity_type, entity_id, payload)
            SELECT
                'refund_pending_overdue:' || r.id,
                'REFUND_PENDING_OVERDUE',
                'high',
                'refund',
                r.id::text,
                jsonb_build_object(
                    'refundId', r.id,
                    'orderId', r.order_id,
                    'status', r.status,
                    'ageMinutes', ROUND(EXTRACT(EPOCH FROM (NOW() - r.created_at)) / 60),
                    'attemptCount', r.attempt_count,
                    'maxAttempts', r.max_attempts,
                    'lastError', r.last_error
                )
            FROM refunds r
            WHERE r.status IN ('reconciliation_required', 'processing')
              AND r.created_at < NOW() - ($1::int * INTERVAL '1 minute')
            ON CONFLICT (alert_key) DO NOTHING
            RETURNING id
            `,
            [threshold]
        );

        const review = await client.query(
            `
            INSERT INTO operational_alerts (alert_key, alert_type, severity, entity_type, entity_id, payload)
            SELECT
                'refund_manual_review:' || r.id,
                'REFUND_MANUAL_REVIEW',
                'high',
                'refund',
                r.id::text,
                jsonb_build_object(
                    'refundId', r.id,
                    'orderId', r.order_id,
                    'status', r.status,
                    'ageMinutes', ROUND(EXTRACT(EPOCH FROM (NOW() - r.created_at)) / 60),
                    'attemptCount', r.attempt_count,
                    'maxAttempts', r.max_attempts,
                    'lastError', r.last_error
                )
            FROM refunds r
            WHERE r.status = 'manual_review'
            ON CONFLICT (alert_key) DO NOTHING
            RETURNING id
            `
        );

        // Redact stored error text in the payloads just written.
        const inserted = [...pending.rows, ...review.rows].map(r => r.id);
        for (const id of inserted) {
            const row = await client.query(`SELECT payload FROM operational_alerts WHERE id = $1`, [id]);
            const payload = row.rows[0].payload;
            if (payload.lastError) {
                payload.lastError = redactErrorText(payload.lastError);
                await client.query(`UPDATE operational_alerts SET payload = $2::jsonb WHERE id = $1`, [id, JSON.stringify(payload)]);
            }
        }

        return { raised: inserted.length, pendingAfterMinutes: threshold };
    });
}

/*
 * Default sender: a structured log line. External channels (email, chat, or a
 * paging service) need a deployment decision and are not configured here.
 */
export async function logAlertSender(alert) {
    console.error(`[ALERT] ${JSON.stringify({ type: alert.alert_type, severity: alert.severity, entityType: alert.entity_type, payload: alert.payload })}`);
}

/*
 * Delivers undelivered alerts. A failure is recorded and retried later. It never
 * touches refund state. Runs under an advisory lock so one instance delivers.
 */
export async function deliverOperationalAlerts({ sender = logAlertSender, limit = 20 } = {}) {
    const client = await pool.connect();

    try {
        const locked = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ALERT_SWEEP_LOCK_KEY]);
        if (!locked.rows[0].acquired) {
            return { skipped: true, delivered: 0, failed: 0 };
        }

        try {
            const due = await query(
                `
                SELECT id, alert_key, alert_type, severity, entity_type, entity_id, payload, attempt_count
                FROM operational_alerts
                WHERE delivery_status IN ('pending', 'failed')
                  AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
                ORDER BY created_at, id
                LIMIT $1
                `,
                [limit]
            );

            let delivered = 0;
            let failed = 0;

            for (const alert of due.rows) {
                try {
                    await sender(alert);
                    await query(
                        `UPDATE operational_alerts
                         SET delivery_status = 'delivered', delivered_at = NOW(), last_error = NULL, next_attempt_at = NULL
                         WHERE id = $1`,
                        [alert.id]
                    );
                    delivered += 1;
                } catch (error) {
                    failed += 1;
                    const attempts = alert.attempt_count + 1;
                    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
                    await query(
                        `UPDATE operational_alerts
                         SET delivery_status = $2,
                             attempt_count = $3,
                             last_error = $4,
                             next_attempt_at = $5
                         WHERE id = $1`,
                        [
                            alert.id,
                            exhausted ? 'undeliverable' : 'failed',
                            attempts,
                            redactErrorText(error.message),
                            exhausted ? null : new Date(Date.now() + computeBackoffMs(attempts)),
                        ]
                    );
                }
            }

            return { skipped: false, delivered, failed };
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [ALERT_SWEEP_LOCK_KEY]);
        }
    } finally {
        client.release();
    }
}

/*
 * Health counts for operators. Undeliverable alerts are never hidden.
 */
export async function alertHealth() {
    const res = await query(
        `SELECT delivery_status, COUNT(*)::int AS n FROM operational_alerts GROUP BY delivery_status`
    );
    const counts = Object.fromEntries(res.rows.map(r => [r.delivery_status, r.n]));
    return {
        pending: counts.pending || 0,
        failed: counts.failed || 0,
        undeliverable: counts.undeliverable || 0,
        delivered: counts.delivered || 0,
    };
}
