/**
 * The Crunchy Heart - Email delivery for operational alerts
 *
 * Every transport is a mock. No real email is sent. Verifies configuration
 * validation without exposing secret values, allowlisted and redacted message
 * content, acceptance-based success, failure classification, retry through the
 * existing lifecycle, exhaustion to 'undeliverable', duplicate prevention, and
 * that delivery never changes refund state.
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 */

import { test, describe, after } from 'node:test';
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
process.env.CASHFREE_CLIENT_ID = 'TEST_EMAIL_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_EMAIL_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const { query, pool } = await import('../src/db/pool.js');
const { createRefundIntent } = await import('../src/services/refund.service.js');
const { raiseRefundAlerts, deliverOperationalAlerts, MAX_DELIVERY_ATTEMPTS } = await import('../src/services/ops-alert.service.js');
const {
    readEmailConfig,
    buildAlertEmail,
    createEmailAlertSender,
    emailHealth,
} = await import('../src/services/ops-alert-email.service.js');

const SECRET_PASSWORD = 'TOP-SECRET-SMTP-PASSWORD-DO-NOT-LEAK';
const goodEnv = {
    OPS_ALERT_EMAIL_PROVIDER: 'smtp',
    OPS_ALERT_EMAIL_FROM: 'alerts@example.test',
    OPS_ALERT_EMAIL_TO: 'ops@example.test, oncall@example.test',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_USER: 'alerts-user',
    SMTP_PASSWORD: SECRET_PASSWORD,
};

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const fixtureOrderIds = [];
const fixtureRefundIds = [];

async function manualReviewRefund({ lastError = null } = {}) {
    const orderRes = await query(
        `INSERT INTO orders (order_number, customer_name, phone, shipping_address,
                             subtotal, total_amount, currency, status, payment_status)
         VALUES ($1, 'Email Customer', '9876543210', '{"city":"Mumbai"}'::jsonb,
                 100, 100, 'INR', 'confirmed', 'paid') RETURNING id`,
        [`EMAIL-ORD-${rand()}`]
    );
    const orderId = orderRes.rows[0].id;
    fixtureOrderIds.push(orderId);

    const paymentRes = await query(
        `INSERT INTO payments (order_id, provider, provider_order_id, provider_payment_id, amount, currency, status)
         VALUES ($1, 'cashfree', $2, $3, 100, 'INR', 'paid') RETURNING id`,
        [orderId, `TCH-EMAIL-${rand()}`, `CF-EMAIL-${rand()}`]
    );

    const created = await createRefundIntent({
        orderId,
        paymentId: paymentRes.rows[0].id,
        amount: 40,
        currency: 'INR',
        reason: 'email test',
        origin: 'operator',
        idempotencyKey: `refund:email:${rand()}`,
    });
    fixtureRefundIds.push(created.refundId);

    await query(
        `UPDATE refunds SET status = 'manual_review', resolved_at = NOW(), last_error = $2 WHERE id = $1`,
        [created.refundId, lastError]
    );
    return created.refundId;
}

async function alertFor(refundId) {
    return (await query(
        `SELECT * FROM operational_alerts WHERE entity_type = 'refund' AND entity_id = $1`,
        [String(refundId)]
    )).rows[0];
}

async function refundStatus(refundId) {
    return (await query(`SELECT status FROM refunds WHERE id = $1`, [refundId])).rows[0].status;
}

function mockTransport({ accept = true, error = null } = {}) {
    const sent = [];
    return {
        sent,
        async sendMail(message) {
            sent.push(message);
            if (error) throw error;
            return { accepted: accept ? [message.to] : [], rejected: accept ? [] : [message.to] };
        },
    };
}

