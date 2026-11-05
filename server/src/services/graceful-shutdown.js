/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
| On SIGINT or SIGTERM:
|   1. stop accepting new HTTP connections;
|   2. close idle keep-alive connections, sweeping until the server has closed;
|   3. wait for in-flight requests to finish, up to the drain timeout;
|   4. after the timeout, force-close the remaining connections and log [HIGH];
|   5. stop background workers, each bounded by the step timeout;
|   6. close the database pool, bounded by the step timeout;
|   7. exit with 0 on success, or 1 if any step failed, timed out, or hung.
|
| The returned function is idempotent: a second signal during shutdown returns
| the same pending result and starts no overlapping cleanup. Every timer the
| shutdown depends on is referenced, so the process cannot exit silently while
| cleanup is still pending.
|--------------------------------------------------------------------------
*/

export const DEFAULT_DRAIN_TIMEOUT_MS = 25000;
export const MAX_DRAIN_TIMEOUT_MS = 120000;
export const STEP_TIMEOUT_CODE = 'SHUTDOWN_STEP_TIMEOUT';

// Connections accepted just before shutdown may have request bytes still unread.
// Idle sockets are closed only after this grace period, so those bytes are read and
// served first. Requests arriving after the grace period can still be dropped.
export const IDLE_CLOSE_GRACE_MS = 500;

// Node's server.close() closes idle sockets immediately, and a connection that is
// accepted but whose bytes are not yet read counts as idle. Waiting briefly before
// closing the listener lets the event loop accept pending connections and read their
// request bytes, so those requests become active and are served.
export const ACCEPT_GRACE_MS = 200;

export function parseDrainTimeoutMs(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_DRAIN_TIMEOUT_MS;
    }
    const value = Number(String(raw).trim());
    if (!Number.isInteger(value) || value < 1000 || value > MAX_DRAIN_TIMEOUT_MS) {
        throw new Error(`SHUTDOWN_DRAIN_TIMEOUT_MS must be an integer between 1000 and ${MAX_DRAIN_TIMEOUT_MS} milliseconds.`);
    }
    return value;
}

// Resolves or rejects with the step's own result, or rejects with STEP_TIMEOUT_CODE.
async function boundedStep(promise, ms, name) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            reject(Object.assign(new Error(`${name} did not finish within ${ms} ms.`), { code: STEP_TIMEOUT_CODE }));
        }, ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export function createGracefulShutdown({
    server,
    stopWorkers,
    closePool,
    exit = process.exit,
    log = console,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
}) {
    let pending = null;

    return function shutdown(signal) {
        if (pending) return pending;

        pending = (async () => {
            log.log(`Received ${signal}; draining HTTP connections.`);

            // Responses sent while draining ask the client to close the connection, so
            // keep-alive sockets end after their current request. prependListener runs
            // before the application's own request handler.
            const markClose = (req, res) => {
                if (!res.headersSent) res.setHeader('Connection', 'close');
            };
            server.prependListener('request', markClose);

            await new Promise(resolve => setTimeout(resolve, ACCEPT_GRACE_MS));

            const closed = new Promise(resolve => server.close(() => resolve(true)));

            // Do not close idle sockets immediately: a request may already be on the wire.
            // After the grace period, sweep idle sockets so the drain does not wait for
            // the keep-alive timeout.
            let idleSweep = null;
            const graceTimer = setTimeout(() => {
                idleSweep = setInterval(() => server.closeIdleConnections?.(), 100);
            }, IDLE_CLOSE_GRACE_MS);
            closed.then(() => {
                clearTimeout(graceTimer);
                clearInterval(idleSweep);
            });

            // Drain phase: wait for in-flight requests, or force-close after the deadline.
            let forced = false;
            let drainTimer = null;
            const drainDeadline = new Promise(resolve => {
                drainTimer = setTimeout(() => {
                    forced = true;
                    server.closeAllConnections?.();
                    resolve(false);
                }, drainTimeoutMs);
            });

            await Promise.race([closed, drainDeadline]);
            clearTimeout(drainTimer);
            await closed;

            if (forced) {
                log.error(`[HIGH] Drain timeout after ${drainTimeoutMs} ms; remaining connections were force-closed. Check for slow requests.`);
            }

            // Cleanup phase: workers first, then the pool. Each step is bounded.
            // If workers do not stop in time, the pool is still closed so the process can exit.
            // Any in-flight worker run then fails, and its claim expires into reconciliation.
            const errors = [];
            try {
                await boundedStep(Promise.resolve().then(() => stopWorkers()), drainTimeoutMs, 'Worker shutdown');
            } catch (error) {
                errors.push(error.code || 'WORKER_SHUTDOWN_ERROR');
                log.error(`[HIGH] Worker shutdown failed: ${error.code || 'WORKER_SHUTDOWN_ERROR'}.`);
            }

            try {
                await boundedStep(Promise.resolve().then(() => closePool()), drainTimeoutMs, 'Database pool shutdown');
            } catch (error) {
                errors.push(error.code || 'POOL_SHUTDOWN_ERROR');
                log.error(`[HIGH] Database pool shutdown failed: ${error.code || 'POOL_SHUTDOWN_ERROR'}.`);
            }

            const errorCode = errors.length ? errors.join(',') : null;
            const result = { drained: !forced, forced, errorCode };
            exit(errorCode ? 1 : 0);
            return result;
        })();

        return pending;
    };
}
