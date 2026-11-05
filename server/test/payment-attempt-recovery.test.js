/**
 * The Crunchy Heart - Stale payment-attempt recovery: concurrency and timeouts
 *
 * Covers an attempt persisted before the provider call: process interruption, a
 * hung provider response bounded by CASHFREE_CREATE_TIMEOUT_MS, concurrent retries,
 * reconciliation racing a new request, and terminal-state protection. The Cashfree
 * API is mocked at the global fetch boundary. No live provider call is made.
 */

import { test, describe, before, after } from 'node:test';
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
process.env.CASHFREE_CLIENT_ID = 'TEST_ATTEMPT_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_ATTEMPT_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'TEST_ATTEMPT_ORDER_TOKEN_SECRET_0123456789abcdef';
process.env.OWNER_SESSION_SECRET = 'TEST_ATTEMPT_OWNER_SESSION_SECRET_0123456789ab';

const { query, pool } = await import('../src/db/pool.js');
const { createOrder, retryPaymentAttempt, ATTEMPT_LEASE_MS } = await import('../src/services/order.service.js');
const { CASHFREE_CREATE_TIMEOUT_MS } = await import('../src/services/cashfree.service.js');
const { reconcilePaymentAttempt } = await import('../src/services/reconciliation.service.js');
const { generateGuestAccessToken } = await import('../src/utils/order-token.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const originalFetch = globalThis.fetch;

// Cashfree boundary mock. Modes: 'OK' answers immediately; 'HANG' never answers until aborted.
let mode = 'OK';
let posts = 0;
let gets = 0;
let recoverSession = null; // when set, GET /pg/orders/{id} reports this session (reconciliation)

globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('cashfree.com')) return originalFetch(url, options);

    const method = (options.method || 'GET').toUpperCase();

    if (method === 'POST' && u.endsWith('/pg/orders')) {
        posts += 1;
        if (mode === 'HANG') {
            return new Promise((_, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
                });
            });
        }
        const body = JSON.parse(options.body || '{}');
        return new Response(JSON.stringify({
            order_id: body.order_id,
            cf_order_id: 700000 + posts,
            order_status: 'ACTIVE',
            payment_session_id: `sess_${body.order_id}_${posts}`,
            order_expiry_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'GET' && /\/pg\/orders\/[^/]+$/.test(u)) {
        gets += 1;
        const orderId = decodeURIComponent(u.split('/pg/orders/')[1]);
        return new Response(JSON.stringify({
            order_id: orderId,
            cf_order_id: 800000,
            order_status: 'ACTIVE',
            payment_session_id: recoverSession,
            order_expiry_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'GET' && u.endsWith('/payments')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
};

const fixtureOrderIds = [];
const fixtureVariantIds = [];
let testProductId;

async function createVariant() {
    const v = await query(
        `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, flavor,
                                       mrp, selling_price, cost_price, tax_rate, is_active)
         VALUES ($1, $2, 'Attempt Test', 100, 'Salt', 200, 100, 50, 18, true) RETURNING id`,
        [testProductId, `ATT-${rand()}`]
    );
    fixtureVariantIds.push(v.rows[0].id);
    await query(`INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, 100, 0, 5)`, [v.rows[0].id]);
    return v.rows[0].id;
}

async function onlineOrder() {
    const variantId = await createVariant();
    const created = await createOrder({
        customer: { name: 'Attempt Customer', phone: '9876543210', email: 'attempt@example.test' },
        shippingAddress: { name: 'Attempt Customer', phone: '9876543210', addressLine1: '1 Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', country: 'India' },
        items: [{ variantId, quantity: 1 }],
        paymentMethod: 'ONLINE',
        idempotencyKey: `att-${rand()}-${Date.now()}`,
    });
    fixtureOrderIds.push(created.order.id);
    return { order: created.order, paymentId: created.payment.id, token: generateGuestAccessToken(created.order) };
}

async function insertStaleAttempt(order, ageMinutes = 30) {
    const providerOrderId = `${order.order_number}-R9`;
    await query(
        `INSERT INTO payments (order_id, provider, provider_order_id, amount, currency, status,
                               gateway_status, payment_method, created_at, updated_at)
         VALUES ($1, 'cashfree', $2, $3, 'INR', 'created', 'ATTEMPT_INITIATED', 'ONLINE',
                 NOW() - ($4::int * INTERVAL '1 minute'), NOW() - ($4::int * INTERVAL '1 minute'))`,
        [order.id, providerOrderId, order.total_amount, ageMinutes]
    );
    return providerOrderId;
}

async function paymentRows(orderId) {
    return (await query(`SELECT provider_order_id, gateway_status FROM payments WHERE order_id = $1 ORDER BY created_at`, [orderId])).rows;
}

describe('Stale payment-attempt recovery', () => {
    before(async () => {
        const cat = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Attempt Category', 'attempt-cat-' || gen_random_uuid(), 'Attempt', true) RETURNING id`
        );
        const prod = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Attempt Product', 'attempt-prod-' || gen_random_uuid(), 'The Crunchy Heart', true) RETURNING id`,
            [cat.rows[0].id]
        );
        testProductId = prod.rows[0].id;
    });

    after(async () => {
        globalThis.fetch = originalFetch;
        for (const id of fixtureOrderIds) {
            await query(`DELETE FROM inventory_transactions WHERE reference_id = $1`, [id]);
            await query(`DELETE FROM orders WHERE id = $1`, [id]);
        }
        for (const id of fixtureVariantIds) {
            await query(`DELETE FROM inventory WHERE variant_id = $1`, [id]);
            await query(`DELETE FROM product_variants WHERE id = $1`, [id]);
        }
        if (testProductId) await query(`DELETE FROM products WHERE id = $1`, [testProductId]);
        await pool.end().catch(() => {});
    });

    test('1. The lease is far longer than the provider timeout (static invariant)', () => {
        assert.ok(CASHFREE_CREATE_TIMEOUT_MS * 2 <= ATTEMPT_LEASE_MS,
            `timeout ${CASHFREE_CREATE_TIMEOUT_MS} ms must be well below lease ${ATTEMPT_LEASE_MS} ms`);
    });

    test('2. Two concurrent retries on a stale attempt: both get 504, one ambiguous row, no provider order', async () => {
        const { order, token } = await onlineOrder();
        await insertStaleAttempt(order);
        const postsBefore = posts;
        mode = 'OK';

        const results = await Promise.allSettled([
            retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }),
            retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }),
        ]);

        for (const r of results) {
            assert.equal(r.status, 'rejected');
            assert.equal(r.reason.statusCode, 504);
        }
        const rows = await paymentRows(order.id);
        assert.equal(rows.filter(r => r.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT').length, 1);
        assert.equal(posts, postsBefore, 'no provider order is created while the outcome is unknown');
    });

    test('3. A provider call that never answers is aborted at the bound and classified as ambiguous', async () => {
        const { order, token } = await onlineOrder();
        const postsBefore = posts;
        mode = 'HANG';
        try {
            await assert.rejects(
                () => retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }),
                (err) => err.statusCode === 504
            );
        } finally {
            mode = 'OK';
        }
        const rows = await paymentRows(order.id);
        assert.ok(rows.some(r => r.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT'));
        assert.equal(posts, postsBefore + 1, 'exactly one provider call was made');

        // A retry does not call the provider again while the outcome is unknown.
        await assert.rejects(
            () => retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }),
            (err) => err.statusCode === 504
        );
        assert.equal(posts, postsBefore + 1);
    });

    test('4. Reconciliation recovers the session of an interrupted attempt without a new provider order', async () => {
        const { order, token } = await onlineOrder();
        const providerOrderId = await insertStaleAttempt(order);
        // First retry marks the stale attempt ambiguous.
        await assert.rejects(() => retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }), (err) => err.statusCode === 504);

        const postsBefore = posts;
        recoverSession = `recovered_${providerOrderId}`;
        try {
            await reconcilePaymentAttempt({ providerOrderId });
        } finally {
            recoverSession = null;
        }

        assert.equal(posts, postsBefore, 'reconciliation never creates a provider order');
        const rows = await paymentRows(order.id);
        const recovered = rows.find(r => r.provider_order_id === providerOrderId);
        assert.equal(recovered.gateway_status, 'ORDER_CREATED');
    });

    test('5. Reconciliation racing a new request never produces a second provider order', async () => {
        const { order, token } = await onlineOrder();
        const providerOrderId = await insertStaleAttempt(order);
        await assert.rejects(() => retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }), (err) => err.statusCode === 504);

        const postsBefore = posts;
        const paymentsBefore = (await paymentRows(order.id)).length;
        recoverSession = `race_${providerOrderId}`;
        try {
            const [reconciled, retried] = await Promise.allSettled([
                reconcilePaymentAttempt({ providerOrderId }),
                retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }),
            ]);
            // Either outcome is safe: a reused session or a 504 while unresolved.
            if (retried.status === 'rejected') assert.equal(retried.reason.statusCode, 504);
            else assert.equal(retried.value.existing, true);
            assert.ok(['fulfilled', 'rejected'].includes(reconciled.status));
        } finally {
            recoverSession = null;
        }

        assert.equal(posts, postsBefore, 'no second provider order was created');
        assert.equal((await paymentRows(order.id)).length, paymentsBefore);
    });

    test('6. A paid order cannot be retried, so no attempt can be recreated after success', async () => {
        const { order, token } = await onlineOrder();
        await query(`UPDATE orders SET payment_status = 'paid', status = 'confirmed' WHERE id = $1`, [order.id]);
        const postsBefore = posts;
        await assert.rejects(
            () => retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }),
            (err) => err.statusCode === 409
        );
        assert.equal(posts, postsBefore);
    });

    test('7. A fresh in-flight attempt is not converted to ambiguous (it is still refused with 409)', async () => {
        const { order, token } = await onlineOrder();
        await insertStaleAttempt(order, 0);
        await assert.rejects(
            () => retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }),
            (err) => err.statusCode === 409
        );
        const rows = await paymentRows(order.id);
        assert.ok(rows.some(r => r.gateway_status === 'ATTEMPT_INITIATED'));
        assert.ok(!rows.some(r => r.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT'));
    });
});
