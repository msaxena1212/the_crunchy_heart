/*
|--------------------------------------------------------------------------
| Worker Registry
|--------------------------------------------------------------------------
| Starts, stops and reports the background workers. Every worker is disabled
| unless its environment flag is exactly 'true'. The registry only schedules
| work. Business logic stays in the services (sweeps, alerts), and every
| sweep keeps its own advisory lock and claim fencing.
|
| Guarantees:
|   - Starting a worker name twice returns the existing handle. No second timer.
|   - A worker never overlaps itself inside one process.
|   - A failing run is logged at high severity and the next tick still runs.
|   - stopWorker/stopAllWorkers wait for an in-flight run to finish.
|--------------------------------------------------------------------------
*/

import { redactErrorText } from './ops-alert.service.js';

export const WORKER_FLAGS = Object.freeze({
    reconciliation_sweep: 'RECONCILIATION_WORKER_ENABLED',
    refund_sweep: 'REFUND_WORKER_ENABLED',
    operational_alerts: 'OPS_ALERTS_ENABLED',
    inventory_hold_expiry: 'INVENTORY_HOLD_WORKER_ENABLED',
});

export const DEFAULT_WORKER_INTERVAL_MS = 60 * 1000;

const workers = new Map();

export function workerEnabled(name, env = process.env) {
    const flag = WORKER_FLAGS[name];
    if (!flag) {
        throw new Error(`Unknown worker: ${name}`);
    }
    return env[flag] === 'true';
}

export function startWorker({ name, run, intervalMs = DEFAULT_WORKER_INTERVAL_MS }) {
    if (!WORKER_FLAGS[name]) {
        throw new Error(`Unknown worker: ${name}`);
    }

    if (workers.has(name)) {
        return workers.get(name);
    }

    const state = {
        name,
        intervalMs,
        runs: 0,
        running: false,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastResult: null,
        lastError: null,
        consecutiveFailures: 0,
        stopped: false,
    };

    let inFlight = null;

    const tick = () => {
        if (state.running || state.stopped) return;

        state.running = true;
        state.lastStartedAt = new Date().toISOString();

        inFlight = (async () => {
            try {
                const result = await run();
                state.lastResult = summarise(result);
                state.lastError = null;
                state.consecutiveFailures = 0;
            } catch (error) {
                state.lastError = `${error.code || 'WORKER_ERROR'}: ${String(error.message).slice(0, 200)}`;
                state.consecutiveFailures += 1;
                console.error(`[HIGH] Worker ${name} run failed (${state.consecutiveFailures} in a row):`, state.lastError);
            } finally {
                state.runs += 1;
                state.lastFinishedAt = new Date().toISOString();
                state.running = false;
            }
        })();

        return inFlight;
    };

    const timer = setInterval(tick, intervalMs);
    timer.unref?.();

    const handle = {
        state: () => ({ ...state }),

        async stop() {
            state.stopped = true;
            clearInterval(timer);
            if (inFlight) {
                await inFlight;
            }
            workers.delete(name);
        },

        // Test hook: run one tick now and wait for it.
        async runOnce() {
            await tick();
        },
    };

    workers.set(name, handle);
    return handle;
}

export async function stopWorker(name) {
    const handle = workers.get(name);
    if (handle) {
        await handle.stop();
    }
}

export async function stopAllWorkers() {
    for (const name of [...workers.keys()]) {
        await stopWorker(name);
    }
}

export function workerHealth() {
    return Object.keys(WORKER_FLAGS).map(name => {
        const handle = workers.get(name);
        return {
            name,
            flag: WORKER_FLAGS[name],
            enabled: workerEnabled(name),
            started: Boolean(handle),
            state: handle ? redactState(handle.state()) : null,
        };
    });
}

// Error text is redacted before it leaves the process.
function redactState(state) {
    return { ...state, lastError: state.lastError ? redactErrorText(state.lastError) : null };
}

// Keep health output small and free of anything sensitive.
function summarise(result) {
    if (!result || typeof result !== 'object') return null;
    const out = {};
    if ('skipped' in result) out.skipped = Boolean(result.skipped);
    if (Array.isArray(result.results)) out.processed = result.results.length;
    if (typeof result.raised === 'number') out.raised = result.raised;
    if (typeof result.delivered === 'number') out.delivered = result.delivered;
    if (typeof result.failed === 'number') out.failed = result.failed;
    return out;
}
