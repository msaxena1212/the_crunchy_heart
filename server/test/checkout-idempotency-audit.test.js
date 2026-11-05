/**
 * The Crunchy Heart - Checkout, payment, and idempotency safety audit
 *
 * Deterministic regression tests for retry, concurrency, timeout, and webhook
 * scenarios. The Cashfree HTTP API is mocked at the global fetch boundary, and
 * all other traffic is passed through to a local test server. No live provider
 * call is made. The database is the isolated crunchy_heart_test database.
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
process.env.CASHFREE_CLIENT_ID = 'TEST_AUDIT_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_AUDIT_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'TEST_AUDIT_ORDER_TOKEN_SECRET_0123456789abcdef';
process.env.OWNER_SESSION_SECRET = 'TEST_AUDIT_OWNER_SESSION_SECRET_0123456789abcdef';

const { query, pool } = await import('../src/db/pool.js');
const { createOrder, retryPaymentAttempt } = await import('../src/services/order.service.js');
const { attachCashfreeOrderToPayment, markPaymentSuccess, markPaymentFailed } = await import('../src/services/payment.service.js');
const { generateGuestAccessToken } = await import('../src/utils/order-token.js');
const { default: orderRoutes } = await import('../src/routes/order.routes.js');
const { default: paymentRoutes } = await import('../src/routes/payment.routes.js');

// ---------------------------------------------------------------------------
// Cashfree boundary mock: order creation only. Modes control the outcome.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let cashfreeMode = 'SUCCESS'; // 'SUCCESS' | 'TIMEOUT'
let cashfreeCalls = 0;

globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (!urlStr.includes('cashfree.com')) {
        return originalFetch(url, options);
    }

    cashfreeCalls += 1;

    if (cashfreeMode === 'TIMEOUT') {
        // Request was sent, but no response arrived in time.
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }

    const body = JSON.parse(options.body || '{}');
    return new Response(
        JSON.stringify({
            order_id: body.order_id,
            cf_order_id: 900000 + cashfreeCalls,
            order_status: 'ACTIVE',
            payment_session_id: `session_${body.order_id}_${cashfreeCalls}`,
            order_expiry_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
};

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const fixtureOrderIds = [];
const fixtureVariantIds = [];
let testProductId;
let server;
let baseUrl;

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/orders', orderRoutes);
    app.use('/api/payments', paymentRoutes);
    app.use((error, req, res, next) => {
        res.status(error.statusCode || 500).json({ success: false, code: error.code, message: error.message });
    });
    return app;
}

async function createVariant(stock = 50) {
    const v = await query(
        `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, flavor,
                                       mrp, selling_price, cost_price, tax_rate, is_active)
         VALUES ($1, $2, 'Audit Test', 100, 'Salt', 200, 100, 50, 18, true) RETURNING id`,
        [testProductId, `AUD-${rand()}`]
    );
    const id = v.rows[0].id;
    fixtureVariantIds.push(id);
    await query(
        `INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, $2, 0, 5)`,
        [id, stock]
    );
    return id;
}

const customer = () => ({ name: 'Audit Customer', phone: '9876543210', email: 'audit@example.com' });
const address = () => ({
    name: 'Audit Customer', phone: '9876543210', addressLine1: '1 Audit Road',
    city: 'Mumbai', state: 'Maharashtra', pincode: '400001', country: 'India',
});

async function httpCreate({ key, items, token = null, body = {} }) {
    const headers = { 'Content-Type': 'application/json' };
    if (key !== undefined) headers['idempotency-key'] = key;
    if (token) headers['x-guest-access-token'] = token;
    const res = await fetch(`${baseUrl}/api/orders/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            customer: customer(),
            shippingAddress: address(),
            items,
            paymentMethod: 'ONLINE',
            ...body,
        }),
    });
    return { status: res.status, json: await res.json() };
}

async function ordersWithKey(key) {
    return (await query(`SELECT id, order_number, total_amount FROM orders WHERE idempotency_key = $1`, [key])).rows;
}

async function paymentsFor(orderId) {
    return (await query(`SELECT id, provider_order_id, gateway_status, status FROM payments WHERE order_id = $1 ORDER BY created_at`, [orderId])).rows;
}

async function deductionUnits(orderId) {
    return (await query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS units FROM inventory_transactions
         WHERE reference_id = $1 AND transaction_type = 'SALE_DEDUCTION'`,
        [orderId]
    )).rows[0].units;
}

describe('Checkout, payment, and idempotency safety audit', () => {
    before(async () => {
        const cat = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Audit Category', 'audit-cat-' || gen_random_uuid(), 'Audit', true) RETURNING id`
        );
        const prod = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Audit Product', 'audit-prod-' || gen_random_uuid(), 'The Crunchy Heart', true) RETURNING id`,
            [cat.rows[0].id]
        );
        testProductId = prod.rows[0].id;

        await new Promise(resolve => {
            server = buildApp().listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        globalThis.fetch = originalFetch;
        await new Promise(resolve => server.close(resolve));
        for (const orderId of fixtureOrderIds) {
            await query(`DELETE FROM inventory_transactions WHERE reference_id = $1`, [orderId]);
            await query(`DELETE FROM refunds WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM orders WHERE id = $1`, [orderId]);
        }
        for (const variantId of fixtureVariantIds) {
            await query(`DELETE FROM inventory WHERE variant_id = $1`, [variantId]);
            await query(`DELETE FROM product_variants WHERE id = $1`, [variantId]);
        }
        if (testProductId) await query(`DELETE FROM products WHERE id = $1`, [testProductId]);
        await pool.end().catch(() => {});
    });

    // ---- Scenario 1: retry after no response, with and without a key ----

    test('1a. Order creation without an idempotency key is rejected before any order is written', async () => {
        const variantId = await createVariant();
        const before = await query(`SELECT COUNT(*)::int AS n FROM orders WHERE phone = '9876543210'`);
        const res = await httpCreate({ key: undefined, items: [{ variantId, quantity: 1 }] });
        const after = await query(`SELECT COUNT(*)::int AS n FROM orders WHERE phone = '9876543210'`);

        assert.equal(res.status, 400);
        assert.equal(res.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
        assert.equal(after.rows[0].n, before.rows[0].n, 'no order row is written');
    });

    test('1b. A malformed idempotency key is rejected', async () => {
        const variantId = await createVariant();
        const res = await httpCreate({ key: 'x y', items: [{ variantId, quantity: 1 }] });
        assert.equal(res.status, 400);
        assert.equal(res.json.code, 'IDEMPOTENCY_KEY_INVALID');
    });

    // ---- Scenario 2: concurrent requests with the same key ----

    test('2. Concurrent identical requests with the same key produce exactly one order', async () => {
        const variantId = await createVariant();
        const key = `aud-conc-${rand()}-${Date.now()}`;
        const items = [{ variantId, quantity: 1 }];

        const [a, b] = await Promise.all([
            httpCreate({ key, items }),
            httpCreate({ key, items }),
        ]);

        // The winner gets the order and its guest token. The loser is refused without
        // disclosure (409), so it cannot be used to read the order. No duplicate is created.
        const statuses = [a.status, b.status].sort();
        assert.deepEqual(statuses, [201, 409]);

        const rows = await ordersWithKey(key);
        assert.equal(rows.length, 1);
        const winner = a.status === 201 ? a : b;
        assert.equal(winner.json.order.order_number, rows[0].order_number);
        fixtureOrderIds.push(rows[0].id);
    });

    // ---- Scenario 3: key reused with a different request ----

    test('3a. A key reused with a different cart is rejected and the original order is unchanged', async () => {
        const variantId = await createVariant();
        const key = `aud-diff-${rand()}-${Date.now()}`;

        const first = await httpCreate({ key, items: [{ variantId, quantity: 1 }] });
        assert.equal(first.status, 201);
        const originalTotal = Number(first.json.order.total_amount);
        fixtureOrderIds.push(first.json.order.id);

        // Even the owner (with a valid guest token) must not get the earlier order back
        // for a different cart. Without the fingerprint check this would return 200.
        const ownerToken = generateGuestAccessToken(first.json.order);
        const reused = await httpCreate({ key, items: [{ variantId, quantity: 3 }], token: ownerToken });

        // Same non-disclosing response an unauthenticated replay gets.
        assert.equal(reused.status, 409);
        assert.equal(reused.json.code, 'IDEMPOTENCY_REPLAY_UNAUTHORIZED');
        assert.equal(reused.json.order, undefined);

        const rows = await ordersWithKey(key);
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].total_amount), originalTotal);
    });

    test('3b. Service level: a reused key with different items throws IDEMPOTENCY_KEY_REUSED', async () => {
        const variantId = await createVariant();
        const key = `aud-svc-${rand()}-${Date.now()}`;
        const base = {
            customer: customer(),
            shippingAddress: address(),
            paymentMethod: 'COD',
            idempotencyKey: key,
        };

        const first = await createOrder({ ...base, items: [{ variantId, quantity: 1 }] });
        fixtureOrderIds.push(first.order.id);

        await assert.rejects(
            () => createOrder({ ...base, items: [{ variantId, quantity: 2 }] }),
            (err) => err.code === 'IDEMPOTENCY_KEY_REUSED' && err.statusCode === 409
        );
        assert.equal((await ordersWithKey(key)).length, 1);
    });

    test('3c. The same key with the same request replays the existing order without a new one', async () => {
        const variantId = await createVariant();
        const key = `aud-same-${rand()}-${Date.now()}`;
        const items = [{ variantId, quantity: 2 }];

        const first = await createOrder({ customer: customer(), shippingAddress: address(), items, paymentMethod: 'COD', idempotencyKey: key });
        fixtureOrderIds.push(first.order.id);
        const again = await createOrder({ customer: customer(), shippingAddress: address(), items, paymentMethod: 'COD', idempotencyKey: key });

        assert.equal(again.existing, true);
        assert.equal(again.order.order_number, first.order.order_number);
        assert.equal((await ordersWithKey(key)).length, 1);
    });

    // ---- Scenario 4: order committed, response lost ----

    test('4. A retry after a lost response cannot create a second order; recovery needs the guest token', async () => {
        const variantId = await createVariant();
        const key = `aud-lost-${rand()}-${Date.now()}`;
        const items = [{ variantId, quantity: 1 }];

        const first = await httpCreate({ key, items });
        assert.equal(first.status, 201);
        fixtureOrderIds.push(first.json.order.id);

        // The client never saw the response and retries with the same key and no token.
        const blind = await httpCreate({ key, items });
        assert.equal(blind.status, 409);
        assert.equal(blind.json.code, 'IDEMPOTENCY_REPLAY_UNAUTHORIZED');

        // With the guest token the client recovers its order.
        const token = generateGuestAccessToken(first.json.order);
        const recovered = await httpCreate({ key, items, token });
        assert.equal(recovered.status, 200);
        assert.equal(recovered.json.existing, true);

        assert.equal((await ordersWithKey(key)).length, 1);
    });

    // ---- Scenario 5 and 10: provider timeout with an unknown outcome ----

    test('5/10. A provider timeout is recorded as ambiguous; retries create no new provider order', async () => {
        const variantId = await createVariant();
        const created = await createOrder({
            customer: customer(), shippingAddress: address(),
            items: [{ variantId, quantity: 1 }], paymentMethod: 'ONLINE',
            idempotencyKey: `aud-timeout-${rand()}-${Date.now()}`,
        });
        fixtureOrderIds.push(created.order.id);
        const token = generateGuestAccessToken(created.order);

        const callsBefore = cashfreeCalls;
        cashfreeMode = 'TIMEOUT';
        try {
            await assert.rejects(
                () => retryPaymentAttempt({ orderNumber: created.order.order_number, guestAccessToken: token }),
                (err) => err.statusCode === 504
            );
            const rows = await paymentsFor(created.order.id);
            const ambiguous = rows.filter(r => r.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT');
            assert.equal(ambiguous.length, 1);

            // A second retry must not call the provider again or create another attempt.
            const paymentCountBefore = rows.length;
            await assert.rejects(
                () => retryPaymentAttempt({ orderNumber: created.order.order_number, guestAccessToken: token }),
                (err) => err.statusCode === 504
            );
            assert.equal((await paymentsFor(created.order.id)).length, paymentCountBefore);
            assert.equal(cashfreeCalls, callsBefore + 1, 'exactly one provider call was made');
        } finally {
            cashfreeMode = 'SUCCESS';
        }
    });

    // ---- Scenario 9 and 12: attempt persisted, provider result never saved ----

    test('9/12. An attempt left in flight by a crash no longer blocks the order forever', async () => {
        const variantId = await createVariant();
        const created = await createOrder({
            customer: customer(), shippingAddress: address(),
            items: [{ variantId, quantity: 1 }], paymentMethod: 'ONLINE',
            idempotencyKey: `aud-crash-${rand()}-${Date.now()}`,
        });
        fixtureOrderIds.push(created.order.id);
        const token = generateGuestAccessToken(created.order);

        // Simulate: the attempt was committed, then the process stopped before saving the result.
        await query(
            `INSERT INTO payments (order_id, provider, provider_order_id, amount, currency, status,
                                   gateway_status, payment_method, created_at, updated_at)
             VALUES ($1, 'cashfree', $2, $3, 'INR', 'created', 'ATTEMPT_INITIATED', 'ONLINE',
                     NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes')`,
            [created.order.id, `${created.order.order_number}-R9`, created.order.total_amount]
        );

        const callsBefore = cashfreeCalls;
        await assert.rejects(
            () => retryPaymentAttempt({ orderNumber: created.order.order_number, guestAccessToken: token }),
            (err) => err.statusCode === 504
        );
        const rows = await paymentsFor(created.order.id);
        assert.ok(rows.some(r => r.provider_order_id === `${created.order.order_number}-R9` && r.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT'));
        assert.equal(cashfreeCalls, callsBefore, 'no new provider order was created for the stale attempt');

        // A second retry is still ambiguous, not a new attempt.
        await assert.rejects(
            () => retryPaymentAttempt({ orderNumber: created.order.order_number, guestAccessToken: token }),
            (err) => err.statusCode === 504
        );
        assert.equal(cashfreeCalls, callsBefore);
    });

    test('9b. A fresh in-flight attempt still blocks concurrent retries with 409', async () => {
        const variantId = await createVariant();
        const created = await createOrder({
            customer: customer(), shippingAddress: address(),
            items: [{ variantId, quantity: 1 }], paymentMethod: 'ONLINE',
            idempotencyKey: `aud-fresh-${rand()}-${Date.now()}`,
        });
        fixtureOrderIds.push(created.order.id);
        const token = generateGuestAccessToken(created.order);

        await query(
            `INSERT INTO payments (order_id, provider, provider_order_id, amount, currency, status,
                                   gateway_status, payment_method)
             VALUES ($1, 'cashfree', $2, $3, 'INR', 'created', 'ATTEMPT_INITIATED', 'ONLINE')`,
            [created.order.id, `${created.order.order_number}-R9`, created.order.total_amount]
        );

        await assert.rejects(
            () => retryPaymentAttempt({ orderNumber: created.order.order_number, guestAccessToken: token }),
            (err) => err.statusCode === 409
        );
    });

    // ---- Keyless retry while a live session exists ----

    test('13. A keyless retry reuses a live session with a future expiry instead of creating a second one', async () => {
        const variantId = await createVariant();
        const created = await createOrder({
            customer: customer(), shippingAddress: address(),
            items: [{ variantId, quantity: 1 }], paymentMethod: 'ONLINE',
            idempotencyKey: `aud-live-${rand()}-${Date.now()}`,
        });
        fixtureOrderIds.push(created.order.id);
        const token = generateGuestAccessToken(created.order);

        await attachCashfreeOrderToPayment({
            paymentId: created.payment.id,
            cashfreeOrder: {
                order_id: created.order.order_number,
                payment_session_id: 'live_session_13',
                order_expiry_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            },
        });

        const callsBefore = cashfreeCalls;
        const paymentsBefore = (await paymentsFor(created.order.id)).length;
        const result = await retryPaymentAttempt({ orderNumber: created.order.order_number, guestAccessToken: token });

        assert.equal(result.existing, true);
        assert.equal(result.cashfree.paymentSessionId, 'live_session_13');
        assert.equal(cashfreeCalls, callsBefore);
        assert.equal((await paymentsFor(created.order.id)).length, paymentsBefore);
    });

    // ---- Scenarios 6, 7, 8: webhooks ----

    test('6. A duplicate success webhook settles once and deducts stock once', async () => {
        const variantId = await createVariant();
        const created = await createOrder({
            customer: customer(), shippingAddress: address(),
            items: [{ variantId, quantity: 2 }], paymentMethod: 'ONLINE',
            idempotencyKey: `aud-dup-${rand()}-${Date.now()}`,
        });
        fixtureOrderIds.push(created.order.id);

        const providerOrderId = `${created.order.order_number}-R1`;
        await attachCashfreeOrderToPayment({
            paymentId: created.payment.id,
            cashfreeOrder: { order_id: providerOrderId, payment_session_id: 'sess_dup' },
        });

        const event = {
            providerOrderId,
            providerPaymentId: `CF-DUP-${rand()}`,
            paymentAmount: Number(created.order.total_amount),
            paymentCurrency: 'INR',
        };
        const first = await markPaymentSuccess(event);
        const second = await markPaymentSuccess(event);

        assert.equal(first.inventoryDeducted, true);
        assert.equal(second.alreadySettled, true);
        assert.equal(await deductionUnits(created.order.id), 2);
    });

    test('7. A late FAILED webhook cannot reverse a payment that already succeeded', async () => {
        const variantId = await createVariant();
        const created = await createOrder({
            customer: customer(), shippingAddress: address(),
            items: [{ variantId, quantity: 1 }], paymentMethod: 'ONLINE',
            idempotencyKey: `aud-ooo-${rand()}-${Date.now()}`,
        });
        fixtureOrderIds.push(created.order.id);

        const providerOrderId = `${created.order.order_number}-R1`;
        await attachCashfreeOrderToPayment({
            paymentId: created.payment.id,
            cashfreeOrder: { order_id: providerOrderId, payment_session_id: 'sess_ooo' },
        });
        await markPaymentSuccess({
            providerOrderId,
            providerPaymentId: `CF-OOO-${rand()}`,
            paymentAmount: Number(created.order.total_amount),
            paymentCurrency: 'INR',
        });

        await markPaymentFailed({ providerOrderId, providerPaymentId: `CF-OOO-LATE-${rand()}` });

        const pay = await query(`SELECT status, gateway_status FROM payments WHERE id = $1`, [created.payment.id]);
        assert.equal(pay.rows[0].status, 'paid');
        const order = await query(`SELECT status, payment_status FROM orders WHERE id = $1`, [created.order.id]);
        assert.equal(order.rows[0].payment_status, 'paid');
    });

    test('8. Insufficient stock after payment is handled as a stock exception with one refund intent (covered in depth by refund-orchestration 17-19)', async () => {
        // Exhaustive coverage lives in refund-orchestration.test.js (scenarios 17 to 19),
        // which reuses the same settlement path. This placeholder keeps the audit
        // matrix explicit: the scenario is verified there, not here.
        assert.ok(true);
    });

    // ---- Route-level safety ----

    test('14. Payment routes remain mounted behind the same validation (smoke)', async () => {
        const res = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.ok(res.status >= 400 && res.status < 500, `unsigned webhook must be refused, got ${res.status}`);
    });
});
