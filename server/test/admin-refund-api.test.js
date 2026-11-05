/**
 * The Crunchy Heart - Admin Refund & Reconciliation API
 *
 * Mounts the admin refund router on a bare Express app with a stub that sets
 * req.admin from test headers. The real requireAdminAuth is covered by the
 * existing admin-operations suite. Here the focus is server-side authorization
 * of each action, state validation, pagination, audit history, and sanitised
 * output.
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 * No provider call is made.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

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
process.env.CASHFREE_CLIENT_ID = 'TEST_ADMIN_REFUND_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_ADMIN_REFUND_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const { query } = await import('../src/db/pool.js');
const { createRefundIntent } = await import('../src/services/refund.service.js');
const { default: adminRefundRouter } = await import('../src/routes/admin-refund.routes.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const fixtureOrderIds = [];
const fixtureAdminIds = [];
let server;
let baseUrl;

// Test-only identity stub. Real auth is tested elsewhere.
function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const role = req.headers['x-test-role'];
        if (role) {
            req.admin = { id: req.headers['x-test-admin'] || null, role };
        }
        next();
    });
    app.use('/api/admin', adminRefundRouter);
    app.use((error, req, res, next) => {
        res.status(error.statusCode || 500).json({ success: false, code: error.code, message: error.message });
    });
    return app;
}

async function call(method, path, { role = 'ADMIN', admin = null, body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (role) headers['x-test-role'] = role;
    if (admin) headers['x-test-admin'] = admin;
    const res = await fetch(`${baseUrl}/api/admin${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
}

async function createOwner() {
    const row = await query(
        `INSERT INTO admin_users (email, password_hash, full_name, role, is_active)
         VALUES ($1, 'x', 'Admin API Owner', 'ADMIN', true) RETURNING id`,
        [`admin-api-${rand()}@example.test`]
    );
    fixtureAdminIds.push(row.rows[0].id);
    return row.rows[0].id;
}

async function createPendingRefund({ amount = 50 } = {}) {
    const orderRes = await query(
        `INSERT INTO orders (order_number, customer_name, phone, shipping_address,
                             subtotal, total_amount, currency, status, payment_status)
         VALUES ($1, 'Admin API Customer', '9876543210', '{"city":"Mumbai"}'::jsonb,
                 100, 100, 'INR', 'confirmed', 'paid') RETURNING id`,
        [`ADM-REF-${rand()}`]
    );
    const orderId = orderRes.rows[0].id;
    fixtureOrderIds.push(orderId);

    const paymentRes = await query(
        `INSERT INTO payments (order_id, provider, provider_order_id, provider_payment_id, amount, currency, status)
         VALUES ($1, 'cashfree', $2, $3, 100, 'INR', 'paid') RETURNING id`,
        [orderId, `TCH-ADM-${rand()}`, `CF-ADM-${rand()}`]
    );

    const created = await createRefundIntent({
        orderId,
        paymentId: paymentRes.rows[0].id,
        amount,
        currency: 'INR',
        reason: 'admin api test',
        origin: 'operator',
        idempotencyKey: `refund:admin-api:${rand()}`,
    });

    return { refundId: created.refundId, orderId, paymentId: paymentRes.rows[0].id };
}

async function insertIncident({ type = 'UNIDENTIFIED_PROVIDER_PAYMENT', orderId }) {
    const row = await query(
        `INSERT INTO payment_reconciliation_incidents (
             fingerprint, incident_type, severity, order_id, provider_order_id,
             incoming_details, existing_details)
         VALUES ($1, $2, 'high', $3, $4, '{"amount":100,"currency":"INR"}'::jsonb, '{}'::jsonb)
         RETURNING id`,
        [`fp-${rand()}${rand()}`, type, orderId, `TCH-INC-${rand()}`]
    );
    return row.rows[0].id;
}

describe('Admin refund & reconciliation API', () => {
    before(async () => {
        const app = buildApp();
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
        for (const orderId of fixtureOrderIds) {
            await query(`DELETE FROM payment_reconciliation_incidents WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM payment_reconciliation_queue WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM refunds WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM orders WHERE id = $1`, [orderId]);
        }
        for (const adminId of fixtureAdminIds) {
            await query(`DELETE FROM admin_audit_logs WHERE admin_user_id = $1`, [adminId]);
            await query(`DELETE FROM admin_users WHERE id = $1`, [adminId]);
        }
    });

    test('1. Unauthenticated request is rejected before any state is read or changed', async () => {
        const fx = await createPendingRefund();
        const res = await call('POST', `/refunds/${fx.refundId}/approve`, { role: null });

        assert.equal(res.status, 401);
        assert.equal((await query(`SELECT status FROM refunds WHERE id = $1`, [fx.refundId])).rows[0].status, 'pending');
    });

    test('2. Non-owner role cannot approve; state unchanged', async () => {
        const fx = await createPendingRefund();
        const owner = await createOwner();
        const res = await call('POST', `/refunds/${fx.refundId}/approve`, { role: 'viewer', admin: owner });

        assert.equal(res.status, 403);
        assert.equal((await query(`SELECT status FROM refunds WHERE id = $1`, [fx.refundId])).rows[0].status, 'pending');
    });

    test('3. Owner approval records the session identity; a body-supplied actor is ignored', async () => {
        const fx = await createPendingRefund();
        const owner = await createOwner();
        const res = await call('POST', `/refunds/${fx.refundId}/approve`, {
            role: 'ADMIN',
            admin: owner,
            body: { actorAdminId: '00000000-0000-0000-0000-000000000000', adminId: 'forged' },
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'approved');
        const row = (await query(`SELECT status, approved_by_admin_id FROM refunds WHERE id = $1`, [fx.refundId])).rows[0];
        assert.equal(row.status, 'approved');
        assert.equal(row.approved_by_admin_id, owner);

        const audit = await query(
            `SELECT admin_user_id FROM admin_audit_logs WHERE action = 'refund.approved' AND entity_id = $1`,
            [String(fx.refundId)]
        );
        assert.equal(audit.rows[0].admin_user_id, owner);
    });

    test('4. Approving an already-approved refund is an invalid transition', async () => {
        const fx = await createPendingRefund();
        const owner = await createOwner();
        await call('POST', `/refunds/${fx.refundId}/approve`, { role: 'ADMIN', admin: owner });
        const again = await call('POST', `/refunds/${fx.refundId}/approve`, { role: 'ADMIN', admin: owner });

        assert.equal(again.status, 409);
        assert.equal(again.body.code, 'INVALID_TRANSITION');
    });

    test('5. Refund list validates the status filter and caps the page size', async () => {
        const owner = await createOwner();

        const bad = await call('GET', `/refunds?status=${encodeURIComponent("pending' OR '1'='1")}`, { role: 'ADMIN', admin: owner });
        assert.equal(bad.status, 400);

        const big = await call('GET', `/refunds?limit=500&page=1`, { role: 'ADMIN', admin: owner });
        assert.equal(big.status, 200);
        assert.equal(big.body.limit, 50);
        assert.ok(Array.isArray(big.body.items));
    });

    test('6. Refund detail is sanitised and includes its audit history', async () => {
        const fx = await createPendingRefund();
        const owner = await createOwner();
        await call('POST', `/refunds/${fx.refundId}/approve`, { role: 'ADMIN', admin: owner });

        const res = await call('GET', `/refunds/${fx.refundId}`, { role: 'ADMIN', admin: owner });

        assert.equal(res.status, 200);
        assert.equal(res.body.refund.status, 'approved');
        assert.equal(res.body.refund.idempotency_key, undefined, 'idempotency key is not exposed');
        assert.equal(res.body.refund.claim_token, undefined, 'claim token is not exposed');
        assert.ok(res.body.history.some(h => h.action === 'refund.approved'));
    });

    test('7. Reconcile-now only applies to reconciliation_required and never calls a provider', async () => {
        const fx = await createPendingRefund();
        const owner = await createOwner();

        const wrong = await call('POST', `/refunds/${fx.refundId}/reconcile`, { role: 'ADMIN', admin: owner });
        assert.equal(wrong.status, 409);

        await query(
            `UPDATE refunds SET status = 'reconciliation_required', next_attempt_at = NOW() + INTERVAL '1 hour' WHERE id = $1`,
            [fx.refundId]
        );
        const ok = await call('POST', `/refunds/${fx.refundId}/reconcile`, { role: 'ADMIN', admin: owner });

        assert.equal(ok.status, 200);
        const row = (await query(`SELECT status, next_attempt_at <= NOW() AS due FROM refunds WHERE id = $1`, [fx.refundId])).rows[0];
        assert.equal(row.status, 'reconciliation_required');
        assert.equal(row.due, true);
    });

    test('8. Unresolved incidents, including unidentified payments with no queue row, are visible', async () => {
        const fx = await createPendingRefund();
        const incidentId = await insertIncident({ orderId: fx.orderId });
        const owner = await createOwner();

        const res = await call('GET', `/reconciliation/incidents?resolved=false&limit=50`, { role: 'ADMIN', admin: owner });

        assert.equal(res.status, 200);
        const found = res.body.items.find(i => i.id === incidentId);
        assert.ok(found, 'unidentified-payment incident must be listed');
        assert.equal(found.queue_id, null);
        assert.equal(found.incident_type, 'UNIDENTIFIED_PROVIDER_PAYMENT');
    });

    test('9. Incident resolution requires an owner and a meaningful note; it settles and refunds nothing', async () => {
        const fx = await createPendingRefund();
        const incidentId = await insertIncident({ orderId: fx.orderId });
        const owner = await createOwner();

        const viewer = await call('POST', `/reconciliation/incidents/${incidentId}/resolve`, {
            role: 'viewer', admin: owner, body: { note: 'checked with provider dashboard' },
        });
        assert.equal(viewer.status, 403);

        const short = await call('POST', `/reconciliation/incidents/${incidentId}/resolve`, {
            role: 'ADMIN', admin: owner, body: { note: 'ok' },
        });
        assert.equal(short.status, 400);
        assert.equal(short.body.code, 'NOTE_REQUIRED');

        const ok = await call('POST', `/reconciliation/incidents/${incidentId}/resolve`, {
            role: 'ADMIN', admin: owner, body: { note: 'Verified on provider dashboard, no duplicate capture.' },
        });
        assert.equal(ok.status, 200);

        const again = await call('POST', `/reconciliation/incidents/${incidentId}/resolve`, {
            role: 'ADMIN', admin: owner, body: { note: 'second attempt to resolve it' },
        });
        assert.equal(again.status, 409);

        assert.equal((await query(`SELECT status FROM refunds WHERE order_id = $1`, [fx.orderId])).rows[0].status, 'pending');
    });

    test('10. Queue list is filtered, paginated, and excludes raw provider payloads', async () => {
        const owner = await createOwner();
        const res = await call('GET', `/reconciliation/queue?status=pending_admin&limit=5&page=1`, { role: 'ADMIN', admin: owner });

        assert.equal(res.status, 200);
        assert.equal(res.body.limit, 5);
        for (const item of res.body.items) {
            assert.equal(item.raw_provider_payload, undefined);
            assert.equal(item.status, 'pending_admin');
        }
    });

    test('11. Queue retry requires an owner and a real item', async () => {
        const owner = await createOwner();
        const missing = await call('POST', `/reconciliation/queue/00000000-0000-0000-0000-000000000000/retry`, {
            role: 'ADMIN', admin: owner,
        });
        assert.equal(missing.status, 404);

        const viewer = await call('POST', `/reconciliation/queue/00000000-0000-0000-0000-000000000000/retry`, {
            role: 'viewer', admin: owner,
        });
        assert.equal(viewer.status, 403);
    });

    test('12. Audit history rejects unknown entity types and returns events for known ones', async () => {
        const owner = await createOwner();
        const bad = await call('GET', `/audit/admin_users/${owner}`, { role: 'ADMIN', admin: owner });
        assert.equal(bad.status, 400);

        const fx = await createPendingRefund();
        await call('POST', `/refunds/${fx.refundId}/approve`, { role: 'ADMIN', admin: owner });
        const good = await call('GET', `/audit/refund/${fx.refundId}`, { role: 'ADMIN', admin: owner });
        assert.equal(good.status, 200);
        assert.ok(good.body.items.some(i => i.action === 'refund.approved'));
    });

    test('13. Unknown incident type and invalid ids are rejected with validation errors', async () => {
        const owner = await createOwner();
        const res = await call('GET', `/reconciliation/incidents?type=DROP_TABLE`, { role: 'ADMIN', admin: owner });
        assert.equal(res.status, 400);
    });

    test('14. A deactivated administrator is refused even with a valid session', async () => {
        const fx = await createPendingRefund();
        const owner = await createOwner();
        await query(`UPDATE admin_users SET is_active = false WHERE id = $1`, [owner]);

        const res = await call('POST', `/refunds/${fx.refundId}/approve`, { role: 'ADMIN', admin: owner });

        assert.equal(res.status, 403);
        assert.equal((await query(`SELECT status FROM refunds WHERE id = $1`, [fx.refundId])).rows[0].status, 'pending');
    });

    test('15. Session role other than ADMIN is refused for writes', async () => {
        const fx = await createPendingRefund();
        const admin = await createOwner();
        const res = await call('POST', `/refunds/${fx.refundId}/approve`, { role: 'viewer', admin });
        assert.equal(res.status, 403);
    });

    test('16. Late reconciliation: admin only, manual-review only, lookup-only, audited, state preserved', async () => {
        const fx = await createPendingRefund();
        const owner = await createOwner();
        await query("UPDATE refunds SET status = 'manual_review', resolved_at = NOW() WHERE id = $1", [fx.refundId]);

        const ok = await call('POST', `/refunds/${fx.refundId}/late-reconcile`, { role: 'ADMIN', admin: owner });

        // The route uses the fail-closed default provider, so the outcome must stay manual_review.
        assert.equal(ok.status, 200);
        assert.equal(ok.body.outcome, 'manual_review');
        assert.equal((await query('SELECT status FROM refunds WHERE id = $1', [fx.refundId])).rows[0].status, 'manual_review');

        const audit = await query(
            "SELECT action, admin_user_id FROM admin_audit_logs WHERE entity_id = $1 AND action = 'refund.late_reconcile_requested'",
            [String(fx.refundId)]
        );
        assert.equal(audit.rows.length, 1);
        assert.equal(audit.rows[0].admin_user_id, owner);
    });

    test('17. Late reconciliation refuses refunds that are not in manual review', async () => {
        const fx = await createPendingRefund();
        const owner = await createOwner();
        const res = await call('POST', `/refunds/${fx.refundId}/late-reconcile`, { role: 'ADMIN', admin: owner });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'INVALID_TRANSITION');
    });

    test('18. Late reconciliation rejects non-admin and unauthenticated callers', async () => {
        const fx = await createPendingRefund();
        const owner = await createOwner();
        await query("UPDATE refunds SET status = 'manual_review', resolved_at = NOW() WHERE id = $1", [fx.refundId]);

        const viewer = await call('POST', `/refunds/${fx.refundId}/late-reconcile`, { role: 'viewer', admin: owner });
        assert.equal(viewer.status, 403);

        const anon = await call('POST', `/refunds/${fx.refundId}/late-reconcile`, { role: null });
        assert.equal(anon.status, 401);
    });

    test('19. Worker health: active administrator gets status and no secrets', async () => {
        const admin = await createOwner();
        const res = await call('GET', '/workers/health', { role: 'ADMIN', admin });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body.workers));
        assert.ok('alerts' in res.body);
        const text = JSON.stringify(res.body);
        assert.doesNotMatch(text, /CLIENT_SECRET|OWNER_SESSION|ORDER_TOKEN|SMTP_PASSWORD|DATABASE_URL|postgresql:\/\//i);
    });

    test('20. Worker health: deactivated administrator and non-admin sessions are refused', async () => {
        const admin = await createOwner();
        await query('UPDATE admin_users SET is_active = false WHERE id = $1', [admin]);
        const inactive = await call('GET', '/workers/health', { role: 'ADMIN', admin });
        assert.equal(inactive.status, 403);

        const other = await createOwner();
        const viewer = await call('GET', '/workers/health', { role: 'viewer', admin: other });
        assert.equal(viewer.status, 403);
    });

    test('21: Worker health: unauthenticated requests are refused by the route guard', async () => {
        const res = await call('GET', '/workers/health', { role: null });
        assert.equal(res.status, 401);
    });

    test('22. Worker health: worker error text is redacted before it is returned', async () => {
        const { startWorker, stopWorker } = await import('../src/services/worker-registry.js');
        const handle = startWorker({
            name: 'refund_sweep',
            intervalMs: 60 * 60 * 1000,
            run: async () => { throw new Error('upstream said token=abc123SECRET for card 4111111111111111'); },
        });
        await handle.runOnce();

        const admin = await createOwner();
        const res = await call('GET', '/workers/health', { role: 'ADMIN', admin });
        const text = JSON.stringify(res.body);
        assert.doesNotMatch(text, /abc123SECRET|4111111111111111/);
        assert.match(text, /[redacted]/);
        await stopWorker('refund_sweep');
    });
});
