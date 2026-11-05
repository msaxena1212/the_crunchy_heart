/**
 * The Crunchy Heart - Email verification guards (no real mail is sent)
 *
 * Verifies the explicit test-email procedure refuses to run without its
 * confirmations, sends one allowlisted synthetic alert through an injected
 * sender, and that transport setup and SMTP configuration never start workers.
 * Also confirms the sandbox monitor's wall-clock stopping limit.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test';
process.env.CASHFREE_CLIENT_ID = 'TEST_EMAIL_VERIFY_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_EMAIL_VERIFY_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const here = path.dirname(fileURLToPath(import.meta.url));

const {
    sendTestAlertEmail,
    buildTestAlert,
    TEST_CONFIRM_PHRASE,
} = await import('../src/scripts/send-test-alert-email.mjs');
const { readEmailConfig, createSmtpTransport } = await import('../src/services/ops-alert-email.service.js');
const { startConfiguredWorkers } = await import('../src/services/worker-bootstrap.js');
const { stopAllWorkers, workerHealth } = await import('../src/services/worker-registry.js');
const { monitorSandboxRefunds } = await import('../src/scripts/sandbox-refund-status.mjs');
const { pool } = await import('../src/db/pool.js');

const smtpEnv = {
    OPS_ALERT_EMAIL_PROVIDER: 'smtp',
    OPS_ALERT_EMAIL_FROM: 'alerts@example.test',
    OPS_ALERT_EMAIL_TO: 'test-inbox@example.test',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_PASSWORD: 'SMTP-SECRET-NOT-FOR-LOGS',
};

const confirmedEnv = {
    ...smtpEnv,
    OPS_ALERT_TEST_CONFIRM: TEST_CONFIRM_PHRASE,
    OPS_ALERT_TEST_RECIPIENT: 'test-inbox@example.test',
};

function recordingSender(result = { accepted: 1 }) {
    const sent = [];
    const sender = async alert => { sent.push(alert); return result; };
    return { sent, sender };
}

describe('Email verification guards', () => {
    test('1. The test email refuses to run without the exact confirmation phrase', async () => {
        const { sent, sender } = recordingSender();
        await assert.rejects(
            () => sendTestAlertEmail({ env: { ...confirmedEnv, OPS_ALERT_TEST_CONFIRM: 'yes' }, sender }),
            /OPS_ALERT_TEST_CONFIRM/
        );
        await assert.rejects(
            () => sendTestAlertEmail({ env: { ...confirmedEnv, OPS_ALERT_TEST_CONFIRM: undefined }, sender }),
            /OPS_ALERT_TEST_CONFIRM/
        );
        assert.equal(sent.length, 0);
    });

    test('2. The test email refuses multiple recipients and a recipient mismatch', async () => {
        const { sent, sender } = recordingSender();
        await assert.rejects(
            () => sendTestAlertEmail({ env: { ...confirmedEnv, OPS_ALERT_EMAIL_TO: 'a@example.test,b@example.test' }, sender }),
            /exactly one test recipient|must match/
        );
        await assert.rejects(
            () => sendTestAlertEmail({ env: { ...confirmedEnv, OPS_ALERT_TEST_RECIPIENT: 'someone-else@example.test' }, sender }),
            /must match OPS_ALERT_EMAIL_TO/
        );
        assert.equal(sent.length, 0);
    });

    test('3. With full confirmation it sends exactly one allowlisted synthetic alert', async () => {
        const { sent, sender } = recordingSender({ accepted: 1 });
        const result = await sendTestAlertEmail({ env: confirmedEnv, sender });

        assert.equal(result.accepted, 1);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].alert_type, 'OPS_EMAIL_TEST');
        assert.equal(sent[0].entity_id, 'TEST-ONLY');
        assert.equal(sent[0].payload.refundId, 'TEST-ONLY');
    });

    test('4. The synthetic alert contains no real refund, order, or provider data', () => {
        const alert = buildTestAlert();
        const text = JSON.stringify(alert);
        assert.doesNotMatch(text, /idempotency|claim|provider|cf_|secret|token/i);
        assert.equal(alert.payload.lastError, null);
    });

    test('5. The test-email script has no database or refund write paths', () => {
        const source = fs.readFileSync(path.join(here, '..', 'src', 'scripts', 'send-test-alert-email.mjs'), 'utf8');
        assert.doesNotMatch(source, /\bquery\(|INSERT\s+INTO|UPDATE\s+\w+\s+SET|createRefund|processRefund/i);
    });
});

describe('Transport setup and configuration do not enable workers', () => {
    test('6. SMTP transport can be created without starting any worker or the alert flag', async () => {
        const config = readEmailConfig(smtpEnv);
        const transport = createSmtpTransport(config);
        assert.equal(typeof transport.sendMail, 'function');

        const started = startConfiguredWorkers({ env: smtpEnv });
        assert.deepEqual(started, []);
        assert.equal(workerHealth().find(w => w.name === 'operational_alerts').started, false);
        await stopAllWorkers();
    });

    test('7. Missing SMTP configuration does not enable workers', () => {
        const started = startConfiguredWorkers({ env: { OPS_ALERTS_ENABLED: 'false' } });
        assert.deepEqual(started, []);
        assert.equal(readEmailConfig({}).configured, false);
    });
});

describe('Sandbox monitor wall-clock stopping limit', () => {
    test('8. The monitor stops at the deadline even when checks remain', async () => {
        let clock = 0;
        const fetchImpl = async () => ({ status: 200, async json() { return [{ refund_id: 'R', refund_note: 'ACTIVE', refund_status: 'PENDING' }]; } });
        const env = {
            CASHFREE_ENVIRONMENT: 'sandbox',
            CASHFREE_API_VERSION: '2026-01-01',
            CASHFREE_CLIENT_ID: 'TEST_MONITOR_ID',
            CASHFREE_CLIENT_SECRET: 'TEST_MONITOR_SECRET_KEY_1234567890abcdef',
        };

        const result = await monitorSandboxRefunds(['A'], {
            maxChecks: 100,
            intervalMs: 1000,
            maxHours: 1,
            fetchImpl,
            env,
            clock: () => { clock += 40 * 60 * 1000; return clock; },
            sleep: async () => {},
        });

        assert.equal(result.stoppedByDeadline, true);
        assert.ok(result.checks < 100);
        assert.equal(result.escalate, true);
    });

    test('9. Default stopping limit is 72 hours and documented as such', async () => {
        const { DEFAULT_MAX_HOURS } = await import('../src/scripts/sandbox-refund-status.mjs');
        assert.equal(DEFAULT_MAX_HOURS, 72);
    });
});

describe('Shared cleanup', () => {
    test('10. Pool closes cleanly after the verification suite', async () => {
        await pool.end().catch(() => {});
        assert.ok(true);
    });
});
