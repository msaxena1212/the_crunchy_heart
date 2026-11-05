/**
 * The Crunchy Heart - Graceful shutdown with real HTTP connections
 *
 * Uses a local Express app on an ephemeral loopback port. No database, provider,
 * or mail call is made. Workers and the pool are replaced by spies.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const {
    createGracefulShutdown,
    parseDrainTimeoutMs,
    DEFAULT_DRAIN_TIMEOUT_MS,
} = await import('../src/services/graceful-shutdown.js');

function silentLog() {
    const entries = [];
    return {
        entries,
        log: (...args) => entries.push(['log', ...args]),
        error: (...args) => entries.push(['error', ...args]),
    };
}

function startApp(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => {
            resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

describe('Graceful shutdown', () => {
    test('1. Drain timeout defaults to 25 seconds and rejects invalid values', () => {
        assert.equal(DEFAULT_DRAIN_TIMEOUT_MS, 25000);
        assert.equal(parseDrainTimeoutMs(undefined), 25000);
        assert.equal(parseDrainTimeoutMs('5000'), 5000);
        for (const bad of ['abc', '500', '999999', '1.5', '-1']) {
            assert.throws(() => parseDrainTimeoutMs(bad), /SHUTDOWN_DRAIN_TIMEOUT_MS/, `value ${bad}`);
        }
    });

    test('2. An in-flight request completes before workers stop and the pool closes', async () => {
        const app = express();
        let markStarted;
        const handlerStarted = new Promise(resolve => { markStarted = resolve; });
        const order = [];
        app.get('/slow', (req, res) => {
            markStarted();
            // Record completion on the server side: the response has been fully handed off.
            res.on('finish', () => order.push('response-sent'));
            setTimeout(() => res.json({ ok: true }), 300);
        });
        const { server, baseUrl } = await startApp(app);

        const inFlight = fetch(`${baseUrl}/slow`).then(async r => ({ status: r.status, body: await r.json() }));

        // Shut down only once the handler is running, so the request is genuinely in flight.
        await handlerStarted;
        const logger = silentLog();
        const shutdown = createGracefulShutdown({
            server,
            stopWorkers: async () => { order.push('workers-stopped'); },
            closePool: async () => { order.push('pool-closed'); },
            exit: code => { order.push(`exit-${code}`); },
            log: logger,
            drainTimeoutMs: 5000,
        });

        const result = await shutdown('SIGTERM');
        const response = await inFlight;

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { ok: true });
        assert.equal(result.drained, true);
        assert.equal(result.forced, false);
        assert.deepEqual(order, ['response-sent', 'workers-stopped', 'pool-closed', 'exit-0']);
    });

    test('3. New connections are refused once shutdown has begun', async () => {
        const app = express();
        app.get('/ping', (req, res) => res.json({ pong: true }));
        const { server, baseUrl } = await startApp(app);

        const shutdown = createGracefulShutdown({
            server,
            stopWorkers: async () => {},
            closePool: async () => {},
            exit: () => {},
            log: silentLog(),
            drainTimeoutMs: 5000,
        });
        await shutdown('SIGINT');

        await assert.rejects(() => fetch(`${baseUrl}/ping`));
    });

    test('4. A hung request is force-closed after the timeout and recorded as forced', async () => {
        const app = express();
        let markStarted;
        const handlerStarted = new Promise(resolve => { markStarted = resolve; });
        app.get('/hang', () => { markStarted(); /* never responds */ });
        const { server, baseUrl } = await startApp(app);

        const hung = fetch(`${baseUrl}/hang`).catch(error => ({ failed: true, name: error.name }));
        // Shut down only once the handler is running, so the request is genuinely in flight.
        await handlerStarted;

        const logger = silentLog();
        const exits = [];
        const shutdown = createGracefulShutdown({
            server,
            stopWorkers: async () => {},
            closePool: async () => {},
            exit: code => exits.push(code),
            log: logger,
            drainTimeoutMs: 1000,
        });

        const result = await shutdown('SIGTERM');
        const outcome = await hung;

        assert.equal(result.forced, true);
        assert.equal(result.drained, false);
        assert.equal(outcome.failed, true, 'the hung client sees its connection closed');
        assert.deepEqual(exits, [0]);
        assert.ok(logger.entries.some(e => e[0] === 'error' && String(e[1]).includes('[HIGH] Drain timeout')));
    });

    test('5. Repeated signals share one shutdown and exit once', async () => {
        const app = express();
        const { server } = await startApp(app);

        let stops = 0;
        const exits = [];
        const shutdown = createGracefulShutdown({
            server,
            stopWorkers: async () => { stops += 1; },
            closePool: async () => {},
            exit: code => exits.push(code),
            log: silentLog(),
            drainTimeoutMs: 5000,
        });

        const first = shutdown('SIGTERM');
        const second = shutdown('SIGINT');
        await Promise.all([first, second]);

        assert.equal(stops, 1);
        assert.deepEqual(exits, [0]);
    });

    test('6. A failure while stopping workers or closing the pool exits non-zero', async () => {
        const app = express();
        const { server } = await startApp(app);

        const exits = [];
        const logger = silentLog();
        const shutdown = createGracefulShutdown({
            server,
            stopWorkers: async () => {},
            closePool: async () => { throw Object.assign(new Error('pool busy'), { code: 'POOL_BUSY' }); },
            exit: code => exits.push(code),
            log: logger,
            drainTimeoutMs: 5000,
        });

        const result = await shutdown('SIGTERM');

        assert.equal(result.errorCode, 'POOL_BUSY');
        assert.deepEqual(exits, [1]);
        assert.ok(logger.entries.some(e => e[0] === 'error'));
    });

    test('7. A hung worker stop is bounded: the pool still closes and the process exits non-zero', async () => {
        const app = express();
        const { server } = await startApp(app);

        const order = [];
        const exits = [];
        const logger = silentLog();
        const started = Date.now();
        const shutdown = createGracefulShutdown({
            server,
            stopWorkers: () => new Promise(() => {}),
            closePool: async () => { order.push('pool-closed'); },
            exit: code => exits.push(code),
            log: logger,
            drainTimeoutMs: 1000,
        });

        const result = await shutdown('SIGTERM');

        assert.equal(result.errorCode, 'SHUTDOWN_STEP_TIMEOUT');
        assert.deepEqual(exits, [1]);
        assert.deepEqual(order, ['pool-closed'], 'pool is still closed after a worker timeout');
        assert.ok(Date.now() - started < 5000, 'shutdown stays bounded');
        assert.ok(logger.entries.some(e => e[0] === 'error' && String(e[1]).includes('[HIGH] Worker shutdown failed')));
    });

    test('8. A hung pool close is bounded and the process exits non-zero', async () => {
        const app = express();
        const { server } = await startApp(app);

        const exits = [];
        const started = Date.now();
        const shutdown = createGracefulShutdown({
            server,
            stopWorkers: async () => {},
            closePool: () => new Promise(() => {}),
            exit: code => exits.push(code),
            log: silentLog(),
            drainTimeoutMs: 1000,
        });

        const result = await shutdown('SIGINT');

        assert.equal(result.errorCode, 'SHUTDOWN_STEP_TIMEOUT');
        assert.deepEqual(exits, [1]);
        assert.ok(Date.now() - started < 5000, 'shutdown stays bounded');
    });

    test('9. A complete request already on the wire when shutdown starts is served, not dropped', async () => {
        const net = await import('node:net');
        const app = express();
        app.post('/order', (req, res) => {
            res.end('served');
        });
        const { server, baseUrl } = await startApp(app);
        const port = new URL(baseUrl).port;

        const socket = net.default.connect(Number(port), '127.0.0.1');
        socket.on('error', () => {});
        let received = '';
        socket.on('data', chunk => { received += chunk.toString(); });
        await new Promise(resolve => socket.on('connect', resolve));

        // Write a complete request, then begin shutdown in the same turn, before the
        // server has necessarily read the bytes.
        socket.write('POST /order HTTP/1.1\r\nHost: test\r\nContent-Length: 2\r\n\r\nhi');
        const shutdown = createGracefulShutdown({
            server,
            stopWorkers: async () => {},
            closePool: async () => {},
            exit: () => {},
            log: silentLog(),
            drainTimeoutMs: 5000,
        });
        await shutdown('SIGTERM');

        // The client's data event can fire after shutdown resolves, so wait for it (bounded).
        const deadline = Date.now() + 2000;
        while (!received.includes('served') && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(received.includes('served'), 'the request bytes were read and answered');
        socket.destroy();
    });

    test('10. A request arriving during the drain is answered with Connection: close', async () => {
        const app = express();
        app.get('/during', (req, res) => res.json({ ok: true }));
        const { server, baseUrl } = await startApp(app);

        // A keep-alive socket is established before shutdown, so the request during the
        // drain travels on a connection that is already open. A brand-new connection
        // accepted just before shutdown could be closed as idle before its bytes are read.
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        const get = () => new Promise((resolve, reject) => {
            const req = http.get(`${baseUrl}/during`, { agent }, res => {
                res.resume();
                res.on('end', () => resolve(res));
            });
            req.on('error', reject);
        });
        const before = await get();
        assert.equal(before.statusCode, 200);

        const shutdown = createGracefulShutdown({
            server,
            stopWorkers: async () => {},
            closePool: async () => {},
            exit: () => {},
            log: silentLog(),
            drainTimeoutMs: 5000,
        });
        // Marking starts synchronously when shutdown begins, so a request sent right
        // after this call is answered with Connection: close.
        const drained = shutdown('SIGTERM');

        const during = await get();
        assert.equal(during.statusCode, 200);
        assert.match(during.headers.connection || '', /close/i);
        agent.destroy();
        await drained;
    });
});
