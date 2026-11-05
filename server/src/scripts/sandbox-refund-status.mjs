/*
|--------------------------------------------------------------------------
| Read-only sandbox refund status monitor
|--------------------------------------------------------------------------
| Checks the status of refunds on EXISTING sandbox orders. It only performs
| GET requests. It never creates or retries a refund.
|
| Usage (PowerShell or bash):
|   CASHFREE_ENVIRONMENT=sandbox CASHFREE_API_VERSION=2026-01-01 \
|     node src/scripts/sandbox-refund-status.mjs <orderId> [<orderId> ...] \
|       [--max-checks=6] [--interval-ms=60000] [--max-hours=72]
|
| Guards: refuses to run unless the environment is 'sandbox', the API version is
| set explicitly, and the host is the sandbox host. Credentials are read from
| the environment and are never printed.
|
| Stopping limit: the script stops when every refund is terminal or after
| --max-checks. Anything still non-terminal is reported UNRESOLVED and must be
| escalated for manual review. It is never treated as success or failure.
|--------------------------------------------------------------------------
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SANDBOX_HOST = 'https://sandbox.cashfree.com';
export const REQUIRED_API_VERSION = '2026-01-01';
export const DEFAULT_MAX_CHECKS = 6;
export const DEFAULT_INTERVAL_MS = 60 * 1000;
export const DEFAULT_MAX_HOURS = 72;

const TERMINAL_SUCCESS = new Set(['SUCCESS']);
const TERMINAL_FAILURE = new Set(['FAILED', 'CANCELLED']);

/*
 * Throws unless the configuration is verifiably sandbox. Returns nothing on success.
 */
export function assertSandboxConfig(env = process.env, host = SANDBOX_HOST) {
    if (env.CASHFREE_ENVIRONMENT !== 'sandbox') {
        throw new Error('ABORT: CASHFREE_ENVIRONMENT must be "sandbox".');
    }
    if (env.CASHFREE_API_VERSION !== REQUIRED_API_VERSION) {
        throw new Error(`ABORT: CASHFREE_API_VERSION must be set explicitly to ${REQUIRED_API_VERSION}.`);
    }
    if (!host.startsWith('https://sandbox.cashfree.com') || host.includes('api.cashfree.com')) {
        throw new Error('ABORT: host is not the Cashfree sandbox.');
    }
    if (!env.CASHFREE_CLIENT_ID || !env.CASHFREE_CLIENT_SECRET) {
        throw new Error('ABORT: sandbox credentials are not present in the environment.');
    }
}

/*
 * Classifies a provider refund status without guessing. Unknown values are
 * never treated as final.
 */
export function classifyRefundStatus(status) {
    const value = String(status || '').toUpperCase();
    if (TERMINAL_SUCCESS.has(value)) return 'terminal_success';
    if (TERMINAL_FAILURE.has(value)) return 'terminal_failure';
    if (value === 'PENDING' || value === 'ACTIVE' || value === 'PROCESSING') return 'pending';
    return 'unknown';
}

/*
 * Reads refunds for one order with a GET request. Returns sanitised fields only.
 */
export async function fetchOrderRefunds(orderId, { fetchImpl = globalThis.fetch, env = process.env, host = SANDBOX_HOST } = {}) {
    const res = await fetchImpl(`${host}/pg/orders/${encodeURIComponent(orderId)}/refunds`, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            'x-client-id': env.CASHFREE_CLIENT_ID,
            'x-client-secret': env.CASHFREE_CLIENT_SECRET,
            'x-api-version': env.CASHFREE_API_VERSION,
        },
    });

    if (res.status < 200 || res.status >= 300) {
        return { orderId, httpStatus: res.status, refunds: [], error: `HTTP ${res.status}` };
    }

    const body = await res.json();
    const list = Array.isArray(body) ? body : body?.data || [];

    return {
        orderId,
        httpStatus: res.status,
        refunds: list.map(r => ({
            refundId: r.refund_id ?? null,
            refundNote: r.refund_note ?? null,
            refundStatus: r.refund_status ?? null,
            classification: classifyRefundStatus(r.refund_status),
            amount: r.refund_amount ?? null,
            processedAt: r.processed_at ?? null,
            statusDescription: r.status_description ?? null,
        })),
        error: null,
    };
}

/*
 * Runs bounded checks. Stops early only when every refund is terminal.
 */
export async function monitorSandboxRefunds(orderIds, {
    maxChecks = DEFAULT_MAX_CHECKS,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxHours = DEFAULT_MAX_HOURS,
    clock = () => Date.now(),
    fetchImpl = globalThis.fetch,
    env = process.env,
    host = SANDBOX_HOST,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => new Date().toISOString(),
} = {}) {
    assertSandboxConfig(env, host);

    if (!orderIds.length) throw new Error('ABORT: at least one order ID is required.');

    const history = [];
    let latest = {};
    const deadline = clock() + maxHours * 60 * 60 * 1000;
    let stoppedByDeadline = false;

    for (let check = 1; check <= maxChecks; check++) {
        const observed = [];
        for (const orderId of orderIds) {
            observed.push(await fetchOrderRefunds(orderId, { fetchImpl, env, host }));
        }
        latest = { checkedAt: now(), observed };
        history.push({ check, checkedAt: latest.checkedAt, summary: summarise(observed) });

        const allTerminal = observed.every(o => isOrderTerminal(o));
        if (allTerminal) break;
        if (clock() >= deadline) {
            stoppedByDeadline = true;
            break;
        }
        if (check < maxChecks) await sleep(intervalMs);
    }

    const unresolved = latest.observed.flatMap(o => {
        // An HTTP error or an order with no refunds is never silently treated as resolved.
        if (o.error || o.refunds.length === 0) {
            return [{ orderId: o.orderId, refundNote: null, reason: o.error || 'no refunds found' }];
        }
        return o.refunds
            .filter(r => !r.classification.startsWith('terminal'))
            .map(r => ({ orderId: o.orderId, refundNote: r.refundNote, reason: r.refundStatus }));
    });

    return {
        apiVersion: REQUIRED_API_VERSION,
        host,
        checks: history.length,
        maxChecks,
        intervalMs,
        maxHours,
        stoppedByDeadline,
        history,
        final: latest.observed,
        unresolved,
        escalate: unresolved.length > 0,
    };
}

