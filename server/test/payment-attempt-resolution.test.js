/**
 * The Crunchy Heart - Operator resolution of unresolved payment attempts
 *
 * Covers the three operator actions (lookup, verified reconcile, attested close) and the review
 * list. Checks state transitions, audit records, the refusal of non-administrators, and exact
 * provider call counts. The Cashfree API is mocked at the fetch boundary. No live endpoint is
 * reachable, and no provider order is ever created.
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
process.env.CASHFREE_CLIENT_ID = 'TEST_RESOLUTION_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_RESOLUTION_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'TEST_RESOLUTION_ORDER_TOKEN_SECRET_0123456789abcdef';
process.env.OWNER_SESSION_SECRET = 'TEST_RESOLUTION_OWNER_SESSION_SECRET_0123456789ab';
process.env.RECOVERY_CODE_SECRET = 'TEST_RESOLUTION_RECOVERY_CODE_SECRET_0123456789abcdef';

const { query, pool } = await import('../src/db/pool.js');
const { createOrder } = await import('../src/services/order.service.js');
const {
    listAttemptsForReview,
    resolveAttemptByLookup,
    reconcileAttempt,
    closeAttemptNotSubmitted,
    listOrderPaymentStates,
    ABSENCE_CONFIRMATION,
} = await import('../src/services/payment-attempt-admin.service.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const originalFetch = globalThis.fetch;

// Provider mock: behaviour per merchant order_id. Counts every call. Never creates an order.
const provider = { plans: new Map(), sessions: new Map(), posts: 0, gets: [] };
const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('cashfree.com')) return originalFetch(url, options);
    const method = (options.method || 'GET').toUpperCase();

    if (method === 'POST' && u.endsWith('/pg/orders')) {
        provider.posts += 1;
        return json({ message: 'resolution tests must not create provider orders' }, 500);
    }
    if (method === 'GET' && /\/pg\/orders\/[^/]+$/.test(u)) {
        const orderId = decodeURIComponent(u.split('/pg/orders/')[1]);
        provider.gets.push(orderId);
        const plan = provider.plans.get(orderId) || 'session';
        if (plan === 'notfound') return json({ message: 'Resource Not found' }, 404);
        if (plan === 'error500') return json({ message: 'internal' }, 500);
        if (plan === 'mismatch') return json({ order_id: 'someone-else', order_status: 'ACTIVE', payment_session_id: 'sess_x' });
        if (plan === 'nosession') return json({ order_id: orderId, order_status: 'ACTIVE' });
        if (plan === 'paid') return json({ order_id: orderId, order_status: 'PAID', payment_session_id: 'sess_paid' });
        return json({
            order_id: orderId,
            cf_order_id: 8100001,
            order_status: 'ACTIVE',
            payment_session_id: provider.sessions.get(orderId) || `sess_resolved_${orderId}`,
            order_expiry_time: new Date(Date.now() + 3600e3).toISOString(),
        });
    }
    return json({}, 404);
};

const createdOrderIds = [];
const fixtureAdminIds = [];
let testProductId;

async function createAdmin({ active = true, role = 'ADMIN' } = {}) {
    const row = await query(
        `INSERT INTO admin_users (email, password_hash, full_name, role, is_active)
         VALUES ($1, 'x', 'Resolution Test Admin', $2, $3) RETURNING id, role`,
        [`resolution-${rand().toLowerCase()}@example.test`, role, active]
    );
    fixtureAdminIds.push(row.rows[0].id);
    return { id: row.rows[0].id, role: row.rows[0].role };
}

async function createVariant() {
    const v = await query(
        `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, flavor,
                                       mrp, selling_price, cost_price, tax_rate, is_active)
         VALUES ($1, $2, 'Resolution Test', 100, 'Salt', 200, 100, 50, 18, true) RETURNING id`,
        [testProductId, `RES-${rand()}`]
    );
    await query(`INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, 500, 0, 5)`, [v.rows[0].id]);
    return v.rows[0].id;
}

async function onlineOrder() {
    const name = `Resolution ${rand()}`;
    const created = await createOrder({
        customer: { name, phone: '9876543210', email: `resolution-${rand().toLowerCase()}@example.test` },
        shippingAddress: { name, phone: '9876543210', addressLine1: '1 Resolution Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', country: 'India' },
        items: [{ variantId: await createVariant(), quantity: 1 }],
        paymentMethod: 'ONLINE',
        idempotencyKey: `res-${rand()}-${Date.now()}`,
    });
    createdOrderIds.push(created.order.id);
    return (await query(`SELECT * FROM orders WHERE id = $1`, [created.order.id])).rows[0];
}

async function clearRows(orderId) {
    await query(`DELETE FROM payments WHERE order_id = $1`, [orderId]);
}

async function insertRow(orderId, orderNumber, { gateway, providerOrderId = `${orderNumber}-T${rand()}`, session = null, status = 'created' }) {
    const raw = session ? JSON.stringify({ payment_session_id: session }) : null;
    const result = await query(
        `INSERT INTO payments (order_id, provider, provider_order_id, amount, currency, status, gateway_status,
                               payment_method, raw_response, created_at, updated_at)
         VALUES ($1, 'cashfree', $2, 100, 'INR', $3, $4, 'ONLINE', $5::jsonb, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes')
         RETURNING id, provider_order_id`,
        [orderId, providerOrderId, status, gateway, raw]
    );
    return result.rows[0];
}

async function rowOf(paymentId) {
    return (await query(`SELECT * FROM payments WHERE id = $1`, [paymentId])).rows[0];
}

async function auditFor(paymentId) {
    return (await query(
        `SELECT action, admin_user_id, details FROM admin_audit_logs WHERE entity_type = 'payment_attempt' AND entity_id = $1 ORDER BY created_at`,
        [String(paymentId)]
    )).rows;
}

const note = 'Checked the provider dashboard: the order number does not appear.';

describe('Operator resolution of unresolved payment attempts', () => {
    before(async () => {
        const cat = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Resolution Category', 'resolution-cat-' || gen_random_uuid(), 'Resolution', true) RETURNING id`
        );
        const prod = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Resolution Product', 'resolution-prod-' || gen_random_uuid(), 'The Crunchy Heart', true) RETURNING id`,
            [cat.rows[0].id]
        );
        testProductId = prod.rows[0].id;
    });

    after(async () => {
        globalThis.fetch = originalFetch;
        for (const id of createdOrderIds) {
            await query(`DELETE FROM inventory_transactions WHERE reference_id = $1`, [id]);
            await query(`DELETE FROM payments WHERE order_id = $1`, [id]);
            await query(`DELETE FROM order_items WHERE order_id = $1`, [id]);
            await query(`DELETE FROM orders WHERE id = $1`, [id]);
        }
        for (const id of fixtureAdminIds) {
            await query(`DELETE FROM admin_audit_logs WHERE admin_user_id = $1`, [id]);
            await query(`DELETE FROM admin_users WHERE id = $1`, [id]);
        }
        await pool.end().catch(() => {});
    });

    test('1. Only an active ADMIN may act; a non-administrator changes nothing', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });

        const inactive = await createAdmin({ active: false });
        await assert.rejects(() => resolveAttemptByLookup({ actor: inactive, paymentId: row.id }), err => err.code === 'FORBIDDEN');
        const customer = await createAdmin({ role: 'CUSTOMER' });
        await assert.rejects(() => reconcileAttempt({ actor: customer, paymentId: row.id }), err => err.code === 'FORBIDDEN');
        await assert.rejects(() => listAttemptsForReview({ actor: { id: null } }), err => err.code === 'AUTH_REQUIRED');

        assert.equal((await rowOf(row.id)).gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
        assert.equal(provider.posts, 0);
    });

    test('2. The review list shows identifiers and statuses only, never sessions or raw payloads', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        const admin = await createAdmin();

        const review = await listAttemptsForReview({ actor: admin, limit: 200 });
        const serialized = JSON.stringify(review);
        assert.ok(review.attempts.some(a => a.orderNumber === order.order_number));
        assert.doesNotMatch(serialized, /sess_/);
        assert.doesNotMatch(serialized, /raw_response|payment_session_id/);
    });

    test('3. Lookup returns 404: inconclusive, the state is unchanged, and the audit records it', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        provider.plans.set(row.provider_order_id, 'notfound');
        const admin = await createAdmin();

        const result = await resolveAttemptByLookup({ actor: admin, paymentId: row.id });
        assert.equal(result.outcome, 'INCONCLUSIVE');
        assert.equal(result.reason, 'PROVIDER_ORDER_NOT_FOUND');
        assert.equal(result.changed, false);
        assert.equal((await rowOf(row.id)).gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
        assert.equal((await auditFor(row.id)).at(-1).action, 'payment_attempt.lookup_inconclusive');
        assert.equal(provider.posts, 0, 'an inconclusive lookup never creates an order');
    });

    test('4. Lookup finds the same order with a session: the session is attached and audited', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        provider.plans.set(row.provider_order_id, 'session');
        const admin = await createAdmin();

        const result = await resolveAttemptByLookup({ actor: admin, paymentId: row.id });
        assert.equal(result.outcome, 'ORDER_CREATED');
        assert.equal(result.changed, true);
        const after = await rowOf(row.id);
        assert.equal(after.gateway_status, 'ORDER_CREATED');
        assert.equal(after.raw_response.payment_session_id, `sess_resolved_${row.provider_order_id}`);
        const audit = await auditFor(row.id);
        assert.equal(audit.at(-1).action, 'payment_attempt.resolved_by_lookup');
        assert.equal(audit.at(-1).admin_user_id, admin.id);
    });

    test('5. A lookup that returns a different order is refused as a mismatch and changes nothing', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        provider.plans.set(row.provider_order_id, 'mismatch');
        const admin = await createAdmin();

        const result = await resolveAttemptByLookup({ actor: admin, paymentId: row.id });
        assert.equal(result.reason, 'LOOKUP_MISMATCH');
        assert.equal((await rowOf(row.id)).gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
    });

    test('6. A lookup with no payment session is not resumable and changes nothing', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        provider.plans.set(row.provider_order_id, 'nosession');
        const admin = await createAdmin();

        const result = await resolveAttemptByLookup({ actor: admin, paymentId: row.id });
        assert.equal(result.reason, 'NO_RESUMABLE_SESSION');
        assert.equal((await rowOf(row.id)).gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
    });

    test('7. A provider report of PAID is passed to reconciliation; the lookup never marks payment', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        provider.plans.set(row.provider_order_id, 'paid');
        const admin = await createAdmin();

        const result = await resolveAttemptByLookup({ actor: admin, paymentId: row.id });
        assert.equal(result.outcome, 'RUN_RECONCILE');
        const after = await rowOf(row.id);
        assert.equal(after.status, 'created', 'the lookup never records a payment');
        assert.equal(after.gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
    });

    test('8. A legacy CASHFREE_PENDING row with no provider id is resolved by the order number, never by creating', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'CASHFREE_PENDING', providerOrderId: null });
        await query(`UPDATE payments SET provider_order_id = NULL WHERE id = $1`, [row.id]);
        provider.plans.set(order.order_number, 'session');
        const admin = await createAdmin();

        const result = await resolveAttemptByLookup({ actor: admin, paymentId: row.id });
        assert.equal(result.outcome, 'ORDER_CREATED');
        const after = await rowOf(row.id);
        assert.equal(after.provider_order_id, order.order_number);
        assert.equal(after.gateway_status, 'ORDER_CREATED');
        assert.equal(provider.posts, 0);
    });

    test('9. A row already in ORDER_CREATED cannot be resolved by lookup', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'ORDER_CREATED', session: 'sess_live' });
        const admin = await createAdmin();

        await assert.rejects(() => resolveAttemptByLookup({ actor: admin, paymentId: row.id }), err => err.code === 'INVALID_TRANSITION');
    });

    test('10. Two lookups at once: exactly one changes the attempt', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        provider.plans.set(row.provider_order_id, 'session');
        const admin = await createAdmin();

        const results = await Promise.allSettled([
            resolveAttemptByLookup({ actor: admin, paymentId: row.id }),
            resolveAttemptByLookup({ actor: admin, paymentId: row.id }),
        ]);
        const changed = results.filter(r => r.status === 'fulfilled' && r.value.changed).length;
        assert.equal(changed, 1, 'only one lookup may change the attempt');
        assert.equal((await rowOf(row.id)).gateway_status, 'ORDER_CREATED');
        assert.equal(provider.posts, 0);
    });

    test('11. Reconcile delegates to the verified path and is audited', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        provider.plans.set(row.provider_order_id, 'notfound');
        const admin = await createAdmin();

        const result = await reconcileAttempt({ actor: admin, paymentId: row.id });
        assert.equal(result.reconciled, false, 'a 404 is inconclusive in reconciliation too');
        assert.equal((await auditFor(row.id)).at(-1).action, 'payment_attempt.reconciled');
        assert.equal((await rowOf(row.id)).status, 'created', 'reconciliation did not mark payment');
    });

    test('12. Close requires the exact attestation and a substantive note', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        provider.plans.set(row.provider_order_id, 'notfound');
        const admin = await createAdmin();

        await assert.rejects(() => closeAttemptNotSubmitted({ actor: admin, paymentId: row.id, confirmation: 'yes', note }), err => err.code === 'CONFIRMATION_REQUIRED');
        await assert.rejects(() => closeAttemptNotSubmitted({ actor: admin, paymentId: row.id, confirmation: ABSENCE_CONFIRMATION, note: 'short' }), err => err.code === 'NOTE_REQUIRED');
        assert.equal((await rowOf(row.id)).gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
    });

    test('13. Close is refused while the provider holds the order, and after an inconclusive lookup', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        const admin = await createAdmin();

        provider.plans.set(row.provider_order_id, 'session');
        await assert.rejects(() => closeAttemptNotSubmitted({ actor: admin, paymentId: row.id, confirmation: ABSENCE_CONFIRMATION, note }), err => err.code === 'PROVIDER_ORDER_EXISTS');

        provider.plans.set(row.provider_order_id, 'error500');
        await assert.rejects(() => closeAttemptNotSubmitted({ actor: admin, paymentId: row.id, confirmation: ABSENCE_CONFIRMATION, note }), err => err.code === 'LOOKUP_INCONCLUSIVE');

        assert.equal((await rowOf(row.id)).gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');
    });

    test('14. Close with a fresh 404 and the attestation closes the attempt, and the audit keeps the note', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        provider.plans.set(row.provider_order_id, 'notfound');
        const admin = await createAdmin();

        const result = await closeAttemptNotSubmitted({ actor: admin, paymentId: row.id, confirmation: ABSENCE_CONFIRMATION, note });
        assert.equal(result.outcome, 'CREATE_NOT_SUBMITTED');
        const after = await rowOf(row.id);
        assert.equal(after.gateway_status, 'CREATE_NOT_SUBMITTED');
        assert.equal(after.status, 'failed');
        const audit = (await auditFor(row.id)).at(-1);
        assert.equal(audit.action, 'payment_attempt.closed_not_submitted');
        assert.equal(audit.details.attestation, ABSENCE_CONFIRMATION);
        assert.equal(audit.details.note, note);
        assert.equal(provider.posts, 0);
    });

    test('15. A closed attempt is no longer unresolved, so it is absent from the review list', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        const row = await insertRow(order.id, order.order_number, { gateway: 'CREATE_NOT_SUBMITTED', status: 'failed' });
        const admin = await createAdmin();

        const review = await listAttemptsForReview({ actor: admin, limit: 200 });
        assert.equal(review.attempts.some(a => a.paymentId === row.id), false);
    });

    test('16. The payment-state overview shows the authoritative state of each order, filters by it, and exposes no sessions', async () => {
        const order = await onlineOrder();
        await clearRows(order.id);
        await insertRow(order.id, order.order_number, { gateway: 'GATEWAY_AMBIGUOUS_TIMEOUT' });
        await insertRow(order.id, order.order_number, { gateway: 'CREATION_REJECTED' });
        const admin = await createAdmin();

        const all = await listOrderPaymentStates({ actor: admin, limit: 200 });
        const mine = all.orders.find(o => o.orderNumber === order.order_number);
        assert.ok(mine, 'the order appears in the overview');
        assert.equal(mine.paymentState, 'UNRESOLVED');

        const unresolved = await listOrderPaymentStates({ actor: admin, state: 'UNRESOLVED', limit: 200 });
        assert.ok(unresolved.orders.some(o => o.orderNumber === order.order_number));
        assert.ok(unresolved.orders.every(o => o.paymentState === 'UNRESOLVED'));

        const serialized = JSON.stringify(all);
        assert.doesNotMatch(serialized, /payment_session_id|raw_response/);
        assert.equal(provider.posts, 0);
    });
});
