/**
 * The Crunchy Heart - Refund operational alerts
 *
 * Verifies deduplicated alert raising, threshold behaviour, delivery success,
 * delivery failure with retry, exhaustion to 'undeliverable', redaction, the
 * allowlisted payload, lock contention, and that alerting never changes refund
 * state or calls a provider.
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DB_URL =
    process.env.TEST_DATABASE_URL ||
    'postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test';

if (
    TEST_DB_URL.includes('neon.tech') ||
    TEST_DB_URL.includes('aws.neon.tech') ||
    TEST_DB_URL.includes('ep-solitary-block')
) {
    throw new Error('FATAL SAFETY VIOLATION: Test suite attempted to run against live Neon database! Aborting immediately.');
}

if (!TEST_DB_URL.includes('crunchy_heart_test')) {
    throw new Error(`FATAL SAFETY VIOLATION: Test suite must strictly run against 'crunchy_heart_test'. Provided: ${TEST_DB_URL}`);
}

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DATABASE_URL_UNPOOLED = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.CASHFREE_CLIENT_ID = 'TEST_OPS_ALERT_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_OPS_ALERT_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const { query, pool } = await import('../src/db/pool.js');
const { createRefundIntent } = await import('../src/services/refund.service.js');
const {
    raiseRefundAlerts,
    deliverOperationalAlerts,
    alertHealth,
    redactErrorText,
    ALERT_SWEEP_LOCK_KEY,
    MAX_DELIVERY_ATTEMPTS,
} = await import('../src/services/ops-alert.service.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const fixtureOrderIds = [];
const fixtureRefundIds = [];

async function createRefund() {
    const orderRes = await query(
        `INSERT INTO orders (order_number, customer_name, phone, shipping_address,
                             subtotal, total_amount, currency, status, payment_status)
         VALUES ($1, 'Alert Customer', '9876543210', '{"city":"Mumbai"}'::jsonb,
                 100, 100, 'INR', 'confirmed', 'paid') RETURNING id`,
        [`ALERT-ORD-${rand()}`]
    );
    const orderId = orderRes.rows[0].id;
    fixtureOrderIds.push(orderId);

    const paymentRes = await query(
        `INSERT INTO payments (order_id, provider, provider_order_id, provider_payment_id, amount, currency, status)
         VALUES ($1, 'cashfree', $2, $3, 100, 'INR', 'paid') RETURNING id`,
        [orderId, `TCH-ALERT-${rand()}`, `CF-ALERT-${rand()}`]
    );

    const created = await createRefundIntent({
        orderId,
        paymentId: paymentRes.rows[0].id,
        amount: 40,
        currency: 'INR',
        reason: 'alert test',
        origin: 'operator',
        idempotencyKey: `refund:alert:${rand()}`,
    });
    fixtureRefundIds.push(created.refundId);
    return created.refundId;
}

async function alertsFor(refundId) {
    return (await query(
        `SELECT * FROM operational_alerts WHERE entity_type = 'refund' AND entity_id = $1 ORDER BY created_at`,
        [String(refundId)]
    )).rows;
}

async function refundRow(id) {
    return (await query(`SELECT * FROM refunds WHERE id = $1`, [id])).rows[0];
}

function collectingSender(sink) {
    return async alert => { sink.push(alert); };
}

describe('Refund operational alerts', () => {
    before(async () => {
        // Clear alert rows from earlier runs so counts here are deterministic.
        await query(`DELETE FROM operational_alerts WHERE entity_type = 'refund'`);
    });

    after(async () => {
        for (const refundId of fixtureRefundIds) {
            await query(`DELETE FROM operational_alerts WHERE entity_id = $1`, [String(refundId)]);
        }
        for (const orderId of fixtureOrderIds) {
            await query(`DELETE FROM refunds WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM payments WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM orders WHERE id = $1`, [orderId]);
        }
    });

    test('1. An overdue pending refund raises exactly one alert, however many times alerts are raised', async () => {
        const refundId = await createRefund();
        await query(
            `UPDATE refunds SET status = 'reconciliation_required', created_at = NOW() - INTERVAL '3 hours' WHERE id = $1`,
            [refundId]
        );

        await raiseRefundAlerts({ pendingAfterMinutes: 60 });
        await raiseRefundAlerts({ pendingAfterMinutes: 60 });

        const rows = await alertsFor(refundId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].alert_type, 'REFUND_PENDING_OVERDUE');
        assert.equal(rows[0].alert_key, `refund_pending_overdue:${refundId}`);
    });

    test('2. A recent pending refund is below the threshold and raises no alert', async () => {
        const refundId = await createRefund();
        await query(`UPDATE refunds SET status = 'reconciliation_required' WHERE id = $1`, [refundId]);

        await raiseRefundAlerts({ pendingAfterMinutes: 60 });

        assert.equal((await alertsFor(refundId)).length, 0);
    });

    test('3. A refund in manual review raises a manual-review alert once', async () => {
        const refundId = await createRefund();
        await query(`UPDATE refunds SET status = 'manual_review', resolved_at = NOW() WHERE id = $1`, [refundId]);

        await raiseRefundAlerts();
        await raiseRefundAlerts();

        const rows = await alertsFor(refundId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].alert_type, 'REFUND_MANUAL_REVIEW');
    });

    test('4. Successful delivery marks the alert delivered and never changes refund state', async () => {
        const refundId = await createRefund();
        await query(`UPDATE refunds SET status = 'manual_review', resolved_at = NOW() WHERE id = $1`, [refundId]);
        await raiseRefundAlerts();

        const sent = [];
        await deliverOperationalAlerts({ sender: collectingSender(sent) });

        const mine = sent.filter(a => a.entity_id === String(refundId));
        assert.equal(mine.length, 1);
        const row = (await alertsFor(refundId))[0];
        assert.equal(row.delivery_status, 'delivered');
        assert.ok(row.delivered_at);
        assert.equal((await refundRow(refundId)).status, 'manual_review');

        // A delivered alert is not sent again.
        const again = [];
        await deliverOperationalAlerts({ sender: collectingSender(again) });
        assert.equal(again.filter(a => a.entity_id === String(refundId)).length, 0);
    });

    test('5. Delivery failure is recorded, retried later, and never changes refund state', async () => {
        const refundId = await createRefund();
        await query(`UPDATE refunds SET status = 'manual_review', resolved_at = NOW() WHERE id = $1`, [refundId]);
        await raiseRefundAlerts();

        await deliverOperationalAlerts({
            sender: async () => { throw new Error('channel unavailable'); },
        });

        let row = (await alertsFor(refundId))[0];
        assert.equal(row.delivery_status, 'failed');
        assert.equal(row.attempt_count, 1);
        assert.match(row.last_error, /channel unavailable/);
        assert.ok(new Date(row.next_attempt_at).getTime() > Date.now());
        assert.equal((await refundRow(refundId)).status, 'manual_review');

        // Due again: a working channel delivers it.
        await query(`UPDATE operational_alerts SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [row.id]);
        const sent = [];
        await deliverOperationalAlerts({ sender: collectingSender(sent) });

        row = (await alertsFor(refundId))[0];
        assert.equal(row.delivery_status, 'delivered');
        assert.equal(sent.filter(a => a.entity_id === String(refundId)).length, 1);
    });

    test('6. Exhausted delivery attempts become undeliverable and stop being retried', async () => {
        const refundId = await createRefund();
        await query(`UPDATE refunds SET status = 'manual_review', resolved_at = NOW() WHERE id = $1`, [refundId]);
        await raiseRefundAlerts();
        const row = (await alertsFor(refundId))[0];
        await query(
            `UPDATE operational_alerts SET attempt_count = $2, next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
            [row.id, MAX_DELIVERY_ATTEMPTS - 1]
        );

        await deliverOperationalAlerts({ sender: async () => { throw new Error('still down'); } });

        const after = (await alertsFor(refundId))[0];
        assert.equal(after.delivery_status, 'undeliverable');
        assert.equal(after.next_attempt_at, null);
        assert.equal((await refundRow(refundId)).status, 'manual_review');

        const health = await alertHealth();
        assert.ok(health.undeliverable >= 1);
    });

    test('7. Payloads are allowlisted and error text is redacted before storage and delivery', async () => {
        const refundId = await createRefund();
        await query(
            `UPDATE refunds SET status = 'manual_review', resolved_at = NOW(),
                 last_error = 'card 4111111111111111 token=abc123SECRET rejected' WHERE id = $1`,
            [refundId]
        );
        await raiseRefundAlerts();

        const sent = [];
        await deliverOperationalAlerts({ sender: collectingSender(sent) });
        const alert = sent.find(a => a.entity_id === String(refundId));

        const payloadKeys = Object.keys(alert.payload).sort();
        assert.deepEqual(payloadKeys, ['ageMinutes', 'attemptCount', 'lastError', 'maxAttempts', 'orderId', 'refundId', 'status']);

        const text = JSON.stringify(alert.payload);
        assert.doesNotMatch(text, /4111111111111111/);
        assert.doesNotMatch(text, /abc123SECRET/);
        assert.match(text, /\[redacted\]/);

        // No idempotency key, provider identifiers, or claim token in the payload.
        assert.doesNotMatch(text, /idempotency|provider|claim/i);
    });

    test('8. Redaction helper strips credential words and long digit runs', () => {
        const out = redactErrorText('password=hunter2 card 4111111111111111 ok');
        assert.doesNotMatch(out, /hunter2/);
        assert.doesNotMatch(out, /4111111111111111/);
        assert.equal(redactErrorText(undefined), 'unknown error');
        assert.ok(redactErrorText('x'.repeat(1000)).length <= 240);
    });

    test('9. A second deliverer is skipped while another instance holds the alert lock', async () => {
        const holder = await pool.connect();
        try {
            const held = await holder.query('SELECT pg_try_advisory_lock($1) AS ok', [ALERT_SWEEP_LOCK_KEY]);
            assert.equal(held.rows[0].ok, true);

            const skipped = await deliverOperationalAlerts({ sender: async () => {} });
            assert.equal(skipped.skipped, true);
        } finally {
            await holder.query('SELECT pg_advisory_unlock($1)', [ALERT_SWEEP_LOCK_KEY]);
            holder.release();
        }
    });
});
