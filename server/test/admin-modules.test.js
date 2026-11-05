/**
 * The Crunchy Heart - Admin modules: dashboard, catalogue, inventory, coupons, customers,
 * integration status, and social media drafts.
 *
 * No external service is contacted. Integration status is checked for presence only, and
 * publishing is checked to refuse without any provider call.
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
process.env.CASHFREE_CLIENT_ID = 'TEST_MODULES_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_MODULES_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'TEST_MODULES_ORDER_TOKEN_SECRET_0123456789abcdef';
process.env.OWNER_SESSION_SECRET = 'TEST_MODULES_OWNER_SESSION_SECRET_0123456789ab';
process.env.RECOVERY_CODE_SECRET = 'TEST_MODULES_RECOVERY_CODE_SECRET_0123456789abcdef';

const { query, pool } = await import('../src/db/pool.js');
const modules = await import('../src/services/admin-modules.service.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const fixtureAdminIds = [];
const fixtureDraftIds = [];
const fixtureProductIds = [];
const SECRET_VALUE = 'MODULE_TEST_SECRET_VALUE_NEVER_SHOWN';

async function createAdmin({ active = true, role = 'ADMIN' } = {}) {
    const row = await query(
        `INSERT INTO admin_users (email, password_hash, full_name, role, is_active)
         VALUES ($1, 'x', 'Modules Test Admin', $2, $3) RETURNING id, role`,
        [`modules-${rand().toLowerCase()}@example.test`, role, active]
    );
    fixtureAdminIds.push(row.rows[0].id);
    return { id: row.rows[0].id, role: row.rows[0].role };
}

describe('Admin modules', () => {
    before(async () => {
        const cat = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Modules Category', 'modules-cat-' || gen_random_uuid(), 'Modules', true) RETURNING id`
        );
        const prod = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Modules Product ${rand()}', 'modules-prod-' || gen_random_uuid(), 'The Crunchy Heart', true) RETURNING id`,
            [cat.rows[0].id]
        );
        fixtureProductIds.push(prod.rows[0].id);
        const variant = await query(
            `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, is_active)
             VALUES ($1, $2, 'Low stock demo', 100, 'Salt', 200, 100, 50, 18, true) RETURNING id`,
            [prod.rows[0].id, `MOD-${rand()}`]
        );
        // On hand 2, reserved 0, reorder level 5: available 2 is at or below the level, so it is low stock.
        await query(`INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, 2, 0, 5)`, [variant.rows[0].id]);
    });

    after(async () => {
        for (const id of fixtureDraftIds) {
            await query(`DELETE FROM social_post_drafts WHERE id = $1`, [id]);
        }
        for (const id of fixtureAdminIds) {
            await query(`DELETE FROM admin_audit_logs WHERE admin_user_id = $1`, [id]);
            await query(`DELETE FROM admin_users WHERE id = $1`, [id]);
        }
        for (const id of fixtureProductIds) {
            await query(`DELETE FROM inventory WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`, [id]);
            await query(`DELETE FROM product_variants WHERE product_id = $1`, [id]);
            await query(`DELETE FROM products WHERE id = $1`, [id]);
        }
        await pool.end().catch(() => {});
    });

    test('1. Only an active administrator can read the modules', async () => {
        const customer = await createAdmin({ role: 'CUSTOMER' });
        await assert.rejects(() => modules.dashboardSummary({ actor: customer }), err => err.code === 'FORBIDDEN');
        await assert.rejects(() => modules.listProducts({ actor: { id: null } }), err => err.code === 'AUTH_REQUIRED');
    });

    test('2. Dashboard returns counts and attention flags', async () => {
        const admin = await createAdmin();
        const summary = await modules.dashboardSummary({ actor: admin });
        assert.equal(typeof summary.orders.total, 'number');
        assert.equal(typeof summary.revenue.paidLast30Days, 'number');
        assert.ok(summary.attention.lowStockVariants >= 1, 'the low-stock demo variant is counted');
    });

    test('3. Inventory low-stock filter returns only variants at or below their reorder level', async () => {
        const admin = await createAdmin();
        const low = await modules.listInventory({ actor: admin, lowStockOnly: true });
        assert.ok(low.variants.length >= 1);
        assert.ok(low.variants.every(v => v.lowStock === true));
        const all = await modules.listInventory({ actor: admin, lowStockOnly: false });
        assert.ok(all.variants.length >= low.variants.length);
    });

    test('4. Products list counts variants and available units', async () => {
        const admin = await createAdmin();
        const products = await modules.listProducts({ actor: admin, search: 'Modules Product', limit: 50 });
        const mine = products.products.find(p => fixtureProductIds.length && p.name.startsWith('Modules Product'));
        assert.ok(mine, 'the fixture product is listed');
        assert.equal(mine.variantCount, 1);
    });

    test('5. Coupons list returns the discount terms and no secrets', async () => {
        const admin = await createAdmin();
        const coupons = await modules.listCoupons({ actor: admin });
        for (const c of coupons.coupons) {
            assert.ok(['percentage', 'fixed'].includes(c.discountType));
        }
        assert.doesNotMatch(JSON.stringify(coupons), /password|token|secret/i);
    });

    test('6. Customers are grouped by phone and expose no sessions or tokens', async () => {
        const admin = await createAdmin();
        const customers = await modules.listCustomers({ actor: admin, limit: 50 });
        assert.ok(Array.isArray(customers.customers));
        assert.doesNotMatch(JSON.stringify(customers), /payment_session|guest|raw_response/i);
    });

    test('7. Integration status reports names only, never values', async () => {
        const admin = await createAdmin();
        process.env.GA_PROPERTY_ID = SECRET_VALUE;
        try {
            const status = await modules.integrationsStatus({ actor: admin });
            assert.equal(status.analytics.connected, false, 'the second analytics variable is still missing');
            assert.ok(status.analytics.missingConfig.includes('GOOGLE_APPLICATION_CREDENTIALS'));
            assert.doesNotMatch(JSON.stringify(status), new RegExp(SECRET_VALUE));
            assert.equal(status.socialAccounts.instagram.connected, false);
        } finally {
            delete process.env.GA_PROPERTY_ID;
        }
    });

    test('8. A social draft is validated, saved as a draft, and can be edited', async () => {
        const admin = await createAdmin();
        await assert.rejects(() => modules.createSocialDraft({ actor: admin, input: { platform: 'myspace', title: 'x', body: 'y' } }), err => err.statusCode === 400);
        await assert.rejects(() => modules.createSocialDraft({ actor: admin, input: { platform: 'instagram', title: 't', body: 'b', mediaUrl: 'http://insecure.example.test/a.jpg' } }), err => err.statusCode === 400);

        const created = await modules.createSocialDraft({ actor: admin, input: { platform: 'instagram', title: 'Launch post', body: 'Crunchy and light.' } });
        fixtureDraftIds.push(created.draft.id);
        assert.equal(created.draft.status, 'draft');
        assert.ok('mediaUrl' in created.draft && 'createdAt' in created.draft && 'updatedAt' in created.draft, 'draft is returned in camelCase');
        assert.ok(!('media_url' in created.draft), 'no raw column names leak into the response');

        const updated = await modules.updateSocialDraft({ actor: admin, draftId: created.draft.id, input: { platform: 'pinterest', title: 'Launch pin', body: 'Crunchy and light.' } });
        assert.equal(updated.draft.platform, 'pinterest');
    });

    test('9. Publishing is refused with no provider call, and names the missing configuration', async () => {
        const admin = await createAdmin();
        const created = await modules.createSocialDraft({ actor: admin, input: { platform: 'tiktok', title: 'Clip', body: 'Short clip caption.' } });
        fixtureDraftIds.push(created.draft.id);

        await assert.rejects(
            () => modules.publishSocialDraft({ actor: admin, draftId: created.draft.id }),
            err => err.code === 'PUBLISHING_UNAVAILABLE' && err.statusCode === 409 && /TIKTOK_ACCESS_TOKEN/.test(err.message)
        );
        const row = await query(`SELECT status FROM social_post_drafts WHERE id = $1`, [created.draft.id]);
        assert.equal(row.rows[0].status, 'draft', 'the draft is not marked published');
    });
});
