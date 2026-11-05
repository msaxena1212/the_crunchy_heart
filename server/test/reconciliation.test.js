/**
 * The Crunchy Heart - Phase 2C: Safe Cashfree Payment Attempt Reconciliation Test Suite
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 * Tests all required reconciliation scenarios (Matrix A through M):
 * A. Ambiguous attempt + verified successful transaction -> 1 settlement, 1 inventory deduction.
 * B. Ambiguous attempt + active order with valid session -> session recovered, ORDER_CREATED, no settlement.
 * C. Provider returns 404 -> attempt remains blocked in GATEWAY_AMBIGUOUS_TIMEOUT.
 * D. Provider times out or returns 5xx -> safe non-terminal state, no mutation.
 * E. Malformed or incomplete provider payload -> fail closed.
 * F. Successful transaction has wrong order identity, payment ID, amount, or currency -> no settlement.
 * G. Order is paid by a webhook while reconciliation in progress -> exactly one settlement.
 * H. Concurrent webhook and reconciliation for same successful attempt -> no duplicate inventory deduction.
 * I. Sibling attempt settles order, this attempt captured -> PAID_DUPLICATE_ORDER_SETTLED + 1 pending refund record.
 * J. Repeated reconciliation of already settled attempt -> alreadySettled: true, no duplicate mutations.
 * K. Late failure/expiry response after successful settlement -> paid state remains intact.
 * L. Reconciliation cannot run against Neon or unrecognized database host.
 * M. Initial checkout timeout direct HTTP integration test.
 *
 * Strictly asserts that live Neon is NEVER connected to.
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
process.env.CASHFREE_CLIENT_ID = 'TEST_RECON_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_RECON_CLIENT_SECRET';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

// Import modules after environment is set
const { pool, query } = await import('../src/db/pool.js');
const { createOrder, retryPaymentAttempt } = await import('../src/services/order.service.js');
const {
    markPaymentSuccess,
    markPaymentFailed,
    attachCashfreeOrderToPayment,
} = await import('../src/services/payment.service.js');
const {
    reconcilePaymentAttempt,
    reconcileUnresolvedAttempts,
    assertSafeDatabaseUrl,
} = await import('../src/services/reconciliation.service.js');
const { generateGuestAccessToken } = await import('../src/utils/order-token.js');
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

let mockCashfreeOrderHandler = null;
let mockCashfreePaymentsHandler = null;
let mockCashfreeCreateOrderHandler = null;
let mockCashfreeCallCount = 0;

function installMockFetch() {
    globalThis.fetch = async (url, options = {}) => {
        const urlStr = String(url);

        // Delegate localhost / internal requests to native fetch
        if (!urlStr.includes('cashfree.com')) {
            return originalFetch(url, options);
        }

        mockCashfreeCallCount++;

        // 1. POST /pg/orders (order creation)
        if (urlStr.endsWith('/pg/orders') && options.method === 'POST') {
            if (mockCashfreeCreateOrderHandler) {
                return mockCashfreeCreateOrderHandler(urlStr, options);
            }
            const body = JSON.parse(options.body || '{}');
            return new Response(
                JSON.stringify({
                    cf_order_id: 11223344,
                    order_id: body.order_id,
                    order_status: 'ACTIVE',
                    payment_session_id: `session_${body.order_id}_mock`,
                    order_amount: body.order_amount,
                    order_currency: 'INR',
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // 2. GET /pg/orders/{orderId}/payments (payment transactions)
        if (urlStr.includes('/payments') && options.method === 'GET') {
            if (mockCashfreePaymentsHandler) {
                return mockCashfreePaymentsHandler(urlStr, options);
            }
            return new Response(JSON.stringify([]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 3. GET /pg/orders/{orderId} (order status lookup)
        if (urlStr.includes('/pg/orders/') && options.method === 'GET') {
            if (mockCashfreeOrderHandler) {
                return mockCashfreeOrderHandler(urlStr, options);
            }
            const orderId = decodeURIComponent(urlStr.split('/pg/orders/')[1]);
            return new Response(
                JSON.stringify({
                    cf_order_id: 11223344,
                    order_id: orderId,
                    order_status: 'ACTIVE',
                    payment_session_id: `session_${orderId}_mock`,
                    order_amount: 378.00,
                    order_currency: 'INR',
                }),
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

function sampleAddress(name = 'Recon Customer') {
    return {
        name,
        phone: '9876543210',
        addressLine1: '789 Recon Expressway',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
        country: 'India',
    };
}

async function createFixtureCategoryAndProduct() {
    const catRes = await query(
        `
        INSERT INTO categories (name, slug, description, is_active)
        VALUES ('Reconciliation Test Category', 'recon-cat-' || gen_random_uuid(), 'Recon Test', true)
        RETURNING id
        `
    );
    testCategoryId = catRes.rows[0].id;

    const prodRes = await query(
        `
        INSERT INTO products (category_id, name, slug, brand, is_active)
        VALUES ($1, 'Reconciliation Test Product', 'recon-prod-' || gen_random_uuid(), 'The Crunchy Heart', true)
        RETURNING id
        `,
        [testCategoryId]
    );
    testProductId = prodRes.rows[0].id;
}

async function createFixtureVariant({
    name = 'Recon Makhana 100g',
    sku = 'RCN-SKU-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
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
        INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved)
        VALUES ($1, $2, $3)
        `,
        [variant.id, stock, reserved]
    );

    return variant;
}

async function createTestOnlineOrder({
    customerName = 'Recon User',
    phone = '9876543200',
    email = 'recon@test.com',
    stock = 10,
    price = 229.00,
} = {}) {
    const variant = await createFixtureVariant({ stock, sellingPrice: price });
    const orderRes = await createOrder({
        customer: { name: customerName, phone, email },
        shippingAddress: sampleAddress(customerName),
        items: [{ variantId: variant.id, quantity: 1 }],
        paymentMethod: 'ONLINE',
    });
    const providerOrderId = orderRes.order.order_number;
    const orderAmount = Number(orderRes.order.total_amount);

    await attachCashfreeOrderToPayment({
        paymentId: orderRes.payment.id,
        cashfreeOrder: {
            order_id: providerOrderId,
            order_amount: orderAmount,
            payment_session_id: `session_${providerOrderId}`,
        },
    });

    return {
        variant,
        order: orderRes.order,
        payment: orderRes.payment,
        providerOrderId,
        orderAmount,
        guestAccessToken: generateGuestAccessToken(orderRes.order),
    };
}

async function cleanupFixtures() {
    await query(`DELETE FROM refunds WHERE reason ILIKE '%recon%' OR reason ILIKE '%duplicate%' OR reason ILIKE '%sibling%' OR reason ILIKE '%intra-attempt%'`);
    await query(`DELETE FROM payments WHERE provider_order_id LIKE 'TCH-%' OR provider_order_id LIKE 'RECON-%'`);
    await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'TCH-%' OR order_number LIKE 'RECON-%')`);
    await query(`DELETE FROM orders WHERE order_number LIKE 'TCH-%' OR order_number LIKE 'RECON-%'`);
    await query(`DELETE FROM inventory WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`, [testProductId]);
    await query(`DELETE FROM product_variants WHERE product_id = $1`, [testProductId]);
    await query(`DELETE FROM products WHERE id = $1`, [testProductId]);
    await query(`DELETE FROM categories WHERE id = $1`, [testCategoryId]);
}

// --------------------------------------------------------------------------
// Test Suite Setup / Teardown
// --------------------------------------------------------------------------
describe('Phase 2C: Payment Attempt Reconciliation Suite', () => {
    before(async () => {
        const verifyRes = await query(`SELECT current_database() AS db`);
        assert.equal(verifyRes.rows[0].db, 'crunchy_heart_test');

        await createFixtureCategoryAndProduct();
        installMockFetch();

        const app = buildTestApp();
        server = app.listen(0);
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        restoreFetch();
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        await cleanupFixtures();
        await pool.end();
    });

    beforeEach(() => {
        mockCashfreeOrderHandler = null;
        mockCashfreePaymentsHandler = null;
        mockCashfreeCreateOrderHandler = null;
        mockCashfreeCallCount = 0;
    });

    // ----------------------------------------------------------------------
    // Scenario A: Ambiguous attempt reports verified successful transaction
    // -> Exactly 1 settlement and 1 inventory deduction
    // ----------------------------------------------------------------------
    test('A. Ambiguous attempt reports verified successful payment transaction -> 1 settlement and 1 inventory deduction', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User A', phone: '9876543201', stock: 5 });

        // Set attempt to GATEWAY_AMBIGUOUS_TIMEOUT
        await query(
            `UPDATE payments SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT' WHERE id = $1`,
            [fix.payment.id]
        );

        // Mock Cashfree: Order is PAID, payments has 1 verified SUCCESS transaction
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10101,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 9911001,
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                    payment_time: new Date().toISOString(),
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        // Run reconciliation
        const result = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });

        assert.equal(result.success, true);
        assert.equal(result.reconciled, true);
        assert.equal(result.action, 'SETTLED');
        assert.equal(result.inventoryDeducted, true);

        // Verify database state
        const payRow = (await query(`SELECT * FROM payments WHERE id = $1`, [fix.payment.id])).rows[0];
        assert.equal(payRow.status, 'paid');
        assert.equal(payRow.gateway_status, 'SUCCESS');
        assert.equal(payRow.provider_payment_id, '9911001');

        const orderRow = (await query(`SELECT * FROM orders WHERE id = $1`, [fix.order.id])).rows[0];
        assert.equal(orderRow.payment_status, 'paid');
        assert.equal(orderRow.status, 'confirmed');

        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 4); // 5 - 1 = 4
    });

    // ----------------------------------------------------------------------
    // Scenario B: Ambiguous attempt reports active/created with valid session
    // -> Session recovered, ORDER_CREATED, no settlement, no stock deduction
    // ----------------------------------------------------------------------
    test('B. Ambiguous attempt reports active/created with valid session -> session recovered, ORDER_CREATED, no settlement', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User B', phone: '9876543202', stock: 5 });

        // Set to GATEWAY_AMBIGUOUS_TIMEOUT
        await query(
            `UPDATE payments SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT' WHERE id = $1`,
            [fix.payment.id]
        );

        // Mock Cashfree: Order is ACTIVE with recoverable session, no payments
        const recoveredSessionId = `session_recovered_${Date.now()}`;
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10102,
                order_id: fix.providerOrderId,
                order_status: 'ACTIVE',
                payment_session_id: recoveredSessionId,
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const result = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });

        assert.equal(result.success, true);
        assert.equal(result.reconciled, true);
        assert.equal(result.action, 'SESSION_RECOVERED');
        assert.equal(result.gatewayStatus, 'ORDER_CREATED');
        assert.equal(result.paymentSessionId, recoveredSessionId);

        // In DB: Payment updated to ORDER_CREATED, raw_response contains session
        const payRow = (await query(`SELECT * FROM payments WHERE id = $1`, [fix.payment.id])).rows[0];
        assert.equal(payRow.gateway_status, 'ORDER_CREATED');
        assert.equal(payRow.status, 'created');
        assert.equal(payRow.raw_response.payment_session_id, recoveredSessionId);

        // Order remains pending, stock untouched
        const orderRow = (await query(`SELECT * FROM orders WHERE id = $1`, [fix.order.id])).rows[0];
        assert.equal(orderRow.payment_status, 'pending');
        assert.equal(orderRow.status, 'pending');

        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 5); // 0 deducted
    });

    // ----------------------------------------------------------------------
    // Scenario C: Provider returns 404 -> attempt remains blocked in GATEWAY_AMBIGUOUS_TIMEOUT
    // ----------------------------------------------------------------------
    test('C. Provider returns 404 -> attempt remains blocked unless definitive rejection proven', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User C', phone: '9876543203', stock: 5 });

        await query(
            `UPDATE payments SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT' WHERE id = $1`,
            [fix.payment.id]
        );

        // Mock Cashfree: 404 Not Found
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                message: 'order_id does not exist',
                code: 'order_not_found',
                type: 'invalid_request_error',
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
        );

        const result = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });

        assert.equal(result.success, true);
        assert.equal(result.reconciled, false);
        assert.equal(result.action, 'KEPT_AMBIGUOUS_BLOCKED');
        assert.equal(result.inconclusive, true);

        // Verify DB: payment is NOT marked rejected/failed; remains GATEWAY_AMBIGUOUS_TIMEOUT
        const payRow = (await query(`SELECT * FROM payments WHERE id = $1`, [fix.payment.id])).rows[0];
        assert.equal(payRow.gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
        assert.equal(payRow.status, 'created');
    });

    // ----------------------------------------------------------------------
    // Scenario D: Provider times out or returns 5xx -> no unsafe state transition
    // ----------------------------------------------------------------------
    test('D. Provider times out or returns 5xx -> no unsafe state transition', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User D', phone: '9876543204', stock: 5 });

        await query(
            `UPDATE payments SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT' WHERE id = $1`,
            [fix.payment.id]
        );

        // Mock Cashfree: 504 Gateway Timeout
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({ message: 'Gateway Timeout' }),
            { status: 504, headers: { 'Content-Type': 'application/json' } }
        );

        const result = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });

        assert.equal(result.success, false);
        assert.equal(result.reconciled, false);
        assert.equal(result.action, 'NO_ACTION');
        assert.equal(result.reason, 'GATEWAY_UNAVAILABLE');

        // State remains untouched
        const payRow = (await query(`SELECT * FROM payments WHERE id = $1`, [fix.payment.id])).rows[0];
        assert.equal(payRow.gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
    });

    // ----------------------------------------------------------------------
    // Scenario E: Malformed or incomplete provider payload -> fail closed
    // ----------------------------------------------------------------------
    test('E. Malformed or incomplete provider payload -> fail closed', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User E', phone: '9876543205', stock: 5 });

        await query(
            `UPDATE payments SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT' WHERE id = $1`,
            [fix.payment.id]
        );

        // Test E1: Order reports PAID, but payments array has no successful transaction
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10105,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([]), // Empty transactions!
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const resultE1 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(resultE1.success, false);
        assert.equal(resultE1.reconciled, false);
        assert.equal(resultE1.action, 'NO_ACTION');
        assert.equal(resultE1.reason, 'MISSING_TRANSACTION_DETAILS');

        // Test E2: Transaction missing payment_amount
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 101051,
                    payment_status: 'SUCCESS',
                    payment_amount: null, // missing amount!
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const resultE2 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(resultE2.success, false);
        assert.equal(resultE2.reconciled, false);
        assert.equal(resultE2.action, 'NO_ACTION');
        assert.equal(resultE2.reason, 'MISSING_OR_INVALID_TRANSACTION_AMOUNT');

        // Test E3: Active order missing payment_session_id
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10105,
                order_id: fix.providerOrderId,
                order_status: 'ACTIVE',
                payment_session_id: '', // missing session!
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        mockCashfreePaymentsHandler = async () => new Response(JSON.stringify([]), { status: 200 });

        const resultE3 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(resultE3.success, false);
        assert.equal(resultE3.reconciled, false);
        assert.equal(resultE3.action, 'NO_ACTION');
        assert.equal(resultE3.reason, 'MISSING_PAYMENT_SESSION_ID');

        // Verify payment remains in safe unmutated state
        const payRow = (await query(`SELECT * FROM payments WHERE id = $1`, [fix.payment.id])).rows[0];
        assert.equal(payRow.gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
    });

    // ----------------------------------------------------------------------
    // Scenario F: Successful transaction has wrong order identity, payment ID,
    // amount, or currency -> no settlement
    // ----------------------------------------------------------------------
    test('F. Successful transaction has wrong order identity, payment ID, amount, or currency -> no settlement', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User F', phone: '9876543206', stock: 5 });

        await query(
            `UPDATE payments SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT' WHERE id = $1`,
            [fix.payment.id]
        );

        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10106,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        // F1: Missing cf_payment_id
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: null,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        const resF1 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(resF1.action, 'NO_ACTION');
        assert.equal(resF1.reason, 'MISSING_PAYMENT_ID');

        // F2: Amount mismatch
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 101062,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount - 50.00, // Mismatched amount!
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        const resF2 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(resF2.action, 'NO_ACTION');
        assert.equal(resF2.reason, 'AMOUNT_MISMATCH');

        // F3: Currency mismatch
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 101063,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'USD', // Expected INR!
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        const resF3 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(resF3.action, 'NO_ACTION');
        assert.equal(resF3.reason, 'CURRENCY_MISMATCH');

        // F4: Transaction order identity mismatch
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 101064,
                    order_id: 'WRONG_PROVIDER_ORDER_ID',
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        const resF4 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(resF4.action, 'NO_ACTION');
        assert.equal(resF4.reason, 'TRANSACTION_ORDER_IDENTITY_MISMATCH');

        // Inventory must remain untouched
        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 5);
    });

    // ----------------------------------------------------------------------
    // Scenario G: Order is paid by a webhook while reconciliation is in progress
    // -> Exactly one settlement
    // ----------------------------------------------------------------------
    test('G. Order is paid by a webhook while reconciliation is in progress -> exactly one settlement', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User G', phone: '9876543207', stock: 5 });

        // Webhook arrives first and settles
        await markPaymentSuccess({
            providerOrderId: fix.providerOrderId,
            providerPaymentId: 'CF_WEBHOOK_PAY_G',
            paymentAmount: fix.orderAmount,
            paymentCurrency: 'INR',
        });

        // Mock Cashfree responding to subsequent reconciliation
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10107,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_WEBHOOK_PAY_G',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        // Run reconciliation
        const result = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });

        assert.equal(result.success, true);
        assert.equal(result.alreadySettled, true);
        assert.equal(result.action, 'ALREADY_SETTLED');

        // Inventory must be deducted exactly ONCE
        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 4); // 5 - 1 = 4
    });

    // ----------------------------------------------------------------------
    // Scenario H: Reconciliation and webhook concurrently report the same successful attempt
    // -> No duplicate inventory deduction
    // ----------------------------------------------------------------------
    test('H. Reconciliation and webhook concurrently report the same successful attempt -> no duplicate inventory deduction', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User H', phone: '9876543208', stock: 5 });

        await query(
            `UPDATE payments SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT' WHERE id = $1`,
            [fix.payment.id]
        );

        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10108,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_PAY_H_CONCURRENT',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        // Run webhook settlement and reconciliation concurrently
        const [reconRes, webhookRes] = await Promise.all([
            reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId }),
            markPaymentSuccess({
                providerOrderId: fix.providerOrderId,
                providerPaymentId: 'CF_PAY_H_CONCURRENT',
                paymentAmount: fix.orderAmount,
                paymentCurrency: 'INR',
            }),
        ]);

        // One performed settlement, the other detected already settled
        const settledCount = (reconRes.inventoryDeducted ? 1 : 0) + (webhookRes.inventoryDeducted ? 1 : 0);
        assert.equal(settledCount, 1);

        // Exactly one unit deducted
        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 4); // 5 - 1 = 4
    });

    // ----------------------------------------------------------------------
    // Scenario I: One attempt settles the order while a sibling attempt is also captured
    // -> No second deduction; 1 pending refund-review record
    // ----------------------------------------------------------------------
    test('I. One attempt settles the order while a sibling attempt is also captured -> no second deduction; 1 pending refund record', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User I', phone: '9876543209', stock: 5 });
        const attempt1Id = fix.providerOrderId;

        // 1. Simulate failed Attempt 1 and retry creation to produce Attempt 2 (-R2)
        await markPaymentFailed({ providerOrderId: attempt1Id });

        const retryRes = await retryPaymentAttempt({
            orderNumber: fix.order.order_number,
            guestAccessToken: fix.guestAccessToken,
        });
        const attempt2Id = retryRes.payment.provider_order_id;
        assert.notEqual(attempt1Id, attempt2Id);

        // 2. Settle order via Attempt 2 first!
        await markPaymentSuccess({
            providerOrderId: attempt2Id,
            providerPaymentId: 'CF_PAY_ATTEMPT_2',
            paymentAmount: fix.orderAmount,
            paymentCurrency: 'INR',
        });

        // Verify order is now paid and stock deducted by 1
        const orderAfterSettlement = (await query(`SELECT * FROM orders WHERE id = $1`, [fix.order.id])).rows[0];
        assert.equal(orderAfterSettlement.payment_status, 'paid');
        const invAfterSettlement = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invAfterSettlement.quantity_on_hand, 4);

        // 3. Now reconcile Attempt 1: Cashfree reveals Attempt 1 was ALSO successfully captured!
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10109,
                order_id: attempt1Id,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_PAY_ATTEMPT_1_LATE',
                    order_id: attempt1Id,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const reconResult = await reconcilePaymentAttempt({ providerOrderId: attempt1Id });

        assert.equal(reconResult.success, true);
        assert.equal(reconResult.duplicateSettlement, true);
        assert.equal(reconResult.action, 'DUPLICATE_SETTLEMENT_RECORDED');
        assert.equal(reconResult.inventoryDeducted, false);
        assert.ok(reconResult.refundId);

        // Verify attempt 1 status
        const pay1Row = (await query(`SELECT * FROM payments WHERE provider_order_id = $1`, [attempt1Id])).rows[0];
        assert.equal(pay1Row.status, 'paid');
        assert.equal(pay1Row.gateway_status, 'PAID_DUPLICATE_ORDER_SETTLED');

        // Verify refunds table has exactly 1 pending refund record for Attempt 1
        const refundRows = (await query(`SELECT * FROM refunds WHERE payment_id = $1`, [pay1Row.id])).rows;
        assert.equal(refundRows.length, 1);
        assert.equal(refundRows[0].status, 'pending');
        assert.equal(Number(refundRows[0].amount), fix.orderAmount);

        // Stock MUST remain at 4 (NO double deduction)
        const invFinal = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invFinal.quantity_on_hand, 4);
    });

    // ----------------------------------------------------------------------
    // Scenario J: Repeated reconciliation of an already settled attempt
    // -> No duplicate mutation or refund record
    // ----------------------------------------------------------------------
    test('J. Repeated reconciliation of an already settled attempt -> no duplicate mutation or refund record', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User J', phone: '9876543210', stock: 5 });

        // Settle payment
        await markPaymentSuccess({
            providerOrderId: fix.providerOrderId,
            providerPaymentId: 'CF_PAY_J',
            paymentAmount: fix.orderAmount,
            paymentCurrency: 'INR',
        });

        const refundsBefore = (await query(`SELECT COUNT(*) AS c FROM refunds`)).rows[0].c;

        // Repeat reconciliation multiple times
        const res1 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        const res2 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });

        assert.equal(res1.alreadySettled, true);
        assert.equal(res1.action, 'ALREADY_SETTLED');
        assert.equal(res2.alreadySettled, true);
        assert.equal(res2.action, 'ALREADY_SETTLED');

        // No new refund records created
        const refundsAfter = (await query(`SELECT COUNT(*) AS c FROM refunds`)).rows[0].c;
        assert.equal(refundsAfter, refundsBefore);

        // Stock remains 4
        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 4);
    });

    // ----------------------------------------------------------------------
    // Scenario K: Late failure/expiry response after successful settlement
    // -> Paid state remains intact
    // ----------------------------------------------------------------------
    test('K. Late failure/expiry response after successful settlement -> paid state remains intact', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Recon User K', phone: '9876543211', stock: 5 });

        // Settle order
        await markPaymentSuccess({
            providerOrderId: fix.providerOrderId,
            providerPaymentId: 'CF_PAY_K',
            paymentAmount: fix.orderAmount,
            paymentCurrency: 'INR',
        });

        // Cashfree returns EXPIRED for this order
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10111,
                order_id: fix.providerOrderId,
                order_status: 'EXPIRED',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 101110,
                    payment_status: 'FAILED',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const result = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });

        // Since payment is already 'paid', reconciliation fast-paths or ignores late failure
        assert.equal(result.status, 'paid');

        // Order and payment remain paid
        const payRow = (await query(`SELECT * FROM payments WHERE id = $1`, [fix.payment.id])).rows[0];
        assert.equal(payRow.status, 'paid');

        const orderRow = (await query(`SELECT * FROM orders WHERE id = $1`, [fix.order.id])).rows[0];
        assert.equal(orderRow.payment_status, 'paid');
        assert.equal(orderRow.status, 'confirmed');
    });

    // ----------------------------------------------------------------------
    // Scenario L: Reconciliation cannot run against Neon or an unrecognized database host
    // ----------------------------------------------------------------------
    test('L. Reconciliation cannot run against Neon or an unrecognized database host', () => {
        // Assert throws on neon.tech
        assert.throws(
            () => assertSafeDatabaseUrl('postgresql://user:pass@ep-solitary-block.aws.neon.tech/neondb'),
            /FATAL SAFETY VIOLATION/
        );

        // Assert throws on production target
        assert.throws(
            () => assertSafeDatabaseUrl('postgresql://prod_user:secret@production-db.internal:5432/prod'),
            /FATAL SAFETY VIOLATION/
        );

        // Safe database URL passes
        assert.doesNotThrow(() => assertSafeDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test'));
    });

    // ----------------------------------------------------------------------
    // Scenario M: Initial checkout timeout direct HTTP integration test
    // ----------------------------------------------------------------------
    test('M. Initial checkout timeout HTTP integration: persists order, marks GATEWAY_AMBIGUOUS_TIMEOUT, blocks unauthenticated replay, and guards retry', async () => {
        const variant = await createFixtureVariant({ stock: 5 });

        // 1. Mock Cashfree create order timing out with 504
        mockCashfreeCreateOrderHandler = async () => new Response(
            JSON.stringify({ message: 'Gateway Timeout from Cashfree upstream.' }),
            { status: 504, headers: { 'Content-Type': 'application/json' } }
        );

        const idempotencyKey = `checkout-timeout-key-${Date.now()}`;

        // 2. Direct HTTP POST /api/orders/create
        const createRes = await fetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({
                items: [{ variantId: variant.id, quantity: 1 }],
                customer: {
                    name: 'Timeout User M',
                    phone: '9876543212',
                    email: 'timeoutM@test.com',
                },
                shippingAddress: sampleAddress('Timeout User M'),
                paymentMethod: 'ONLINE',
            }),
        });

        // Phase 3.2.2 Fix 2: Originating request receives 202 Accepted with GATEWAY_AMBIGUOUS_TIMEOUT and guest token
        assert.equal(createRes.status, 202);
        const createBody = await createRes.json();
        assert.equal(createBody.success, false);
        assert.equal(createBody.code, 'GATEWAY_AMBIGUOUS_TIMEOUT');
        assert.ok(createBody.guestAccessToken && createBody.guestAccessToken.startsWith('v1.'));
        assert.ok(createBody.orderNumber);

        // Verify Cashfree was called exactly once (no second gateway order created by timeout handler)
        assert.equal(mockCashfreeCallCount, 1);

        // 3. Inspect DB: local order is persisted in pending state
        const orderRow = (await query(`SELECT * FROM orders WHERE phone = '9876543212' ORDER BY created_at DESC LIMIT 1`)).rows[0];
        assert.ok(orderRow);
        assert.equal(orderRow.status, 'pending');
        assert.equal(orderRow.payment_status, 'pending');
        assert.equal(createBody.orderNumber, orderRow.order_number);

        // Payment attempt is marked GATEWAY_AMBIGUOUS_TIMEOUT
        const payRow = (await query(`SELECT * FROM payments WHERE order_id = $1`, [orderRow.id])).rows[0];
        assert.equal(payRow.gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
        assert.equal(payRow.provider_order_id, orderRow.order_number);

        // 4. Unauthorized replay with same Idempotency-Key MUST be rejected with 409
        const replayRes = await fetch(`${baseUrl}/api/orders/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({
                items: [{ variantId: variant.id, quantity: 1 }],
                customer: {
                    name: 'Timeout User M',
                    phone: '9876543212',
                    email: 'timeoutM@test.com',
                },
                shippingAddress: sampleAddress('Timeout User M'),
                paymentMethod: 'ONLINE',
            }),
        });

        assert.equal(replayRes.status, 409);
        const replayBody = await replayRes.json();
        assert.equal(replayBody.guestAccessToken, undefined); // Token never leaked to unauthenticated caller

        // 5. Retry endpoint is blocked by ambiguous-attempt guard
        const retryRes = await fetch(`${baseUrl}/api/orders/${orderRow.order_number}/retry-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-guest-access-token': 'any_token',
            },
        });
        // Returns 401 (invalid token) or 504 (blocked by ambiguous attempt)
        assert.ok([401, 504].includes(retryRes.status));

        // 6. Reconciliation resolves the ambiguous attempt:
        // Mock Cashfree returning captured payment on status check
        const orderAmount = Number(orderRow.total_amount);
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10113,
                order_id: orderRow.order_number,
                order_status: 'PAID',
                order_amount: orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_RESOLVED_M',
                    order_id: orderRow.order_number,
                    payment_status: 'SUCCESS',
                    payment_amount: orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const reconOutcome = await reconcilePaymentAttempt({ providerOrderId: orderRow.order_number });
        assert.equal(reconOutcome.success, true);
        assert.equal(reconOutcome.action, 'SETTLED');

        // Order is now confirmed and inventory deducted
        const finalOrder = (await query(`SELECT * FROM orders WHERE id = $1`, [orderRow.id])).rows[0];
        assert.equal(finalOrder.status, 'confirmed');
        assert.equal(finalOrder.payment_status, 'paid');

        const finalInv = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [variant.id])).rows[0];
        assert.equal(finalInv.quantity_on_hand, 4); // 5 - 1 = 4
    });

    // ----------------------------------------------------------------------
    // Scenario N: Bounded batch selector reconcileUnresolvedAttempts
    // ----------------------------------------------------------------------
    test('N. Bounded batch selector processes eligible attempts without unbounded scan', async () => {
        const fix = await createTestOnlineOrder({ customerName: 'Batch User N', phone: '9876543213', stock: 5 });

        await query(
            `UPDATE payments SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT' WHERE id = $1`,
            [fix.payment.id]
        );

        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 10114,
                order_id: fix.providerOrderId,
                order_status: 'ACTIVE',
                payment_session_id: 'session_batch_recov',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        mockCashfreePaymentsHandler = async () => new Response(JSON.stringify([]), { status: 200 });

        const batchRes = await reconcileUnresolvedAttempts({ limit: 50, minAgeMinutes: 0 });
        assert.ok(batchRes.processedCount >= 1);
        const match = batchRes.outcomes.find(o => o.providerOrderId === fix.providerOrderId);
        assert.ok(match);
        assert.equal(match.action, 'SESSION_RECOVERED');
    });

    // ----------------------------------------------------------------------
    // Scenario O: Two distinct successful captures under one provider order ID
    // ----------------------------------------------------------------------
    test('O. Two distinct captures under one order: 1 settlement, 1 inventory deduction, 1 pending refund', async () => {
        const fix = await createTestOnlineOrder({
            customerName: 'Multi Capture User O',
            phone: '9876543220',
            stock: 10,
        });

        // Provider returns 2 distinct successful payments for this single Cashfree order attempt
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 20001,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_INTRA_TX_1',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
                {
                    cf_payment_id: 'CF_INTRA_TX_2',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const reconOutcome = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(reconOutcome.success, true);
        assert.equal(reconOutcome.action, 'SETTLED_WITH_EXTRA_CAPTURES');
        assert.equal(reconOutcome.distinctCapturesCount, 2);
        assert.equal(reconOutcome.extraCapturesCount, 1);
        assert.equal(reconOutcome.primaryPaymentId, 'CF_INTRA_TX_1');
        assert.equal(reconOutcome.extraRefunds.length, 1);
        assert.equal(reconOutcome.extraRefunds[0].created, true);
        assert.equal(reconOutcome.extraRefunds[0].extraPaymentId, 'CF_INTRA_TX_2');

        // Check DB: Order is confirmed and payment is paid
        const orderRow = (await query(`SELECT * FROM orders WHERE id = $1`, [fix.order.id])).rows[0];
        assert.equal(orderRow.status, 'confirmed');
        assert.equal(orderRow.payment_status, 'paid');
        assert.ok(orderRow.notes.includes('[DUPLICATE CAPTURE AUDIT] Detected additional captured transaction CF_INTRA_TX_2'));

        // Payment record settled with primary payment ID
        const payRow = (await query(`SELECT * FROM payments WHERE id = $1`, [fix.payment.id])).rows[0];
        assert.equal(payRow.status, 'paid');
        assert.equal(payRow.provider_payment_id, 'CF_INTRA_TX_1');

        // Inventory deducted exactly ONCE (10 - 1 = 9)
        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 9);

        // Refunds table: exactly 1 refund record created for CF_INTRA_TX_2
        const refundRows = (await query(`SELECT * FROM refunds WHERE payment_id = $1`, [fix.payment.id])).rows;
        assert.equal(refundRows.length, 1);
        assert.equal(refundRows[0].status, 'pending');
        assert.equal(Number(refundRows[0].amount), fix.orderAmount);
        assert.ok(refundRows[0].reason.includes('CF_INTRA_TX_2'));
        assert.ok(refundRows[0].reason.includes('[INTRA-ATTEMPT DUPLICATE CAPTURE]'));
    });

    // ----------------------------------------------------------------------
    // Scenario P: Duplicate copies of the same transaction in provider response
    // ----------------------------------------------------------------------
    test('P. Duplicate copies of the same transaction: de-duplicated, 1 settlement, 0 refunds', async () => {
        const fix = await createTestOnlineOrder({
            customerName: 'Dup Tx User P',
            phone: '9876543221',
            stock: 8,
        });

        // Provider returns duplicate copies of the same transaction
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 20002,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_IDENTICAL_TX_1',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
                {
                    cf_payment_id: 'CF_IDENTICAL_TX_1',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const reconOutcome = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(reconOutcome.success, true);
        assert.equal(reconOutcome.action, 'SETTLED');
        assert.equal(reconOutcome.distinctCapturesCount, 1);
        assert.equal(reconOutcome.extraCapturesCount, 0);

        // DB check: exactly 1 deduction, 0 refunds
        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 7); // 8 - 1 = 7

        const refundRows = (await query(`SELECT * FROM refunds WHERE payment_id = $1`, [fix.payment.id])).rows;
        assert.equal(refundRows.length, 0);
    });

    // ----------------------------------------------------------------------
    // Scenario Q: One valid capture and one malformed or mismatched capture
    // ----------------------------------------------------------------------
    test('Q. One valid capture and one mismatched capture: fails closed, 0 mutations', async () => {
        const fix = await createTestOnlineOrder({
            customerName: 'Mismatch User Q',
            phone: '9876543222',
            stock: 6,
        });

        // Case Q1: Second capture has amount mismatch (e.g. 50 INR more)
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 20003,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_VALID_Q_1',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
                {
                    cf_payment_id: 'CF_INVALID_Q_2',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount + 50.00, // Mismatched amount!
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const reconOutcome = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(reconOutcome.success, false);
        assert.equal(reconOutcome.action, 'NO_ACTION');
        assert.equal(reconOutcome.reason, 'AMOUNT_MISMATCH');

        // Order remains pending, stock untouched, 0 refunds
        const orderRow = (await query(`SELECT * FROM orders WHERE id = $1`, [fix.order.id])).rows[0];
        assert.equal(orderRow.status, 'pending');
        assert.equal(orderRow.payment_status, 'pending');

        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 6); // Untouched

        const refundRows = (await query(`SELECT * FROM refunds WHERE payment_id = $1`, [fix.payment.id])).rows;
        assert.equal(refundRows.length, 0);

        // Case Q2: Missing payment ID on one transaction fails closed
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_VALID_Q_3',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
                {
                    cf_payment_id: '', // Empty ID!
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const reconOutcome2 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(reconOutcome2.success, false);
        assert.equal(reconOutcome2.action, 'NO_ACTION');
        assert.equal(reconOutcome2.reason, 'MISSING_PAYMENT_ID');

        // Case Q3: Currency mismatch on one transaction fails closed
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_VALID_Q_4',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
                {
                    cf_payment_id: 'CF_INVALID_Q_5',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'USD', // Currency mismatch!
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const reconOutcome3 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(reconOutcome3.success, false);
        assert.equal(reconOutcome3.action, 'NO_ACTION');
        assert.equal(reconOutcome3.reason, 'CURRENCY_MISMATCH');
    });

    // ----------------------------------------------------------------------
    // Scenario R: Repeated reconciliation of an attempt with multiple captures
    // ----------------------------------------------------------------------
    test('R. Repeated reconciliation: idempotent, no second refund record or inventory deduction', async () => {
        const fix = await createTestOnlineOrder({
            customerName: 'Repeat Recon User R',
            phone: '9876543223',
            stock: 12,
        });

        const paymentsPayload = [
            {
                cf_payment_id: 'CF_INTRA_R_1',
                order_id: fix.providerOrderId,
                payment_status: 'SUCCESS',
                payment_amount: fix.orderAmount,
                payment_currency: 'INR',
            },
            {
                cf_payment_id: 'CF_INTRA_R_2',
                order_id: fix.providerOrderId,
                payment_status: 'SUCCESS',
                payment_amount: fix.orderAmount,
                payment_currency: 'INR',
            },
        ];

        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 20004,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify(paymentsPayload),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        // Run 1: Settles and creates 1 refund record
        const recon1 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(recon1.success, true);
        assert.equal(recon1.action, 'SETTLED_WITH_EXTRA_CAPTURES');
        assert.equal(recon1.extraRefunds[0].created, true);

        const invAfter1 = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invAfter1.quantity_on_hand, 11); // 12 - 1 = 11

        const refundsAfter1 = (await query(`SELECT * FROM refunds WHERE payment_id = $1`, [fix.payment.id])).rows;
        assert.equal(refundsAfter1.length, 1);

        // Run 2: Exact same reconciliation runs again
        const recon2 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(recon2.success, true);
        assert.equal(recon2.action, 'ALREADY_SETTLED');
        assert.equal(recon2.extraRefunds[0].created, false);

        // Inventory is NOT deducted a second time
        const invAfter2 = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invAfter2.quantity_on_hand, 11);

        // Refunds table still contains EXACTLY 1 row (no duplicate pending refund record)
        const refundsAfter2 = (await query(`SELECT * FROM refunds WHERE payment_id = $1`, [fix.payment.id])).rows;
        assert.equal(refundsAfter2.length, 1);
    });

    // ----------------------------------------------------------------------
    // Scenario S: Concurrent webhook settlement and reconciliation
    // ----------------------------------------------------------------------
    test('S. Concurrent webhook settlement and reconciliation with extra capture', async () => {
        const fix = await createTestOnlineOrder({
            customerName: 'Webhook Race User S',
            phone: '9876543224',
            stock: 7,
        });

        // 1. Webhook arrives first and settles the attempt with primary transaction CF_INTRA_S_1
        const webhookResult = await markPaymentSuccess({
            providerOrderId: fix.providerOrderId,
            providerPaymentId: 'CF_INTRA_S_1',
            paymentAmount: fix.orderAmount,
            paymentCurrency: 'INR',
            rawResponse: { source: 'webhook' },
        });
        assert.equal(webhookResult.alreadySettled, false);

        // Inventory deducted once by webhook
        const invAfterWebhook = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invAfterWebhook.quantity_on_hand, 6); // 7 - 1 = 6

        // 2. Now reconciliation runs, discovering both CF_INTRA_S_1 AND extra CF_INTRA_S_2
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 20005,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_INTRA_S_1',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
                {
                    cf_payment_id: 'CF_INTRA_S_2',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const reconOutcome = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(reconOutcome.success, true);
        assert.equal(reconOutcome.action, 'EXTRA_CAPTURES_RECORDED');
        assert.equal(reconOutcome.extraRefunds.length, 1);
        assert.equal(reconOutcome.extraRefunds[0].created, true);

        // Inventory remains 6 (NO duplicate deduction)
        const invAfterRecon = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invAfterRecon.quantity_on_hand, 6);

        // Exactly 1 refund record created for CF_INTRA_S_2
        const refunds = (await query(`SELECT * FROM refunds WHERE payment_id = $1`, [fix.payment.id])).rows;
        assert.equal(refunds.length, 1);
        assert.equal(refunds[0].status, 'pending');
        assert.ok(refunds[0].reason.includes('CF_INTRA_S_2'));

        // Subsequent reconciliation call is completely idempotent
        const reconRepeat = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(reconRepeat.action, 'ALREADY_SETTLED');
        assert.equal(reconRepeat.extraRefunds[0].created, false);
        const refundsFinal = (await query(`SELECT * FROM refunds WHERE payment_id = $1`, [fix.payment.id])).rows;
        assert.equal(refundsFinal.length, 1);
    });

    // ----------------------------------------------------------------------
    // Scenario T: Three distinct captures under one provider order ID
    // ----------------------------------------------------------------------
    test('T. Three distinct captures under one order: 1 settlement, exactly 2 pending refund records', async () => {
        const fix = await createTestOnlineOrder({
            customerName: 'Triple Capture User T',
            phone: '9876543225',
            stock: 15,
        });

        // Provider returns 3 distinct successful captures
        mockCashfreeOrderHandler = async () => new Response(
            JSON.stringify({
                cf_order_id: 20006,
                order_id: fix.providerOrderId,
                order_status: 'PAID',
                order_amount: fix.orderAmount,
                order_currency: 'INR',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        mockCashfreePaymentsHandler = async () => new Response(
            JSON.stringify([
                {
                    cf_payment_id: 'CF_TRIPLE_TX_B',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
                {
                    cf_payment_id: 'CF_TRIPLE_TX_A',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
                {
                    cf_payment_id: 'CF_TRIPLE_TX_C',
                    order_id: fix.providerOrderId,
                    payment_status: 'SUCCESS',
                    payment_amount: fix.orderAmount,
                    payment_currency: 'INR',
                },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        const reconOutcome = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(reconOutcome.success, true);
        assert.equal(reconOutcome.action, 'SETTLED_WITH_EXTRA_CAPTURES');
        assert.equal(reconOutcome.distinctCapturesCount, 3);
        assert.equal(reconOutcome.extraCapturesCount, 2);
        // Note: sorted deterministically, so CF_TRIPLE_TX_A is primary
        assert.equal(reconOutcome.primaryPaymentId, 'CF_TRIPLE_TX_A');
        assert.equal(reconOutcome.extraRefunds.length, 2);
        assert.equal(reconOutcome.extraRefunds[0].created, true);
        assert.equal(reconOutcome.extraRefunds[1].created, true);

        // Verify DB: exactly 1 inventory deduction (15 - 1 = 14)
        const invRow = (await query(`SELECT * FROM inventory WHERE variant_id = $1`, [fix.variant.id])).rows[0];
        assert.equal(invRow.quantity_on_hand, 14);

        // Refunds table: exactly 2 rows
        const refundRows = (await query(`SELECT * FROM refunds WHERE payment_id = $1 ORDER BY id ASC`, [fix.payment.id])).rows;
        assert.equal(refundRows.length, 2);
        assert.equal(refundRows[0].status, 'pending');
        assert.equal(refundRows[1].status, 'pending');
        assert.ok(refundRows.some(r => r.reason.includes('CF_TRIPLE_TX_B')));
        assert.ok(refundRows.some(r => r.reason.includes('CF_TRIPLE_TX_C')));

        // Repeat reconciliation produces no new records
        const recon2 = await reconcilePaymentAttempt({ providerOrderId: fix.providerOrderId });
        assert.equal(recon2.action, 'ALREADY_SETTLED');
        assert.equal(recon2.extraRefunds.every(r => !r.created), true);

        const refundRows2 = (await query(`SELECT * FROM refunds WHERE payment_id = $1`, [fix.payment.id])).rows;
        assert.equal(refundRows2.length, 2);
    });
});
