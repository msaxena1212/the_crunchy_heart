/**
 * The Crunchy Heart - Read-only sandbox refund monitor
 *
 * All HTTP is mocked. The tests prove the monitor refuses non-sandbox
 * configuration, classifies statuses without guessing, stops only when every
 * refund is terminal, escalates unresolved refunds, and issues GET requests only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const sandboxEnv = {
    CASHFREE_ENVIRONMENT: 'sandbox',
    CASHFREE_API_VERSION: '2026-01-01',
    CASHFREE_CLIENT_ID: 'TEST_MONITOR_CLIENT_ID',
    CASHFREE_CLIENT_SECRET: 'TEST_MONITOR_SECRET_KEY_1234567890abcdef',
};

const {
    assertSandboxConfig,
    classifyRefundStatus,
    monitorSandboxRefunds,
    fetchOrderRefunds,
    runMonitorWithReport,
    parseArgs,
    REPORT_FILE_NAME,
} = await import('../src/scripts/sandbox-refund-status.mjs');
import os from 'node:os';

function scriptedFetch(responsesByOrder) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, method: init.method });
        const orderId = decodeURIComponent(url.split('/pg/orders/')[1].split('/')[0]);
        const queue = responsesByOrder[orderId];
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return {
            status: next.status ?? 200,
            async json() { return next.body; },
        };
    };
    return { fetchImpl, calls };
}

const refund = (note, status) => ({ refund_id: `RF-${note}`, refund_note: note, refund_status: status, refund_amount: 1, processed_at: null, status_description: 'In Progress' });

describe('Read-only sandbox refund monitor', () => {
    test('1. Refuses anything other than verified sandbox configuration', () => {
        assert.throws(() => assertSandboxConfig({ ...sandboxEnv, CASHFREE_ENVIRONMENT: 'production' }), /must be "sandbox"/);
        assert.throws(() => assertSandboxConfig({ ...sandboxEnv, CASHFREE_API_VERSION: '2025-01-01' }), /set explicitly to 2026-01-01/);
        assert.throws(() => assertSandboxConfig({ ...sandboxEnv, CASHFREE_API_VERSION: undefined }), /set explicitly/);
        assert.throws(() => assertSandboxConfig({ ...sandboxEnv, CASHFREE_CLIENT_SECRET: '' }), /credentials are not present/);
        assert.throws(() => assertSandboxConfig(sandboxEnv, 'https://api.cashfree.com'), /not the Cashfree sandbox/);
        assert.doesNotThrow(() => assertSandboxConfig(sandboxEnv));
    });

    test('2. Status classification never guesses: unknown values are not terminal', () => {
        assert.equal(classifyRefundStatus('SUCCESS'), 'terminal_success');
        assert.equal(classifyRefundStatus('FAILED'), 'terminal_failure');
        assert.equal(classifyRefundStatus('CANCELLED'), 'terminal_failure');
        assert.equal(classifyRefundStatus('PENDING'), 'pending');
        assert.equal(classifyRefundStatus('ACTIVE'), 'pending');
        assert.equal(classifyRefundStatus('SOMETHING_NEW'), 'unknown');
        assert.equal(classifyRefundStatus(undefined), 'unknown');
    });

    test('3. Stops early only when every refund is terminal', async () => {
        const { fetchImpl, calls } = scriptedFetch({
            A: [{ body: [refund('SUCCESS', 'SUCCESS')] }],
            B: [{ body: [refund('FAILED', 'FAILED')] }],
        });
        const result = await monitorSandboxRefunds(['A', 'B'], {
            maxChecks: 5, intervalMs: 1000, fetchImpl, env: sandboxEnv, sleep: async () => {},
        });

        assert.equal(result.checks, 1);
        assert.deepEqual(result.unresolved, []);
        assert.equal(result.escalate, false);
        assert.equal(calls.length, 2);
    });

    test('4. Stops at the limit and escalates non-terminal refunds as UNRESOLVED', async () => {
        const { fetchImpl } = scriptedFetch({
            A: [{ body: [refund('PENDING', 'PENDING')] }],
            B: [{ body: [refund('ACTIVE', 'PENDING')] }],
        });
        const sleeps = [];
        const result = await monitorSandboxRefunds(['A', 'B'], {
            maxChecks: 3, intervalMs: 5000, fetchImpl, env: sandboxEnv,
            sleep: async ms => { sleeps.push(ms); },
        });

        assert.equal(result.checks, 3);
        assert.equal(result.escalate, true);
        assert.equal(result.unresolved.length, 2);
        assert.deepEqual(sleeps, [5000, 5000], 'sleeps between checks only');
    });

    test('5. A lookup that later becomes terminal is recorded, and the monitor stops', async () => {
        const { fetchImpl } = scriptedFetch({
            A: [{ body: [refund('PENDING', 'PENDING')] }, { body: [refund('SUCCESS', 'SUCCESS')] }],
        });
        const result = await monitorSandboxRefunds(['A'], {
            maxChecks: 5, intervalMs: 1000, fetchImpl, env: sandboxEnv, sleep: async () => {},
        });

        assert.equal(result.checks, 2);
        assert.equal(result.escalate, false);
        assert.equal(result.history[0].summary[0].refunds[0].classification, 'pending');
        assert.equal(result.history[1].summary[0].refunds[0].classification, 'terminal_success');
    });

    test('6. Missing refunds and HTTP errors are never treated as terminal', async () => {
        const { fetchImpl } = scriptedFetch({
            A: [{ status: 404, body: {} }],
        });
        const result = await monitorSandboxRefunds(['A'], {
            maxChecks: 2, intervalMs: 1000, fetchImpl, env: sandboxEnv, sleep: async () => {},
        });

        assert.equal(result.escalate, true);
        assert.equal(result.final[0].error, 'HTTP 404');
    });

    test('7. Results contain status fields only, never credentials or raw payloads', async () => {
        const { fetchImpl } = scriptedFetch({
            A: [{ body: [{ ...refund('SUCCESS', 'SUCCESS'), cf_refund_id: 'CF-SECRET-LOOKING', metadata: { secret: 'hidden' } }] }],
        });
        const result = await fetchOrderRefunds('A', { fetchImpl, env: sandboxEnv });
        const text = JSON.stringify(result);

        assert.doesNotMatch(text, new RegExp(sandboxEnv.CASHFREE_CLIENT_SECRET));
        assert.doesNotMatch(text, /CF-SECRET-LOOKING|hidden|cf_refund_id|metadata/);
    });

    test('8. The monitor source issues GET requests only and never refers to refund creation', () => {
        const source = fs.readFileSync(path.join(here, '..', 'src', 'scripts', 'sandbox-refund-status.mjs'), 'utf8');
        assert.doesNotMatch(source, /method:\s*['"]POST['"]/);
        assert.doesNotMatch(source, /method:\s*['"]PUT['"]|method:\s*['"]PATCH['"]|method:\s*['"]DELETE['"]/);
        assert.match(source, /method: 'GET'/);
    });

    test('10. Repeated runs append one valid JSON line each, with no credentials or raw payloads', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-reports-'));
        const { fetchImpl } = scriptedFetch({ A: [{ body: [{ ...refund('SUCCESS', 'SUCCESS'), cf_refund_id: 'CF-RAW', metadata: { token: 'hidden' } }] }] });
        const opts = { maxChecks: 1, intervalMs: 1000, fetchImpl, env: sandboxEnv, sleep: async () => {}, reportDir: dir };

        await runMonitorWithReport(['A'], opts);
        const second = await runMonitorWithReport(['A'], opts);
        assert.equal(second.reportWritten, true);

        const lines = fs.readFileSync(path.join(dir, REPORT_FILE_NAME), 'utf8').trim().split('\n');
        assert.equal(lines.length, 2);
        for (const line of lines) {
            const parsed = JSON.parse(line);
            assert.ok(parsed.timestamp);
            assert.equal(typeof parsed.elapsedMs, 'number');
            assert.equal(parsed.outcome, 'resolved');
        }
        assert.doesNotMatch(lines.join('\n'), /CF-RAW|hidden|metadata|authorization|x-client|CLIENT_SECRET|TEST_MONITOR_SECRET/i);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('11. A report write failure is returned explicitly and never swallowed', async () => {
        const blocker = path.join(os.tmpdir(), `monitor-blocker-${Date.now()}.txt`);
        fs.writeFileSync(blocker, 'not a directory');
        const { fetchImpl } = scriptedFetch({ A: [{ body: [refund('SUCCESS', 'SUCCESS')] }] });

        const out = await runMonitorWithReport(['A'], {
            maxChecks: 1, intervalMs: 1000, fetchImpl, env: sandboxEnv, sleep: async () => {}, reportDir: blocker,
        });

        assert.equal(out.reportWritten, false);
        assert.equal(out.reportError, 'REPORT_WRITE_FAILED');
        assert.equal(out.result.checks, 1, 'the monitor result is still returned');
        fs.rmSync(blocker, { force: true });
    });

    test('12. Outcome categories distinguish resolved, check limit, and deadline', async () => {
        const resolved = await runMonitorWithReport(['A'], {
            maxChecks: 1, intervalMs: 1000, fetchImpl: scriptedFetch({ A: [{ body: [refund('SUCCESS', 'SUCCESS')] }] }).fetchImpl,
            env: sandboxEnv, sleep: async () => {}, reportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mon-')),
        });
        assert.equal(resolved.report.outcome, 'resolved');

        const limit = await runMonitorWithReport(['A'], {
            maxChecks: 2, intervalMs: 1000, fetchImpl: scriptedFetch({ A: [{ body: [refund('PENDING', 'PENDING')] }] }).fetchImpl,
            env: sandboxEnv, sleep: async () => {}, reportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mon-')),
        });
        assert.equal(limit.report.outcome, 'check_limit_reached_unresolved');

        let clock = 0;
        const deadline = await runMonitorWithReport(['A'], {
            maxChecks: 100, intervalMs: 1000, maxHours: 1, fetchImpl: scriptedFetch({ A: [{ body: [refund('PENDING', 'PENDING')] }] }).fetchImpl,
            env: sandboxEnv, sleep: async () => {}, clock: () => { clock += 40 * 60 * 1000; return clock; },
            reportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mon-')),
        });
        assert.equal(deadline.report.outcome, 'deadline_reached_unresolved');
    });

    test('13. A --max-hours flag is never mistaken for an order ID', () => {
        const parsed = parseArgs(['SBXA', '--max-hours=2', 'SBXB', '--max-checks=3']);
        assert.deepEqual(parsed.orderIds, ['SBXA', 'SBXB']);
        assert.equal(parsed.maxHours, 2);
        assert.equal(parsed.maxChecks, 3);
        assert.throws(() => parseArgs(['SBXA', '--unknown-flag']), /unknown option/);
    });
});