function isOrderTerminal(order) {
    return !order.error && order.refunds.length > 0 && order.refunds.every(r => r.classification.startsWith('terminal'));
}

function summarise(observed) {
    return observed.map(o => ({
        orderId: o.orderId,
        httpStatus: o.httpStatus,
        refunds: o.refunds.map(r => ({ note: r.refundNote, status: r.refundStatus, classification: r.classification })),
        error: o.error,
    }));
}

/*
 * Durable reporting. One JSON line per run, appended. Each line holds only the
 * timestamp, elapsed time, outcome category, and minimal sandbox references
 * (order ID, refund ID, refund note, classification). It never holds headers,
 * credentials, session tokens, or complete provider responses.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPORT_DIR = path.resolve(here, '..', '..', 'reports', 'sandbox-monitor');
export const REPORT_FILE_NAME = 'sandbox-refund-monitor.jsonl';

export function buildMonitorReport(result, { startedAtMs, endedAtMs = Date.now() } = {}) {
    const refs = result.final.flatMap(o => {
        if (o.error || o.refunds.length === 0) {
            return [{ orderId: o.orderId, refundId: null, refundNote: null, classification: o.error ? 'error' : 'no_refunds' }];
        }
        return o.refunds.map(r => ({ orderId: o.orderId, refundId: r.refundId, refundNote: r.refundNote, classification: r.classification }));
    });

    let outcome;
    if (result.unresolved.length === 0) outcome = 'resolved';
    else if (result.stoppedByDeadline) outcome = 'deadline_reached_unresolved';
    else if (result.checks >= result.maxChecks) outcome = 'check_limit_reached_unresolved';
    else outcome = 'unresolved';

    return {
        timestamp: new Date(endedAtMs).toISOString(),
        elapsedMs: endedAtMs - startedAtMs,
        checks: result.checks,
        outcome,
        escalate: result.escalate,
        refs,
    };
}

export async function appendMonitorReport(report, {
    reportDir = process.env.SANDBOX_REPORT_DIR || DEFAULT_REPORT_DIR,
    fsImpl = fs,
} = {}) {
    try {
        await fsImpl.promises.mkdir(reportDir, { recursive: true });
        await fsImpl.promises.appendFile(path.join(reportDir, REPORT_FILE_NAME), JSON.stringify(report) + '\n', 'utf8');
        return { written: true, file: REPORT_FILE_NAME };
    } catch (error) {
        // Explicit failure: the caller must surface it. It is never swallowed.
        throw Object.assign(new Error(`Sandbox report write failed (${error.code || 'UNKNOWN'}).`), { code: 'REPORT_WRITE_FAILED' });
    }
}

/*
 * Runs the monitor and persists one report line. A write failure is returned
 * explicitly, and the CLI exits non-zero.
 */
export async function runMonitorWithReport(orderIds, options = {}) {
    const startedAtMs = (options.clock ?? (() => Date.now()))();
    const result = await monitorSandboxRefunds(orderIds, options);
    const report = buildMonitorReport(result, { startedAtMs, endedAtMs: (options.clock ?? (() => Date.now()))() });

    try {
        const written = await appendMonitorReport(report, { reportDir: options.reportDir, fsImpl: options.fsImpl });
        return { result, report, reportWritten: written.written, reportError: null };
    } catch (error) {
        return { result, report, reportWritten: false, reportError: error.code };
    }
}

export function parseArgs(argv) {
    const orderIds = [];
    let maxChecks = DEFAULT_MAX_CHECKS;
    let intervalMs = DEFAULT_INTERVAL_MS;
    let maxHours = DEFAULT_MAX_HOURS;
    for (const arg of argv) {
        if (arg.startsWith('--max-hours=')) maxHours = Number(arg.split('=')[1]);
        else if (arg.startsWith('--max-checks=')) maxChecks = Number(arg.split('=')[1]);
        else if (arg.startsWith('--interval-ms=')) intervalMs = Number(arg.split('=')[1]);
        else if (arg.startsWith('--')) throw new Error(`ABORT: unknown option ${arg.split('=')[0]}.`);
        else orderIds.push(arg);
    }
    if (!Number.isInteger(maxChecks) || maxChecks < 1 || maxChecks > 100) throw new Error('ABORT: --max-checks must be 1 to 100.');
    if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new Error('ABORT: --interval-ms must be at least 1000.');
    if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > 168) throw new Error('ABORT: --max-hours must be greater than 0 and at most 168.');
    return { orderIds, maxChecks, intervalMs, maxHours };
}

// Runs only when executed directly, never when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { orderIds, maxChecks, intervalMs, maxHours } = parseArgs(process.argv.slice(2));
    runMonitorWithReport(orderIds, { maxChecks, intervalMs, maxHours })
        .then(({ result, report, reportWritten, reportError }) => {
            console.log(JSON.stringify({ ...result, report, reportWritten }, null, 2));
            if (reportError) {
                console.error(`Report not persisted: ${reportError}`);
                process.exitCode = 2;
            }
        })
        .catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
}
