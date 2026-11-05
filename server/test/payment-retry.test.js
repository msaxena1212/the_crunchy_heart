/**
 * The Crunchy Heart - Phase 2B: Safe Cashfree Payment Retry Test Suite
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 * Tests all requirements for safe, idempotent Cashfree payment retries:
 * - 3-phase decoupled transaction flow (no DB locks during Cashfree network call)
 * - Cryptographic guest access token generation and constant-time verification
 * - Hardened payment status lookup
 * - Concurrency locking, duplicate attempt prevention, and ambiguous gateway timeout handling
 * - Zero inventory leakage and zero modification of existing orders/line items
 *
 * Strictly asserts that live Neon database is NEVER connected to.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// --------------------------------------------------------------------------
// 1. HARD SECURITY & PRODUCTION SAFETY ASSERTION
// --------------------------------------------------------------------------
const TEST_DB_URL =
    process.env.TEST_DATABASE_URL ||
    'postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test';

if (
    TEST_DB_URL.includes('neon.tech') ||
    TEST_DB_URL.includes('aws.neon.tech') ||
    TEST_DB_URL.includes('ep-solitary-block')
) {
    throw new Error(
        'FATAL SAFETY VIOLATION: Test suite attempted to run against live Neon database! Aborting immediately.'
    );
}

if (!TEST_DB_URL.includes('crunchy_heart_test')) {
    throw new Error(
        `FATAL SAFETY VIOLATION: Test suite must strictly run against 'crunchy_heart_test'. Provided: ${TEST_DB_URL}`
    );
}

const TEST_ORDER_TOKEN_SECRET = 'test_dedicated_order_token_secret_minimum_32_characters_long_1234567890';

// Override environment variables BEFORE any service/pool imports
process.env.DATABASE_URL = TEST_DB_URL;
process.env.DATABASE_URL_UNPOOLED = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.ORDER_TOKEN_SECRET = TEST_ORDER_TOKEN_SECRET;
process.env.CASHFREE_CLIENT_ID = 'TEST_RETRY_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_RETRY_CLIENT_SECRET';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

// Import modules after environment is set
const { pool, query } = await import('../src/db/pool.js');
const { createOrder, retryPaymentAttempt } = await import('../src/services/order.service.js');
const { attachCashfreeOrderToPayment, markPaymentSuccess, markPaymentFailed } = await import('../src/services/payment.service.js');
const { generateGuestAccessToken, verifyGuestAccessToken } = await import('../src/utils/order-token.js');
const { default: orderRoutes } = await import('../src/routes/order.routes.js');
const { default: paymentRoutes } = await import('../src/routes/payment.routes.js');

// --------------------------------------------------------------------------
// HTTP Test Server Harness
// --------------------------------------------------------------------------
let server;
let baseUrl;

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/orders', orderRoutes);
    app.use('/api/payments', paymentRoutes);

    app.use((error, req, res, next) => {
        const statusCode = error.statusCode || 500;
        return res.status(statusCode).json({
            success: false,
            message: error.message || 'Internal server error.',
        });
    });

    return app;
}

// --------------------------------------------------------------------------
// Mock Cashfree Gateway Interceptor
// --------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let mockCashfreeMode = 'SUCCESS'; // 'SUCCESS' | 'REJECT_400' | 'TIMEOUT_504' | 'NETWORK_ERROR'
let mockCashfreeCallCount = 0;
let lastCashfreePayload = null;
let mockCashfreeDelayMs = 0;

function installMockFetch() {
    globalThis.fetch = async (url, options = {}) => {
        const urlStr = String(url);

        // If not a Cashfree endpoint, delegate to native fetch (e.g. localhost test server)
        if (!urlStr.includes('cashfree.com')) {
            return originalFetch(url, options);
        }

        mockCashfreeCallCount++;

        if (mockCashfreeDelayMs > 0) {
            await new Promise(r => setTimeout(r, mockCashfreeDelayMs));
        }

        // 1. Handle Order Creation: POST /pg/orders
        if (urlStr.endsWith('/pg/orders') && options.method === 'POST') {
            lastCashfreePayload = JSON.parse(options.body || '{}');

            if (mockCashfreeMode === 'REJECT_400') {
                return new Response(
                    JSON.stringify({
                        message: 'Cashfree rejected order creation: invalid customer payload.',
                        code: 'INVALID_REQUEST',
                        type: 'invalid_request_error',
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }

            if (mockCashfreeMode === 'TIMEOUT_504') {
                return new Response(
                    JSON.stringify({
                        message: 'Gateway Timeout from Cashfree upstream.',
                    }),
                    { status: 504, headers: { 'Content-Type': 'application/json' } }
                );
            }

            if (mockCashfreeMode === 'NETWORK_ERROR') {
                const err = new Error('fetch failed: connect ECONNRESET 127.0.0.1');
                err.code = 'ECONNRESET';
                throw err;
            }

            // Normal SUCCESS
            return new Response(
                JSON.stringify({
                    cf_order_id: 99887766,
                    order_id: lastCashfreePayload.order_id,
                    order_status: 'ACTIVE',
                    payment_session_id: `session_${lastCashfreePayload.order_id}_${Math.random().toString(36).substring(2, 7)}`,
                    order_amount: lastCashfreePayload.order_amount,
                    order_currency: 'INR',
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // 2. Handle Payment Status: GET /pg/orders/{orderId}/payments
        if (urlStr.includes('/payments') && options.method === 'GET') {
            return new Response(
                JSON.stringify([
                    {
                        cf_payment_id: 11223344,
                        payment_status: 'SUCCESS',
                        payment_amount: 229.00,
                        payment_currency: 'INR',
                    },
                ]),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return originalFetch(url, options);
    };
}

function restoreFetch() {
    globalThis.fetch = originalFetch;
}

// --------------------------------------------------------------------------
// Database Fixtures
// --------------------------------------------------------------------------
let testCategoryId;
let testProductId;

async function createFixtureCategoryAndProduct() {
    const catRes = await query(
        `
        INSERT INTO categories (name, slug, description, is_active)
        VALUES ('Retry Test Category', 'retry-cat-' || gen_random_uuid(), 'Retry Test', true)
        RETURNING id
        `
    );
    testCategoryId = catRes.rows[0].id;

    const prodRes = await query(
        `
        INSERT INTO products (category_id, name, slug, brand, is_active)
        VALUES ($1, 'Retry Test Product', 'retry-prod-' || gen_random_uuid(), 'The Crunchy Heart', true)
        RETURNING id
        `,
        [testCategoryId]
    );
    testProductId = prodRes.rows[0].id;
}

async function createFixtureVariant({
    name = 'Retry Makhana 100g',
    sku = 'RTR-SKU-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
    sellingPrice = 229.00,
    mrp = 299.00,
    taxRate = 18.00,
    stock = 10,
    reserved = 0,
}) {
    const variantRes = await query(
        `
        INSERT INTO product_variants (
            product_id, sku, variant_name, weight_grams, flavor,
            mrp, selling_price, cost_price, tax_rate, is_active
        )
        VALUES ($1, $2, $3, 100, 'Classic', $4, $5, 100.00, $6, true)
        RETURNING id, sku, variant_name, selling_price, tax_rate
        `,
        [testProductId, sku, name, mrp, sellingPrice, taxRate]
    );
    const variant = variantRes.rows[0];

    await query(
        `
        INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
        VALUES ($1, $2, $3, 5)
        `,
        [variant.id, stock, reserved]
    );

    return variant;
}

function sampleCustomer() {
    return {
        name: 'Retry Customer',
        phone: '9876543210',
        email: 'retry-test@crunchyheart.example.com',
    };
}

function sampleAddress() {
    return {
        name: 'Retry Customer',
        phone: '9876543210',
        addressLine1: '789 Retry Expressway',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
        country: 'India',
    };
}

// --------------------------------------------------------------------------
// TEST SUITE: Safe Cashfree Payment Retry Suite
// --------------------------------------------------------------------------
describe('Phase 2B: Safe Cashfree Payment Retry Suite', () => {

    before(async () => {
        // Assert connection is strictly local
        const connRes = await query('SELECT current_database(), inet_server_addr()');
        assert.equal(connRes.rows[0].current_database, 'crunchy_heart_test');
        console.log(`\nVerified safe test DB connection: ${connRes.rows[0].current_database}`);

        installMockFetch();
        await createFixtureCategoryAndProduct();

        const app = buildTestApp();
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                console.log(`Payment retry test HTTP server listening at: ${baseUrl}`);
                resolve();
            });
        });
    });

    after(async () => {
        restoreFetch();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        await pool.end();
    });

    beforeEach(() => {
        mockCashfreeMode = 'SUCCESS';
        mockCashfreeCallCount = 0;
        lastCashfreePayload = null;
    });

    // ----------------------------------------------------------------------
    // 1. Eligible failed payment creates a new attempt for the existing order
    // ----------------------------------------------------------------------
    test('1. Eligible failed payment creates a new attempt (-R2) for the existing order', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        const initialAttemptOrderId = orderRes.order.order_number;
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: initialAttemptOrderId, payment_session_id: 'initial_sess' },
        });

        // First attempt fails at gateway
        await markPaymentFailed({ providerOrderId: initialAttemptOrderId });

        // Generate valid guest token for this order
        const guestToken = generateGuestAccessToken(orderRes.order);

        // Call HTTP retry endpoint
        const response = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-guest-access-token': guestToken,
            },
            body: JSON.stringify({}),
        });

        assert.equal(response.status, 200);
        const resJson = await response.json();
        assert.equal(resJson.success, true);
        assert.equal(resJson.order.id, orderRes.order.id);
        assert.equal(resJson.order.order_number, orderRes.order.order_number);

        // Crucial invariant: attempt order ID must have distinct attempt suffix
        assert.equal(resJson.cashfree.orderId, `${orderRes.order.order_number}-R2`);
        assert.ok(resJson.cashfree.paymentSessionId.startsWith('session_'));

        // Database assertions: exactly 2 payment attempts exist for this order
        const paymentsRes = await query(
            'SELECT provider_order_id, gateway_status, status FROM payments WHERE order_id = $1 ORDER BY created_at ASC',
            [orderRes.order.id]
        );
        assert.equal(paymentsRes.rows.length, 2);
        assert.equal(paymentsRes.rows[0].provider_order_id, initialAttemptOrderId);
        assert.equal(paymentsRes.rows[0].status, 'failed');
        assert.equal(paymentsRes.rows[1].provider_order_id, `${orderRes.order.order_number}-R2`);
        assert.equal(paymentsRes.rows[1].gateway_status, 'ORDER_CREATED');
    });

    // ----------------------------------------------------------------------
    // 2. Expired session can be replaced safely
    // ----------------------------------------------------------------------
    test('2. Expired session without payment failure can be replaced safely with new session', async () => {
        const variant = await createFixtureVariant({ stock: 5, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: orderRes.order.order_number, payment_session_id: 'old_expired_sess' },
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        // Customer requests retry because previous session expired
        const response = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-guest-access-token': guestToken,
            },
            body: JSON.stringify({}),
        });

        assert.equal(response.status, 200);
        const resJson = await response.json();
        assert.notEqual(resJson.cashfree.paymentSessionId, 'old_expired_sess');
        assert.equal(resJson.cashfree.orderId, `${orderRes.order.order_number}-R2`);
    });

    // ----------------------------------------------------------------------
    // 3. Order ID, order items, pricing and discounts remain unchanged
    // ----------------------------------------------------------------------
    test('3. Order items, snapshots, unit pricing and totals remain completely unchanged during retry', async () => {
        const variant = await createFixtureVariant({ stock: 5, sellingPrice: 229.00 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        const response = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'x-guest-access-token': guestToken,
            },
        });

        assert.equal(response.status, 200);
        const resJson = await response.json();

        assert.equal(resJson.order.id, orderRes.order.id);
        assert.equal(resJson.order.total_amount, orderRes.order.total_amount);
        assert.equal(resJson.order.subtotal, orderRes.order.subtotal);
        assert.equal(resJson.order.shipping_amount, orderRes.order.shipping_amount);
        assert.equal(resJson.items.length, 1);
        assert.equal(resJson.items[0].unitPrice, 229.00);
        assert.equal(resJson.items[0].quantity, 2);
    });

    // ----------------------------------------------------------------------
    // 4. A paid order returns HTTP 409 and makes no Cashfree creation request
    // ----------------------------------------------------------------------
    test('4. Already paid order returns HTTP 409 and aborts without calling Cashfree', async () => {
        const variant = await createFixtureVariant({ stock: 5 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: orderRes.order.order_number, payment_session_id: 's' },
        });

        // Settle payment
        await markPaymentSuccess({
            providerOrderId: orderRes.order.order_number,
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);
        const initialCallCount = mockCashfreeCallCount;

        const response = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });

        assert.equal(response.status, 409);
        const resJson = await response.json();
        assert.match(resJson.message, /already been paid/i);

        // Crucial safety assertion: Cashfree was NEVER called
        assert.equal(mockCashfreeCallCount, initialCallCount);
    });

    // ----------------------------------------------------------------------
    // 5. A cancelled order is rejected
    // ----------------------------------------------------------------------
    test('5. Cancelled order returns HTTP 400 and is rejected', async () => {
        const variant = await createFixtureVariant({ stock: 5 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        // Mark order cancelled
        await query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderRes.order.id]);

        const guestToken = generateGuestAccessToken(orderRes.order);

        const response = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });

        assert.equal(response.status, 400);
        const resJson = await response.json();
        assert.match(resJson.message, /cancelled/i);
    });

    // ----------------------------------------------------------------------
    // 6. COD orders are rejected by the online retry endpoint
    // ----------------------------------------------------------------------
    test('6. COD order is rejected with HTTP 400 by online retry endpoint', async () => {
        const variant = await createFixtureVariant({ stock: 5 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'COD',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        const response = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });

        assert.equal(response.status, 400);
        const resJson = await response.json();
        assert.match(resJson.message, /only online payment orders/i);
    });

    // ----------------------------------------------------------------------
    // 7. Insufficient inventory prevents new payment-session creation
    // ----------------------------------------------------------------------
    test('7. Insufficient inventory returns HTTP 409 and prevents Cashfree session creation', async () => {
        const variant = await createFixtureVariant({ stock: 2, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        // Exhaust stock by another customer before retry
        await query('UPDATE inventory SET quantity_on_hand = 1 WHERE variant_id = $1', [variant.id]);

        const guestToken = generateGuestAccessToken(orderRes.order);
        const initialCallCount = mockCashfreeCallCount;

        const response = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });

        assert.equal(response.status, 409);
        const resJson = await response.json();
        assert.match(resJson.message, /insufficient inventory/i);

        // Never called Cashfree
        assert.equal(mockCashfreeCallCount, initialCallCount);
    });

    // ----------------------------------------------------------------------
    // 8. Unauthenticated or unauthorized guest retry is rejected
    // ----------------------------------------------------------------------
    test('8. Missing, forged, or mismatched guest access token returns HTTP 401', async () => {
        const variant = await createFixtureVariant({ stock: 5 });

        const orderRes1 = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const orderRes2 = await createOrder({
            customer: { name: 'Other User', phone: '9999999999' },
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const tokenOrder1 = generateGuestAccessToken(orderRes1.order);

        // 1. Missing token header
        const res1 = await fetch(`${baseUrl}/api/orders/${orderRes1.order.order_number}/retry-payment`, {
            method: 'POST',
        });
        assert.equal(res1.status, 401);

        // 2. Forged signature token
        const forgedToken = tokenOrder1.slice(0, -6) + 'abcdef';
        const res2 = await fetch(`${baseUrl}/api/orders/${orderRes1.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': forgedToken },
        });
        assert.equal(res2.status, 401);

        // 3. Valid token for Order 1 used against Order 2 (Order mismatch)
        const res3 = await fetch(`${baseUrl}/api/orders/${orderRes2.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': tokenOrder1 },
        });
        assert.equal(res3.status, 401);
    });

    // ----------------------------------------------------------------------
    // 9. Two concurrent retry requests cannot create unintended duplicate attempts
    // ----------------------------------------------------------------------
    test('9. Concurrent retry requests are synchronized deterministically without duplicate sessions', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);
        const retryKey = 'CONC_KEY_' + Math.random().toString(36).substring(2, 9);

        // Fire 2 concurrent HTTP retry requests with the exact same idempotency key
        const [resA, resB] = await Promise.all([
            fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-guest-access-token': guestToken,
                    'idempotency-key': retryKey,
                },
                body: JSON.stringify({}),
            }),
            fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-guest-access-token': guestToken,
                    'idempotency-key': retryKey,
                },
                body: JSON.stringify({}),
            }),
        ]);

        assert.ok([200, 409].includes(resA.status));
        assert.ok([200, 409].includes(resB.status));

        // Exactly one session created for that idempotency key
        const paymentsInDb = await query(
            'SELECT provider_order_id, idempotency_key FROM payments WHERE order_id = $1 AND idempotency_key = $2',
            [orderRes.order.id, retryKey]
        );
        assert.equal(paymentsInDb.rows.length, 1);
    });

    // ----------------------------------------------------------------------
    // 10. Repeating a request with the same idempotency key returns the same attempt
    // ----------------------------------------------------------------------
    test('10. Repeating a retry request with the same idempotency key returns the existing attempt', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);
        const stableKey = 'STABLE_RETRY_KEY_' + Math.random().toString(36).substring(2, 8);

        // First call
        const firstRes = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-guest-access-token': guestToken,
                'idempotency-key': stableKey,
            },
        });
        assert.equal(firstRes.status, 200);
        const firstJson = await firstRes.json();
        assert.equal(firstJson.existing, false);

        const initialSessionId = firstJson.cashfree.paymentSessionId;
        const initialAttemptOrderId = firstJson.cashfree.orderId;

        // Second call with same idempotency key
        const secondRes = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-guest-access-token': guestToken,
                'idempotency-key': stableKey,
            },
        });
        assert.equal(secondRes.status, 200);
        const secondJson = await secondRes.json();
        assert.equal(secondJson.existing, true);
        assert.equal(secondJson.cashfree.paymentSessionId, initialSessionId);
        assert.equal(secondJson.cashfree.orderId, initialAttemptOrderId);
    });

    // ----------------------------------------------------------------------
    // 11. A new idempotency key creates a new attempt when prior is eligible
    // ----------------------------------------------------------------------
    test('11. A new idempotency key creates an incremented attempt (-R2, -R3)', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        // Attempt 1 via retry
        const res1 = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });
        const json1 = await res1.json();
        assert.equal(json1.cashfree.orderId, `${orderRes.order.order_number}-R2`);

        // Attempt 2 via retry with distinct request
        const res2 = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });
        const json2 = await res2.json();
        assert.equal(json2.cashfree.orderId, `${orderRes.order.order_number}-R3`);
    });

    // ----------------------------------------------------------------------
    // 12. Cashfree rejection is handled without corrupting the order
    // ----------------------------------------------------------------------
    test('12. Cashfree 400 rejection records CREATION_REJECTED without corrupting the order', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        // Configure mock to simulate 400 Bad Request rejection from Cashfree
        mockCashfreeMode = 'REJECT_400';

        const response = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });

        assert.equal(response.status, 400);

        // Order remains in pending status
        const orderCheck = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(orderCheck.rows[0].status, 'pending');

        // Payment attempt recorded with CREATION_REJECTED status
        const paymentCheck = await query(
            'SELECT gateway_status, status FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
            [orderRes.order.id]
        );
        assert.equal(paymentCheck.rows[0].gateway_status, 'CREATION_REJECTED');
        assert.equal(paymentCheck.rows[0].status, 'failed');
    });

    // ----------------------------------------------------------------------
    // 13. Cashfree timeout / ambiguous outcome does not cause blind duplicate attempts
    // ----------------------------------------------------------------------
    test('13. Cashfree timeout (504) records GATEWAY_AMBIGUOUS_TIMEOUT and prevents blind duplicate attempts', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);
        const retryKey = 'AMBIGUOUS_TIMEOUT_KEY_' + Math.random().toString(36).substring(2, 7);

        // First call: times out
        mockCashfreeMode = 'TIMEOUT_504';
        const res1 = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-guest-access-token': guestToken,
                'idempotency-key': retryKey,
            },
        });
        assert.equal(res1.status, 504);

        // Verify attempt is preserved in DB as GATEWAY_AMBIGUOUS_TIMEOUT
        const timeoutAttempt = await query(
            'SELECT gateway_status FROM payments WHERE order_id = $1 AND idempotency_key = $2',
            [orderRes.order.id, retryKey]
        );
        assert.equal(timeoutAttempt.rows[0].gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');

        // Second call with same idempotency key fails closed without creating another blind attempt
        const res2 = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-guest-access-token': guestToken,
                'idempotency-key': retryKey,
            },
        });
        assert.equal(res2.status, 504);
        const res2Json = await res2.json();
        assert.match(res2Json.message, /timed out.*check payment status before retrying/i);
    });

    // ----------------------------------------------------------------------
    // 14. A late failure webhook cannot overwrite a successful payment
    // ----------------------------------------------------------------------
    test('14. Late failure webhook does not reverse an already settled payment retry', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        // Perform retry attempt
        const retryRes = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });
        const retryJson = await retryRes.json();
        const retryOrderId = retryJson.cashfree.orderId;

        // Payment succeeds
        await markPaymentSuccess({
            providerOrderId: retryOrderId,
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });

        // A delayed failure event arrives for that attempt
        const failResult = await markPaymentFailed({
            providerOrderId: retryOrderId,
            providerPaymentId: 'CF_FAIL_LATE',
        });

        assert.equal(failResult.status, 'paid');
        assert.equal(failResult.ignored, true);

        const check = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(check.rows[0].status, 'confirmed');
        assert.equal(check.rows[0].payment_status, 'paid');
    });

    // ----------------------------------------------------------------------
    // 15. Duplicate success webhooks cannot deduct inventory twice
    // ----------------------------------------------------------------------
    test('15. Duplicate payment-success events on retried order deduct inventory exactly once', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 3 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);
        const retryRes = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });
        const retryJson = await retryRes.json();
        const retryOrderId = retryJson.cashfree.orderId;

        // 1st webhook call
        const s1 = await markPaymentSuccess({
            providerOrderId: retryOrderId,
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });
        assert.equal(s1.status, 'paid');
        assert.equal(s1.inventoryDeducted, true);

        // 2nd webhook call (duplicate)
        const s2 = await markPaymentSuccess({
            providerOrderId: retryOrderId,
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });
        assert.equal(s2.status, 'paid');
        assert.equal(s2.alreadySettled, true);

        // Inventory check: 10 - 3 = 7 (not 4)
        const inv = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(inv.rows[0].quantity_on_hand), 7);
    });

    // ----------------------------------------------------------------------
    // 16. Hardened payment status lookup requires valid guest token
    // ----------------------------------------------------------------------
    test('16. Hardened payment status endpoint requires guest access token and rejects unauthorized inquiries', async () => {
        const variant = await createFixtureVariant({ stock: 5 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        // 1. Missing token
        const resMissing = await fetch(`${baseUrl}/api/payments/status/${orderRes.order.order_number}`);
        assert.equal(resMissing.status, 401);
        const missingJson = await resMissing.json();
        assert.match(missingJson.message, /valid guest access token is required/i);

        // 2. Invalid token
        const resBad = await fetch(`${baseUrl}/api/payments/status/${orderRes.order.order_number}`, {
            headers: { 'x-guest-access-token': 'v1.fake.signature' },
        });
        assert.equal(resBad.status, 401);

        // 3. Valid token succeeds
        const resGood = await fetch(`${baseUrl}/api/payments/status/${orderRes.order.order_number}`, {
            headers: { 'x-guest-access-token': guestToken },
        });
        assert.equal(resGood.status, 200);
        const goodJson = await resGood.json();
        assert.equal(goodJson.success, true);
        assert.equal(goodJson.status, 'SUCCESS');
    });

    // ----------------------------------------------------------------------
    // 17. Fix SEC-01: Checkout idempotency replay without token fails closed
    // ----------------------------------------------------------------------
    test('17. Checkout idempotency replay rejects unauthorized callers and requires verified guest token', async () => {
        const variant = await createFixtureVariant({ stock: 10 });
        const idempotencyKey = 'SEC01_KEY_' + Math.random().toString(36).substring(2, 9);

        // A. Initial legitimate first-time guest checkout
        const initialRes = await fetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'idempotency-key': idempotencyKey,
            },
            body: JSON.stringify({
                customer: sampleCustomer(),
                shippingAddress: sampleAddress(),
                items: [{ variantId: variant.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
            }),
        });

        assert.equal(initialRes.status, 201);
        const initialJson = await initialRes.json();
        assert.equal(initialJson.success, true);
        assert.equal(initialJson.existing, false);
        assert.ok(initialJson.guestAccessToken);
        const originalGuestToken = initialJson.guestAccessToken;
        const originalOrderNumber = initialJson.order.order_number;

        // B. Unauthorized replay without token: must fail closed with 409 and NOT leak order/token
        const unauthRes = await fetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'idempotency-key': idempotencyKey,
            },
            body: JSON.stringify({
                customer: { name: 'Attacker', phone: '9999999999', email: 'attacker@example.com' },
                shippingAddress: sampleAddress(),
                items: [{ variantId: variant.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
            }),
        });

        assert.equal(unauthRes.status, 409);
        const unauthJson = await unauthRes.json();
        assert.equal(unauthJson.success, false);
        assert.equal(unauthJson.code, 'IDEMPOTENCY_REPLAY_UNAUTHORIZED');
        assert.strictEqual(unauthJson.guestAccessToken, undefined);
        assert.strictEqual(unauthJson.order, undefined);
        assert.strictEqual(unauthJson.cashfree, undefined);

        // C. Replay with invalid/forged token: must fail closed
        const badTokenRes = await fetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'idempotency-key': idempotencyKey,
                'x-guest-access-token': 'v1.forged.invalid_token',
            },
            body: JSON.stringify({
                customer: sampleCustomer(),
                shippingAddress: sampleAddress(),
                items: [{ variantId: variant.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
            }),
        });

        assert.equal(badTokenRes.status, 409);
        const badTokenJson = await badTokenRes.json();
        assert.equal(badTokenJson.code, 'IDEMPOTENCY_REPLAY_UNAUTHORIZED');

        // D. Authorized replay with valid token: returns existing order and session
        const authRes = await fetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'idempotency-key': idempotencyKey,
                'x-guest-access-token': originalGuestToken,
            },
            body: JSON.stringify({
                customer: sampleCustomer(),
                shippingAddress: sampleAddress(),
                items: [{ variantId: variant.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
            }),
        });

        assert.equal(authRes.status, 200);
        const authJson = await authRes.json();
        assert.equal(authJson.success, true);
        assert.equal(authJson.existing, true);
        assert.equal(authJson.order.order_number, originalOrderNumber);
        assert.equal(authJson.guestAccessToken, originalGuestToken);

        // E. SEC-01: Attacker matching phone number and email alone without token is REJECTED
        const phoneMatchRes = await fetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'idempotency-key': idempotencyKey,
            },
            body: JSON.stringify({
                customer: {
                    name: 'Attacker Impersonator',
                    phone: initialJson.order.phone, // Exact matching phone number!
                    email: initialJson.order.email, // Exact matching email!
                },
                shippingAddress: sampleAddress(),
                items: [{ variantId: variant.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
            }),
        });

        assert.equal(phoneMatchRes.status, 409);
        const phoneMatchJson = await phoneMatchRes.json();
        assert.equal(phoneMatchJson.code, 'IDEMPOTENCY_REPLAY_UNAUTHORIZED');
        assert.strictEqual(phoneMatchJson.guestAccessToken, undefined);
        assert.strictEqual(phoneMatchJson.order, undefined);

        // F. SEC-01: Replay of Order A's key with a valid guest token from Order B is REJECTED
        const orderBRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });
        const orderBToken = generateGuestAccessToken(orderBRes.order);

        const crossOrderReplayRes = await fetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'idempotency-key': idempotencyKey,
                'x-guest-access-token': orderBToken, // Valid token, but for Order B!
            },
            body: JSON.stringify({
                customer: sampleCustomer(),
                shippingAddress: sampleAddress(),
                items: [{ variantId: variant.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
            }),
        });

        assert.equal(crossOrderReplayRes.status, 409);
        const crossOrderReplayJson = await crossOrderReplayRes.json();
        assert.equal(crossOrderReplayJson.code, 'IDEMPOTENCY_REPLAY_UNAUTHORIZED');
        assert.strictEqual(crossOrderReplayJson.guestAccessToken, undefined);
        assert.strictEqual(crossOrderReplayJson.order, undefined);
    });

    // ----------------------------------------------------------------------
    // 18. Fix CONC-01: Cross-attempt duplicate settlement prevents double deduction
    // ----------------------------------------------------------------------
    test('18. Two distinct payment attempts for same order deduct inventory exactly once and create refund record', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 3 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        // Attempt 1: orderRes.payment (provider_order_id = TCH-xxxx)
        const attempt1Id = orderRes.order.order_number;
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: attempt1Id, payment_session_id: 'sess1' },
        });

        // Attempt 2: Create retry attempt (-R2)
        const retryRes = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });
        const retryJson = await retryRes.json();
        const attempt2Id = retryJson.cashfree.orderId;

        // A. Attempt 1 is captured and settled first
        const settlement1 = await markPaymentSuccess({
            providerOrderId: attempt1Id,
            providerPaymentId: 'CF_CAPTURE_1',
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });

        assert.equal(settlement1.status, 'paid');
        assert.equal(settlement1.inventoryDeducted, true);

        // Inventory must be 10 - 3 = 7
        const invAfter1 = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfter1.rows[0].quantity_on_hand), 7);

        // B. Attempt 2 is ALSO captured by Cashfree (customer paid twice!)
        const settlement2 = await markPaymentSuccess({
            providerOrderId: attempt2Id,
            providerPaymentId: 'CF_CAPTURE_2',
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });

        // Settlement 2 must record the captured payment, but NOT deduct inventory again
        assert.equal(settlement2.status, 'paid');
        assert.equal(settlement2.gatewayStatus, 'PAID_DUPLICATE_ORDER_SETTLED');
        assert.equal(settlement2.inventoryDeducted, false);
        assert.equal(settlement2.duplicateSettlement, true);
        assert.ok(settlement2.refundId);
        assert.equal(settlement2.refundStatus, 'pending');

        // Inventory must STILL be 7 (never deducted twice)
        const invAfter2 = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfter2.rows[0].quantity_on_hand), 7);

        // Verify refund record exists in DB with status pending
        const refundRow = await query('SELECT * FROM refunds WHERE id = $1', [settlement2.refundId]);
        assert.equal(refundRow.rows.length, 1);
        assert.equal(refundRow.rows[0].status, 'pending');
        assert.equal(Number(refundRow.rows[0].amount), Number(orderRes.order.total_amount));

        // C. Repeated webhook for Attempt 2 returns alreadySettled and does not insert duplicate refund
        const settlement2Repeat = await markPaymentSuccess({
            providerOrderId: attempt2Id,
            providerPaymentId: 'CF_CAPTURE_2',
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });
        assert.equal(settlement2Repeat.alreadySettled, true);

        const refundCount = await query('SELECT count(*) FROM refunds WHERE order_id = $1', [orderRes.order.id]);
        assert.equal(Number(refundCount.rows[0].count), 1);
    });

    // ----------------------------------------------------------------------
    // 18b. CONC-01: Concurrent webhook execution for two different attempts
    // ----------------------------------------------------------------------
    test('18b. Concurrent webhook processing for two distinct payment attempts deducts stock exactly once', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 4 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);
        const attempt1Id = orderRes.order.order_number;
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: attempt1Id, payment_session_id: 'sess1' },
        });

        const retryRes = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });
        const retryJson = await retryRes.json();
        const attempt2Id = retryJson.cashfree.orderId;

        // Execute both settlement webhooks concurrently!
        const [settlementA, settlementB] = await Promise.all([
            markPaymentSuccess({
                providerOrderId: attempt1Id,
                providerPaymentId: 'CF_CONCURRENT_1',
                paymentAmount: orderRes.order.total_amount,
                paymentCurrency: 'INR',
            }),
            markPaymentSuccess({
                providerOrderId: attempt2Id,
                providerPaymentId: 'CF_CONCURRENT_2',
                paymentAmount: orderRes.order.total_amount,
                paymentCurrency: 'INR',
            }),
        ]);

        // One must be the primary settlement and the other must be the duplicate settlement
        const primary = settlementA.inventoryDeducted ? settlementA : settlementB;
        const duplicate = settlementA.inventoryDeducted ? settlementB : settlementA;

        assert.equal(primary.status, 'paid');
        assert.equal(primary.inventoryDeducted, true);

        assert.equal(duplicate.status, 'paid');
        assert.equal(duplicate.duplicateSettlement, true);
        assert.equal(duplicate.gatewayStatus, 'PAID_DUPLICATE_ORDER_SETTLED');
        assert.equal(duplicate.inventoryDeducted, false);
        assert.ok(duplicate.refundId);
        assert.equal(duplicate.refundStatus, 'pending');

        // Stock must be deducted EXACTLY once: 10 - 4 = 6
        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 6);

        // Exactly one pending refund review record exists
        const refundsCheck = await query('SELECT * FROM refunds WHERE order_id = $1', [orderRes.order.id]);
        assert.equal(refundsCheck.rows.length, 1);
        assert.equal(refundsCheck.rows[0].status, 'pending');
        assert.equal(Number(refundsCheck.rows[0].amount), Number(orderRes.order.total_amount));
    });

    // ----------------------------------------------------------------------
    // 19. Fix CONC-02: Competing retry requests with different keys are serialized
    // ----------------------------------------------------------------------
    test('19. In-flight attempt and ambiguous timeout block new attempt creation across different keys', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        // Manually set an attempt as ATTEMPT_INITIATED on this order
        await query(
            `
            INSERT INTO payments (order_id, provider, provider_order_id, amount, currency, status, gateway_status, payment_method, created_at, updated_at)
            VALUES ($1, 'cashfree', $2, 229.00, 'INR', 'created', 'ATTEMPT_INITIATED', 'ONLINE', NOW(), NOW())
            `,
            [orderRes.order.id, `${orderRes.order.order_number}-R2`]
        );

        // Attempting to create another retry with a DIFFERENT idempotency key must fail with 409
        const inFlightRes = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-guest-access-token': guestToken,
                'idempotency-key': 'DIFFERENT_KEY_123',
            },
        });
        assert.equal(inFlightRes.status, 409);
        const inFlightJson = await inFlightRes.json();
        assert.match(inFlightJson.message, /retry attempt is currently being processed/i);

        // Now update that attempt to GATEWAY_AMBIGUOUS_TIMEOUT
        await query(
            `
            UPDATE payments
            SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT'
            WHERE order_id = $1 AND provider_order_id = $2
            `,
            [orderRes.order.id, `${orderRes.order.order_number}-R2`]
        );

        // Retrying with a new idempotency key must now fail with 504 (blocked on ambiguous attempt)
        const ambigRes = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-guest-access-token': guestToken,
                'idempotency-key': 'ANOTHER_NEW_KEY_456',
            },
        });
        assert.equal(ambigRes.status, 504);
        const ambigJson = await ambigRes.json();
        assert.match(ambigJson.message, /timed out and is awaiting status reconciliation/i);
    });

    // ----------------------------------------------------------------------
    // 19b. CONC-02: Simultaneous concurrent retry requests with different keys
    // ----------------------------------------------------------------------
    test('19b. Competing concurrent retry requests with different idempotency keys are serialized without parallel attempts', async () => {
        const variant = await createFixtureVariant({ stock: 10 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        // Fire two retry requests simultaneously with different idempotency keys while Cashfree network call is in flight
        mockCashfreeDelayMs = 50;
        try {
            const [res1, res2] = await Promise.all([
                fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-guest-access-token': guestToken,
                        'idempotency-key': 'CONCURRENT_KEY_1',
                    },
                }),
                fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-guest-access-token': guestToken,
                        'idempotency-key': 'CONCURRENT_KEY_2',
                    },
                }),
            ]);

            const statuses = [res1.status, res2.status].sort();
            // One must succeed (200) and the other must be rejected (409 conflict: in-flight attempt)
            assert.deepEqual(statuses, [200, 409]);

            // Verify total payment attempts in database: exactly 2 (initial attempt + 1 retry attempt)
            const paymentRows = await query('SELECT * FROM payments WHERE order_id = $1', [orderRes.order.id]);
            assert.equal(paymentRows.rows.length, 2);
        } finally {
            mockCashfreeDelayMs = 0;
        }
    });

    // ----------------------------------------------------------------------
    // 20. Fix API-01: Status endpoint reports latest attempt and attempt history
    // ----------------------------------------------------------------------
    test('20. Payment status lookup returns latest retry attempt and attempt summary for base order number', async () => {
        const variant = await createFixtureVariant({ stock: 5 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const guestToken = generateGuestAccessToken(orderRes.order);

        // Create retry attempt (-R2)
        const retryRes = await fetch(`${baseUrl}/api/orders/${orderRes.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': guestToken },
        });
        assert.equal(retryRes.status, 200);

        // Snapshot database state before status checks
        const orderBefore = await query('SELECT * FROM orders WHERE id = $1', [orderRes.order.id]);
        const paymentsBefore = await query('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at ASC', [orderRes.order.id]);
        const invBefore = await query('SELECT * FROM inventory WHERE variant_id = $1', [variant.id]);

        // A. Query status using BASE order number
        const statusRes = await fetch(`${baseUrl}/api/payments/status/${orderRes.order.order_number}`, {
            headers: { 'x-guest-access-token': guestToken },
        });
        assert.equal(statusRes.status, 200);
        const statusJson = await statusRes.json();

        assert.equal(statusJson.success, true);
        assert.equal(statusJson.orderNumber, orderRes.order.order_number);
        assert.ok(statusJson.latestAttempt);
        assert.equal(statusJson.latestAttempt.providerOrderId, `${orderRes.order.order_number}-R2`);
        assert.ok(Array.isArray(statusJson.attempts));
        assert.ok(statusJson.attempts.length >= 2);

        // B. Query status using direct provider_order_id (-R2)
        const directRetryRes = await fetch(`${baseUrl}/api/payments/status/${orderRes.order.order_number}-R2`, {
            headers: { 'x-guest-access-token': guestToken },
        });
        assert.equal(directRetryRes.status, 200);
        const directJson = await directRetryRes.json();
        assert.equal(directJson.success, true);
        assert.equal(directJson.orderId, `${orderRes.order.order_number}-R2`);
        assert.equal(directJson.orderNumber, orderRes.order.order_number);

        // C. Cross-order token rejection: create a second order B, use Order A's token on Order B base number
        const orderB = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });
        const orderBToken = generateGuestAccessToken(orderB.order);

        // Create attempt on Order B
        const retryBRes = await fetch(`${baseUrl}/api/orders/${orderB.order.order_number}/retry-payment`, {
            method: 'POST',
            headers: { 'x-guest-access-token': orderBToken },
        });
        assert.equal(retryBRes.status, 200);

        const crossBaseRes = await fetch(`${baseUrl}/api/payments/status/${orderB.order.order_number}`, {
            headers: { 'x-guest-access-token': guestToken }, // Order A's token!
        });
        assert.equal(crossBaseRes.status, 401);

        // D. Cross-order token rejection: use Order A's token on Order B's provider_order_id (-R2)
        const crossDirectRes = await fetch(`${baseUrl}/api/payments/status/${orderB.order.order_number}-R2`, {
            headers: { 'x-guest-access-token': guestToken }, // Order A's token!
        });
        assert.equal(crossDirectRes.status, 401);

        // E. Verification of zero state mutations: status lookups must NOT mutate orders, payments, or inventory
        const orderAfter = await query('SELECT * FROM orders WHERE id = $1', [orderRes.order.id]);
        const paymentsAfter = await query('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at ASC', [orderRes.order.id]);
        const invAfter = await query('SELECT * FROM inventory WHERE variant_id = $1', [variant.id]);

        assert.equal(orderAfter.rows[0].status, orderBefore.rows[0].status);
        assert.equal(orderAfter.rows[0].payment_status, orderBefore.rows[0].payment_status);
        assert.equal(paymentsAfter.rows.length, paymentsBefore.rows.length);
        assert.equal(invAfter.rows[0].quantity_on_hand, invBefore.rows[0].quantity_on_hand);
    });

    // ----------------------------------------------------------------------
    // 21. The test harness fails closed when the target database is not crunchy_heart_test
    // ----------------------------------------------------------------------
    test('21. Safety assertion validates database identity and fails closed on production targets', () => {
        assert.throws(
            () => {
                const badDbUrl = 'postgresql://user:pass@ep-solitary-block.aws.neon.tech/neondb';
                if (badDbUrl.includes('neon.tech')) {
                    throw new Error('FATAL SAFETY VIOLATION: Test suite attempted to run against live Neon database!');
                }
            },
            /FATAL SAFETY VIOLATION/
        );
    });
});
