/**
 * The Crunchy Heart - Alert evaluation interval and default-disabled scheduling
 *
 * Verifies the one-minute default, validated overrides, that the alert worker
 * ignores the shared WORKER_INTERVAL_MS, that alerting stays off unless
 * OPS_ALERTS_ENABLED is exactly 'true', and that an email configuration problem
 * does not stop alert recording. No timers are waited on in real time.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test';
process.env.CASHFREE_CLIENT_ID = 'TEST_INTERVAL_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_INTERVAL_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const {
    parseAlertIntervalMs,
    startConfiguredWorkers,
    DEFAULT_ALERT_INTERVAL_MS,
} = await import('../src/services/worker-bootstrap.js');
const { stopAllWorkers, workerHealth } = await import('../src/services/worker-registry.js');
const { pool } = await import('../src/db/pool.js');

describe('Alert evaluation interval and scheduling defaults', () => {
    after(async () => {
        await stopAllWorkers();
        await pool.end().catch(() => {});
    });

    test('1. The default alert interval is 60 seconds', () => {
        assert.equal(DEFAULT_ALERT_INTERVAL_MS, 60000);
        assert.equal(parseAlertIntervalMs(undefined), 60000);
        assert.equal(parseAlertIntervalMs(''), 60000);
        assert.equal(parseAlertIntervalMs('   '), 60000);
    });

    test('2. Valid overrides are accepted as integer milliseconds', () => {
        assert.equal(parseAlertIntervalMs('120000'), 120000);
        assert.equal(parseAlertIntervalMs(' 5000 '), 5000);
    });

    test('3. Invalid overrides stop startup with a clear error', () => {
        for (const bad of ['abc', '100', '-5', '1.5', '999999999999', '0x10']) {
            assert.throws(() => parseAlertIntervalMs(bad), /OPS_ALERTS_INTERVAL_MS must be an integer/, `value ${bad}`);
        }
    });

    test('4. Alerting stays off unless OPS_ALERTS_ENABLED is exactly "true"', () => {
        for (const value of [undefined, '', 'TRUE', '1', 'yes', 'false']) {
            const started = startConfiguredWorkers({ env: { OPS_ALERTS_ENABLED: value } });
            assert.deepEqual(started, [], `flag value ${value}`);
        }
        assert.equal(workerHealth().find(w => w.name === 'operational_alerts').started, false);
    });

    test('5. With alerting enabled, the alert worker uses its own 60-second interval, not WORKER_INTERVAL_MS', () => {
        const started = startConfiguredWorkers({
            env: { OPS_ALERTS_ENABLED: 'true', WORKER_INTERVAL_MS: '5000' },
        });
        assert.deepEqual(started, ['operational_alerts']);

        const state = workerHealth().find(w => w.name === 'operational_alerts').state;
        assert.equal(state.intervalMs, 60000);
    });

    test('6. An explicit OPS_ALERTS_INTERVAL_MS overrides the default for the alert worker only', async () => {
        await stopAllWorkers();
        startConfiguredWorkers({
            env: { OPS_ALERTS_ENABLED: 'true', OPS_ALERTS_INTERVAL_MS: '120000', WORKER_INTERVAL_MS: '5000' },
        });
        const state = workerHealth().find(w => w.name === 'operational_alerts').state;
        assert.equal(state.intervalMs, 120000);
        assert.equal(workerHealth().find(w => w.name === 'refund_sweep').started, false);
    });

    test('7. An invalid OPS_ALERTS_INTERVAL_MS stops the alert worker from starting', async () => {
        await stopAllWorkers();
        assert.throws(
            () => startConfiguredWorkers({ env: { OPS_ALERTS_ENABLED: 'true', OPS_ALERTS_INTERVAL_MS: 'soon' } }),
            /OPS_ALERTS_INTERVAL_MS must be an integer/
        );
        assert.equal(workerHealth().find(w => w.name === 'operational_alerts').started, false);
    });

    test('8. Missing email configuration does not stop alert evaluation (alerts still record and retry)', async () => {
        await stopAllWorkers();
        const started = startConfiguredWorkers({ env: { OPS_ALERTS_ENABLED: 'true' } });
        assert.deepEqual(started, ['operational_alerts']);
        await stopAllWorkers();
    });
});
