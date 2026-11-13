/**
 * The Crunchy Heart - Admin catalogue editing: product details and image, per-pack price and stock,
 * and the per-kg rate tool.
 *
 * Runs only against the local crunchy_heart_test database. No external service is contacted.
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
process.env.CASHFREE_CLIENT_ID = 'TEST_CATALOGUE_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_CATALOGUE_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'TEST_CATALOGUE_ORDER_TOKEN_SECRET_0123456789abcdef';
process.env.OWNER_SESSION_SECRET = 'TEST_CATALOGUE_OWNER_SESSION_SECRET_0123456789ab';
process.env.RECOVERY_CODE_SECRET = 'TEST_CATALOGUE_RECOVERY_CODE_SECRET_0123456789abcdef';

const { query, pool } = await import('../src/db/pool.js');
const catalogue = await import('../src/services/admin-catalogue.service.js');
const modules = await import('../src/services/admin-modules.service.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const fixtureAdminIds = [];
const fixtureProductIds = [];
const fixtureCategoryIds = [];
const GHOST_ID = '00000000-0000-4000-8000-000000000000';

async function createAdmin({ active = true, role = 'ADMIN' } = {}) {
    const row = await query(
        `INSERT INTO admin_users (email, password_hash, full_name, role, is_active)
         VALUES ($1, 'x', 'Catalogue Test Admin', $2, $3) RETURNING id, role`,
        [`catalogue-${rand().toLowerCase()}@example.test`, role, active]
    );
    fixtureAdminIds.push(row.rows[0].id);
    return { id: row.rows[0].id, role: row.rows[0].role };
}

describe('Admin catalogue editing', () => {
    let productId;
    let v250;
    let v1000;
    let categorySlug;

    before(async () => {
        categorySlug = `catalogue-cat-${rand().toLowerCase()}`;
        const cat = await query(
            `INSERT INTO categories (name, slug, description, is_active, sort_order)
             VALUES ('Catalogue Test Category', $1, 'Test', true, 999) RETURNING id`,
            [categorySlug]
        );
        fixtureCategoryIds.push(cat.rows[0].id);

        const prod = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active, description, short_description)
             VALUES ($1, 'Catalogue Test Almond', $2, 'The Crunchy Heart', true, 'Long text', 'Short text') RETURNING id`,
            [cat.rows[0].id, `catalogue-almond-${rand().toLowerCase()}`]
        );
        productId = prod.rows[0].id;
        fixtureProductIds.push(productId);

        const small = await query(
            `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, is_active, sort_order)
             VALUES ($1, $2, '250g', 250, 0, 300, 0, 5, true, 1) RETURNING id`,
            [productId, `CAT-${rand()}-250`]
        );
        const large = await query(
            `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, is_active, sort_order)
             VALUES ($1, $2, '1kg', 1000, 1500, 1200, 0, 5, true, 2) RETURNING id`,
            [productId, `CAT-${rand()}-1000`]
        );
        v250 = small.rows[0].id;
        v1000 = large.rows[0].id;

        await query(`INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, 20, 0, 5)`, [v250]);
        // 1kg has 3 units reserved for open orders.
        await query(`INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, 10, 3, 5)`, [v1000]);
    });

    after(async () => {
        for (const id of fixtureAdminIds) {
            await query(`DELETE FROM admin_audit_logs WHERE admin_user_id = $1`, [id]);
            await query(`DELETE FROM admin_users WHERE id = $1`, [id]);
        }
        for (const id of fixtureProductIds) {
            await query(`DELETE FROM inventory_transactions WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`, [id]);
            await query(`DELETE FROM inventory WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`, [id]);
            await query(`DELETE FROM product_images WHERE product_id = $1`, [id]);
            await query(`DELETE FROM product_variants WHERE product_id = $1`, [id]);
            await query(`DELETE FROM products WHERE id = $1`, [id]);
        }
        for (const id of fixtureCategoryIds) {
            await query(`DELETE FROM categories WHERE id = $1`, [id]);
        }
        await pool.end().catch(() => {});
    });

    test('1. Only an active administrator can read or edit the catalogue', async () => {
        const customer = await createAdmin({ role: 'CUSTOMER' });
        await assert.rejects(() => catalogue.getAdminProduct({ actor: customer, productId }), err => err.code === 'FORBIDDEN');
        await assert.rejects(
            () => catalogue.updateAdminVariant({ actor: customer, variantId: v250, input: {} }),
            err => err.code === 'FORBIDDEN'
        );
        await assert.rejects(() => catalogue.getAdminProduct({ actor: { id: null }, productId }), err => err.code === 'AUTH_REQUIRED');
    });

    test('2. A product loads with its pack sizes, stock and the implied price per kg', async () => {
        const admin = await createAdmin();
        const { product, variants } = await catalogue.getAdminProduct({ actor: admin, productId });
        assert.equal(product.name, 'Catalogue Test Almond');
        assert.equal(variants.length, 2);
        const kg = variants.find(v => v.weightGrams === 1000);
        assert.equal(kg.sellingPrice, 1200);
        assert.equal(kg.pricePerKg, 1200);
        assert.equal(kg.reserved, 3);
        assert.equal(kg.available, 7);
        assert.equal(variants.find(v => v.weightGrams === 250).pricePerKg, 1200);
    });

    test('3. Unknown or malformed ids are reported as not found, not as a server error', async () => {
        const admin = await createAdmin();
        await assert.rejects(() => catalogue.getAdminProduct({ actor: admin, productId: 'not-a-uuid' }), err => err.statusCode === 404);
        await assert.rejects(() => catalogue.getAdminProduct({ actor: admin, productId: GHOST_ID }), err => err.statusCode === 404);
        await assert.rejects(
            () => catalogue.updateAdminVariant({ actor: admin, variantId: GHOST_ID, input: { sellingPrice: 1, mrp: 0, isActive: true, quantityOnHand: 1, reorderLevel: 0 } }),
            err => err.statusCode === 404
        );
    });

    test('4. Image values are restricted to storefront asset paths or https links', () => {
        assert.equal(catalogue.parseImageUrl('assets/products/premium-almond.webp'), 'assets/products/premium-almond.webp');
        assert.equal(catalogue.parseImageUrl(''), null);
        assert.equal(catalogue.parseImageUrl(null), null);
        assert.match(catalogue.parseImageUrl('https://cdn.example.test/a.jpg'), /^https:\/\/cdn\.example\.test\/a\.jpg$/);
        for (const bad of ['javascript:alert(1)', 'http://insecure.example.test/a.jpg', 'assets/../secrets.webp', 'assets/x.exe', '/etc/passwd', 'data:image/png;base64,AAAA']) {
            assert.throws(() => catalogue.parseImageUrl(bad), err => err.statusCode === 400, `rejects ${bad}`);
        }
    });

    test('5. Product details, visibility and image can be updated, and the change is audited', async () => {
        const admin = await createAdmin();
        const saved = await catalogue.updateAdminProduct({
            actor: admin,
            productId,
            input: {
                name: 'Catalogue Test Almond Deluxe',
                shortDescription: 'New short',
                description: 'New long text',
                isActive: false,
                isFeatured: true,
                imageUrl: 'assets/products/test-almond.webp',
            },
        });
        assert.equal(saved.product.name, 'Catalogue Test Almond Deluxe');
        assert.equal(saved.product.isActive, false);
        assert.equal(saved.product.isFeatured, true);
        assert.equal(saved.product.imageUrl, 'assets/products/test-almond.webp');

        // Changing the image again updates the same primary row (no duplicates).
        await catalogue.updateAdminProduct({
            actor: admin,
            productId,
            input: { name: 'Catalogue Test Almond Deluxe', shortDescription: '', description: '', isActive: true, isFeatured: false, imageUrl: 'assets/products/other.webp' },
        });
        const images = await query(`SELECT image_url FROM product_images WHERE product_id = $1`, [productId]);
        assert.equal(images.rows.length, 1);
        assert.equal(images.rows[0].image_url, 'assets/products/other.webp');

        // Clearing the image removes it.
        const cleared = await catalogue.updateAdminProduct({
            actor: admin,
            productId,
            input: { name: 'Catalogue Test Almond Deluxe', shortDescription: '', description: '', isActive: true, isFeatured: false, imageUrl: '' },
        });
        assert.equal(cleared.product.imageUrl, null);

        const log = await query(`SELECT COUNT(*)::int AS n FROM admin_audit_logs WHERE admin_user_id = $1 AND action = 'product.updated'`, [admin.id]);
        assert.equal(log.rows[0].n, 3);
    });

    test('6. Product validation rejects blank names, bad flags and bad image values', async () => {
        const admin = await createAdmin();
        const base = { name: 'Ok', shortDescription: '', description: '', isActive: true, isFeatured: false, imageUrl: null };
        await assert.rejects(() => catalogue.updateAdminProduct({ actor: admin, productId, input: { ...base, name: '   ' } }), err => err.statusCode === 400);
        await assert.rejects(() => catalogue.updateAdminProduct({ actor: admin, productId, input: { ...base, isActive: 'yes' } }), err => err.statusCode === 400);
        await assert.rejects(() => catalogue.updateAdminProduct({ actor: admin, productId, input: { ...base, imageUrl: 'javascript:alert(1)' } }), err => err.statusCode === 400);
    });

    test('7. A pack price, MRP, stock and visibility can be edited; the stock change is recorded', async () => {
        const admin = await createAdmin();
        const result = await catalogue.updateAdminVariant({
            actor: admin,
            variantId: v250,
            input: { sellingPrice: 325.5, mrp: 400, isActive: true, badge: ' Bestseller ', quantityOnHand: 35, reorderLevel: 8 },
        });
        const row = result.variants.find(v => v.id === v250);
        assert.equal(row.sellingPrice, 325.5);
        assert.equal(row.mrp, 400);
        assert.equal(row.badge, 'Bestseller');
        assert.equal(row.onHand, 35);
        assert.equal(row.reorderLevel, 8);

        const tx = await query(`SELECT quantity, transaction_type FROM inventory_transactions WHERE variant_id = $1`, [v250]);
        assert.equal(tx.rows.length, 1);
        assert.equal(tx.rows[0].transaction_type, 'admin_adjustment');
        assert.equal(tx.rows[0].quantity, 15); // 20 -> 35

        // Saving the same stock again records nothing new.
        await catalogue.updateAdminVariant({
            actor: admin,
            variantId: v250,
            input: { sellingPrice: 325.5, mrp: 400, isActive: true, badge: 'Bestseller', quantityOnHand: 35, reorderLevel: 8 },
        });
        const again = await query(`SELECT COUNT(*)::int AS n FROM inventory_transactions WHERE variant_id = $1`, [v250]);
        assert.equal(again.rows[0].n, 1);

        // Hide the pack.
        const hidden = await catalogue.updateAdminVariant({
            actor: admin,
            variantId: v250,
            input: { sellingPrice: 325.5, mrp: 400, isActive: false, badge: '', quantityOnHand: 35, reorderLevel: 8 },
        });
        assert.equal(hidden.variants.find(v => v.id === v250).isActive, false);
    });

    test('8. Invalid pack edits are rejected: negative price, MRP below price, stock below reserved', async () => {
        const admin = await createAdmin();
        const ok = { sellingPrice: 1200, mrp: 0, isActive: true, badge: '', quantityOnHand: 10, reorderLevel: 5 };

        await assert.rejects(() => catalogue.updateAdminVariant({ actor: admin, variantId: v1000, input: { ...ok, sellingPrice: -5 } }), err => err.statusCode === 400);
        await assert.rejects(() => catalogue.updateAdminVariant({ actor: admin, variantId: v1000, input: { ...ok, sellingPrice: 'abc' } }), err => err.statusCode === 400);
        await assert.rejects(() => catalogue.updateAdminVariant({ actor: admin, variantId: v1000, input: { ...ok, sellingPrice: 1000000.01 } }), err => err.statusCode === 400);
        await assert.rejects(() => catalogue.updateAdminVariant({ actor: admin, variantId: v1000, input: { ...ok, mrp: 900 } }), err => err.statusCode === 400);
        await assert.rejects(() => catalogue.updateAdminVariant({ actor: admin, variantId: v1000, input: { ...ok, quantityOnHand: 1.5 } }), err => err.statusCode === 400);
        await assert.rejects(() => catalogue.updateAdminVariant({ actor: admin, variantId: v1000, input: { ...ok, isActive: 'true' } }), err => err.statusCode === 400);

        // 3 units are reserved for open orders, so on-hand cannot drop to 2.
        await assert.rejects(
            () => catalogue.updateAdminVariant({ actor: admin, variantId: v1000, input: { ...ok, quantityOnHand: 2 } }),
            err => err.statusCode === 409 && /reserved/.test(err.message)
        );

        // Nothing was changed by the failed attempts.
        const { variants } = await catalogue.getAdminProduct({ actor: admin, productId });
        const kg = variants.find(v => v.id === v1000);
        assert.equal(kg.sellingPrice, 1200);
        assert.equal(kg.onHand, 10);
    });

    test('9. A per-kg rate re-prices every weight-based pack, rounding to the nearest rupee', async () => {
        const admin = await createAdmin();
        const result = await catalogue.setAdminProductRatePerKg({ actor: admin, productId, ratePerKg: 1234 });
        const small = result.variants.find(v => v.id === v250);
        const large = result.variants.find(v => v.id === v1000);
        assert.equal(small.sellingPrice, 309); // 1234 x 0.25 = 308.5 -> 309
        assert.equal(large.sellingPrice, 1234);
        // The 1kg pack had MRP 1500, which still covers 1234, so it is kept. The 250g pack had MRP 400 >= 309.
        assert.equal(large.mrp, 1500);

        // A rate that would put the price above an existing MRP clears that MRP (no strike-through) instead of failing.
        const raised = await catalogue.setAdminProductRatePerKg({ actor: admin, productId, ratePerKg: 1800 });
        const raisedLarge = raised.variants.find(v => v.id === v1000);
        assert.equal(raisedLarge.sellingPrice, 1800);
        assert.equal(raisedLarge.mrp, 0);

        await assert.rejects(() => catalogue.setAdminProductRatePerKg({ actor: admin, productId, ratePerKg: -1 }), err => err.statusCode === 400);
        await assert.rejects(() => catalogue.setAdminProductRatePerKg({ actor: admin, productId, ratePerKg: '' }), err => err.statusCode === 400);

        const log = await query(`SELECT details FROM admin_audit_logs WHERE admin_user_id = $1 AND action = 'product.rate_per_kg_set'`, [admin.id]);
        assert.equal(log.rows.length, 2);
        assert.equal(log.rows[0].details.ratePerKg, 1234);
    });

    test('10. A product with no weight-based packs cannot be priced per kg', async () => {
        const admin = await createAdmin();
        const cat = await query(`SELECT id FROM categories WHERE slug = $1`, [categorySlug]);
        const prod = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active) VALUES ($1, 'No weight product', $2, 'The Crunchy Heart', true) RETURNING id`,
            [cat.rows[0].id, `catalogue-noweight-${rand().toLowerCase()}`]
        );
        fixtureProductIds.push(prod.rows[0].id);
        await query(
            `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, is_active)
             VALUES ($1, $2, 'Gift box', NULL, 0, 500, 0, 5, true)`,
            [prod.rows[0].id, `CAT-${rand()}-GIFT`]
        );
        await assert.rejects(
            () => catalogue.setAdminProductRatePerKg({ actor: admin, productId: prod.rows[0].id, ratePerKg: 100 }),
            err => err.statusCode === 400
        );
    });

    test('11. The product list shows the image, family, starting price and can be filtered by category', async () => {
        const admin = await createAdmin();
        await catalogue.updateAdminProduct({
            actor: admin,
            productId,
            input: { name: 'Catalogue Test Almond Deluxe', shortDescription: '', description: '', isActive: true, isFeatured: false, imageUrl: 'assets/products/list.webp' },
        });
        const list = await modules.listProducts({ actor: admin, category: categorySlug, limit: 50 });
        assert.ok(list.products.length >= 1);
        assert.ok(list.products.every(p => p.categorySlug === categorySlug));
        const mine = list.products.find(p => p.id === productId);
        assert.equal(mine.imageUrl, 'assets/products/list.webp');
        assert.equal(typeof mine.fromPrice, 'number');
        assert.equal(mine.variantCount, 2);

        const none = await modules.listProducts({ actor: admin, category: 'category-that-does-not-exist', limit: 50 });
        assert.equal(none.products.length, 0);
    });
});
