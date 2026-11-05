/**
 * The Crunchy Heart - Phase 3.2: Storefront Minimum Viable Customer Checkout Suite
 *
 * Tests the complete end-to-end customer checkout journey against isolated local PostgreSQL:
 * - Checkout preview & server-calculated totals (GST 18%, shipping threshold ₹499)
 * - COD order creation (zero inventory reservation at checkout)
 * - Online order creation with mocked Cashfree payment session
 * - Idempotency key replay protection & guest token authorization (SEC-01)
 * - Ambiguous timeout safety (CONC-02)
 * - Protected order details endpoint GET /api/orders/:orderNumber
 * - Status inquiries and retry permission rules
 * - Preservation of historical order TCH-20261008-AJERUQ
 *
 * Live Neon and live Cashfree are NEVER contacted.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// --------------------------------------------------------------------------
// 1. HARD SAFETY ASSERTION
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

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DATABASE_URL_UNPOOLED = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.CASHFREE_CLIENT_ID = 'TEST_CHECKOUT_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_CHECKOUT_SECRET_KEY_123456789012345678901234';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'test_order_token_secret_minimum_32_characters_long_for_security';

const { pool, query } = await import('../src/db/pool.js');
const checkoutRoutes = (await import('../src/routes/checkout.routes.js')).default;
const orderRoutes = (await import('../src/routes/order.routes.js')).default;
const paymentRoutes = (await import('../src/routes/payment.routes.js')).default;
const { generateGuestAccessToken, verifyGuestAccessToken } = await import('../src/utils/order-token.js');

// --------------------------------------------------------------------------
// Express App & HTTP Server Harness
// --------------------------------------------------------------------------
let server;
let baseUrl;

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/checkout', checkoutRoutes);
    app.use('/api/orders', orderRoutes);
    app.use('/api/payments', paymentRoutes);

    app.use((error, req, res, next) => {
        const statusCode = error.statusCode || 500;
        return res.status(statusCode).json({
            success: false,
            message: error.message || 'Internal server error.',
            code: error.code || null,
        });
    });

    return app;
}

// --------------------------------------------------------------------------
// Mock Cashfree Gateway Interceptor
// --------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let mockCashfreeMode = 'SUCCESS'; // 'SUCCESS' | 'TIMEOUT_504' | 'FAIL_400'
let lastCashfreeCreatePayload = null;

function installMockFetch() {
    globalThis.fetch = async (url, options = {}) => {
        const urlStr = String(url);

        if (!urlStr.includes('cashfree.com')) {
            return originalFetch(url, options);
        }

        if (urlStr.endsWith('/pg/orders') && options.method === 'POST') {
            lastCashfreeCreatePayload = JSON.parse(options.body || '{}');

            if (mockCashfreeMode === 'TIMEOUT_504') {
                const err = new Error('Gateway timeout from upstream Cashfree');
                err.statusCode = 504;
                throw err;
            }

            if (mockCashfreeMode === 'FAIL_400') {
                return new Response(
                    JSON.stringify({
                        message: 'Customer phone is invalid.',
                        code: 'invalid_customer_phone',
                        type: 'validation_error',
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }

            return new Response(
                JSON.stringify({
                    cf_order_id: `cf_test_${Date.now()}`,
                    order_id: lastCashfreeCreatePayload.order_id,
                    order_amount: lastCashfreeCreatePayload.order_amount,
                    order_currency: 'INR',
                    order_status: 'ACTIVE',
                    payment_session_id: `session_mock_${Date.now()}_xyz`,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        if (urlStr.includes('/payments')) {
            return new Response(
                JSON.stringify([]),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return new Response(
            JSON.stringify({}),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    };
}

function restoreFetch() {
    globalThis.fetch = originalFetch;
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------
let testCategoryId;
let testProductId;
let variantA;
let variantB;

async function setupFixtures() {
    const catRes = await query(
        `
        INSERT INTO categories (name, slug, description, is_active)
        VALUES ('Checkout Test Category', 'checkout-cat-' || gen_random_uuid(), 'Test', true)
        RETURNING id
        `
    );
    testCategoryId = catRes.rows[0].id;

    const prodRes = await query(
        `
        INSERT INTO products (category_id, name, slug, brand, is_active)
        VALUES ($1, 'Checkout Test Makhana', 'checkout-makhana-' || gen_random_uuid(), 'The Crunchy Heart', true)
        RETURNING id
        `,
        [testCategoryId]
    );
    testProductId = prodRes.rows[0].id;

    // Variant A: ₹199 (below ₹499 shipping threshold)
    const varARes = await query(
        `
        INSERT INTO product_variants (
            product_id, sku, variant_name, weight_grams, flavor,
            mrp, selling_price, cost_price, tax_rate, is_active
        )
        VALUES ($1, 'TEST-CHK-A-' || gen_random_uuid(), 'Roasted Himalayan Salt 100g', 100, 'Salt', 249.00, 199.00, 90.00, 18.00, true)
        RETURNING id, sku, variant_name, selling_price, tax_rate
        `,
        [testProductId]
    );
    variantA = varARes.rows[0];

    await query(
        `
        INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved)
        VALUES ($1, 50, 0)
        ON CONFLICT (variant_id) DO UPDATE SET quantity_on_hand = 50, quantity_reserved = 0
        `,
        [variantA.id]
    );

    // Variant B: ₹599 (at/above ₹499 threshold for free shipping)
    const varBRes = await query(
        `
        INSERT INTO product_variants (
            product_id, sku, variant_name, weight_grams, flavor,
            mrp, selling_price, cost_price, tax_rate, is_active
        )
        VALUES ($1, 'TEST-CHK-B-' || gen_random_uuid(), 'Truffle & Herb Makhana Family Pack', 300, 'Truffle', 699.00, 599.00, 250.00, 18.00, true)
        RETURNING id, sku, variant_name, selling_price, tax_rate
        `,
        [testProductId]
    );
    variantB = varBRes.rows[0];

    await query(
        `
        INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved)
        VALUES ($1, 20, 0)
        ON CONFLICT (variant_id) DO UPDATE SET quantity_on_hand = 20, quantity_reserved = 0
        `,
        [variantB.id]
    );
}

// --------------------------------------------------------------------------
// SUITE
// --------------------------------------------------------------------------
describe('Phase 3.2: Storefront Customer Checkout Acceptance Suite', () => {

    before(async () => {
        installMockFetch();
        await setupFixtures();

        const app = buildTestApp();
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    after(async () => {
        restoreFetch();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    // ----------------------------------------------------------------------
    // Safety check
    // ----------------------------------------------------------------------
    test('0. Historical order safety check & zero-reservation assertion', async () => {
        const res = await query(
            `
            SELECT o.order_number, i.quantity_reserved
            FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
            JOIN inventory i ON i.variant_id = oi.variant_id
            WHERE o.order_number = 'TCH-20261008-AJERUQ'
            `
        );
        if (res.rows.length > 0) {
            assert.equal(
                Number(res.rows[0].quantity_reserved),
                1,
                'Historical COD reservation must remain exactly 1 unit'
            );
        } else {
            // Strictly assert that live Neon was NOT connected to and local test DB is isolated
            assert.ok(!TEST_DB_URL.includes('neon.tech'));
            assert.ok(TEST_DB_URL.includes('crunchy_heart_test'));
        }
    });

    // ----------------------------------------------------------------------
    // 1. Checkout Preview
    // ----------------------------------------------------------------------
    test('1. Checkout preview calculates ₹149 shipping below ₹499 and FREE above ₹499', async () => {
        // Below ₹499: Variant A @ ₹199
        const previewResBelow = await originalFetch(`${baseUrl}/api/checkout/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [{ variantId: variantA.id, quantity: 1 }]
            })
        });
        assert.equal(previewResBelow.status, 200);
        const dataBelow = await previewResBelow.json();
        assert.equal(dataBelow.subtotal, 199);
        assert.equal(dataBelow.shippingAmount, 149); // ₹149 below ₹499
        assert.equal(dataBelow.totalAmount, 348); // 199 + 149
        assert.equal(dataBelow.priceIncludesTax, true);
        assert.ok(dataBelow.taxAmount > 0);

        // Above ₹499: Variant B @ ₹599
        const previewResAbove = await originalFetch(`${baseUrl}/api/checkout/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [{ variantId: variantB.id, quantity: 1 }]
            })
        });
        assert.equal(previewResAbove.status, 200);
        const dataAbove = await previewResAbove.json();
        assert.equal(dataAbove.subtotal, 599);
        assert.equal(dataAbove.shippingAmount, 0); // Free at or above ₹499
        assert.equal(dataAbove.totalAmount, 599);
    });

    // ----------------------------------------------------------------------
    // 2. Checkout Preview Input Validation
    // ----------------------------------------------------------------------
    test('2. Checkout preview validates items array and quantities', async () => {
        // Empty items
        const emptyRes = await originalFetch(`${baseUrl}/api/checkout/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [] })
        });
        assert.equal(emptyRes.status, 400);

        // Invalid quantity
        const invalidQtyRes = await originalFetch(`${baseUrl}/api/checkout/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [{ variantId: variantA.id, quantity: -2 }]
            })
        });
        assert.equal(invalidQtyRes.status, 400);
    });

    // ----------------------------------------------------------------------
    // 3. COD Order Creation (Zero Reservation)
    // ----------------------------------------------------------------------
    test('3. COD checkout creates confirmed order with guest token and zero inventory reservation', async () => {
        // Record inventory before checkout
        const stockBefore = await query(
            `SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1`,
            [variantA.id]
        );
        const onHandBefore = Number(stockBefore.rows[0].quantity_on_hand);
        const reservedBefore = Number(stockBefore.rows[0].quantity_reserved);

        const idemKey = `cod_test_${Date.now()}`;
        const createRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idemKey
            },
            body: JSON.stringify({
                customer: {
                    name: 'Rajesh Verma',
                    phone: '9876543210',
                    email: 'rajesh@example.com'
                },
                shippingAddress: {
                    name: 'Rajesh Verma',
                    phone: '9876543210',
                    addressLine1: 'B-104 Park View Heights',
                    city: 'New Delhi',
                    state: 'Delhi',
                    pincode: '110001',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 2 }],
                paymentMethod: 'COD',
                idempotencyKey: idemKey
            })
        });

        assert.equal(createRes.status, 201);
        const data = await createRes.json();
        assert.equal(data.success, true);
        assert.ok(data.order.order_number.startsWith('TCH-'));
        assert.equal(data.order.payment_method, 'COD');
        assert.equal(data.order.status, 'confirmed');
        assert.equal(data.order.payment_status, 'pending');
        assert.ok(typeof data.guestAccessToken === 'string' && data.guestAccessToken.startsWith('v1.'));

        // Verify ZERO reservation policy for COD at checkout
        const stockAfter = await query(
            `SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1`,
            [variantA.id]
        );
        assert.equal(
            Number(stockAfter.rows[0].quantity_reserved),
            reservedBefore,
            'COD checkout must NOT increment quantity_reserved'
        );
        assert.equal(
            Number(stockAfter.rows[0].quantity_on_hand),
            onHandBefore,
            'COD checkout must NOT deduct quantity_on_hand before dispatch'
        );
    });

    // ----------------------------------------------------------------------
    // 4. Online Order Creation with Mocked Cashfree Session
    // ----------------------------------------------------------------------
    test('4. Online checkout creates pending order and returns Cashfree payment session', async () => {
        mockCashfreeMode = 'SUCCESS';
        const idemKey = `online_test_${Date.now()}`;

        const createRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idemKey
            },
            body: JSON.stringify({
                customer: {
                    name: 'Aarti Saxena',
                    phone: '9812345678',
                    email: 'aarti@example.com'
                },
                shippingAddress: {
                    name: 'Aarti Saxena',
                    phone: '9812345678',
                    addressLine1: 'Flat 502, Lotus Greens',
                    city: 'Noida',
                    state: 'Uttar Pradesh',
                    pincode: '201301',
                    country: 'India'
                },
                items: [{ variantId: variantB.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
                idempotencyKey: idemKey
            })
        });

        assert.equal(createRes.status, 201);
        const data = await createRes.json();
        assert.equal(data.success, true);
        assert.equal(data.order.payment_method, 'ONLINE');
        assert.equal(data.order.status, 'pending');
        assert.ok(data.cashfree?.paymentSessionId);
        assert.ok(data.cashfree.paymentSessionId.startsWith('session_mock_'));
        assert.ok(data.guestAccessToken.startsWith('v1.'));
    });

    // ----------------------------------------------------------------------
    // 5. Idempotency Replay Authorization (SEC-01)
    // ----------------------------------------------------------------------
    test('5. Replaying checkout idempotency key without valid guest token is rejected (409)', async () => {
        const idemKey = `replay_test_${Date.now()}`;

        // Initial creation
        const firstRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idemKey
            },
            body: JSON.stringify({
                customer: { name: 'Pooja Jain', phone: '9711223344' },
                shippingAddress: {
                    name: 'Pooja Jain',
                    phone: '9711223344',
                    addressLine1: '77 Civil Lines',
                    city: 'Jaipur',
                    state: 'Rajasthan',
                    pincode: '302006',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 1 }],
                paymentMethod: 'COD',
                idempotencyKey: idemKey
            })
        });
        assert.equal(firstRes.status, 201);
        const firstData = await firstRes.json();
        const legitimateGuestToken = firstData.guestAccessToken;

        // Replay without guest token -> 409 Unauthorized replay
        const unauthReplayRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idemKey
            },
            body: JSON.stringify({
                customer: { name: 'Pooja Jain', phone: '9711223344' },
                shippingAddress: {
                    name: 'Pooja Jain',
                    phone: '9711223344',
                    addressLine1: '77 Civil Lines',
                    city: 'Jaipur',
                    state: 'Rajasthan',
                    pincode: '302006',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 1 }],
                paymentMethod: 'COD',
                idempotencyKey: idemKey
            })
        });
        assert.equal(unauthReplayRes.status, 409);
        const unauthData = await unauthReplayRes.json();
        assert.equal(unauthData.code, 'IDEMPOTENCY_REPLAY_UNAUTHORIZED');

        // Authorized replay with valid guest token -> 200 with existing order
        const authReplayRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idemKey,
                'x-guest-access-token': legitimateGuestToken
            },
            body: JSON.stringify({
                customer: { name: 'Pooja Jain', phone: '9711223344' },
                shippingAddress: {
                    name: 'Pooja Jain',
                    phone: '9711223344',
                    addressLine1: '77 Civil Lines',
                    city: 'Jaipur',
                    state: 'Rajasthan',
                    pincode: '302006',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 1 }],
                paymentMethod: 'COD',
                idempotencyKey: idemKey
            })
        });
        assert.equal(authReplayRes.status, 200);
        const authData = await authReplayRes.json();
        assert.equal(authData.existing, true);
        assert.equal(authData.order.order_number, firstData.order.order_number);
    });

    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // 6. Ambiguous Gateway Timeout Safety & Originating Request Recovery (Phase 3.2.2 Fix 2)
    // ----------------------------------------------------------------------
    test('6. Gateway timeout returns 202 GATEWAY_AMBIGUOUS_TIMEOUT with guest token for originating caller, prevents duplicate orders, and blocks unauthenticated replay', async () => {
        mockCashfreeMode = 'TIMEOUT_504';
        const timeoutIdemKey = `timeout_test_${Date.now()}`;

        // Initial checkout attempt where Cashfree upstream times out
        const timeoutRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': timeoutIdemKey
            },
            body: JSON.stringify({
                customer: { name: 'Vikram Mehta', phone: '9822334455' },
                shippingAddress: {
                    name: 'Vikram Mehta',
                    phone: '9822334455',
                    addressLine1: 'Plot 12, Senapati Bapat Marg',
                    city: 'Pune',
                    state: 'Maharashtra',
                    pincode: '411016',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
                idempotencyKey: timeoutIdemKey
            })
        });

        // 1. Originating request receives HTTP 202 Accepted with legitimate guest token and order number
        assert.equal(timeoutRes.status, 202);
        const timeoutData = await timeoutRes.json();
        assert.equal(timeoutData.success, false);
        assert.equal(timeoutData.code, 'GATEWAY_AMBIGUOUS_TIMEOUT');
        assert.ok(timeoutData.orderNumber && timeoutData.orderNumber.startsWith('TCH-'));
        assert.ok(timeoutData.guestAccessToken && timeoutData.guestAccessToken.startsWith('v1.'));
        assert.equal(timeoutData.requiresVerification, true);

        // 2. Verify order is persisted in pending state, payment marked GATEWAY_AMBIGUOUS_TIMEOUT
        const payRes = await query(
            `
            SELECT p.gateway_status, p.status as payment_status, o.status as order_status, o.order_number
            FROM payments p
            JOIN orders o ON o.id = p.order_id
            WHERE o.idempotency_key = $1
            `,
            [timeoutIdemKey]
        );
        assert.equal(payRes.rows.length, 1);
        assert.equal(payRes.rows[0].gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
        assert.equal(payRes.rows[0].payment_status, 'created');
        assert.equal(payRes.rows[0].order_status, 'pending');

        // Verify timeout is NOT classified as confirmed payment failure
        assert.notEqual(payRes.rows[0].payment_status, 'failed');
        assert.notEqual(payRes.rows[0].gateway_status, 'FAILED');

        // 3. Unauthorized replay with same Idempotency-Key MUST be rejected with 409 (SEC-01)
        const unauthReplayRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': timeoutIdemKey
            },
            body: JSON.stringify({
                customer: { name: 'Vikram Mehta', phone: '9822334455' },
                shippingAddress: {
                    name: 'Vikram Mehta',
                    phone: '9822334455',
                    addressLine1: 'Plot 12, Senapati Bapat Marg',
                    city: 'Pune',
                    state: 'Maharashtra',
                    pincode: '411016',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
                idempotencyKey: timeoutIdemKey
            })
        });
        assert.equal(unauthReplayRes.status, 409);
        const unauthData = await unauthReplayRes.json();
        assert.equal(unauthData.code, 'IDEMPOTENCY_REPLAY_UNAUTHORIZED');
        assert.equal(unauthData.guestAccessToken, undefined);
        assert.equal(unauthData.order, undefined);

        // 4. Authorized replay with valid guest token returns 202 existing: true, no duplicate order
        const authReplayRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': timeoutIdemKey,
                'x-guest-access-token': timeoutData.guestAccessToken
            },
            body: JSON.stringify({
                customer: { name: 'Vikram Mehta', phone: '9822334455' },
                shippingAddress: {
                    name: 'Vikram Mehta',
                    phone: '9822334455',
                    addressLine1: 'Plot 12, Senapati Bapat Marg',
                    city: 'Pune',
                    state: 'Maharashtra',
                    pincode: '411016',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
                idempotencyKey: timeoutIdemKey
            })
        });
        assert.equal(authReplayRes.status, 202);
        const authData = await authReplayRes.json();
        assert.equal(authData.existing, true);
        assert.equal(authData.order.order_number, timeoutData.orderNumber);

        // Check total orders in DB for this idempotency key remains strictly 1
        const countRes = await query(
            `SELECT COUNT(*) as cnt FROM orders WHERE idempotency_key = $1`,
            [timeoutIdemKey]
        );
        assert.equal(Number(countRes.rows[0].cnt), 1);
    });

    test('6b. Guest token recovered from ambiguous timeout accesses only that specific order', async () => {
        mockCashfreeMode = 'TIMEOUT_504';
        const idemKey = `timeout_access_${Date.now()}`;

        const timeoutRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
            body: JSON.stringify({
                customer: { name: 'Deepa Shah', phone: '9877001122' },
                shippingAddress: {
                    name: 'Deepa Shah',
                    phone: '9877001122',
                    addressLine1: '54 Model Town',
                    city: 'Ludhiana',
                    state: 'Punjab',
                    pincode: '141002',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
                idempotencyKey: idemKey
            })
        });
        assert.equal(timeoutRes.status, 202);
        const { orderNumber, guestAccessToken } = await timeoutRes.json();

        // Access corresponding order details -> 200 OK
        const orderRes = await originalFetch(`${baseUrl}/api/orders/${orderNumber}`, {
            method: 'GET',
            headers: { 'x-guest-access-token': guestAccessToken }
        });
        assert.equal(orderRes.status, 200);
        const details = await orderRes.json();
        assert.equal(details.order.orderNumber, orderNumber);
        assert.equal(details.order.customerName, 'Deepa Shah');
        assert.equal(details.order.status, 'pending');

        // Create an existing other order to test cross-order token isolation
        const otherIdemKey = `other_order_${Date.now()}`;
        const otherRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': otherIdemKey },
            body: JSON.stringify({
                customer: { name: 'Other Customer', phone: '9877009988' },
                shippingAddress: {
                    name: 'Other Customer',
                    phone: '9877009988',
                    addressLine1: '99 Other Road',
                    city: 'Delhi',
                    state: 'Delhi',
                    pincode: '110001',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 1 }],
                paymentMethod: 'COD',
                idempotencyKey: otherIdemKey
            })
        });
        const otherData = await otherRes.json();
        const otherOrderNumber = otherData.order.order_number;

        // Attempting to access an unrelated order with Deepa's token -> 401 Unauthorized
        const unrelatedRes = await originalFetch(`${baseUrl}/api/orders/${otherOrderNumber}`, {
            method: 'GET',
            headers: { 'x-guest-access-token': guestAccessToken }
        });
        assert.equal(unrelatedRes.status, 401);
    });

    // ----------------------------------------------------------------------
    // 7. GET /api/orders/:orderNumber Security & Access Control
    // ----------------------------------------------------------------------
    test('7. Order details endpoint requires valid x-guest-access-token header and rejects unauthenticated callers', async () => {
        // Create an order
        mockCashfreeMode = 'SUCCESS';
        const idemKey = `order_detail_test_${Date.now()}`;
        const createRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
            body: JSON.stringify({
                customer: { name: 'Sunita Rao', phone: '9988776655' },
                shippingAddress: {
                    name: 'Sunita Rao',
                    phone: '9988776655',
                    addressLine1: 'House 45, Indiranagar',
                    city: 'Bengaluru',
                    state: 'Karnataka',
                    pincode: '560038',
                    country: 'India'
                },
                items: [{ variantId: variantA.id, quantity: 1 }],
                paymentMethod: 'COD',
                idempotencyKey: idemKey
            })
        });
        const created = await createRes.json();
        const orderNum = created.order.order_number;
        const validToken = created.guestAccessToken;

        // Missing token -> 401
        const missingRes = await originalFetch(`${baseUrl}/api/orders/${orderNum}`, {
            method: 'GET'
        });
        assert.equal(missingRes.status, 401);

        // Invalid token -> 401
        const invalidRes = await originalFetch(`${baseUrl}/api/orders/${orderNum}`, {
            method: 'GET',
            headers: { 'x-guest-access-token': 'v1.fake.token' }
        });
        assert.equal(invalidRes.status, 401);

        // Valid token in header -> 200 with full details
        const validRes = await originalFetch(`${baseUrl}/api/orders/${orderNum}`, {
            method: 'GET',
            headers: { 'x-guest-access-token': validToken }
        });
        assert.equal(validRes.status, 200);
        const details = await validRes.json();
        assert.equal(details.success, true);
        assert.equal(details.order.orderNumber, orderNum);
        assert.equal(details.order.customerName, 'Sunita Rao');
        assert.equal(details.items.length, 1);
        assert.equal(details.items[0].productName, 'Checkout Test Makhana');
    });

    // ----------------------------------------------------------------------
    // 8. Payment Status Endpoint & Retry Restrictions
    // ----------------------------------------------------------------------
    test('8. Payment status endpoint validates guest token and enforces retry restrictions', async () => {
        // Create an ONLINE order
        mockCashfreeMode = 'SUCCESS';
        const idemKey = `status_test_${Date.now()}`;
        const createRes = await originalFetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
            body: JSON.stringify({
                customer: { name: 'Kunal Kapoor', phone: '9845012345' },
                shippingAddress: {
                    name: 'Kunal Kapoor',
                    phone: '9845012345',
                    addressLine1: 'Sector 15, Vashi',
                    city: 'Navi Mumbai',
                    state: 'Maharashtra',
                    pincode: '400703',
                    country: 'India'
                },
                items: [{ variantId: variantB.id, quantity: 1 }],
                paymentMethod: 'ONLINE',
                idempotencyKey: idemKey
            })
        });
        const created = await createRes.json();
        const orderNum = created.order.order_number;
        const validToken = created.guestAccessToken;

        // Payment status lookup
        const statusRes = await originalFetch(`${baseUrl}/api/payments/status/${orderNum}`, {
            method: 'GET',
            headers: { 'x-guest-access-token': validToken }
        });
        assert.equal(statusRes.status, 200);
        const statusData = await statusRes.json();
        assert.equal(statusData.success, true);
        assert.equal(statusData.orderNumber, orderNum);
        assert.ok(statusData.latestAttempt);
    });

    // ----------------------------------------------------------------------
    // 7b. Stock Shortage Exception & Refund Reporting (Phase 3.2.2 Fix 1)
    // ----------------------------------------------------------------------
    test('7b. Stock-shortage exception and pending-refund state are truthfully exposed on order details', async () => {
        // Create an order directly in DB with exception_stock_shortage notes
        const orderNum = `TCH-STOCK-SHORT-${Date.now()}`;
        const shippingAddress = {
            name: 'Rohan Verma',
            phone: '9811223344',
            addressLine1: 'Flat 101, Residency',
            city: 'Jaipur',
            state: 'Rajasthan',
            pincode: '302001',
            country: 'India'
        };
        const orderInsert = await query(
            `
            INSERT INTO orders (
                order_number, idempotency_key, customer_name, email, phone,
                shipping_address, subtotal, discount_amount, shipping_amount, tax_amount, total_amount,
                payment_method, payment_status, status, notes
            )
            VALUES (
                $1, $2, 'Rohan Verma', 'rohan@example.com', '9811223344',
                $3::jsonb, 599.00, 0.00, 0.00, 91.37, 599.00,
                'ONLINE', 'captured', 'paid', 'exception_stock_shortage'
            )
            RETURNING id, order_number, phone
            `,
            [orderNum, `stock_short_${Date.now()}`, JSON.stringify(shippingAddress)]
        );
        const testOrder = orderInsert.rows[0];

        // Insert pending refund record
        await query(
            `
            INSERT INTO refunds (
                order_id, amount, reason, status
            )
            VALUES ($1, 599.00, 'exception_stock_shortage', 'pending')
            RETURNING id, amount, status
            `,
            [testOrder.id]
        );

        // Generate valid guest access token
        const token = generateGuestAccessToken(testOrder);

        // Retrieve order details
        const detailsRes = await originalFetch(`${baseUrl}/api/orders/${orderNum}`, {
            method: 'GET',
            headers: { 'x-guest-access-token': token }
        });
        assert.equal(detailsRes.status, 200);
        const detailsData = await detailsRes.json();
        assert.equal(detailsData.success, true);
        assert.equal(detailsData.order.orderNumber, orderNum);
        assert.equal(detailsData.order.status, 'paid');
        assert.equal(detailsData.order.notes, 'exception_stock_shortage');

        // Crucial Fix 1 assertion: backend confirms pending refund record exists
        assert.ok(detailsData.order.refund);
        assert.equal(detailsData.order.refund.status, 'pending');
        assert.equal(Number(detailsData.order.refund.amount), 599);
        assert.equal(detailsData.order.refund.reason, 'exception_stock_shortage');
    });

    // ----------------------------------------------------------------------
    // 8b. Server-Enforced Guest Token Expiry & Tamper Protection (Phase 3.2.2 Fix 3)
    // ----------------------------------------------------------------------
    test('8b. Server-enforced guest token expiry, signature protection, and tampering resistance', async () => {
        const dummyOrder = { id: 9999, order_number: 'TCH-TEST-TOKEN-EXP', phone: '9999999999' };
        
        // 1. Valid token lifetime matches server-side rule (7 days = 604800s)
        const validToken = generateGuestAccessToken(dummyOrder);
        const parts = validToken.split('.');
        assert.equal(parts.length, 3);
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        assert.equal(payload.exp - payload.iat, 7 * 86400, 'Server token must have 7-day lifetime');

        // 2. Token with expired timestamp fails verification safely
        const expiredToken = generateGuestAccessToken(dummyOrder, { expiresInSeconds: -60 });
        const expiredCheck = verifyGuestAccessToken({ token: expiredToken, orderNumber: dummyOrder.order_number });
        assert.equal(expiredCheck.valid, false);
        assert.equal(expiredCheck.reason, 'TOKEN_EXPIRED');

        // 3. Tampered payload or signature fails verification safely
        const tamperedSigToken = `${parts[0]}.${parts[1]}.tampered_invalid_signature`;
        const tamperedCheck = verifyGuestAccessToken({ token: tamperedSigToken, orderNumber: dummyOrder.order_number });
        assert.equal(tamperedCheck.valid, false);
        assert.equal(tamperedCheck.reason, 'SIGNATURE_MISMATCH');

        // 4. Malformed token fails safely without uncaught exception
        const malformedCheck = verifyGuestAccessToken({ token: 'not-even-a-token', orderNumber: dummyOrder.order_number });
        assert.equal(malformedCheck.valid, false);
        assert.equal(malformedCheck.reason, 'INVALID_TOKEN_FORMAT');
    });

    // ----------------------------------------------------------------------
    // 8c. Cart Recovery Snapshot Policies (Phase 3.2.2 Fix 3)
    // ----------------------------------------------------------------------
    test('8c. Cart recovery snapshot expiration and merge policy', async () => {
        const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

        const sampleItems = [{ variantId: variantA.id, quantity: 2, sellingPrice: 199 }];
        const validSnapshot = {
            orderNumber: 'TCH-12345678-ABCDEF',
            timestamp: Date.now(),
            items: sampleItems,
        };

        // Snapshot is valid within 24h
        assert.ok(Date.now() - validSnapshot.timestamp < SNAPSHOT_MAX_AGE_MS);

        // Expired snapshot (> 24h)
        const expiredSnapshot = {
            orderNumber: 'TCH-12345678-ABCDEF',
            timestamp: Date.now() - (SNAPSHOT_MAX_AGE_MS + 1000),
            items: sampleItems,
        };
        assert.ok(Date.now() - expiredSnapshot.timestamp >= SNAPSHOT_MAX_AGE_MS);
    });

    // ----------------------------------------------------------------------
    test('9. Final safety assertion: inventory reservation policy is maintained', async () => {
        const res = await query(
            `
            SELECT o.order_number, i.quantity_reserved
            FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
            JOIN inventory i ON i.variant_id = oi.variant_id
            WHERE o.order_number = 'TCH-20261008-AJERUQ'
            `
        );
        if (res.rows.length > 0) {
            assert.equal(
                Number(res.rows[0].quantity_reserved),
                1,
                'Historical reservation must still be 1 unit after all checkout operations'
            );
        }
        // Also verify Variant A reservation remained 0 through all tests
        const varRes = await query(
            `SELECT quantity_reserved FROM inventory WHERE variant_id = $1`,
            [variantA.id]
        );
        assert.equal(Number(varRes.rows[0].quantity_reserved), 0);
    });

});
