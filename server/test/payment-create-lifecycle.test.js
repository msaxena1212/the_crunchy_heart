/**
 * The Crunchy Heart - Cashfree create-order lifecycle (crash safety)
 *
 * Covers POST /api/orders/create and the retry path when the provider outcome is unknown:
 * timeouts, persistence failures after provider success, definitive refusals, concurrent
 * requests, stale owners, provider lookup, and legacy create rows.
 *
 * The Cashfree API is mocked at the global fetch boundary. Every provider call is counted per
 * merchant order_id, and the tests assert exact counts. No live endpoint is reachable.
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
process.env.CASHFREE_CLIENT_ID = 'TEST_LIFECYCLE_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_LIFECYCLE_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'TEST_LIFECYCLE_ORDER_TOKEN_SECRET_0123456789abcdef';
process.env.OWNER_SESSION_SECRET = 'TEST_LIFECYCLE_OWNER_SESSION_SECRET_0123456789ab';
process.env.RECOVERY_CODE_SECRET = 'TEST_LIFECYCLE_RECOVERY_CODE_SECRET_0123456789abcdef';

const { query, pool } = await import('../src/db/pool.js');
const { createOrder } = await import('../src/services/order.service.js');
const { reconcilePaymentAttempt } = await import('../src/services/reconciliation.service.js');
const { generateGuestAccessToken } = await import('../src/utils/order-token.js');
const { default: orderRoutes } = await import('../src/routes/order.routes.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const originalFetch = globalThis.fetch;

/*
 * Provider mock.
 *   plansByName: a plan keyed by customer name, applied to the next create only. The name is
 *                the only value known before the server assigns the order number.
 *   plans:       the plan for each merchant order_id, used by the create and by lookups.
 *   hung:        a create held until the test releases it, keyed by merchant order_id.
 */
const provider = {
    plansByName: new Map(),
    plans: new Map(),
    posts: new Map(),
    gets: new Map(),
    hung: new Map(),
    hangingOrderId: null,
    getSession: new Map(),
};

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const countOf = (map, key) => map.get(key) || 0;
const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const DEFAULT_PLAN = { post: 'ok', get: 'found' };

globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('cashfree.com')) return originalFetch(url, options);

    const method = (options.method || 'GET').toUpperCase();

    if (method === 'POST' && u.endsWith('/pg/orders')) {
        const body = JSON.parse(options.body || '{}');
        const orderId = body.order_id;
        const name = body.customer_details?.customer_name;
        if (provider.plansByName.has(name)) {
            provider.plans.set(orderId, provider.plansByName.get(name));
            provider.plansByName.delete(name);
        }
        bump(provider.posts, orderId);
        const plan = provider.plans.get(orderId) || DEFAULT_PLAN;

        if (plan.post === 'hang') {
            provider.hangingOrderId = orderId;
            return new Promise(resolve => provider.hung.set(orderId, resolve));
        }
        if (plan.post === 'timeout504') return json({ message: 'gateway timeout' }, 504);
        if (plan.post === 'reject400') return json({ message: 'invalid customer details', type: 'invalid_request_error' }, 400);
        if (plan.post === 'conflict409') return json({ message: 'order with same id is already present', code: 'order_already_exists' }, 409);
        if (plan.post === 'malformed') return json({ order_id: orderId, order_status: 'ACTIVE' }, 200);

        return json({
            order_id: orderId,
            cf_order_id: 7000000 + countOf(provider.posts, orderId),
            order_status: 'ACTIVE',
            payment_session_id: `sess_create_${orderId}`,
            order_expiry_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
    }

    if (method === 'GET' && /\/pg\/orders\/[^/]+$/.test(u)) {
        const orderId = decodeURIComponent(u.split('/pg/orders/')[1]);
        bump(provider.gets, orderId);
        const plan = provider.plans.get(orderId) || DEFAULT_PLAN;
        if (plan.get === 'notfound') return json({ message: 'Resource Not found' }, 404);
        if (plan.get === 'error500') return json({ message: 'internal' }, 500);
        return json({
            order_id: orderId,
            cf_order_id: 8000001,
            order_status: 'ACTIVE',
            payment_session_id: provider.getSession.get(orderId) || `sess_lookup_${orderId}`,
            order_expiry_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
    }

    if (method === 'GET' && u.endsWith('/payments')) return json([]);
    return json({}, 404);
};

let baseUrl;
let server;
let testProductId;
const createdOrderIds = [];

async function createVariant() {
    const v = await query(
        `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, flavor,
                                       mrp, selling_price, cost_price, tax_rate, is_active)
         VALUES ($1, $2, 'Lifecycle Test', 100, 'Salt', 200, 100, 50, 18, true) RETURNING id`,
        [testProductId, `LC-${rand()}`]
    );
    await query(`INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, 500, 0, 5)`, [v.rows[0].id]);
    return v.rows[0].id;
}

// The customer name is unique per test, so it can also key a provider plan.
function checkoutBody(variantId, name) {
    const address = { name, phone: '9876543210', addressLine1: '1 Lifecycle Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', country: 'India' };
    return {
        customer: { name, phone: '9876543210', email: `lifecycle-${rand().toLowerCase()}@example.test` },
        shippingAddress: address,
        items: [{ variantId, quantity: 1 }],
        paymentMethod: 'ONLINE',
    };
}

function planFor(name, plan) {
    provider.plansByName.set(name, plan);
}

// A replay of an existing order is authorised only with its guest token. Without it, the reply
// is the generic 409, so the existence of a key is never revealed.
async function postCreate(body, key = `lc-${rand()}-${Date.now()}`, token = null) {
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key };
    if (token) headers['x-guest-access-token'] = token;
    const res = await fetch(`${baseUrl}/api/orders/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
}

async function postRetry(orderNumber, token) {
    const res = await fetch(`${baseUrl}/api/orders/${orderNumber}/retry-payment`, {
        method: 'POST',
        headers: { 'x-guest-access-token': token, 'Idempotency-Key': `retry-${rand()}-${Date.now()}`, 'Content-Type': 'application/json' },
        body: '{}',
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
}

async function paymentsFor(orderId) {
    return (await query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at`, [orderId])).rows;
}

async function orderRowByName(name) {
    const row = (await query(`SELECT * FROM orders WHERE customer_name = $1`, [name])).rows[0];
    if (row) createdOrderIds.push(row.id);
    return row;
}

function tokenFor(order) {
    return generateGuestAccessToken(order);
}

// Provider creates made by retries use "<order_number>-R<n>" merchant ids.
function retryCallsFor(orderNumber) {
    let total = 0;
    for (const [orderId, count] of provider.posts) {
        if (orderId.startsWith(`${orderNumber}-R`)) total += count;
    }
    return total;
}

/*
 * Backdates a create row past the lease. payments has a BEFORE UPDATE trigger that resets
 * updated_at, so the trigger is skipped for this one connection only.
 */
async function ageRow(orderId, minutes = 10) {
    const client = await pool.connect();
    try {
        await client.query(`SET session_replication_role = replica`);
        await client.query(
            `UPDATE payments
             SET created_at = NOW() - ($2::int * INTERVAL '1 minute'),
                 updated_at = NOW() - ($2::int * INTERVAL '1 minute')
             WHERE order_id = $1`,
            [orderId, minutes]
        );
    } finally {
        await client.query(`RESET session_replication_role`).catch(() => {});
        client.release();
    }
}

async function waitUntil(predicate, ms, label) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
}

function sessionResponse(orderId, sessionId) {
    return json({
        order_id: orderId,
        cf_order_id: 9000009,
        order_status: 'ACTIVE',
        payment_session_id: sessionId,
        order_expiry_time: new Date(Date.now() + 3600e3).toISOString(),
    });
}

