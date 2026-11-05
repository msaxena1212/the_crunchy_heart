/**
 * The Crunchy Heart - Worker registry, scheduling flags, and lock contention
 *
 * Verifies: workers are disabled unless their flag is exactly 'true', duplicate
 * starts reuse one worker, a worker never overlaps itself, a failing run does not
 * stop later ticks, graceful stop waits for an in-flight run, and the refund
 * sweep honours its advisory lock.
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 * No provider call is made; the refund sweep uses its fail-closed default.
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
process.env.CASHFREE_CLIENT_ID = 'TEST_WORKER_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_WORKER_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const { pool } = await import('../src/db/pool.js');
const {
    startWorker,
    stopWorker,
    stopAllWorkers,
    workerEnabled,
    workerHealth,
} = await import('../src/services/worker-registry.js');
const { startConfiguredWorkers } = await import('../src/services/worker-bootstrap.js');
const { runRefundSweep, REFUND_SWEEP_LOCK_KEY } = await import('../src/services/refund.service.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Worker registry and scheduling flags', () => {
    after(async () => {
        await stopAllWorkers();
        await pool.end().catch(() => {});
    });

    test('1. Every worker is disabled unless its flag is exactly "true"', () => {
        assert.equal(workerEnabled('refund_sweep', {}), false);
        assert.equal(workerEnabled('refund_sweep', { REFUND_WORKER_ENABLED: 'TRUE' }), false);
        assert.equal(workerEnabled('refund_sweep', { REFUND_WORKER_ENABLED: '1' }), false);
        assert.equal(workerEnabled('refund_sweep', { REFUND_WORKER_ENABLED: 'yes' }), false);
        assert.equal(workerEnabled('refund_sweep', { REFUND_WORKER_ENABLED: 'true' }), true);
        assert.throws(() => workerEnabled('unknown_worker', {}), /Unknown worker/);
    });

    test('2. With no flags set, bootstrap starts nothing', () => {
        const started = startConfiguredWorkers({ env: {}, intervalMs: 1000 });
        assert.deepEqual(started, []);
        assert.equal(workerHealth().every(w => w.started === false), true);
    });

    test('3. Enabling flags starts exactly those workers; health reports them', async () => {
        const started = startConfiguredWorkers({
            env: { REFUND_WORKER_ENABLED: 'true', RECONCILIATION_WORKER_ENABLED: 'false' },
            intervalMs: 60 * 60 * 1000,
        });
        assert.deepEqual(started, ['refund_sweep']);

        const health = workerHealth();
        assert.equal(health.find(w => w.name === 'refund_sweep').started, true);
        assert.equal(health.find(w => w.name === 'reconciliation_sweep').started, false);
        await stopWorker('refund_sweep');
    });

    test('4. Duplicate starts reuse one worker and one timer', async () => {
        let runs = 0;
        const first = startWorker({ name: 'refund_sweep', intervalMs: 60 * 60 * 1000, run: async () => { runs += 1; } });
        const second = startWorker({ name: 'refund_sweep', intervalMs: 5, run: async () => { runs += 100; } });

        assert.equal(first, second);
        await first.runOnce();
        assert.equal(runs, 1, 'only the first worker body runs');
        await stopWorker('refund_sweep');
    });

    test('5. A worker never overlaps itself inside one process', async () => {
        let concurrent = 0;
        let maxConcurrent = 0;
        const handle = startWorker({
            name: 'operational_alerts',
            intervalMs: 5,
            run: async () => {
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await sleep(60);
                concurrent -= 1;
            },
        });

        await sleep(250);
        await handle.stop();
        assert.equal(maxConcurrent, 1);
    });

    test('6. A failing run is recorded and the next tick still runs; success clears the failure count', async () => {
        let attempt = 0;
        const handle = startWorker({
            name: 'reconciliation_sweep',
            intervalMs: 60 * 60 * 1000,
            run: async () => {
                attempt += 1;
                if (attempt === 1) throw Object.assign(new Error('transient outage'), { code: 'NET' });
                return { skipped: false, results: [] };
            },
        });

        await handle.runOnce();
        assert.equal(handle.state().consecutiveFailures, 1);
        assert.match(handle.state().lastError, /NET: transient outage/);

        await handle.runOnce();
        assert.equal(handle.state().consecutiveFailures, 0);
        assert.equal(handle.state().lastError, null);
        assert.equal(handle.state().runs, 2);
        await stopWorker('reconciliation_sweep');
    });

    test('7. Graceful stop waits for an in-flight run and then stops scheduling', async () => {
        let finished = false;
        let runs = 0;
        const handle = startWorker({
            name: 'refund_sweep',
            intervalMs: 5,
            run: async () => {
                runs += 1;
                await sleep(120);
                finished = true;
            },
        });

        await sleep(20);
        await handle.stop();
        assert.equal(finished, true, 'stop must wait for the in-flight run');

        const runsAtStop = runs;
        await sleep(60);
        assert.equal(runs, runsAtStop, 'no runs after stop');
    });

    test('8. Refund sweep honours its advisory lock: a second sweeper is skipped', async () => {
        const holder = await pool.connect();
        try {
            const held = await holder.query('SELECT pg_try_advisory_lock($1) AS ok', [REFUND_SWEEP_LOCK_KEY]);
            assert.equal(held.rows[0].ok, true);

            const skipped = await runRefundSweep({ limit: 5 });
            assert.equal(skipped.skipped, true);
            assert.deepEqual(skipped.results, []);
        } finally {
            await holder.query('SELECT pg_advisory_unlock($1)', [REFUND_SWEEP_LOCK_KEY]);
            holder.release();
        }
    });
});
