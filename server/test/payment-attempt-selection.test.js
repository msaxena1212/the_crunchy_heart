/**
 * The Crunchy Heart - Authoritative payment attempt selection
 *
 * An order can have several payment rows (create attempt, retries, reconciliation outcomes).
 * These tests pin the selection rules, then check the replay, details, and payment-status
 * endpoints against real rows. The Cashfree API is mocked at the fetch boundary and every
 * provider call is counted. No live endpoint is reachable.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

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
process.env.CASHFREE_CLIENT_ID = 'TEST_SELECTION_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_SELECTION_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'TEST_SELECTION_ORDER_TOKEN_SECRET_0123456789abcdef';
process.env.OWNER_SESSION_SECRET = 'TEST_SELECTION_OWNER_SESSION_SECRET_0123456789ab';
process.env.RECOVERY_CODE_SECRET = 'TEST_SELECTION_RECOVERY_CODE_SECRET_0123456789abcdef';

const { query, pool } = await import('../src/db/pool.js');
const { createOrder } = await import('../src/services/order.service.js');
const { summarizeAttempts, ATTEMPT_STATE } = await import('../src/services/payment-creation.service.js');
const { generateGuestAccessToken } = await import('../src/utils/order-token.js');
const { default: orderRoutes } = await import('../src/routes/order.routes.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// 1. Pure rules
// ---------------------------------------------------------------------------

const T = minutesAgo => new Date(Date.now() - minutesAgo * 60000).toISOString();
const session = id => ({ payment_session_id: `sess_${id}` });
const row = (id, fields) => ({
    id,
    provider: 'cashfree',
    provider_order_id: `ord-${id}`,
    status: 'created',
    gateway_status: 'ORDER_CREATED',
    raw_response: session(id),
    created_at: T(10),
    ...fields,
});

describe('summarizeAttempts: pure selection rules', () => {
    test('1. No rows: NO_ATTEMPT with no authoritative row', () => {
        const s = summarizeAttempts([]);
        assert.equal(s.state, ATTEMPT_STATE.NO_ATTEMPT);
        assert.equal(s.authoritative, null);
    });

    test('2. A paid row wins over a stale live session; the live session is reported as a reason', () => {
        const paid = row('p', { status: 'paid', created_at: T(1) });
        const stale = row('s', { created_at: T(30) });
        const s = summarizeAttempts([stale, paid]);
        assert.equal(s.state, ATTEMPT_STATE.PAID);
        assert.equal(s.authoritative.id, 'p');
        assert.ok(s.reasons.includes('LIVE_SESSION_ON_PAID_ORDER'));
    });

    test('3. Two live sessions: CONFLICT, which fails closed', () => {
        const s = summarizeAttempts([row('a', { created_at: T(20) }), row('b', { created_at: T(5) })]);
        assert.equal(s.state, ATTEMPT_STATE.CONFLICT);
        assert.ok(s.reasons.includes('MULTIPLE_LIVE_SESSIONS'));
    });

    test('4. An ambiguous attempt beside a live session: UNRESOLVED, the live session is authoritative', () => {
        const ambiguous = row('amb', { gateway_status: 'GATEWAY_AMBIGUOUS_TIMEOUT', raw_response: null, created_at: T(3) });
        const live = row('live', { created_at: T(20) });
        const s = summarizeAttempts([ambiguous, live]);
        assert.equal(s.state, ATTEMPT_STATE.UNRESOLVED);
        assert.equal(s.authoritative.id, 'live');
    });

    test('5. Only an ambiguous attempt: UNRESOLVED, and the ambiguous attempt is the one reported', () => {
        const s = summarizeAttempts([row('amb', { gateway_status: 'GATEWAY_AMBIGUOUS_TIMEOUT', raw_response: null })]);
        assert.equal(s.state, ATTEMPT_STATE.UNRESOLVED);
        assert.equal(s.authoritative.id, 'amb');
    });

    test('6. A legacy CASHFREE_PENDING row with no provider id is UNRESOLVED', () => {
        const legacy = row('legacy', { gateway_status: 'CASHFREE_PENDING', provider_order_id: null, raw_response: null });
        const s = summarizeAttempts([legacy]);
        assert.equal(s.state, ATTEMPT_STATE.UNRESOLVED);
    });

    test('7. Exactly one live session and nothing unresolved: RESUMABLE', () => {
        const s = summarizeAttempts([row('old-rej', { gateway_status: 'CREATION_REJECTED', raw_response: null, created_at: T(1) }), row('live', { created_at: T(20) })]);
        assert.equal(s.state, ATTEMPT_STATE.RESUMABLE);
        assert.equal(s.authoritative.id, 'live', 'a newer rejected row never overrides the live session');
    });

    test('8. Only rejected or closed attempts: NO_LIVE, reporting the newest row', () => {
        const s = summarizeAttempts([
            row('r1', { gateway_status: 'CREATION_REJECTED', raw_response: null, created_at: T(30) }),
            row('r2', { gateway_status: 'CREATE_NOT_SUBMITTED', raw_response: null, created_at: T(2) }),
        ]);
        assert.equal(s.state, ATTEMPT_STATE.NO_LIVE);
        assert.equal(s.authoritative.id, 'r2');
    });

    test('9. An unclaimed create row (CREATE_PENDING) is not unresolved: it has not reached the provider', () => {
        const s = summarizeAttempts([row('pending', { gateway_status: 'CREATE_PENDING', provider_order_id: null, raw_response: null })]);
        assert.notEqual(s.state, ATTEMPT_STATE.UNRESOLVED);
    });

    test('10. The result does not depend on row order', () => {
        const rows = [
            row('a', { created_at: T(40) }),
            row('amb', { gateway_status: 'GATEWAY_AMBIGUOUS_TIMEOUT', raw_response: null, created_at: T(3) }),
            row('r', { gateway_status: 'CREATION_REJECTED', raw_response: null, created_at: T(8) }),
        ];
        const forward = summarizeAttempts(rows);
        const reversed = summarizeAttempts([...rows].reverse());
        assert.equal(forward.state, reversed.state);
        assert.equal(forward.authoritative.id, reversed.authoritative.id);
    });
});

// ---------------------------------------------------------------------------
// 2. Endpoints against real rows
// ---------------------------------------------------------------------------

const providerPosts = [];
const providerGets = [];
globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('cashfree.com')) return originalFetch(url, options);
    const method = (options.method || 'GET').toUpperCase();
    if (method === 'POST' && u.endsWith('/pg/orders')) {
        providerPosts.push(JSON.parse(options.body || '{}').order_id);
        return new Response(JSON.stringify({ message: 'selection tests must not create provider orders' }), { status: 500 });
    }
    if (method === 'GET' && /\/pg\/orders\//.test(u)) {
        providerGets.push(u);
        return new Response(JSON.stringify({ message: 'Resource Not found' }), { status: 404 });
    }
    return new Response('{}', { status: 404 });
};

let baseUrl;
let server;
let testProductId;
const createdOrderIds = [];

async function createVariant() {
    const v = await query(
        `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, flavor,
                                       mrp, selling_price, cost_price, tax_rate, is_active)
         VALUES ($1, $2, 'Selection Test', 100, 'Salt', 200, 100, 50, 18, true) RETURNING id`,
        [testProductId, `SEL-${rand()}`]
    );
    await query(`INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, 500, 0, 5)`, [v.rows[0].id]);
    return v.rows[0].id;
}

// Creates an ONLINE order. Its first row is CREATE_PENDING, and the tests reshape it below.
async function onlineOrder() {
    const name = `Selection ${rand()}`;
    const variantId = await createVariant();
    const idempotencyKey = `sel-${rand()}-${Date.now()}`;
    const created = await createOrder({
        customer: { name, phone: '9876543210', email: `selection-${rand().toLowerCase()}@example.test` },
        shippingAddress: { name, phone: '9876543210', addressLine1: '1 Selection Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', country: 'India' },
        items: [{ variantId, quantity: 1 }],
        paymentMethod: 'ONLINE',
        idempotencyKey,
    });
    createdOrderIds.push(created.order.id);
    const order = (await query(`SELECT * FROM orders WHERE id = $1`, [created.order.id])).rows[0];
    // Replay verifies the token against the mapped order (as createOrder returns it).
    // Details verifies against the stored row. Each endpoint gets the token it verifies.
    return {
        order,
        token: generateGuestAccessToken(order),
        replayToken: generateGuestAccessToken(created.order),
        idempotencyKey,
    };
}

async function insertAttempt(orderId, orderNumber, { gateway, status = 'created', session: sessionId = null, createdMinutesAgo = 10 }) {
    const providerOrderId = `${orderNumber}-T${rand()}`;
    const raw = sessionId ? JSON.stringify({ payment_session_id: sessionId }) : null;
    await query(
        `INSERT INTO payments (order_id, provider, provider_order_id, amount, currency, status, gateway_status,
                               payment_method, raw_response, created_at, updated_at)
         VALUES ($1, 'cashfree', $2, 100, 'INR', $3, $4, 'ONLINE', $5::jsonb,
                 NOW() - ($6::int * INTERVAL '1 minute'), NOW() - ($6::int * INTERVAL '1 minute'))`,
        [orderId, providerOrderId, status, gateway, raw, createdMinutesAgo]
    );
    return providerOrderId;
}

// Removes the claim row that createOrder created, so each test controls every row it sees.
async function clearRows(orderId) {
    await query(`DELETE FROM payments WHERE order_id = $1`, [orderId]);
}

async function replay(order, token, idempotencyKey) {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            'x-guest-access-token': token,
        },
        body: JSON.stringify({
            customer: { name: order.customer_name, phone: order.phone, email: order.email },
            shippingAddress: order.shipping_address,
            items: (await query(`SELECT variant_id AS "variantId", quantity FROM order_items WHERE order_id = $1`, [order.id])).rows,
            paymentMethod: 'ONLINE',
        }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('Replay, details, and payment status use the authoritative attempt', () => {
    before(async () => {
        const cat = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Selection Category', 'selection-cat-' || gen_random_uuid(), 'Selection', true) RETURNING id`
        );
        const prod = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Selection Product', 'selection-prod-' || gen_random_uuid(), 'The Crunchy Heart', true) RETURNING id`,
            [cat.rows[0].id]
        );
        testProductId = prod.rows[0].id;

        const app = express();
        app.use(express.json());
        app.use('/api/orders', orderRoutes);
        app.use((error, req, res, next) => {
            res.status(error.statusCode || 500).json({ success: false, code: error.code, message: error.message });
        });
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        globalThis.fetch = originalFetch;
        await new Promise(resolve => server.close(resolve));
        for (const id of createdOrderIds) {
            await query(`DELETE FROM inventory_transactions WHERE reference_id = $1`, [id]);
            await query(`DELETE FROM payments WHERE order_id = $1`, [id]);
            await query(`DELETE FROM order_items WHERE order_id = $1`, [id]);
            await query(`DELETE FROM orders WHERE id = $1`, [id]);
        }
        await pool.end().catch(() => {});
    });

    test('11. A stale rejected row never hides the live session on replay; no provider call is made', async () => {
        const { order, token, replayToken, idempotencyKey } = await onlineOrder();
        await clearRows(order.id);
        await insertAttempt(order.id, order.order_number, { gateway: 'ORDER_CREATED', session: `sess_live_${order.order_number}`, createdMinutesAgo: 30 });
        await insertAttempt(order.id, order.order_number, { gateway: 'CREATION_REJECTED', createdMinutesAgo: 1 });

        const res = await replay(order, replayToken, idempotencyKey);
        assert.equal(res.status, 200);
        assert.equal(res.body.cashfree.paymentSessionId, `sess_live_${order.order_number}`);
        assert.equal(providerPosts.filter(id => id === order.order_number).length, 0);
    });

    test('12. Two live sessions: replay fails closed with PAYMENT_STATE_CONFLICT and returns no session', async () => {
        const { order, token, replayToken, idempotencyKey } = await onlineOrder();
        await clearRows(order.id);
        await insertAttempt(order.id, order.order_number, { gateway: 'ORDER_CREATED', session: 'sess_a', createdMinutesAgo: 20 });
        await insertAttempt(order.id, order.order_number, { gateway: 'ORDER_CREATED', session: 'sess_b', createdMinutesAgo: 5 });

        const res = await replay(order, replayToken, idempotencyKey);
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'PAYMENT_STATE_CONFLICT');
        assert.equal(res.body.cashfree, undefined, 'no session is returned in conflict');
    });

    test('13. A paid row: replay returns the paid status and no payment session', async () => {
        const { order, token, replayToken, idempotencyKey } = await onlineOrder();
        await clearRows(order.id);
        await insertAttempt(order.id, order.order_number, { gateway: 'ORDER_CREATED', session: 'sess_stale', createdMinutesAgo: 30 });
        await insertAttempt(order.id, order.order_number, { gateway: 'ORDER_CREATED', status: 'paid', session: 'sess_paid', createdMinutesAgo: 2 });

        const res = await replay(order, replayToken, idempotencyKey);
        assert.equal(res.status, 200);
        assert.equal(res.body.paymentStatus, 'paid');
        assert.equal(res.body.cashfree, undefined, 'a paid order never returns a session');
    });

    test('14. An ambiguous attempt beside a rejected one: replay answers 202 and creates nothing', async () => {
        const { order, token, replayToken, idempotencyKey } = await onlineOrder();
        await clearRows(order.id);
        await insertAttempt(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT', createdMinutesAgo: 6 });
        await insertAttempt(order.id, order.order_number, { gateway: 'CREATION_REJECTED', createdMinutesAgo: 1 });

        const res = await replay(order, replayToken, idempotencyKey);
        assert.equal(res.status, 202);
        assert.equal(res.body.code, 'GATEWAY_AMBIGUOUS_TIMEOUT');
        assert.equal(providerPosts.filter(id => id === order.order_number).length, 0);
    });

    test('15. Details report the authoritative state and do not offer a retry while an attempt is unresolved', async () => {
        const { order, token } = await onlineOrder();
        await clearRows(order.id);
        await insertAttempt(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT', createdMinutesAgo: 6 });
        await insertAttempt(order.id, order.order_number, { gateway: 'CREATION_REJECTED', createdMinutesAgo: 1 });

        const res = await fetch(`${baseUrl}/api/orders/${order.order_number}`, { headers: { 'x-guest-access-token': token } });
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.paymentState, 'UNRESOLVED');
        assert.equal(body.canRetry, false, 'the retry button must match the server refusal');
    });

    test('16. Details offer a retry when no attempt is live or unresolved', async () => {
        const { order, token } = await onlineOrder();
        await clearRows(order.id);
        await insertAttempt(order.id, order.order_number, { gateway: 'CREATION_REJECTED', createdMinutesAgo: 1 });

        const res = await fetch(`${baseUrl}/api/orders/${order.order_number}`, { headers: { 'x-guest-access-token': token } });
        const body = await res.json();
        assert.equal(body.paymentState, 'NO_LIVE');
        assert.equal(body.canRetry, true);
    });

    test('17. Two replays at once with one live session return the same session and call no provider', async () => {
        const { order, token, replayToken, idempotencyKey } = await onlineOrder();
        await clearRows(order.id);
        await insertAttempt(order.id, order.order_number, { gateway: 'ORDER_CREATED', session: `sess_conc_${order.order_number}`, createdMinutesAgo: 10 });

        const [a, b] = await Promise.all([replay(order, replayToken, idempotencyKey), replay(order, replayToken, idempotencyKey)]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(a.body.cashfree.paymentSessionId, b.body.cashfree.paymentSessionId);
        assert.equal(providerPosts.filter(id => id === order.order_number).length, 0);
    });
});