describe('Cashfree create-order lifecycle', () => {
    before(async () => {
        const cat = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Lifecycle Category', 'lifecycle-cat-' || gen_random_uuid(), 'Lifecycle', true) RETURNING id`
        );
        const prod = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Lifecycle Product', 'lifecycle-prod-' || gen_random_uuid(), 'The Crunchy Heart', true) RETURNING id`,
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
        // Release any held provider call so no request stays pending.
        for (const resolve of provider.hung.values()) resolve(json({ message: 'released' }, 504));
        globalThis.fetch = originalFetch;
        await new Promise(resolve => server.close(resolve));
        await query(`DROP TRIGGER IF EXISTS lifecycle_interrupt_payments ON payments`);
        await query(`DROP FUNCTION IF EXISTS lifecycle_interrupt_order_created()`);
        for (const id of createdOrderIds) {
            await query(`DELETE FROM inventory_transactions WHERE reference_id = $1`, [id]);
            await query(`DELETE FROM payments WHERE order_id = $1`, [id]);
            await query(`DELETE FROM order_items WHERE order_id = $1`, [id]);
            await query(`DELETE FROM orders WHERE id = $1`, [id]);
        }
        await pool.end().catch(() => {});
    });

    test('1. A healthy create calls the provider once and stores the session', async () => {
        const name = `Lifecycle ${rand()}`;
        const res = await postCreate(checkoutBody(await createVariant(), name));
        assert.equal(res.status, 201);
        assert.ok(res.body.cashfree.paymentSessionId);

        const order = await orderRowByName(name);
        assert.equal(countOf(provider.posts, order.order_number), 1);
        const [payment] = await paymentsFor(order.id);
        assert.equal(payment.gateway_status, 'ORDER_CREATED');
        assert.equal(payment.provider_order_id, order.order_number);
    });

    test('2. Ambiguous create: 202, retry refused with no provider call, lookup resolves the original order', async () => {
        const name = `Lifecycle ${rand()}`;
        planFor(name, { post: 'timeout504', get: 'found' });
        const res = await postCreate(checkoutBody(await createVariant(), name));
        const order = await orderRowByName(name);

        assert.equal(res.status, 202, 'a timeout is reported as an unknown outcome');
        assert.equal(res.body.code, 'GATEWAY_AMBIGUOUS_TIMEOUT');
        assert.equal(countOf(provider.posts, order.order_number), 1);
        const [payment] = await paymentsFor(order.id);
        assert.equal(payment.gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');

        const retry = await postRetry(order.order_number, tokenFor(order));
        assert.equal(retry.status, 504, 'retry is blocked while the outcome is unresolved');
        assert.equal(countOf(provider.posts, order.order_number), 1, 'no second provider create');

        provider.getSession.set(order.order_number, `sess_recovered_${order.order_number}`);
        const outcome = await reconcilePaymentAttempt({ providerOrderId: order.order_number });
        assert.equal(outcome.reconciled, true);
        assert.equal(countOf(provider.posts, order.order_number), 1, 'lookup never creates an order');
        assert.ok(countOf(provider.gets, order.order_number) >= 1, 'lookup was used');

        const [resolved] = await paymentsFor(order.id);
        assert.equal(resolved.gateway_status, 'ORDER_CREATED');
        assert.equal(resolved.raw_response.payment_session_id, `sess_recovered_${order.order_number}`);
    });

    test('3. A definitive 400 refusal closes the create: the row is rejected, and a new attempt is allowed', async () => {
        const name = `Lifecycle ${rand()}`;
        planFor(name, { post: 'reject400', get: 'notfound' });
        const res = await postCreate(checkoutBody(await createVariant(), name));
        const order = await orderRowByName(name);

        assert.equal(res.status, 400);
        assert.equal(countOf(provider.posts, order.order_number), 1);
        const [payment] = await paymentsFor(order.id);
        assert.equal(payment.gateway_status, 'CREATION_REJECTED');
        assert.equal(payment.status, 'failed');

        // The provider refused, so no order exists. A new attempt is therefore a valid retry.
        const retry = await postRetry(order.order_number, tokenFor(order));
        assert.equal(retry.status, 200);
        assert.equal(retryCallsFor(order.order_number), 1, 'exactly one new provider order for the new attempt');
    });

    test('4. Two concurrent creates with the same key make exactly one provider call', async () => {
        const name = `Lifecycle ${rand()}`;
        const body = checkoutBody(await createVariant(), name);
        const key = `lc-conc-${rand()}-${Date.now()}`;
        const results = await Promise.all([postCreate(body, key), postCreate(body, key)]);
        const order = await orderRowByName(name);

        assert.equal(countOf(provider.posts, order.order_number), 1, 'exactly one provider create');
        for (const r of results) {
            assert.ok([200, 201, 409].includes(r.status), `unexpected status ${r.status}`);
        }
        assert.equal((await paymentsFor(order.id)).length, 1, 'one create row for the order');
    });

    test('5. While the create is in flight, a replay and a retry are refused without a provider call', async () => {
        const name = `Lifecycle ${rand()}`;
        const body = checkoutBody(await createVariant(), name);
        planFor(name, { post: 'hang', get: 'found' });
        provider.hangingOrderId = null;
        const key = `lc-flight-${rand()}-${Date.now()}`;
        const pending = postCreate(body, key);

        await waitUntil(() => provider.hangingOrderId !== null, 10000, 'provider call in flight');
        const order = await orderRowByName(name);

        const replay = await postCreate(body, key, tokenFor(order));
        assert.equal(replay.status, 409);
        assert.equal(replay.body.code, 'PAYMENT_CREATION_IN_PROGRESS');

        const retry = await postRetry(order.order_number, tokenFor(order));
        assert.equal(retry.status, 409, 'a live claim blocks a retry');
        assert.equal(countOf(provider.posts, order.order_number), 1, 'no provider call from the replay or the retry');

        provider.hung.get(order.order_number)(json({ message: 'gateway timeout' }, 504));
        const first = await pending;
        assert.equal(first.status, 202);
        assert.equal(countOf(provider.posts, order.order_number), 1);
    });

    test('6. A stale owner cannot overwrite a session that reconciliation already stored', async () => {
        const name = `Lifecycle ${rand()}`;
        planFor(name, { post: 'hang', get: 'found' });
        provider.hangingOrderId = null;
        const pending = postCreate(checkoutBody(await createVariant(), name));
        await waitUntil(() => provider.hangingOrderId !== null, 10000, 'provider call in flight');
        const order = await orderRowByName(name);

        // Lease expires, the retry path marks the attempt ambiguous, and lookup stores the session.
        await ageRow(order.id);
        const retry = await postRetry(order.order_number, tokenFor(order));
        assert.equal(retry.status, 504);
        provider.getSession.set(order.order_number, `sess_reconciled_${order.order_number}`);
        const outcome = await reconcilePaymentAttempt({ providerOrderId: order.order_number });
        assert.equal(outcome.reconciled, true);

        // The original owner now receives its own success. It must not overwrite the stored state.
        provider.hung.get(order.order_number)(sessionResponse(order.order_number, `sess_owner_${order.order_number}`));
        const late = await pending;
        assert.equal(late.status, 202, 'a stale owner reports the outcome without claiming success');

        const [stored] = await paymentsFor(order.id);
        assert.equal(stored.raw_response.payment_session_id, `sess_reconciled_${order.order_number}`);
        assert.equal(countOf(provider.posts, order.order_number), 1);
    });

    test('7. A stale owner may persist its provider success while the outcome is still ambiguous', async () => {
        const name = `Lifecycle ${rand()}`;
        planFor(name, { post: 'hang', get: 'found' });
        provider.hangingOrderId = null;
        const pending = postCreate(checkoutBody(await createVariant(), name));
        await waitUntil(() => provider.hangingOrderId !== null, 10000, 'provider call in flight');
        const order = await orderRowByName(name);

        await ageRow(order.id);
        const retry = await postRetry(order.order_number, tokenFor(order));
        assert.equal(retry.status, 504, 'the stale attempt is marked ambiguous, not retried');
        assert.equal(countOf(provider.posts, order.order_number), 1);

        provider.hung.get(order.order_number)(sessionResponse(order.order_number, `sess_owner_${order.order_number}`));
        const late = await pending;
        assert.equal(late.status, 201, 'the owner records its own result when no session was stored');

        const [stored] = await paymentsFor(order.id);
        assert.equal(stored.gateway_status, 'ORDER_CREATED');
        assert.equal(stored.raw_response.payment_session_id, `sess_owner_${order.order_number}`);
    });

    test('8. Provider success followed by a persistence failure: 202, the outcome is unknown, lookup recovers it', async () => {
        const marker = `LIFECYCLE INTERRUPT ${rand()}`;
        await query(`DROP TRIGGER IF EXISTS lifecycle_interrupt_payments ON payments`);
        await query(`DROP FUNCTION IF EXISTS lifecycle_interrupt_order_created()`);
        await query(`
            CREATE FUNCTION lifecycle_interrupt_order_created() RETURNS trigger LANGUAGE plpgsql AS $fn$
            BEGIN
                IF NEW.gateway_status = 'ORDER_CREATED' AND EXISTS (
                    SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.customer_name LIKE 'LIFECYCLE INTERRUPT %'
                ) THEN
                    RAISE EXCEPTION 'simulated persistence failure';
                END IF;
                RETURN NEW;
            END
            $fn$
        `);
        await query(`CREATE TRIGGER lifecycle_interrupt_payments BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION lifecycle_interrupt_order_created()`);

        let res;
        try {
            res = await postCreate(checkoutBody(await createVariant(), marker));
        } finally {
            await query(`DROP TRIGGER IF EXISTS lifecycle_interrupt_payments ON payments`);
            await query(`DROP FUNCTION IF EXISTS lifecycle_interrupt_order_created()`);
        }

        const order = await orderRowByName(marker);
        assert.equal(res.status, 202, 'a persistence failure after provider success is not reported as success');
        assert.equal(countOf(provider.posts, order.order_number), 1);
        const [payment] = await paymentsFor(order.id);
        assert.equal(payment.gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');

        provider.getSession.set(order.order_number, `sess_after_persist_${order.order_number}`);
        const outcome = await reconcilePaymentAttempt({ providerOrderId: order.order_number });
        assert.equal(outcome.reconciled, true);
        assert.equal(countOf(provider.posts, order.order_number), 1, 'recovery never creates a second order');
    });

    test('9. Lookup not found is inconclusive: the attempt stays blocked and nothing is created', async () => {
        const name = `Lifecycle ${rand()}`;
        planFor(name, { post: 'timeout504', get: 'notfound' });
        const res = await postCreate(checkoutBody(await createVariant(), name));
        const order = await orderRowByName(name);
        assert.equal(res.status, 202);

        const outcome = await reconcilePaymentAttempt({ providerOrderId: order.order_number });
        assert.equal(outcome.reconciled, false);
        assert.equal(outcome.action, 'KEPT_AMBIGUOUS_BLOCKED');

        const retry = await postRetry(order.order_number, tokenFor(order));
        assert.equal(retry.status, 504);
        assert.equal(countOf(provider.posts, order.order_number), 1);
    });

    test('10. Legacy create row without a provider id blocks retries; a replay resolves it by lookup, never by create', async () => {
        const name = `Lifecycle ${rand()}`;
        const body = checkoutBody(await createVariant(), name);
        const key = `lc-legacy-${rand()}-${Date.now()}`;
        // The service creates the order and its create row (CREATE_PENDING) without a provider call.
        const created = await createOrder({
            customer: body.customer,
            shippingAddress: body.shippingAddress,
            items: body.items,
            paymentMethod: 'ONLINE',
            idempotencyKey: key,
        });
        const order = await orderRowByName(name);
        assert.equal(created.order.order_number, order.order_number);
        // Rewrite the row to the pre-fix shape: CASHFREE_PENDING with no provider id.
        await query(
            `UPDATE payments SET gateway_status = 'CASHFREE_PENDING', provider_order_id = NULL, provider = 'cashfree' WHERE order_id = $1`,
            [order.id]
        );

        const retry = await postRetry(order.order_number, tokenFor(order));
        assert.equal(retry.status, 409);
        assert.equal(retry.body.code, 'PAYMENT_RESOLUTION_REQUIRED');
        assert.equal(countOf(provider.posts, order.order_number), 0, 'a retry never creates for a legacy row');

        provider.getSession.set(order.order_number, `sess_legacy_${order.order_number}`);
        const replay = await postCreate(body, key, tokenFor(order));
        assert.equal(replay.status, 200);
        assert.equal(replay.body.cashfree.paymentSessionId, `sess_legacy_${order.order_number}`);
        assert.equal(countOf(provider.posts, order.order_number), 0, 'the replay never creates a provider order');
    });
});