describe('Email alert delivery', () => {
    after(async () => {
        for (const refundId of fixtureRefundIds) {
            await query(`DELETE FROM operational_alerts WHERE entity_id = $1`, [String(refundId)]);
        }
        for (const orderId of fixtureOrderIds) {
            await query(`DELETE FROM refunds WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM payments WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM orders WHERE id = $1`, [orderId]);
        }
        await pool.end().catch(() => {});
    });

    test('1. Valid configuration is accepted and health output never exposes secrets', () => {
        const config = readEmailConfig(goodEnv);
        assert.equal(config.configured, true);
        assert.deepEqual(config.to, ['ops@example.test', 'oncall@example.test']);

        const health = JSON.stringify(emailHealth(config));
        assert.doesNotMatch(health, /TOP-SECRET/);
        assert.doesNotMatch(health, /alerts-user/);
        assert.doesNotMatch(health, /ops@example/);
    });

    test('2. Missing and invalid configuration is reported by name only, never by value', () => {
        const missing = readEmailConfig({ OPS_ALERT_EMAIL_PROVIDER: 'smtp' });
        assert.equal(missing.configured, false);
        assert.ok(missing.missing.includes('OPS_ALERT_EMAIL_FROM'));
        assert.ok(missing.missing.includes('OPS_ALERT_EMAIL_TO'));
        assert.ok(missing.missing.includes('SMTP_HOST'));

        const invalid = readEmailConfig({ ...goodEnv, OPS_ALERT_EMAIL_TO: 'not-an-address', SMTP_PORT: '99999' });
        assert.equal(invalid.configured, false);
        assert.deepEqual(invalid.invalid.sort(), ['OPS_ALERT_EMAIL_TO', 'SMTP_PORT']);
        assert.doesNotMatch(JSON.stringify(emailHealth(invalid)), /not-an-address/);
    });

    test('3. Successful delivery sends an allowlisted, redacted message and marks the alert delivered', async () => {
        const refundId = await manualReviewRefund({ lastError: 'provider said token=abc123SECRET for card 4111111111111111' });
        await raiseRefundAlerts();

        const transport = mockTransport();
        const sender = createEmailAlertSender({ config: readEmailConfig(goodEnv), transport });
        await deliverOperationalAlerts({ limit: 1000, sender });

        const mine = transport.sent.filter(m => m.subject.includes(String(refundId)));
        assert.equal(mine.length, 1);
        const message = mine[0];
        assert.equal(message.from, 'alerts@example.test');
        assert.match(message.text, /REFUND_MANUAL_REVIEW/);
        assert.doesNotMatch(message.text, /abc123SECRET/);
        assert.doesNotMatch(message.text, /4111111111111111/);
        assert.doesNotMatch(message.text, /idempotency|claim|provider_payment|TOP-SECRET/i);

        const row = await alertFor(refundId);
        assert.equal(row.delivery_status, 'delivered');
        assert.equal(await refundStatus(refundId), 'manual_review');
    });

    test('4. Missing configuration preserves the alert and records delivery as failed, not delivered', async () => {
        const refundId = await manualReviewRefund();
        await raiseRefundAlerts();

        const transport = mockTransport();
        const sender = createEmailAlertSender({ config: readEmailConfig({}), transport });
        await deliverOperationalAlerts({ limit: 1000, sender });

        assert.equal(transport.sent.length, 0, 'no transport call without configuration');
        const row = await alertFor(refundId);
        assert.equal(row.delivery_status, 'failed');
        assert.match(row.last_error, /not configured/);
        assert.equal(await refundStatus(refundId), 'manual_review');
    });

    test('5. Transport authentication failure is recorded and retried; refund state is unchanged', async () => {
        const refundId = await manualReviewRefund();
        await raiseRefundAlerts();

        const auth = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
        await deliverOperationalAlerts({ limit: 1000, sender: createEmailAlertSender({ config: readEmailConfig(goodEnv), transport: mockTransport({ error: auth }) }) });

        const row = await alertFor(refundId);
        assert.equal(row.delivery_status, 'failed');
        assert.equal(row.attempt_count, 1);
        assert.match(row.last_error, /EAUTH/);
        assert.doesNotMatch(row.last_error, /Invalid login|TOP-SECRET/);
        assert.equal(await refundStatus(refundId), 'manual_review');
    });

    test('6. Transient failure followed by success delivers exactly once', async () => {
        const refundId = await manualReviewRefund();
        await raiseRefundAlerts();

        const failing = mockTransport({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) });
        await deliverOperationalAlerts({ limit: 1000, sender: createEmailAlertSender({ config: readEmailConfig(goodEnv), transport: failing }) });

        await query(`UPDATE operational_alerts SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE entity_id = $1`, [String(refundId)]);
        const working = mockTransport();
        await deliverOperationalAlerts({ limit: 1000, sender: createEmailAlertSender({ config: readEmailConfig(goodEnv), transport: working }) });

        assert.equal(working.sent.filter(m => m.subject.includes(String(refundId))).length, 1);
        assert.equal((await alertFor(refundId)).delivery_status, 'delivered');
    });

    test('7. Repeated evaluations never send a second email for a delivered alert', async () => {
        const refundId = await manualReviewRefund();
        await raiseRefundAlerts();
        const transport = mockTransport();
        const sender = createEmailAlertSender({ config: readEmailConfig(goodEnv), transport });

        await deliverOperationalAlerts({ limit: 1000, sender });
        await raiseRefundAlerts();
        await deliverOperationalAlerts({ limit: 1000, sender });

        assert.equal(transport.sent.filter(m => m.subject.includes(String(refundId))).length, 1);
    });

    test('8. A send the transport does not accept is a failure, never delivered', async () => {
        const refundId = await manualReviewRefund();
        await raiseRefundAlerts();

        await deliverOperationalAlerts({ limit: 1000,
            sender: createEmailAlertSender({ config: readEmailConfig(goodEnv), transport: mockTransport({ accept: false }) }),
        });

        const row = await alertFor(refundId);
        assert.equal(row.delivery_status, 'failed');
        assert.match(row.last_error, /not accepted/);
    });

    test('9. Exhausted email attempts become undeliverable and stop being retried', async () => {
        const refundId = await manualReviewRefund();
        await raiseRefundAlerts();
        const row = await alertFor(refundId);
        await query(
            `UPDATE operational_alerts SET attempt_count = $2, next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
            [row.id, MAX_DELIVERY_ATTEMPTS - 1]
        );

        await deliverOperationalAlerts({ limit: 1000,
            sender: createEmailAlertSender({
                config: readEmailConfig(goodEnv),
                transport: mockTransport({ error: Object.assign(new Error('down'), { code: 'ECONNECTION' }) }),
            }),
        });

        const after = await alertFor(refundId);
        assert.equal(after.delivery_status, 'undeliverable');
        assert.equal(after.next_attempt_at, null);
        assert.equal(await refundStatus(refundId), 'manual_review');
    });

    test('10. Message builder uses only allowlisted fields and redacts error text', () => {
        const email = buildAlertEmail(
            {
                alert_type: 'REFUND_PENDING_OVERDUE',
                severity: 'high',
                entity_id: 'REF-1',
                payload: {
                    refundId: 'REF-1',
                    orderId: 'ORD-1',
                    status: 'reconciliation_required',
                    ageMinutes: 90,
                    attemptCount: 3,
                    maxAttempts: 20,
                    lastError: 'secret=zzz idempotency_key=abc 123456789012',
                    idempotencyKey: 'refund:should-not-appear',
                    providerRefundId: 'CF-SHOULD-NOT-APPEAR',
                },
            },
            readEmailConfig(goodEnv)
        );

        assert.match(email.subject, /REFUND_PENDING_OVERDUE/);
        assert.doesNotMatch(email.text, /should-not-appear|SHOULD-NOT-APPEAR|zzz|123456789012/);
        assert.match(email.text, /Attempts: 3 of 20/);
    });

    test('11. Alerts persist and stay visible when email is unavailable', async () => {
        const refundId = await manualReviewRefund();
        await raiseRefundAlerts();
        await deliverOperationalAlerts({ limit: 1000, sender: createEmailAlertSender({ config: readEmailConfig({}) }) });

        const row = await alertFor(refundId);
        assert.ok(row, 'alert row must still exist');
        assert.notEqual(row.delivery_status, 'delivered');
        assert.equal(await refundStatus(refundId), 'manual_review');
    });
});
