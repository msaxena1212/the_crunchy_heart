/**
 * The Crunchy Heart - Payment Reconciliation Queue (Checkpoint 1)
 *
 * Verifies that a verified Cashfree SUCCESS whose settlement is blocked by an
 * inventory ledger anomaly is durably queued, idempotently, without changing
 * stock, order confirmation, or payment status.
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 * Cashfree is never contacted: webhooks are signed locally.
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

const TEST_WEBHOOK_SECRET = 'cfsk_ma_test_recon_queue_secret_key_123456789';

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DATABASE_URL_UNPOOLED = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.CASHFREE_CLIENT_ID = 'TEST_RECON_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = TEST_WEBHOOK_SECRET;
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const { query } = await import('../src/db/pool.js');
const { cashfreeWebhook } = await import('../src/controllers/payment.controller.js');
const {
    enqueuePaymentReconciliationEvent,
    isQueueableSettlementError,
    buildReconciliationIdempotencyKey,
} = await import('../src/services/payment-reconciliation.service.js');

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------
function buildWebhookApp() {
    const app = express();

    app.post(
        '/api/payments/cashfree/webhook',
        express.raw({ type: 'application/json' }),
        (req, res, next) => {
            req.rawBody = req.body?.toString('utf8') || '';
            req.body = JSON.parse(req.rawBody || '{}');
            return cashfreeWebhook(req, res, next);
        }
    );

    app.use((error, req, res, next) => {
        const statusCode = error.statusCode || 500;
        return res.status(statusCode).json({
            success: false,
            message: error.message || 'Internal server error.',
        });
    });

    return app;
}

function sign(timestamp, rawBody) {
    return crypto
        .createHmac('sha256', TEST_WEBHOOK_SECRET)
        .update(`${timestamp}${rawBody}`)
        .digest('base64');
}

async function postWebhook(baseUrl, body, { badSignature = false } = {}) {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`${baseUrl}/api/payments/cashfree/webhook`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-webhook-timestamp': timestamp,
            'x-webhook-signature': badSignature ? 'invalid-signature' : sign(timestamp, rawBody),
        },
        body: rawBody,
    });
    return { status: response.status, body: await response.json() };
}

function successEvent({ providerOrderId, providerPaymentId, amount, currency = 'INR' }) {
    return {
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        data: {
            order: { order_id: providerOrderId, order_amount: amount, order_currency: currency },
            payment: {
                cf_payment_id: providerPaymentId,
                payment_status: 'SUCCESS',
                payment_amount: amount,
                payment_currency: currency,
            },
        },
    };
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------
const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const fixtureOrderIds = [];
const fixtureVariantIds = [];
let testProductId;

async function createAnomalousOrder({ stock = 10, reserved = 5, quantity = 5, price = 100 } = {}) {
    const variantRes = await query(
        `
        INSERT INTO product_variants (
            product_id, sku, variant_name, weight_grams, flavor,
            mrp, selling_price, cost_price, tax_rate, is_active
        )
        VALUES ($1, $2, 'Recon Test', 100, 'Peri Peri', $3, $3, 50.00, 18.00, true)
        RETURNING id
        `,
        [testProductId, `RECON-${rand()}`, price]
    );
    const variantId = variantRes.rows[0].id;
    fixtureVariantIds.push(variantId);

    await query(
        `INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
         VALUES ($1, $2, $3, 5)`,
        [variantId, stock, reserved]
    );

    const orderRes = await query(
        `
        INSERT INTO orders (order_number, customer_name, phone, shipping_address,
                            subtotal, total_amount, currency, status, payment_status)
        VALUES ($1, 'Recon Customer', '9876543210', '{"city":"Mumbai"}'::jsonb,
                $2, $2, 'INR', 'pending_payment', 'pending')
        RETURNING id
        `,
        [`RECON-ORD-${rand()}`, price * quantity]
    );
    const orderId = orderRes.rows[0].id;
    fixtureOrderIds.push(orderId);

    await query(
        `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price, total_price)
         VALUES ($1, $2, 'Recon Test', 'Recon Test', 'RECON', $3, $4, $5)`,
        [orderId, variantId, quantity, price, price * quantity]
    );

    // Anomaly: ledger already holds a partial deduction (2 of 5 units).
    await query(
        `INSERT INTO inventory_transactions (variant_id, transaction_type, quantity, reference_type, reference_id, notes)
         VALUES ($1, 'SALE_DEDUCTION', 2, 'ORDER', $2, 'Recon test partial deduction')`,
        [variantId, orderId]
    );

    const providerOrderId = `TCH-RECON-${rand()}`;
    const paymentRes = await query(
        `
        INSERT INTO payments (order_id, provider, amount, currency, status)
        VALUES ($1, 'cashfree', $2, 'INR', 'created')
        RETURNING id
        `,
        [orderId, price * quantity]
    );
    await query(`UPDATE payments SET provider_order_id = $2 WHERE id = $1`, [paymentRes.rows[0].id, providerOrderId]);

    return { orderId, variantId, paymentId: paymentRes.rows[0].id, providerOrderId, amount: price * quantity };
}

async function queueRowsFor(orderId) {
    const res = await query(
        `SELECT * FROM payment_reconciliation_queue WHERE order_id = $1 ORDER BY created_at`,
        [orderId]
    );
    return res.rows;
}

async function incidentsFor(orderId) {
    const res = await query(
        `SELECT * FROM payment_reconciliation_incidents WHERE order_id = $1 ORDER BY created_at`,
        [orderId]
    );
    return res.rows;
}

async function stockFor(variantId) {
    const res = await query(`SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1`, [variantId]);
    return res.rows[0];
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------
describe('Payment reconciliation queue: durable recovery of blocked settlements', () => {
    let server;
    let baseUrl;

    before(async () => {
        const catRes = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Recon Test Category', 'recon-cat-' || gen_random_uuid(), 'Recon', true)
             RETURNING id`
        );
        const prodRes = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Recon Test Product', 'recon-prod-' || gen_random_uuid(), 'The Crunchy Heart', true)
             RETURNING id`,
            [catRes.rows[0].id]
        );
        testProductId = prodRes.rows[0].id;

        await new Promise(resolve => {
            server = buildWebhookApp().listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));

        // Queue rows reference orders with ON DELETE RESTRICT: remove them first.
        for (const orderId of fixtureOrderIds) {
            await query(`DELETE FROM payment_reconciliation_incidents WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM payment_reconciliation_queue WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM inventory_transactions WHERE reference_id = $1`, [orderId]);
            await query(`DELETE FROM orders WHERE id = $1`, [orderId]);
        }
        for (const variantId of fixtureVariantIds) {
            await query(`DELETE FROM inventory WHERE variant_id = $1`, [variantId]);
            await query(`DELETE FROM product_variants WHERE id = $1`, [variantId]);
        }
        if (testProductId) {
            await query(`DELETE FROM products WHERE id = $1`, [testProductId]);
        }
    });

    test('1. Blocked settlement is durably queued and acknowledged; nothing else changes', async () => {
        const fx = await createAnomalousOrder();
        const before = await stockFor(fx.variantId);

        const res = await postWebhook(
            baseUrl,
            successEvent({ providerOrderId: fx.providerOrderId, providerPaymentId: 'CF-PAY-1', amount: fx.amount })
        );

        assert.equal(res.status, 200);
        assert.equal(res.body.reconciliation.status, 'queued');
        assert.equal(res.body.reconciliation.result, 'created');

        const rows = await queueRowsFor(fx.orderId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'pending');
        assert.equal(rows[0].event_type, 'payment_success_settlement_blocked');
        assert.equal(rows[0].provider_payment_id, 'CF-PAY-1');
        assert.equal(Number(rows[0].verified_amount), fx.amount);
        assert.equal(rows[0].verified_currency, 'INR');
        assert.equal(rows[0].attempt_count, 0);
        assert.match(rows[0].last_error, /INVENTORY_RECONCILIATION_REQUIRED/);

        // Sanitised payload: no raw webhook body, no customer fields.
        const payload = rows[0].raw_provider_payload;
        assert.deepEqual(Object.keys(payload).sort(), ['amount', 'currency', 'paymentStatus', 'provider', 'providerOrderId', 'providerPaymentId']);

        // Settlement rolled back: payment not paid, order not confirmed, stock untouched.
        const payment = await query(`SELECT status FROM payments WHERE id = $1`, [fx.paymentId]);
        assert.equal(payment.rows[0].status, 'created');
        const order = await query(`SELECT status, payment_status FROM orders WHERE id = $1`, [fx.orderId]);
        assert.equal(order.rows[0].status, 'pending_payment');
        assert.equal(order.rows[0].payment_status, 'pending');
        const after = await stockFor(fx.variantId);
        assert.deepEqual(after, before);
    });

    test('2. Redelivered webhook is idempotent: no duplicate row', async () => {
        const fx = await createAnomalousOrder();
        const event = successEvent({ providerOrderId: fx.providerOrderId, providerPaymentId: 'CF-PAY-2', amount: fx.amount });

        const first = await postWebhook(baseUrl, event);
        const second = await postWebhook(baseUrl, event);

        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(second.body.reconciliation.result, 'duplicate');
        assert.equal((await queueRowsFor(fx.orderId)).length, 1);
        // Exact duplicates are not incidents.
        assert.equal((await incidentsFor(fx.orderId)).length, 0);
    });

    test('3. Two distinct successful payment attempts on one order are not collapsed', async () => {
        const fx = await createAnomalousOrder({ quantity: 5, price: 100 });
        const second = await query(
            `INSERT INTO payments (order_id, provider, amount, currency, status, provider_order_id)
             VALUES ($1, 'cashfree', 500.00, 'INR', 'created', $2) RETURNING id`,
            [fx.orderId, `${fx.providerOrderId}-R2`]
        );
        assert.ok(second.rows[0].id);

        await postWebhook(baseUrl, successEvent({ providerOrderId: fx.providerOrderId, providerPaymentId: 'CF-A', amount: fx.amount }));
        await postWebhook(baseUrl, successEvent({ providerOrderId: `${fx.providerOrderId}-R2`, providerPaymentId: 'CF-B', amount: fx.amount }));

        const rows = await queueRowsFor(fx.orderId);
        assert.equal(rows.length, 2);
        assert.notEqual(rows[0].idempotency_key, rows[1].idempotency_key);
    });

    test('4. Conflicting duplicate (different amount for same payment) is rejected, not overwritten', async () => {
        const fx = await createAnomalousOrder();
        await postWebhook(baseUrl, successEvent({ providerOrderId: fx.providerOrderId, providerPaymentId: 'CF-PAY-4', amount: fx.amount }));

        // Same payment ID, forged amount: signed, but does not match our record.
        const forged = await postWebhook(
            baseUrl,
            successEvent({ providerOrderId: fx.providerOrderId, providerPaymentId: 'CF-PAY-4', amount: 1.0 })
        );

        assert.equal(forged.status, 400);
        const rows = await queueRowsFor(fx.orderId);
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].verified_amount), fx.amount);
        // Amount mismatch is rejected as untrusted, not recorded as a conflict.
        assert.equal((await incidentsFor(fx.orderId)).length, 0);
    });

    test('4b. Same key with a materially different stored record is a durable conflict incident', async () => {
        const fx = await createAnomalousOrder();
        const event = successEvent({ providerOrderId: fx.providerOrderId, providerPaymentId: 'CF-PAY-4B', amount: fx.amount });

        await postWebhook(baseUrl, event);

        // Simulate a stored case that disagrees with the verified payment.
        await query(
            `UPDATE payment_reconciliation_queue SET verified_amount = 999.00 WHERE order_id = $1`,
            [fx.orderId]
        );

        const first = await postWebhook(baseUrl, event);
        assert.equal(first.status, 200);
        assert.equal(first.body.reconciliation.status, 'conflict_recorded');

        // Stored case is preserved, not overwritten.
        const rows = await queueRowsFor(fx.orderId);
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].verified_amount), 999);

        const incidents = await incidentsFor(fx.orderId);
        assert.equal(incidents.length, 1);
        assert.equal(incidents[0].incident_type, 'IDEMPOTENCY_CONFLICT');
        assert.equal(incidents[0].severity, 'high');
        assert.equal(incidents[0].queue_id, rows[0].id);
        assert.equal(Number(incidents[0].incoming_details.amount), fx.amount);
        assert.equal(Number(incidents[0].existing_details.amount), 999);

        // Redelivery of the same conflicting event: still one incident.
        const second = await postWebhook(baseUrl, event);
        assert.equal(second.status, 200);
        assert.equal((await incidentsFor(fx.orderId)).length, 1);
    });

    test('4c. Verified success without provider payment ID goes to manual review, never auto-queued', async () => {
        const fx = await createAnomalousOrder();
        const event = successEvent({ providerOrderId: fx.providerOrderId, providerPaymentId: null, amount: fx.amount });

        const first = await postWebhook(baseUrl, event);
        assert.equal(first.status, 200);
        assert.equal(first.body.reconciliation.status, 'manual_review_recorded');

        // No queue row: the event cannot be keyed uniquely.
        assert.equal((await queueRowsFor(fx.orderId)).length, 0);

        const incidents = await incidentsFor(fx.orderId);
        assert.equal(incidents.length, 1);
        assert.equal(incidents[0].incident_type, 'UNIDENTIFIED_PROVIDER_PAYMENT');
        assert.equal(incidents[0].queue_id, null);

        // Settlement still rolled back: payment and order untouched.
        const payment = await query(`SELECT status FROM payments WHERE id = $1`, [fx.paymentId]);
        assert.equal(payment.rows[0].status, 'created');

        // Redelivery maps to the same incident.
        await postWebhook(baseUrl, event);
        assert.equal((await incidentsFor(fx.orderId)).length, 1);
    });

    test('5. Unknown provider order never creates an orphan queue row', async () => {
        const res = await postWebhook(
            baseUrl,
            successEvent({ providerOrderId: `TCH-UNKNOWN-${rand()}`, providerPaymentId: 'CF-X', amount: 100 })
        );

        assert.equal(res.status, 404);
        assert.notEqual(res.body.reconciliation?.status, 'queued');
    });

    test('6. Invalid signature cannot create a queue entry', async () => {
        const fx = await createAnomalousOrder();
        const res = await postWebhook(
            baseUrl,
            successEvent({ providerOrderId: fx.providerOrderId, providerPaymentId: 'CF-PAY-6', amount: fx.amount }),
            { badSignature: true }
        );

        assert.equal(res.status, 401);
        assert.equal((await queueRowsFor(fx.orderId)).length, 0);
    });

    test('7. Only the inventory anomaly code is queueable; other errors still fail the webhook', () => {
        assert.equal(isQueueableSettlementError({ code: 'INVENTORY_RECONCILIATION_REQUIRED' }), true);
        assert.equal(isQueueableSettlementError({ code: 'ORDER_NOT_FOUND' }), false);
        assert.equal(isQueueableSettlementError({ code: 'INSUFFICIENT_STOCK' }), false);
        assert.equal(isQueueableSettlementError(new Error('db down')), false);
    });

    test('8. Idempotency key is keyed only by provider payment ID; order ID never substitutes', () => {
        assert.equal(
            buildReconciliationIdempotencyKey({ providerPaymentId: 'CF-1' }),
            buildReconciliationIdempotencyKey({ providerPaymentId: 'CF-1' })
        );
        assert.notEqual(
            buildReconciliationIdempotencyKey({ providerPaymentId: 'CF-1' }),
            buildReconciliationIdempotencyKey({ providerPaymentId: 'CF-2' })
        );
        assert.throws(() => buildReconciliationIdempotencyKey({ providerPaymentId: null }), /required/);
        assert.throws(() => buildReconciliationIdempotencyKey({}), /required/);
    });

    test('9. Direct enqueue rejects an empty provider order reference', async () => {
        await assert.rejects(
            () => enqueuePaymentReconciliationEvent({ providerOrderId: '' }),
            (err) => err.statusCode === 400
        );
    });
});
