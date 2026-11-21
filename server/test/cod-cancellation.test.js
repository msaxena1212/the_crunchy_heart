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

const { cancelCodOrder } = await import('../src/services/order-cancellation.service.js');
const { getPublicStoreInfo, updateBusinessSettings } = await import('../src/services/store-settings.service.js');

async function inv(variantId) {
    const r = await query('SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1', [variantId]);
    return { onHand: Number(r.rows[0].quantity_on_hand), reserved: Number(r.rows[0].quantity_reserved) };
}

async function placeOrder(variantId, quantity, paymentMethod) {
    return createOrder({
        customer: sampleCustomer(),
        shippingAddress: sampleAddress(),
        items: [{ variantId, quantity }],
        paymentMethod,
    });
}

describe('COD cancellation and business settings', () => {
    before(async () => { await createFixtureCategoryAndProduct(); });
    after(async () => { await pool.end(); });

    test('1. A COD order can be cancelled before dispatch and its stock is released', async () => {
        const v = await createFixtureVariant({ stock: 10, reserved: 0 });
        const o = await placeOrder(v.id, 3, 'COD');
        assert.deepEqual(await inv(v.id), { onHand: 10, reserved: 3 });

        const res = await cancelCodOrder({ orderNumber: o.order.order_number, actor: 'customer', reason: 'changed my mind' });
        assert.equal(res.status, 'cancelled');
        assert.deepEqual(await inv(v.id), { onHand: 10, reserved: 0 });

        const row = await query('SELECT status, notes FROM orders WHERE order_number = $1', [o.order.order_number]);
        assert.equal(row.rows[0].status, 'cancelled');
        assert.match(row.rows[0].notes, /CANCELLED by customer: changed my mind/);
    });

    test('2. Cancelling twice is idempotent and does not release stock again', async () => {
        const v = await createFixtureVariant({ stock: 10, reserved: 0 });
        const a = await placeOrder(v.id, 2, 'COD');
        await placeOrder(v.id, 4, 'COD');
        await cancelCodOrder({ orderNumber: a.order.order_number, actor: 'admin' });
        const again = await cancelCodOrder({ orderNumber: a.order.order_number, actor: 'admin' });
        assert.equal(again.alreadyCancelled, true);
        assert.deepEqual(await inv(v.id), { onHand: 10, reserved: 4 }); // the other order still holds its 4
    });

    test('3. A dispatched COD order cannot be cancelled', async () => {
        const v = await createFixtureVariant({ stock: 10, reserved: 0 });
        const o = await placeOrder(v.id, 1, 'COD');
        await query("UPDATE orders SET status = 'dispatched' WHERE id = $1", [o.order.id]);
        await assert.rejects(
            () => cancelCodOrder({ orderNumber: o.order.order_number, actor: 'customer' }),
            (err) => err.statusCode === 409 && err.code === 'ORDER_ALREADY_SHIPPED'
        );
    });

    test('4. Online orders are not cancellable through the COD path', async () => {
        const v = await createFixtureVariant({ stock: 10, reserved: 0 });
        const o = await placeOrder(v.id, 1, 'ONLINE');
        await assert.rejects(
            () => cancelCodOrder({ orderNumber: o.order.order_number, actor: 'admin' }),
            (err) => err.statusCode === 400 && err.code === 'NOT_COD_ORDER'
        );
    });

    test('5. A customer who does not own the order is refused', async () => {
        const v = await createFixtureVariant({ stock: 10, reserved: 0 });
        const o = await placeOrder(v.id, 1, 'COD');
        await assert.rejects(
            () => cancelCodOrder({ orderNumber: o.order.order_number, actor: 'customer', authorize: () => false }),
            (err) => err.statusCode === 403
        );
        assert.deepEqual(await inv(v.id), { onHand: 10, reserved: 1 });
    });

    test('6. Unknown order number returns 404', async () => {
        await assert.rejects(
            () => cancelCodOrder({ orderNumber: 'TCH-DOES-NOT-EXIST', actor: 'admin' }),
            (err) => err.statusCode === 404
        );
    });

    test('7. Online orders get a 15-minute hold that the expiry sweep releases', async () => {
        const { runInventoryHoldExpirySweep } = await import('../src/services/inventory-hold.service.js');
        const v = await createFixtureVariant({ stock: 5, reserved: 0 });
        const o = await placeOrder(v.id, 2, 'ONLINE');
        const held = await query('SELECT hold_expires_at FROM orders WHERE id = $1', [o.order.id]);
        assert.ok(held.rows[0].hold_expires_at, 'online order must have a hold expiry');
        assert.deepEqual(await inv(v.id), { onHand: 5, reserved: 2 });

        await query("UPDATE orders SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [o.order.id]);
        await runInventoryHoldExpirySweep();
        assert.deepEqual(await inv(v.id), { onHand: 5, reserved: 0 });
        const row = await query('SELECT status FROM orders WHERE id = $1', [o.order.id]);
        assert.equal(row.rows[0].status, 'cancelled');
    });

    test('8. FSSAI number: stored, validated, public, and clearable', async () => {
        await query("DELETE FROM store_settings WHERE setting_key = 'business'");
        assert.equal((await getPublicStoreInfo()).fssaiLicenseNumber, null);
        await assert.rejects(() => updateBusinessSettings({ fssaiLicenseNumber: '123' }), (e) => e.code === 'INVALID_FSSAI_NUMBER');
        await assert.rejects(() => updateBusinessSettings({ fssaiLicenseNumber: 'abcdefghijklmn' }), (e) => e.statusCode === 400);
        const saved = await updateBusinessSettings({ fssaiLicenseNumber: '1234 5678 9012 34' });
        assert.equal(saved.fssaiLicenseNumber, '12345678901234');
        assert.equal((await getPublicStoreInfo()).fssaiLicenseNumber, '12345678901234');
        await updateBusinessSettings({ fssaiLicenseNumber: '' });
        assert.equal((await getPublicStoreInfo()).fssaiLicenseNumber, null);
        await query("DELETE FROM store_settings WHERE setting_key = 'business'");
    });
});
