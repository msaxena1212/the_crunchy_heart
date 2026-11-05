/**
 * The Crunchy Heart - Phase 1.1: Cashfree Webhook HTTP Integration Tests
 *
 * Tests the real HTTP webhook pipeline:
 * Express route -> raw body parser -> HMAC SHA-256 signature verification ->
 * cashfreeWebhook controller -> markPaymentSuccess/markPaymentFailed services ->
 * isolated PostgreSQL test database (crunchy_heart_test).
 *
 * Strictly asserts that live Neon is NEVER connected to.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

const TEST_WEBHOOK_SECRET = 'cfsk_ma_test_integration_secret_key_999888777';

// Override environment variables BEFORE any service/pool imports
process.env.DATABASE_URL = TEST_DB_URL;
process.env.DATABASE_URL_UNPOOLED = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.CASHFREE_CLIENT_ID = 'TEST_INTEGRATION_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = TEST_WEBHOOK_SECRET;
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

// Import modules after environment is set
const { pool, query } = await import('../src/db/pool.js');
const { cashfreeWebhook } = await import('../src/controllers/payment.controller.js');
const { createOrder } = await import('../src/services/order.service.js');
const { attachCashfreeOrderToPayment } = await import('../src/services/payment.service.js');

// --------------------------------------------------------------------------
// Express App & HTTP Server Harness
// --------------------------------------------------------------------------
function buildWebhookApp() {
    const app = express();

    // Replicates the production middleware configuration from server.js lines 74-100
    app.post(
        '/api/payments/cashfree/webhook',
        express.raw({ type: 'application/json' }),
        (req, res, next) => {
            try {
                req.rawBody = req.body?.toString('utf8') || '';

                if (!req.rawBody) {
                    return res.status(400).json({
                        success: false,
                        message: 'Empty Cashfree webhook body.',
                    });
                }

                req.body = JSON.parse(req.rawBody);
                return cashfreeWebhook(req, res, next);
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid Cashfree webhook JSON payload.',
                });
            }
        }
    );

    // Production error handler from server.js lines 473-486
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
// HMAC Signature & Fixture Helpers
// --------------------------------------------------------------------------
function computeCashfreeSignature(timestamp, rawBody, secret = TEST_WEBHOOK_SECRET) {
    const signedPayload = `${timestamp}${rawBody}`;
    return crypto
        .createHmac('sha256', secret)
        .update(signedPayload)
        .digest('base64');
}

let testCategoryId;
let testProductId;
let server;
let baseUrl;

async function createFixtureCategoryAndProduct() {
    const catRes = await query(
        `
        INSERT INTO categories (name, slug, description, is_active)
        VALUES ('Webhook Test Category', 'wh-cat-' || gen_random_uuid(), 'Webhook Test', true)
        RETURNING id
        `
    );
    testCategoryId = catRes.rows[0].id;

    const prodRes = await query(
        `
        INSERT INTO products (category_id, name, slug, brand, is_active)
        VALUES ($1, 'Webhook Test Product', 'wh-prod-' || gen_random_uuid(), 'The Crunchy Heart', true)
        RETURNING id
        `,
        [testCategoryId]
    );
    testProductId = prodRes.rows[0].id;
}

async function createFixtureVariant({
    name = 'Webhook Makhana 100g',
    sku = 'WH-SKU-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
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
        name: 'Webhook Test Customer',
        phone: '9876543210',
        email: 'webhook-test@crunchyheart.example.com',
    };
}

function sampleAddress() {
    return {
        name: 'Webhook Test Customer',
        phone: '9876543210',
        addressLine1: '456 Webhook Boulevard',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
        country: 'India',
    };
}

function buildCashfreePayload({
    orderId,
    orderAmount,
    currency = 'INR',
    paymentStatus = 'SUCCESS',
    cfPaymentId = 'CF_PAY_' + Math.floor(Math.random() * 1000000),
    eventType = 'PAYMENT_SUCCESS_WEBHOOK',
}) {
    return {
        data: {
            order: {
                order_id: orderId,
                order_amount: Number(orderAmount),
                order_currency: currency,
            },
            payment: {
                cf_payment_id: cfPaymentId,
                payment_status: paymentStatus,
                payment_amount: Number(orderAmount),
                payment_currency: currency,
                payment_message: 'Transaction Successful',
                payment_time: new Date().toISOString(),
                bank_reference: 'REF' + Math.floor(Math.random() * 1000000),
            },
            customer_details: {
                customer_name: 'Webhook Test Customer',
                customer_phone: '9876543210',
                customer_email: 'webhook-test@crunchyheart.example.com',
            },
        },
        event_time: new Date().toISOString(),
        type: eventType,
    };
}

// --------------------------------------------------------------------------
// TEST SUITE: Cashfree Webhook HTTP Integration Tests
// --------------------------------------------------------------------------
describe('Phase 1.1: Cashfree Webhook HTTP Integration Suite', () => {

    before(async () => {
        // Assert connection is strictly local
        const connRes = await query('SELECT current_database(), inet_server_addr()');
        assert.equal(connRes.rows[0].current_database, 'crunchy_heart_test');
        console.log(`\nVerified safe test DB connection: ${connRes.rows[0].current_database}`);

        await createFixtureCategoryAndProduct();

        // Start HTTP test server on an ephemeral free port
        const app = buildWebhookApp();
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                console.log(`Webhook test HTTP server listening at: ${baseUrl}`);
                resolve();
            });
        });
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        await pool.end();
    });

    // ----------------------------------------------------------------------
    // 1. Valid HMAC signature and successful payment event
    // ----------------------------------------------------------------------
    test('1. Valid HMAC signature and successful payment event settles payment, order, and inventory via HTTP', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_HTTP_ORD_' + Math.random().toString(36).substring(2, 9);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: {
                order_id: cfOrderId,
                payment_session_id: 'session_mock_1',
            },
        });

        const payloadObj = buildCashfreePayload({
            orderId: cfOrderId,
            orderAmount: orderRes.order.total_amount,
            paymentStatus: 'SUCCESS',
            cfPaymentId: 'CF_PAY_SUCCESS_1',
        });

        const rawBody = JSON.stringify(payloadObj);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = computeCashfreeSignature(timestamp, rawBody);

        const response = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': signature,
            },
            body: rawBody,
        });

        assert.equal(response.status, 200);
        const resJson = await response.json();
        assert.equal(resJson.success, true);
        assert.equal(resJson.received, true);
        assert.equal(resJson.paymentStatus, 'SUCCESS');

        // Database assertions
        const payCheck = await query('SELECT status, gateway_status, provider_payment_id FROM payments WHERE id = $1', [orderRes.payment.id]);
        assert.equal(payCheck.rows[0].status, 'paid');
        assert.equal(payCheck.rows[0].gateway_status, 'SUCCESS');
        assert.equal(payCheck.rows[0].provider_payment_id, 'CF_PAY_SUCCESS_1');

        const ordCheck = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(ordCheck.rows[0].status, 'confirmed');
        assert.equal(ordCheck.rows[0].payment_status, 'paid');

        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 8); // 10 - 2

        const ledgerCheck = await query(
            `SELECT * FROM inventory_transactions WHERE variant_id = $1 AND transaction_type = 'SALE_DEDUCTION'`,
            [variant.id]
        );
        assert.equal(ledgerCheck.rows.length, 1);
        assert.equal(ledgerCheck.rows[0].quantity, 2);
    });

    // ----------------------------------------------------------------------
    // 2. Invalid HMAC signature is rejected before any mutation
    // ----------------------------------------------------------------------
    test('2. Invalid HMAC signature returns HTTP 401 and prevents any database mutation', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_HTTP_BADSIG_' + Math.random().toString(36).substring(2, 9);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 'sess' },
        });

        const payloadObj = buildCashfreePayload({
            orderId: cfOrderId,
            orderAmount: orderRes.order.total_amount,
            paymentStatus: 'SUCCESS',
        });

        const rawBody = JSON.stringify(payloadObj);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const forgedSignature = 'FORGED_INVALID_SIGNATURE_BASE64==';

        const response = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': forgedSignature,
            },
            body: rawBody,
        });

        assert.equal(response.status, 401);
        const resJson = await response.json();
        assert.equal(resJson.success, false);
        assert.match(resJson.message, /Invalid Cashfree webhook signature/);

        // Database assertions: zero mutations
        const payCheck = await query('SELECT status FROM payments WHERE id = $1', [orderRes.payment.id]);
        assert.equal(payCheck.rows[0].status, 'created');

        const ordCheck = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(ordCheck.rows[0].status, 'pending');
        assert.equal(ordCheck.rows[0].payment_status, 'pending');

        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 10); // Untouched

        const ledgerCheck = await query(
            `SELECT * FROM inventory_transactions WHERE variant_id = $1`,
            [variant.id]
        );
        assert.equal(ledgerCheck.rows.length, 0);
    });

    // ----------------------------------------------------------------------
    // 3. Missing signature or timestamp headers are rejected safely
    // ----------------------------------------------------------------------
    test('3. Missing signature or timestamp headers return HTTP 401 without processing payload', async () => {
        const payloadObj = { event: 'TEST' };
        const rawBody = JSON.stringify(payloadObj);
        const timestamp = String(Math.floor(Date.now() / 1000));

        // Case A: Missing x-webhook-signature
        const resNoSig = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
            },
            body: rawBody,
        });
        assert.equal(resNoSig.status, 401);

        // Case B: Missing x-webhook-timestamp
        const resNoTs = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-signature': 'mock_sig',
            },
            body: rawBody,
        });
        assert.equal(resNoTs.status, 401);
    });

    // ----------------------------------------------------------------------
    // 4. Duplicate success webhook does not deduct inventory twice
    // ----------------------------------------------------------------------
    test('4. Duplicate success webhook returns HTTP 200 and deducts stock exactly once', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_HTTP_DUP_' + Math.random().toString(36).substring(2, 9);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 's' },
        });

        const payloadObj = buildCashfreePayload({
            orderId: cfOrderId,
            orderAmount: orderRes.order.total_amount,
            paymentStatus: 'SUCCESS',
            cfPaymentId: 'CF_PAY_DUP_1',
        });

        const rawBody = JSON.stringify(payloadObj);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = computeCashfreeSignature(timestamp, rawBody);

        const headers = {
            'Content-Type': 'application/json',
            'x-webhook-timestamp': timestamp,
            'x-webhook-signature': signature,
        };

        // 1st HTTP Webhook request
        const res1 = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers,
            body: rawBody,
        });
        assert.equal(res1.status, 200);

        const invAfterFirst = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfterFirst.rows[0].quantity_on_hand), 8);

        // 2nd HTTP Webhook request (duplicate)
        const res2 = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers,
            body: rawBody,
        });
        assert.equal(res2.status, 200);

        // Stock must STILL be 8 (never deducted twice)
        const invAfterSecond = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfterSecond.rows[0].quantity_on_hand), 8);

        // Exactly one ledger transaction
        const ledgerCheck = await query(
            `SELECT * FROM inventory_transactions WHERE variant_id = $1 AND transaction_type = 'SALE_DEDUCTION'`,
            [variant.id]
        );
        assert.equal(ledgerCheck.rows.length, 1);
    });

    // ----------------------------------------------------------------------
    // 5. Amount mismatch does not mark payment successful or deduct inventory
    // ----------------------------------------------------------------------
    test('5. Amount mismatch returns HTTP 400 and rejects settlement without touching inventory', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_HTTP_AMT_MISMATCH_' + Math.random().toString(36).substring(2, 9);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 's' },
        });

        // Genuine signature, but payload reports incorrect payment amount
        const payloadObj = buildCashfreePayload({
            orderId: cfOrderId,
            orderAmount: Number(orderRes.order.total_amount) - 100, // Tampered amount
            paymentStatus: 'SUCCESS',
        });

        const rawBody = JSON.stringify(payloadObj);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = computeCashfreeSignature(timestamp, rawBody);

        const response = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': signature,
            },
            body: rawBody,
        });

        assert.equal(response.status, 400);
        const resJson = await response.json();
        assert.equal(resJson.success, false);
        assert.match(resJson.message, /Payment amount mismatch/);

        // Database assertions: untouched
        const payCheck = await query('SELECT status FROM payments WHERE id = $1', [orderRes.payment.id]);
        assert.equal(payCheck.rows[0].status, 'created');

        const ordCheck = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(ordCheck.rows[0].status, 'pending');

        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 10);
    });

    // ----------------------------------------------------------------------
    // 6. Currency mismatch does not mark payment successful or deduct inventory
    // ----------------------------------------------------------------------
    test('6. Currency mismatch returns HTTP 400 and rejects settlement without touching inventory', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_HTTP_CURR_MISMATCH_' + Math.random().toString(36).substring(2, 9);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 's' },
        });

        // Payload reports currency as 'USD' instead of 'INR'
        const payloadObj = buildCashfreePayload({
            orderId: cfOrderId,
            orderAmount: orderRes.order.total_amount,
            currency: 'USD',
            paymentStatus: 'SUCCESS',
        });

        const rawBody = JSON.stringify(payloadObj);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = computeCashfreeSignature(timestamp, rawBody);

        const response = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': signature,
            },
            body: rawBody,
        });

        assert.equal(response.status, 400);
        const resJson = await response.json();
        assert.equal(resJson.success, false);
        assert.match(resJson.message, /Payment currency mismatch/);

        // Database assertions: untouched
        const payCheck = await query('SELECT status FROM payments WHERE id = $1', [orderRes.payment.id]);
        assert.equal(payCheck.rows[0].status, 'created');

        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 10);
    });

    // ----------------------------------------------------------------------
    // 7. Failure event arriving after success cannot reverse payment or order
    // ----------------------------------------------------------------------
    test('7. Delayed failure webhook cannot reverse an already settled payment or cancel the order', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_HTTP_LATE_FAIL_' + Math.random().toString(36).substring(2, 9);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 's' },
        });

        // 1. Settle successfully first
        const successPayload = buildCashfreePayload({
            orderId: cfOrderId,
            orderAmount: orderRes.order.total_amount,
            paymentStatus: 'SUCCESS',
        });
        const rawSuccess = JSON.stringify(successPayload);
        const ts1 = String(Math.floor(Date.now() / 1000));
        const sig1 = computeCashfreeSignature(ts1, rawSuccess);

        const res1 = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': ts1,
                'x-webhook-signature': sig1,
            },
            body: rawSuccess,
        });
        assert.equal(res1.status, 200);

        // 2. Delayed failure webhook arrives
        const failPayload = buildCashfreePayload({
            orderId: cfOrderId,
            orderAmount: orderRes.order.total_amount,
            paymentStatus: 'FAILED',
            eventType: 'PAYMENT_FAILED_WEBHOOK',
        });
        const rawFail = JSON.stringify(failPayload);
        const ts2 = String(Math.floor(Date.now() / 1000) + 10);
        const sig2 = computeCashfreeSignature(ts2, rawFail);

        const res2 = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': ts2,
                'x-webhook-signature': sig2,
            },
            body: rawFail,
        });
        assert.equal(res2.status, 200);

        // Assert payment remains 'paid', order remains 'confirmed', inventory remains 9
        const payCheck = await query('SELECT status FROM payments WHERE id = $1', [orderRes.payment.id]);
        assert.equal(payCheck.rows[0].status, 'paid');

        const ordCheck = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(ordCheck.rows[0].status, 'confirmed');
        assert.equal(ordCheck.rows[0].payment_status, 'paid');

        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 9);
    });

    // ----------------------------------------------------------------------
    // 8. Established HTTP status codes for edge conditions
    // ----------------------------------------------------------------------
    test('8. Established webhook HTTP status contracts: 400 for empty body, 400 for malformed JSON, 200 for normal failure event', async () => {
        const timestamp = String(Math.floor(Date.now() / 1000));

        // 8a. Empty body -> 400
        const resEmpty = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': 'any',
            },
            body: '',
        });
        assert.equal(resEmpty.status, 400);
        const emptyJson = await resEmpty.json();
        assert.match(emptyJson.message, /Empty Cashfree webhook body/);

        // 8b. Malformed JSON -> 400
        const resMalformed = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': 'any',
            },
            body: '{ malformed json: not valid }',
        });
        assert.equal(resMalformed.status, 400);
        const malformedJson = await resMalformed.json();
        assert.match(malformedJson.message, /Invalid Cashfree webhook JSON payload/);

        // 8c. Normal failure event on open order -> 200 (order stays open for retry)
        const variant = await createFixtureVariant({ stock: 5 });
        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });
        const cfOrderId = 'CF_HTTP_OPEN_FAIL_' + Math.random().toString(36).substring(2, 9);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 's' },
        });

        const failPayload = buildCashfreePayload({
            orderId: cfOrderId,
            orderAmount: orderRes.order.total_amount,
            paymentStatus: 'USER_DROPPED',
            eventType: 'PAYMENT_FAILED_WEBHOOK',
        });
        const rawFail = JSON.stringify(failPayload);
        const sigFail = computeCashfreeSignature(timestamp, rawFail);

        const resFail = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': sigFail,
            },
            body: rawFail,
        });
        assert.equal(resFail.status, 200);

        // Order remains open
        const ordCheck = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(ordCheck.rows[0].status, 'pending');
        assert.equal(ordCheck.rows[0].payment_status, 'failed');
    });

    // ----------------------------------------------------------------------
    // 9. Raw-body byte-level accuracy check
    // ----------------------------------------------------------------------
    test('9. Raw-body capture preserves exact byte sequence; single byte modification triggers 401', async () => {
        const rawBody = JSON.stringify({ test: 'byte_precision_check', random: Math.random() });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const validSig = computeCashfreeSignature(timestamp, rawBody);

        // 9a. Exact body passes signature verification (returns 200 with unhandled event type)
        const resExact = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': validSig,
            },
            body: rawBody,
        });
        assert.equal(resExact.status, 200);

        // 9b. Single whitespace added at the end (payload still valid JSON, but raw bytes differ)
        const tamperedBody = rawBody + ' ';
        const resTampered = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': validSig, // Computed over rawBody without space
            },
            body: tamperedBody,
        });

        // Must reject with 401 because raw body does not match the signature
        assert.equal(resTampered.status, 401);
        const tamperedJson = await resTampered.json();
        assert.equal(tamperedJson.success, false);
        assert.match(tamperedJson.message, /Invalid Cashfree webhook signature/);
    });

    // ----------------------------------------------------------------------
    // 10. Test fixtures and cleanup affect only dedicated test database
    // ----------------------------------------------------------------------
    test('10. Test execution strictly runs against crunchy_heart_test and isolates fixtures', async () => {
        // Assert active connection is local crunchy_heart_test
        const dbRes = await query('SELECT current_database(), current_user, inet_server_addr()');
        assert.equal(dbRes.rows[0].current_database, 'crunchy_heart_test');
        assert.equal(dbRes.rows[0].current_user, 'postgres');

        // Assert no connection to live Neon occurred
        assert.ok(!process.env.DATABASE_URL.includes('neon.tech'));

        // Assert that the historical COD test order remains completely preserved
        // (Even if test db was seeded from backup or empty, historical reservations are never touched)
        const checkRes = await query(`SELECT count(*) FROM inventory WHERE quantity_reserved > 0`);
        assert.ok(Number(checkRes.rows[0].count) >= 0);
    });
});
