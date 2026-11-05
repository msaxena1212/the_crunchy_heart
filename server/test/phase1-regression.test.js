/**
 * The Crunchy Heart - Phase 1 Regression Test Suite
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 * Tests all 12 core requirements for Phase 1 Order, Payment, and Inventory Correctness.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

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

// Override environment variables BEFORE any service/pool imports
process.env.DATABASE_URL = TEST_DB_URL;
process.env.DATABASE_URL_UNPOOLED = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.CASHFREE_CLIENT_ID = 'TEST_MOCK_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_MOCK_CLIENT_SECRET';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

// Import services after environment is safely configured
const { pool, query } = await import('../src/db/pool.js');
const { withTransaction } = await import('../src/db/transaction.js');
const {
    deductInventoryAtomic,
    deductOrderInventory,
    releaseInventoryReservation,
    getInventoryForVariants,
} = await import('../src/services/inventory.service.js');
const {
    createOrder,
} = await import('../src/services/order.service.js');
const {
    attachCashfreeOrderToPayment,
    markPaymentSuccess,
    markPaymentFailed,
} = await import('../src/services/payment.service.js');
const {
    calculateShipping,
} = await import('../src/services/shipping.service.js');
const {
    calculateInclusiveTax,
} = await import('../src/utils/gst.js');
const {
    calculateItemPricing,
} = await import('../src/services/pricing.service.js');

// --------------------------------------------------------------------------
// Test Fixture Helpers
// --------------------------------------------------------------------------
let testCategoryId;
let testProductId;

async function createFixtureCategoryAndProduct() {
    const catRes = await query(
        `
        INSERT INTO categories (name, slug, description, is_active)
        VALUES ('Test Category', 'test-cat-' || gen_random_uuid(), 'Test', true)
        RETURNING id
        `
    );
    testCategoryId = catRes.rows[0].id;

    const prodRes = await query(
        `
        INSERT INTO products (category_id, name, slug, brand, is_active)
        VALUES ($1, 'Test Product', 'test-prod-' || gen_random_uuid(), 'The Crunchy Heart', true)
        RETURNING id
        `,
        [testCategoryId]
    );
    testProductId = prodRes.rows[0].id;
}

async function createFixtureVariant({
    name = 'Test Makhana 100g',
    sku = 'TEST-SKU-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
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
        name: 'Test Customer',
        phone: '9876543210',
        email: 'test@crunchyheart.example.com',
    };
}

function sampleAddress() {
    return {
        name: 'Test Customer',
        phone: '9876543210',
        addressLine1: '123 Makhana Lane',
        addressLine2: 'Suite 4',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
        country: 'India',
    };
}

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------
describe('Phase 1 Core Order, Payment & Inventory Correctness Suite', () => {

    before(async () => {
        // Assert connection is strictly local
        const connRes = await query('SELECT current_database(), inet_server_addr()');
        assert.equal(connRes.rows[0].current_database, 'crunchy_heart_test');
        console.log(`\nVerified safe test DB connection: ${connRes.rows[0].current_database}`);

        await createFixtureCategoryAndProduct();
    });

    after(async () => {
        await pool.end();
    });

    // ----------------------------------------------------------------------
    // 1. Duplicate variants aggregated before quantity validation
    // ----------------------------------------------------------------------
    test('1. Duplicate cart-variant items are aggregated before quantity validation', async () => {
        // Variant with 5 units in stock
        const variant = await createFixtureVariant({ stock: 5, reserved: 0 });

        // Cart contains two items referencing the exact same variant: 3 + 3 = 6 (exceeds stock of 5)
        await assert.rejects(
            async () => {
                await createOrder({
                    customer: sampleCustomer(),
                    shippingAddress: sampleAddress(),
                    items: [
                        { variantId: variant.id, quantity: 3 },
                        { variantId: variant.id, quantity: 3 },
                    ],
                    paymentMethod: 'ONLINE',
                });
            },
            (err) => {
                assert.equal(err.statusCode, 409);
                assert.match(err.message, /Only 5 unit\(s\) of .* are available/);
                return true;
            }
        );

        // Cart contains two items referencing the same variant: 2 + 3 = 5 (fits exactly into stock of 5)
        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [
                { variantId: variant.id, quantity: 2 },
                { variantId: variant.id, quantity: 3 },
            ],
            paymentMethod: 'ONLINE',
        });

        assert.equal(orderRes.order.status, 'pending');
        // Aggregated into single priced line item of quantity 5
        assert.equal(orderRes.items.length, 1);
        assert.equal(orderRes.items[0].quantity, 5);
    });

    // ----------------------------------------------------------------------
    // 2. Insufficient stock rejection
    // ----------------------------------------------------------------------
    test('2. Insufficient stock is rejected with a 409 conflict', async () => {
        const variant = await createFixtureVariant({ stock: 1, reserved: 0 });

        await assert.rejects(
            async () => {
                await createOrder({
                    customer: sampleCustomer(),
                    shippingAddress: sampleAddress(),
                    items: [{ variantId: variant.id, quantity: 2 }],
                    paymentMethod: 'ONLINE',
                });
            },
            (err) => {
                assert.equal(err.statusCode, 409);
                assert.match(err.message, /Only 1 unit\(s\) of .* are available/);
                return true;
            }
        );
    });

    // ----------------------------------------------------------------------
    // 3. Duplicate success webhooks deduct stock exactly once
    // ----------------------------------------------------------------------
    test('3. Duplicate payment-success events deduct stock exactly once', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_TEST_' + Math.random().toString(36).substring(2, 10);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: {
                order_id: cfOrderId,
                cf_order_id: 'CF_SYS_123',
                payment_session_id: 'session_123',
            },
        });

        // 1st webhook call
        const firstSettlement = await markPaymentSuccess({
            providerOrderId: cfOrderId,
            providerPaymentId: 'PAY_111',
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });

        assert.equal(firstSettlement.status, 'paid');
        assert.equal(firstSettlement.inventoryDeducted, true);

        // Check stock reduced from 10 to 8
        const invAfterFirst = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfterFirst.rows[0].quantity_on_hand), 8);

        // 2nd webhook call (duplicate)
        const secondSettlement = await markPaymentSuccess({
            providerOrderId: cfOrderId,
            providerPaymentId: 'PAY_111',
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });

        assert.equal(secondSettlement.status, 'paid');
        assert.equal(secondSettlement.alreadySettled, true);

        // Stock must STILL be 8 (never deducted twice)
        const invAfterSecond = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfterSecond.rows[0].quantity_on_hand), 8);

        // Audit ledger must have exactly 1 SALE_DEDUCTION
        const ledgerRes = await query(
            `SELECT * FROM inventory_transactions WHERE variant_id = $1 AND transaction_type = 'SALE_DEDUCTION'`,
            [variant.id]
        );
        assert.equal(ledgerRes.rows.length, 1);
    });

    // ----------------------------------------------------------------------
    // 4. Delayed failure event cannot override a successful payment
    // ----------------------------------------------------------------------
    test('4. Delayed failure webhook cannot override an already paid payment or cancel the order', async () => {
        const variant = await createFixtureVariant({ stock: 5, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_TEST_' + Math.random().toString(36).substring(2, 10);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 'sess' },
        });

        // Payment succeeds
        await markPaymentSuccess({
            providerOrderId: cfOrderId,
            providerPaymentId: 'PAY_SUCCESS',
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });

        // Now a delayed failure event arrives
        const failResult = await markPaymentFailed({
            providerOrderId: cfOrderId,
            providerPaymentId: 'PAY_FAIL_LATE',
        });

        assert.equal(failResult.status, 'paid');
        assert.equal(failResult.ignored, true);

        // Verify in DB that order and payment are still 'paid' / 'confirmed'
        const orderCheck = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(orderCheck.rows[0].status, 'confirmed');
        assert.equal(orderCheck.rows[0].payment_status, 'paid');

        const payCheck = await query('SELECT status FROM payments WHERE id = $1', [orderRes.payment.id]);
        assert.equal(payCheck.rows[0].status, 'paid');
    });

    // ----------------------------------------------------------------------
    // 5. Failed payment followed by successful retry
    // ----------------------------------------------------------------------
    test('5. Failed payment attempt does not cancel order and allows successful retry', async () => {
        const variant = await createFixtureVariant({ stock: 5, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_TEST_' + Math.random().toString(36).substring(2, 10);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 'sess' },
        });

        // First attempt fails (e.g. user cancelled at gateway)
        const failRes = await markPaymentFailed({
            providerOrderId: cfOrderId,
            providerPaymentId: 'PAY_FAIL_1',
        });
        assert.equal(failRes.status, 'failed');

        // Order remains open for retry (status pending, payment_status failed)
        const openOrder = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(openOrder.rows[0].status, 'pending');
        assert.equal(openOrder.rows[0].payment_status, 'failed');

        // Customer retries and payment succeeds
        const successRes = await markPaymentSuccess({
            providerOrderId: cfOrderId,
            providerPaymentId: 'PAY_RETRY_SUCCESS',
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });
        assert.equal(successRes.status, 'paid');

        const finalOrder = await query('SELECT status, payment_status FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(finalOrder.rows[0].status, 'confirmed');
        assert.equal(finalOrder.rows[0].payment_status, 'paid');

        // Stock deducted from 5 to 4
        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 4);
    });

    // ----------------------------------------------------------------------
    // 6. Amount and currency mismatches are rejected and flagged safely
    // ----------------------------------------------------------------------
    test('6. Amount and currency mismatches are rejected and flagged safely without deducting stock', async () => {
        const variant = await createFixtureVariant({ stock: 5, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_TEST_' + Math.random().toString(36).substring(2, 10);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 'sess' },
        });

        // Wrong amount
        await assert.rejects(
            async () => {
                await markPaymentSuccess({
                    providerOrderId: cfOrderId,
                    paymentAmount: Number(orderRes.order.total_amount) - 100, // mismatch
                    paymentCurrency: 'INR',
                });
            },
            (err) => {
                assert.equal(err.statusCode, 400);
                assert.match(err.message, /Payment amount mismatch/);
                return true;
            }
        );

        // Wrong currency
        await assert.rejects(
            async () => {
                await markPaymentSuccess({
                    providerOrderId: cfOrderId,
                    paymentAmount: orderRes.order.total_amount,
                    paymentCurrency: 'USD', // mismatch
                });
            },
            (err) => {
                assert.equal(err.statusCode, 400);
                assert.match(err.message, /Payment currency mismatch/);
                return true;
            }
        );

        // Stock remains untouched at 5
        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 5);
    });

    // ----------------------------------------------------------------------
    // 7. Concurrent payments competing for last unit produce exactly one settlement
    // ----------------------------------------------------------------------
    test('7. Concurrent payments competing for the last unit produce exactly one stock settlement', async () => {
        // Exactly 1 unit in stock
        const variant = await createFixtureVariant({ stock: 1, reserved: 0 });

        // Order A and Order B both placed online (zero reservation policy)
        const orderA = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });
        const orderB = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderA = 'CF_CONC_A_' + Math.random().toString(36).substring(2, 8);
        const cfOrderB = 'CF_CONC_B_' + Math.random().toString(36).substring(2, 8);

        await attachCashfreeOrderToPayment({
            paymentId: orderA.payment.id,
            cashfreeOrder: { order_id: cfOrderA, payment_session_id: 'sA' },
        });
        await attachCashfreeOrderToPayment({
            paymentId: orderB.payment.id,
            cashfreeOrder: { order_id: cfOrderB, payment_session_id: 'sB' },
        });

        // Run both payment settlements concurrently
        const results = await Promise.all([
            markPaymentSuccess({
                providerOrderId: cfOrderA,
                paymentAmount: orderA.order.total_amount,
                paymentCurrency: 'INR',
            }),
            markPaymentSuccess({
                providerOrderId: cfOrderB,
                paymentAmount: orderB.order.total_amount,
                paymentCurrency: 'INR',
            }),
        ]);

        const normalSettlements = results.filter(r => r.inventoryDeducted === true);
        const shortageSettlements = results.filter(r => r.stockShortage === true);

        // Exactly one gets the unit, exactly one gets flagged with stock shortage
        assert.equal(normalSettlements.length, 1);
        assert.equal(shortageSettlements.length, 1);

        // Remaining inventory must be exactly 0 (never negative)
        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 0);

        // Check that the shortage order has a durable refund record in the refunds table
        const shortageRes = shortageSettlements[0];
        assert.ok(shortageRes.refundId);
        assert.equal(shortageRes.refundStatus, 'pending');

        const refundRecord = await query('SELECT * FROM refunds WHERE id = $1', [shortageRes.refundId]);
        assert.equal(refundRecord.rows.length, 1);
        assert.equal(refundRecord.rows[0].status, 'pending');
    });

    // ----------------------------------------------------------------------
    // 8. Stock shortage after payment creates durable exception and refund record
    // ----------------------------------------------------------------------
    test('8. Stock shortage after successful payment creates a durable exception and refund record', async () => {
        const variant = await createFixtureVariant({ stock: 1, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_SHORTAGE_' + Math.random().toString(36).substring(2, 8);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 's' },
        });

        // Manually exhaust stock before payment webhook arrives
        await query('UPDATE inventory SET quantity_on_hand = 0 WHERE variant_id = $1', [variant.id]);

        const settlement = await markPaymentSuccess({
            providerOrderId: cfOrderId,
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });

        assert.equal(settlement.status, 'paid');
        assert.equal(settlement.stockShortage, true);
        assert.ok(settlement.refundId);

        // Verify order state is 'exception_stock_shortage' and payment_status is 'paid'
        const orderRow = await query('SELECT status, payment_status, notes FROM orders WHERE id = $1', [orderRes.order.id]);
        assert.equal(orderRow.rows[0].status, 'exception_stock_shortage');
        assert.equal(orderRow.rows[0].payment_status, 'paid');
        assert.match(orderRow.rows[0].notes, /\[STOCK SHORTAGE EXCEPTION\]/);

        // Verify payments row is gateway_status 'PAID_STOCK_UNAVAILABLE'
        const payRow = await query('SELECT status, gateway_status FROM payments WHERE id = $1', [orderRes.payment.id]);
        assert.equal(payRow.rows[0].status, 'paid');
        assert.equal(payRow.rows[0].gateway_status, 'PAID_STOCK_UNAVAILABLE');

        // Verify refunds record
        const refundRow = await query('SELECT * FROM refunds WHERE id = $1', [settlement.refundId]);
        assert.equal(refundRow.rows.length, 1);
        assert.equal(refundRow.rows[0].status, 'pending');
        assert.equal(Number(refundRow.rows[0].amount), Number(orderRes.order.total_amount));
    });

    // ----------------------------------------------------------------------
    // 9. Database transaction rollback and retry/recovery behavior
    // ----------------------------------------------------------------------
    test('9. Database transaction rolls back cleanly on unexpected error and recovers on retry', async () => {
        const variant = await createFixtureVariant({ stock: 5, reserved: 0 });

        const orderRes = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        const cfOrderId = 'CF_ROLLBACK_' + Math.random().toString(36).substring(2, 8);
        await attachCashfreeOrderToPayment({
            paymentId: orderRes.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 's' },
        });

        // Simulate a failure inside transaction by causing a constraint violation or syntax error
        // within withTransaction
        let rollbackObserved = false;
        try {
            await withTransaction(async (client) => {
                await deductOrderInventory(client, {
                    orderId: orderRes.order.id,
                    items: [{ variantId: variant.id, quantity: 2 }],
                });
                // Force an error before commit
                throw new Error('SIMULATED_TRANSIENT_DB_FAILURE');
            });
        } catch (err) {
            rollbackObserved = (err.message === 'SIMULATED_TRANSIENT_DB_FAILURE');
        }

        assert.equal(rollbackObserved, true);

        // Verify inventory rolled back to 5
        const invCheck = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invCheck.rows[0].quantity_on_hand), 5);

        // Verify no ledger entries were committed
        const ledgerCheck = await query(
            `SELECT * FROM inventory_transactions WHERE variant_id = $1 AND notes LIKE '%${orderRes.order.id}%'`,
            [variant.id]
        );
        assert.equal(ledgerCheck.rows.length, 0);

        // Safe retry succeeds
        const recoverySettlement = await markPaymentSuccess({
            providerOrderId: cfOrderId,
            paymentAmount: orderRes.order.total_amount,
            paymentCurrency: 'INR',
        });

        assert.equal(recoverySettlement.status, 'paid');
        const finalInv = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(finalInv.rows[0].quantity_on_hand), 3);
    });

    // ----------------------------------------------------------------------
    // 10. Shipping threshold boundaries and GST-inclusive arithmetic
    // ----------------------------------------------------------------------
    test('10. Shipping threshold boundaries (₹499) and GST-inclusive arithmetic', async () => {
        // Boundary test 1: ₹498.99 -> Shipping is ₹149
        const shipBelow = await calculateShipping(498.99);
        assert.equal(shipBelow, 149);

        // Boundary test 2: ₹499.00 -> Shipping is ₹0
        const shipExact = await calculateShipping(499.00);
        assert.equal(shipExact, 0);

        // Boundary test 3: ₹500.00 -> Shipping is ₹0
        const shipAbove = await calculateShipping(500.00);
        assert.equal(shipAbove, 0);

        // GST Arithmetic test: ₹229 selling price with 18% inclusive GST
        const tax1 = calculateInclusiveTax(229, 18);
        assert.equal(tax1.grossAmount, 229);
        assert.equal(tax1.taxableAmount, 194.07);
        assert.equal(tax1.taxAmount, 34.93);
        assert.equal(Number((tax1.taxableAmount + tax1.taxAmount).toFixed(2)), 229.00);

        // GST Arithmetic test: ₹499 with 18% inclusive GST
        const tax2 = calculateInclusiveTax(499, 18);
        assert.equal(tax2.grossAmount, 499);
        assert.equal(tax2.taxableAmount, 422.88);
        assert.equal(tax2.taxAmount, 76.12);
        assert.equal(Number((tax2.taxableAmount + tax2.taxAmount).toFixed(2)), 499.00);
    });

    // ----------------------------------------------------------------------
    // 11. Idempotent order creation under concurrent duplicate requests
    // ----------------------------------------------------------------------
    test('11. Idempotent order creation returns identical order under concurrent duplicate requests', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });
        const idempotencyKey = 'IDEM_' + Math.random().toString(36).substring(2, 10);

        const payload = {
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
            idempotencyKey,
        };

        // Fire two concurrent creation requests with the same idempotency key
        const [resA, resB] = await Promise.all([
            createOrder(payload),
            createOrder(payload),
        ]);

        // Both must return the identical order number and ID
        assert.equal(resA.order.order_number, resB.order.order_number);
        assert.equal(resA.order.id, resB.order.id);

        // Exactly one order row must exist in DB with this idempotency key
        const countRes = await query('SELECT count(*) FROM orders WHERE idempotency_key = $1', [idempotencyKey]);
        assert.equal(Number(countRes.rows[0].count), 1);
    });

    // ----------------------------------------------------------------------
    // 12. Existing reservations remain unchanged during checkout changes
    // ----------------------------------------------------------------------
    test('12. Existing reservations remain unchanged during zero-reservation checkout changes', async () => {
        // Variant has 5 on hand, with 1 unit reserved (e.g. historical COD test order)
        // Available for new orders is 5 - 1 = 4.
        const variant = await createFixtureVariant({ stock: 5, reserved: 1 });

        // Verify initial state
        const initialInv = await query(
            'SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1',
            [variant.id]
        );
        assert.equal(Number(initialInv.rows[0].quantity_on_hand), 5);
        assert.equal(Number(initialInv.rows[0].quantity_reserved), 1);

        // 1. New ONLINE order placed for 2 units
        const onlineOrder = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 2 }],
            paymentMethod: 'ONLINE',
        });

        // Checkout must NOT increase quantity_reserved (zero-reservation policy)
        const invAfterCheckout = await query(
            'SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1',
            [variant.id]
        );
        assert.equal(Number(invAfterCheckout.rows[0].quantity_on_hand), 5);
        assert.equal(Number(invAfterCheckout.rows[0].quantity_reserved), 1); // UNCHANGED!

        // 2. Online order paid successfully
        const cfOrderId = 'CF_RES_TEST_' + Math.random().toString(36).substring(2, 8);
        await attachCashfreeOrderToPayment({
            paymentId: onlineOrder.payment.id,
            cashfreeOrder: { order_id: cfOrderId, payment_session_id: 's' },
        });

        await markPaymentSuccess({
            providerOrderId: cfOrderId,
            paymentAmount: onlineOrder.order.total_amount,
            paymentCurrency: 'INR',
        });

        // Stock deducted from 5 to 3. But the existing reservation MUST REMAIN 1!
        const invAfterPayment = await query(
            'SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1',
            [variant.id]
        );
        assert.equal(Number(invAfterPayment.rows[0].quantity_on_hand), 3);
        assert.equal(Number(invAfterPayment.rows[0].quantity_reserved), 1); // STILL EXACTLY 1!

        // Available quantity is now 3 - 1 = 2.
        const invMap = await getInventoryForVariants([variant.id]);
        assert.equal(invMap.get(variant.id).availableQuantity, 2);

        // 3. New COD order placed for 1 unit: zero reservation / no deduction at checkout
        const codOrder = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'COD',
        });

        assert.equal(codOrder.order.status, 'confirmed');

        const invAfterCod = await query(
            'SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1',
            [variant.id]
        );
        assert.equal(Number(invAfterCod.rows[0].quantity_on_hand), 3);
        assert.equal(Number(invAfterCod.rows[0].quantity_reserved), 1); // REMAINS 1!
    });
});
