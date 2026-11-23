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


const fixtureVariant = o => createFixtureVariant({ mrp: 5000, ...o });
const { createCoupon, updateCoupon, listCoupons } = await import('../src/services/admin-modules.service.js');
const { cancelCodOrder } = await import('../src/services/order-cancellation.service.js');
const { runInventoryHoldExpirySweep } = await import('../src/services/inventory-hold.service.js');
const { previewCoupon, computeCouponDiscount, validateCouponInput, phoneKey } = await import('../src/services/coupon.service.js');

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
let admin;

async function makeCoupon(overrides = {}) {
    const code = overrides.code || `T${rand()}`;
    await query(
        `INSERT INTO coupons (code, discount_type, discount_value, minimum_order_value, maximum_discount,
                              usage_limit, per_customer_limit, starts_at, expires_at, is_active, first_order_only)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [code, overrides.type || 'percentage', overrides.value ?? 10, overrides.min ?? 0, overrides.max ?? null,
            overrides.usageLimit ?? null, overrides.perCustomer ?? null, overrides.startsAt ?? null,
            overrides.expiresAt ?? null, overrides.active ?? true, overrides.firstOrderOnly ?? false]
    );
    return code;
}

const uniquePhone = () => '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
const customerWith = phone => ({ ...sampleCustomer(), phone });

async function order(variantId, qty, { code, phone, method = 'COD', key } = {}) {
    return createOrder({
        customer: customerWith(phone || uniquePhone()),
        shippingAddress: sampleAddress(),
        items: [{ variantId, quantity: qty }],
        paymentMethod: method,
        couponCode: code,
        idempotencyKey: key,
    });
}

const couponRow = async code => (await query('SELECT * FROM coupons WHERE lower(code) = lower($1)', [code])).rows[0];

describe('Coupons', () => {
    before(async () => {
        await createFixtureCategoryAndProduct();
        const a = await query(
            `INSERT INTO admin_users (email, password_hash, full_name, role, is_active)
             VALUES ($1, 'x', 'Coupon Test Admin', 'ADMIN', true) RETURNING id, role`,
            [`coupon-${rand().toLowerCase()}@example.test`]
        );
        admin = { id: a.rows[0].id, role: a.rows[0].role };
    });
    after(async () => {
        await query('DELETE FROM admin_audit_logs WHERE admin_user_id = $1', [admin.id]);
        await query('DELETE FROM admin_users WHERE id = $1', [admin.id]);
        await pool.end();
    });

    test('1. Discount maths: percentage, fixed, cap, and Rs 1 always left payable', () => {
        assert.equal(computeCouponDiscount({ discount_type: 'percentage', discount_value: 10, maximum_discount: null }, 500), 50);
        assert.equal(computeCouponDiscount({ discount_type: 'percentage', discount_value: 50, maximum_discount: 100 }, 1000), 100);
        assert.equal(computeCouponDiscount({ discount_type: 'fixed', discount_value: 75, maximum_discount: null }, 500), 75);
        assert.equal(computeCouponDiscount({ discount_type: 'fixed', discount_value: 900, maximum_discount: null }, 500), 499);
        assert.equal(computeCouponDiscount({ discount_type: 'percentage', discount_value: 100, maximum_discount: null }, 200), 199);
    });

    test('2. A percentage coupon reduces the order total and is counted as used', async () => {
        const v = await fixtureVariant({ sellingPrice: 400, taxRate: 5, stock: 20 });
        const code = await makeCoupon({ value: 10 });
        const o = await order(v.id, 2, { code: code.toLowerCase() }); // codes are case-insensitive
        const row = (await query('SELECT subtotal, discount_amount, total_amount, coupon_code FROM orders WHERE id = $1', [o.order.id])).rows[0];
        assert.equal(Number(row.discount_amount), 80);
        assert.equal(row.coupon_code, code);
        assert.equal(Number(row.total_amount), Number(row.subtotal) - 80 + Number(o.order.shipping_amount));
        assert.equal((await couponRow(code)).usage_count, 1);
        const red = await query('SELECT * FROM coupon_redemptions WHERE order_id = $1', [o.order.id]);
        assert.equal(red.rows.length, 1);
        assert.equal(Number(red.rows[0].discount_amount), 80);
    });

    test('3. Unknown, inactive, expired, not-yet-started and exhausted coupons are refused', async () => {
        const v = await fixtureVariant({ sellingPrice: 300, stock: 50 });
        const day = 86400000;
        const cases = [
            ['COUPON_INVALID', 'NOSUCH' + rand()],
            ['COUPON_INVALID', await makeCoupon({ active: false })],
            ['COUPON_EXPIRED', await makeCoupon({ expiresAt: new Date(Date.now() - day) })],
            ['COUPON_NOT_STARTED', await makeCoupon({ startsAt: new Date(Date.now() + day) })],
        ];
        for (const [expected, code] of cases) {
            await assert.rejects(() => order(v.id, 1, { code }), e => e.code === expected && e.statusCode === 400, expected);
        }
        const limited = await makeCoupon({ usageLimit: 1 });
        await order(v.id, 1, { code: limited });
        await assert.rejects(() => order(v.id, 1, { code: limited }), e => e.code === 'COUPON_EXHAUSTED');
    });

    test('4. A refused coupon creates no order and holds no stock', async () => {
        const v = await fixtureVariant({ sellingPrice: 300, stock: 10 });
        await assert.rejects(() => order(v.id, 2, { code: 'NOSUCH' + rand() }));
        assert.equal(Number((await query('SELECT quantity_reserved FROM inventory WHERE variant_id = $1', [v.id])).rows[0].quantity_reserved), 0);
    });

    test('5. Minimum order value is enforced, with a helpful message', async () => {
        const v = await fixtureVariant({ sellingPrice: 200, stock: 50 });
        const code = await makeCoupon({ min: 1000 });
        await assert.rejects(() => order(v.id, 2, { code }), e => e.code === 'COUPON_MIN_ORDER' && /more/.test(e.message));
        const ok = await order(v.id, 6, { code }); // 1200 subtotal
        assert.ok(Number(ok.order.discount_amount) > 0);
    });

    test('6. Per-customer limit holds even when the phone is written differently', async () => {
        const v = await fixtureVariant({ sellingPrice: 300, stock: 50 });
        const code = await makeCoupon({ perCustomer: 1 });
        const phone = uniquePhone();
        await order(v.id, 1, { code, phone });
        await assert.rejects(() => order(v.id, 1, { code, phone: '+91 ' + phone.slice(0, 5) + ' ' + phone.slice(5) }),
            e => e.code === 'COUPON_LIMIT_REACHED');
        await order(v.id, 1, { code }); // a different customer is fine
        assert.equal(phoneKey('+91 98765-43210'), '9876543210');
    });

    test('7. first_order_only is refused for a returning customer', async () => {
        const v = await fixtureVariant({ sellingPrice: 300, stock: 50 });
        const code = await makeCoupon({ firstOrderOnly: true });
        const phone = uniquePhone();
        await order(v.id, 1, { phone });
        await assert.rejects(() => order(v.id, 1, { code, phone }), e => e.code === 'COUPON_FIRST_ORDER_ONLY');
        await order(v.id, 1, { code }); // brand new phone works
    });

    test('8. Cancelling a COD order gives the coupon use back', async () => {
        const v = await fixtureVariant({ sellingPrice: 300, stock: 50 });
        const code = await makeCoupon({ usageLimit: 1 });
        const o = await order(v.id, 1, { code });
        assert.equal((await couponRow(code)).usage_count, 1);
        await cancelCodOrder({ orderNumber: o.order.order_number, actor: 'customer' });
        assert.equal((await couponRow(code)).usage_count, 0);
        assert.equal((await query('SELECT 1 FROM coupon_redemptions WHERE order_id = $1', [o.order.id])).rows.length, 0);
        await order(v.id, 1, { code }); // usable again
    });

    test('9. An unpaid online order that expires gives the coupon use back', async () => {
        const v = await fixtureVariant({ sellingPrice: 300, stock: 50 });
        const code = await makeCoupon({ usageLimit: 1 });
        const o = await order(v.id, 1, { code, method: 'ONLINE' });
        assert.equal((await couponRow(code)).usage_count, 1);
        await query("UPDATE orders SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [o.order.id]);
        await runInventoryHoldExpirySweep();
        assert.equal((await couponRow(code)).usage_count, 0);
    });

    test('10. Replaying an order key with a different coupon is rejected', async () => {
        const v = await fixtureVariant({ sellingPrice: 300, stock: 50 });
        const code = await makeCoupon({ value: 10 });
        const key = 'coupon_replay_' + rand() + rand();
        const phone = uniquePhone();
        await order(v.id, 1, { code, phone, key });
        await assert.rejects(() => order(v.id, 1, { phone, key }), e => e.code === 'IDEMPOTENCY_KEY_REUSED');
        const same = await order(v.id, 1, { code, phone, key }); // identical replay returns the original
        assert.equal((await couponRow(code)).usage_count, 1);
        assert.ok(same.order.order_number);
    });

    test('11. The festive combo discount is a real number on created orders (was NaN)', async () => {
        const v = await fixtureVariant({ sku: 'TCH-FLV-TEST-' + rand(), sellingPrice: 100, taxRate: 5, stock: 50 });
        const o = await order(v.id, 4);
        const row = (await query('SELECT subtotal, discount_amount, total_amount FROM orders WHERE id = $1', [o.order.id])).rows[0];
        assert.equal(Number(row.discount_amount), 20); // 5% of 400
        assert.ok(Number.isFinite(Number(row.total_amount)));
    });

    test('12. Combo discount and coupon stack, and the total is never below Rs 1', async () => {
        const v = await fixtureVariant({ sku: 'TCH-FLV-TEST-' + rand(), sellingPrice: 100, taxRate: 5, stock: 50 });
        const code = await makeCoupon({ type: 'fixed', value: 5000 });
        const o = await order(v.id, 4, { code });
        const row = (await query('SELECT discount_amount, total_amount FROM orders WHERE id = $1', [o.order.id])).rows[0];
        assert.equal(Number(row.discount_amount), 399); // 20 combo + 379 coupon, leaving Rs 1 of goods
        assert.ok(Number(row.total_amount) >= 1);
    });

    test('13. The preview reports a coupon as data, and an error without throwing', async () => {
        const code = await makeCoupon({ value: 20 });
        const ok = await previewCoupon({ code, subtotal: 1000, discountableAmount: 1000, phone: null });
        assert.deepEqual([ok.applied, ok.discountAmount], [true, 200]);
        const bad = await previewCoupon({ code: 'NOSUCH' + rand(), subtotal: 1000, discountableAmount: 1000 });
        assert.equal(bad.applied, false);
        assert.equal(bad.errorCode, 'COUPON_INVALID');
        assert.deepEqual(await previewCoupon({ code: '', subtotal: 1, discountableAmount: 1 }), { applied: false });
    });

    test('14. Admin input is validated', () => {
        const bad = (input, partial) => assert.throws(() => validateCouponInput(input, { partial }), e => e.code === 'VALIDATION');
        bad({ code: 'ab', discountType: 'fixed', discountValue: 10 });
        bad({ code: 'GOOD10', discountType: 'bogus', discountValue: 10 });
        bad({ code: 'GOOD10', discountType: 'percentage', discountValue: 150 });
        bad({ code: 'GOOD10', discountType: 'fixed', discountValue: 0 });
        bad({ code: 'GOOD10', discountType: 'fixed', discountValue: 10, startsAt: '2030-01-02', expiresAt: '2030-01-01' });
        bad({ code: 'GOOD10', discountType: 'fixed', discountValue: 10, usageLimit: 0 });
        const good = validateCouponInput({ code: ' diwali10 ', discountType: 'percentage', discountValue: 10, usageLimit: '100' });
        assert.equal(good.code, 'DIWALI10');
        assert.equal(good.usageLimit, 100);
    });

    test('15. Admin can create, edit and deactivate a coupon, and every change is audited', async () => {
        const code = 'ADM' + rand();
        const created = await createCoupon({ actor: admin, input: { code, discountType: 'percentage', discountValue: 15, minimumOrderValue: 300, description: 'Test' } });
        await assert.rejects(() => createCoupon({ actor: admin, input: { code: code.toLowerCase(), discountType: 'fixed', discountValue: 5 } }),
            e => e.statusCode === 409 && e.code === 'COUPON_CODE_EXISTS');
        await updateCoupon({ actor: admin, couponId: created.couponId, input: { discountValue: 20, isActive: false } });
        const row = await couponRow(code);
        assert.equal(Number(row.discount_value), 20);
        assert.equal(row.is_active, false);
        const listed = (await listCoupons({ actor: admin })).coupons.find(c => c.code === code);
        assert.equal(listed.isActive, false);
        const logs = await query("SELECT action FROM admin_audit_logs WHERE entity_type = 'coupon' AND entity_id = $1 ORDER BY created_at", [created.couponId]);
        assert.deepEqual(logs.rows.map(r => r.action), ['COUPON_CREATED', 'COUPON_UPDATED']);
        await assert.rejects(() => updateCoupon({ actor: admin, couponId: created.couponId, input: {} }), e => e.statusCode === 400);
        await assert.rejects(() => updateCoupon({ actor: { id: null }, couponId: created.couponId, input: { isActive: true } }));
    });

    test('16. GST is charged on the discounted price, and line tax adds up to the order tax', async () => {
        const v = await fixtureVariant({ sellingPrice: 105, taxRate: 5, stock: 50 });
        const plain = await order(v.id, 10);
        const code = await makeCoupon({ type: 'fixed', value: 200 });
        const disc = await order(v.id, 10, { code });
        const read = async id => (await query('SELECT subtotal, discount_amount, tax_amount FROM orders WHERE id = $1', [id])).rows[0];
        const a = await read(plain.order.id);
        const b = await read(disc.order.id);
        assert.equal(Number(a.tax_amount), 50);   // 1050 incl 5% GST
        assert.equal(Number(b.discount_amount), 200);
        assert.equal(Number(b.tax_amount), 40.48); // 850 incl 5% GST = 850 * 5/105
        const items = await query('SELECT SUM(tax_amount) AS t, SUM(taxable_value) AS v FROM order_items WHERE order_id = $1', [disc.order.id]);
        assert.ok(Math.abs(Number(items.rows[0].t) - 40.48) < 0.02);
        assert.ok(Math.abs(Number(items.rows[0].v) + Number(items.rows[0].t) - 850) < 0.05);
    });
});
