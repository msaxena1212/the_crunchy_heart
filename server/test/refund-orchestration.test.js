/**
 * The Crunchy Heart - Durable Refund Orchestration
 *
 * Verifies refund intent, idempotency, over-refund protection, claiming and
 * fencing, provider ambiguity handling, reconciliation, stock-shortage
 * integration, and sweep recovery.
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 * Every provider call is an injected mock. No Cashfree endpoint is contacted.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

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

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DATABASE_URL_UNPOOLED = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.CASHFREE_CLIENT_ID = 'TEST_REFUND_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_REFUND_CLIENT_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const { query } = await import('../src/db/pool.js');
const { markPaymentSuccess } = await import('../src/services/payment.service.js');
const {
    createRefundIntent,
    approveRefund,
    processRefund,
    reconcileRefund,
    expireStaleRefundClaims,
    runRefundSweep,
    reconcileManualReviewRefund,
} = await import('../src/services/refund.service.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();

const fixtureOrderIds = [];
const fixtureVariantIds = [];
const fixtureAdminIds = [];
let testProductId;

// Mock provider with call recording. Each behaviour is a function or value.
function mockProvider({ create = async (args) => ({ status: 'SUCCEEDED', providerRefundId: `RF-${args.refundKey}` }), lookup = async () => ({ found: false }) } = {}) {
    const calls = { create: [], lookup: [] };
    return {
        calls,
        async createRefund(args) {
            calls.create.push(args);
            return create(args);
        },
        async getRefund(args) {
            calls.lookup.push(args);
            return lookup(args);
        },
    };
}

// Creates an order with one settled payment (no inventory involved).
async function createPaidOrder({ amount = 100, currency = 'INR' } = {}) {
    const orderRes = await query(
        `INSERT INTO orders (order_number, customer_name, phone, shipping_address,
                             subtotal, total_amount, currency, status, payment_status)
         VALUES ($1, 'Refund Customer', '9876543210', '{"city":"Mumbai"}'::jsonb,
                 $2, $2, $3, 'confirmed', 'paid')
         RETURNING id`,
        [`REF-ORD-${rand()}`, amount, currency]
    );
    const orderId = orderRes.rows[0].id;
    fixtureOrderIds.push(orderId);

    const providerOrderId = `TCH-REF-${rand()}`;
    const providerPaymentId = `CF-REF-${rand()}`;
    const paymentRes = await query(
        `INSERT INTO payments (order_id, provider, provider_order_id, provider_payment_id,
                               amount, currency, status)
         VALUES ($1, 'cashfree', $2, $3, $4, $5, 'paid')
         RETURNING id`,
        [orderId, providerOrderId, providerPaymentId, amount, currency]
    );

    return { orderId, paymentId: paymentRes.rows[0].id, providerOrderId, providerPaymentId, amount, currency };
}

async function createAdmin() {
    const admin = await query(
        `INSERT INTO admin_users (email, password_hash, full_name, role, is_active)
         VALUES ($1, 'x', 'Refund Test Admin', 'owner', true) RETURNING id`,
        [`refund-admin-${rand()}@example.test`]
    );
    fixtureAdminIds.push(admin.rows[0].id);
    return admin.rows[0].id;
}

async function intent(fx, overrides = {}) {
    return createRefundIntent({
        orderId: fx.orderId,
        paymentId: fx.paymentId,
        amount: fx.amount,
        currency: fx.currency,
        reason: 'test refund',
        origin: 'operator',
        idempotencyKey: `refund:test:${rand()}`,
        ...overrides,
    });
}

async function refundRow(id) {
    return (await query(`SELECT * FROM refunds WHERE id = $1`, [id])).rows[0];
}

async function refundsFor(paymentId) {
    return (await query(`SELECT * FROM refunds WHERE payment_id = $1 ORDER BY created_at`, [paymentId])).rows;
}

async function approvedRefund(fx, amount = fx.amount) {
    const admin = await createAdmin();
    const created = await intent(fx, { amount });
    await approveRefund({ refundId: created.refundId, actorAdminId: admin });
    return created.refundId;
}

async function stockOf(variantId) {
    return (await query(`SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1`, [variantId])).rows[0];
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------
describe('Durable refund orchestration', () => {
    before(async () => {
        const catRes = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Refund Test Category', 'refund-cat-' || gen_random_uuid(), 'Refund', true)
             RETURNING id`
        );
        const prodRes = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Refund Test Product', 'refund-prod-' || gen_random_uuid(), 'The Crunchy Heart', true)
             RETURNING id`,
            [catRes.rows[0].id]
        );
        testProductId = prodRes.rows[0].id;
    });

    after(async () => {
        for (const orderId of fixtureOrderIds) {
            await query(`DELETE FROM payment_reconciliation_incidents WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM payment_reconciliation_queue WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM inventory_transactions WHERE reference_id = $1`, [orderId]);
            await query(`DELETE FROM refunds WHERE order_id = $1`, [orderId]);
            await query(`DELETE FROM orders WHERE id = $1`, [orderId]);
        }
        for (const variantId of fixtureVariantIds) {
            await query(`DELETE FROM inventory WHERE variant_id = $1`, [variantId]);
            await query(`DELETE FROM product_variants WHERE id = $1`, [variantId]);
        }
        for (const adminId of fixtureAdminIds) {
            await query(`DELETE FROM admin_users WHERE id = $1`, [adminId]);
        }
        if (testProductId) {
            await query(`DELETE FROM products WHERE id = $1`, [testProductId]);
        }
    });

    // ---- Intent and idempotency ----

    test('1. Creating a refund intent persists a pending row with stable identity', async () => {
        const fx = await createPaidOrder();
        const key = `refund:create:${rand()}`;
        const created = await intent(fx, { idempotencyKey: key });

        assert.equal(created.result, 'created');
        const row = await refundRow(created.refundId);
        assert.equal(row.status, 'pending');
        assert.equal(row.idempotency_key, key);
        assert.equal(row.currency, 'INR');
        assert.equal(row.origin, 'operator');
        assert.equal(Number(row.amount), fx.amount);
        assert.equal(row.provider_refund_id, null);
    });

    test('2. Identical repeat request returns the existing intent; no second row', async () => {
        const fx = await createPaidOrder();
        const key = `refund:dup:${rand()}`;
        const first = await intent(fx, { idempotencyKey: key });
        const second = await intent(fx, { idempotencyKey: key });

        assert.equal(second.result, 'duplicate');
        assert.equal(second.refundId, first.refundId);
        assert.equal((await refundsFor(fx.paymentId)).length, 1);
    });

    test('3. Reused key with different details is rejected and the original is untouched', async () => {
        const fx = await createPaidOrder();
        const key = `refund:conflict:${rand()}`;
        const first = await intent(fx, { idempotencyKey: key, amount: 40 });

        await assert.rejects(
            () => intent(fx, { idempotencyKey: key, amount: 50 }),
            (err) => err.code === 'IDEMPOTENCY_CONFLICT'
        );

        const rows = await refundsFor(fx.paymentId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, first.refundId);
        assert.equal(Number(rows[0].amount), 40);
    });

    test('4. Two concurrent requests for the same logical refund produce exactly one row', async () => {
        const fx = await createPaidOrder();
        const key = `refund:race:${rand()}`;

        const results = await Promise.allSettled([intent(fx, { idempotencyKey: key }), intent(fx, { idempotencyKey: key })]);

        const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value.result).sort();
        assert.deepEqual(fulfilled, ['created', 'duplicate']);
        assert.equal((await refundsFor(fx.paymentId)).length, 1);
    });

    test('5. Concurrent different refunds cannot exceed the paid amount', async () => {
        const fx = await createPaidOrder({ amount: 100 });

        const results = await Promise.allSettled([
            intent(fx, { amount: 60 }),
            intent(fx, { amount: 60 }),
        ]);

        const created = results.filter(r => r.status === 'fulfilled').length;
        const rejected = results.filter(r => r.status === 'rejected' && r.reason.code === 'REFUND_EXCEEDS_PAYMENT').length;
        assert.equal(created, 1);
        assert.equal(rejected, 1);

        const total = (await refundsFor(fx.paymentId)).reduce((sum, r) => sum + Number(r.amount), 0);
        assert.ok(total <= 100);
    });

    test('6. Payment that belongs to a different order is rejected', async () => {
        const fx = await createPaidOrder();
        const other = await createPaidOrder();

        await assert.rejects(
            () => createRefundIntent({
                orderId: fx.orderId,
                paymentId: other.paymentId,
                amount: 10,
                currency: 'INR',
                origin: 'operator',
                idempotencyKey: `refund:mismatch:${rand()}`,
            }),
            (err) => err.code === 'PAYMENT_ORDER_MISMATCH'
        );
        assert.equal((await refundsFor(other.paymentId)).length, 0);
    });

    test('7. Currency mismatch, zero amount, and over-amount are rejected without writing', async () => {
        const fx = await createPaidOrder({ amount: 100 });

        await assert.rejects(() => intent(fx, { currency: 'USD' }), (err) => err.code === 'CURRENCY_MISMATCH');
        await assert.rejects(() => intent(fx, { amount: 0 }), (err) => err.code === 'VALIDATION');
        await assert.rejects(() => intent(fx, { amount: 101 }), (err) => err.code === 'REFUND_EXCEEDS_PAYMENT');
        assert.equal((await refundsFor(fx.paymentId)).length, 0);
    });

    // ---- Approval and provider processing ----

    test('8. Approval moves pending to approved; a second approval is an invalid transition', async () => {
        const fx = await createPaidOrder();
        const admin = await createAdmin();
        const created = await intent(fx);

        const approved = await approveRefund({ refundId: created.refundId, actorAdminId: admin });
        assert.equal(approved.status, 'approved');
        assert.equal((await refundRow(created.refundId)).approved_by_admin_id, admin);

        await assert.rejects(
            () => approveRefund({ refundId: created.refundId, actorAdminId: admin }),
            (err) => err.code === 'INVALID_TRANSITION'
        );
    });

    test('9. Approval requires an authenticated admin', async () => {
        const fx = await createPaidOrder();
        const created = await intent(fx);
        await assert.rejects(
            () => approveRefund({ refundId: created.refundId, actorAdminId: null }),
            (err) => err.code === 'AUTH_REQUIRED'
        );
        assert.equal((await refundRow(created.refundId)).status, 'pending');
    });

    test('10. Provider SUCCEEDED marks refunded with the provider reference, using the stable key', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        const key = (await refundRow(refundId)).idempotency_key;
        const provider = mockProvider({
            create: async () => ({ status: 'SUCCEEDED', providerRefundId: 'RF-OK-1' }),
        });

        const result = await processRefund({ refundId, provider });

        assert.equal(result.outcome, 'refunded');
        const row = await refundRow(refundId);
        assert.equal(row.status, 'refunded');
        assert.equal(row.provider_refund_id, 'RF-OK-1');
        assert.ok(row.resolved_at);
        assert.equal(row.claim_token, null);
        assert.equal(provider.calls.create.length, 1);
        assert.equal(provider.calls.create[0].refundKey, key);
    });

    test('11. Provider definitive rejection goes to manual review, not refunded', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        const provider = mockProvider({
            create: async () => ({ status: 'FAILED' }),
        });

        const result = await processRefund({ refundId, provider });

        assert.equal(result.outcome, 'manual_review');
        assert.equal((await refundRow(refundId)).status, 'manual_review');
    });

    test('12. Timeout is ambiguous: reconciliation_required, never refunded, never resubmitted', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        const provider = mockProvider({
            create: async () => { throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }); },
        });

        const result = await processRefund({ refundId, provider });

        assert.equal(result.outcome, 'reconciliation_required');
        const row = await refundRow(refundId);
        assert.equal(row.status, 'reconciliation_required');
        assert.notEqual(row.status, 'refunded');
        assert.ok(new Date(row.next_attempt_at).getTime() > Date.now() - 1000);
        assert.match(row.last_error, /ETIMEDOUT/);
    });

    test('13. Crash after provider success: reconciliation recovers the refund with no second submission', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);

        // Provider actually refunds, but the response is lost (timeout).
        const provider = mockProvider({
            create: async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); },
            lookup: async ({ refundKey }) => ({ found: true, status: 'SUCCEEDED', providerRefundId: `RF-LOOKUP-${refundKey.length}` }),
        });

        await processRefund({ refundId, provider });
        // Make the reconciliation item due now (backoff elapsed).
        await query(`UPDATE refunds SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [refundId]);

        const reconciled = await reconcileRefund({ refundId, provider });

        assert.equal(reconciled.outcome, 'refunded');
        assert.equal(provider.calls.create.length, 1, 'provider must not receive a second submission');
        assert.equal(provider.calls.lookup.length, 1);
        assert.equal((await refundRow(refundId)).status, 'refunded');
    });

    test('14. Not-found at the provider keeps reconciling and never resubmits', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        const provider = mockProvider({
            create: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
            lookup: async () => ({ found: false }),
        });

        await processRefund({ refundId, provider });
        await query(`UPDATE refunds SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [refundId]);
        const outcome = await reconcileRefund({ refundId, provider });

        assert.equal(outcome.outcome, 'reconciliation_required');
        assert.equal(provider.calls.create.length, 1);
        assert.equal((await refundRow(refundId)).status, 'reconciliation_required');
    });

    test('15. Stale worker cannot overwrite a newer owner after lease expiry', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);

        let newerOutcome;
        const provider = mockProvider({
            create: async () => {
                // Lease expires while this worker waits on the provider; the sweep fences it.
                await query(`UPDATE refunds SET claimed_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [refundId]);
                const maintenance = await expireStaleRefundClaims();
                assert.ok(maintenance.leaseExpired.includes(refundId));
                // A newer worker then reconciles and confirms the refund.
                newerOutcome = await reconcileRefund({
                    refundId,
                    provider: mockProvider({
                        lookup: async () => ({ found: true, status: 'SUCCEEDED', providerRefundId: 'RF-NEWER' }),
                    }),
                });
                return { status: 'SUCCEEDED', providerRefundId: 'RF-STALE' };
            },
        });

        const stale = await processRefund({ refundId, provider });

        assert.equal(newerOutcome.outcome, 'refunded');
        assert.equal(stale.outcome, 'lease_lost');
        const row = await refundRow(refundId);
        assert.equal(row.status, 'refunded');
        assert.equal(row.provider_refund_id, 'RF-NEWER', 'stale worker must not overwrite the provider reference');
    });

    test('16. Reconciliation items with exhausted attempts reach manual review', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        await query(
            `UPDATE refunds SET status = 'reconciliation_required', attempt_count = max_attempts, next_attempt_at = NOW() WHERE id = $1`,
            [refundId]
        );

        const maintenance = await expireStaleRefundClaims();
        assert.ok(maintenance.escalated.includes(refundId));
        const row = await refundRow(refundId);
        assert.equal(row.status, 'manual_review');
        assert.ok(row.resolved_at);
    });

    // ---- Stock-shortage integration ----

    test('17. Stock shortage creates exactly one refund intent, origin stock_shortage, pending', async () => {
        const fx = await createStockShortageCase();

        const result = await markPaymentSuccess(settlementEvent(fx));

        assert.equal(result.stockShortage, true);
        const rows = await refundsFor(fx.paymentId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'pending');
        assert.equal(rows[0].origin, 'stock_shortage');
        assert.equal(rows[0].idempotency_key, `stock_shortage:${fx.paymentId}`);
    });

    test('18. Duplicate webhook after stock shortage creates no second refund intent', async () => {
        const fx = await createStockShortageCase();
        await markPaymentSuccess(settlementEvent(fx));
        const again = await markPaymentSuccess(settlementEvent(fx));

        assert.equal(again.alreadySettled, true);
        assert.equal((await refundsFor(fx.paymentId)).length, 1);
    });

    test('19. Concurrent settlement deliveries produce one refund intent', async () => {
        const fx = await createStockShortageCase();
        const event = settlementEvent(fx);

        await Promise.all([markPaymentSuccess(event), markPaymentSuccess(event)]);

        assert.equal((await refundsFor(fx.paymentId)).length, 1);
    });

    test('20. Processing a stock-shortage refund does not deduct inventory or rerun settlement', async () => {
        const fx = await createStockShortageCase();
        await markPaymentSuccess(settlementEvent(fx));
        const stockBefore = await stockOf(fx.variantId);
        const refundId = (await refundsFor(fx.paymentId))[0].id;

        const admin = await createAdmin();
        await approveRefund({ refundId, actorAdminId: admin });
        const provider = mockProvider({ create: async () => ({ status: 'SUCCEEDED', providerRefundId: 'RF-STOCK' }) });
        await processRefund({ refundId, provider });

        assert.equal((await refundRow(refundId)).status, 'refunded');
        assert.deepEqual(await stockOf(fx.variantId), stockBefore);
        const deductions = await query(
            `SELECT COUNT(*)::int AS n FROM inventory_transactions WHERE reference_id = $1 AND transaction_type = 'SALE_DEDUCTION'`,
            [fx.orderId]
        );
        assert.equal(deductions.rows[0].n, 0);
    });

    // ---- Recovery sweep ----

    test('21. Worker restart: the sweep recovers due approved refunds', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        const provider = mockProvider(); // unique provider reference per refund key

        const sweep = await runRefundSweep({ limit: 100, provider });

        assert.equal(sweep.skipped, false);
        assert.ok(sweep.results.some(r => r.refundId === refundId && r.outcome === 'refunded'), JSON.stringify({ skipped: sweep.skipped, mine: sweep.results.filter(r => r.refundId === refundId), n: sweep.results.length, row: await refundRow(refundId) }));
        assert.equal((await refundRow(refundId)).status, 'refunded');
    });

    test('22. Sweep recovers a crashed worker: expired processing claim becomes reconciliation and is confirmed', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        const key = (await refundRow(refundId)).idempotency_key;
        // Simulate a crashed worker that held a claim long ago.
        await query(
            `UPDATE refunds SET status = 'processing', claim_token = gen_random_uuid(), claimed_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
            [refundId]
        );
        const provider = mockProvider({
            lookup: async () => ({ found: true, status: 'SUCCEEDED', providerRefundId: 'RF-CRASH' }),
        });

        await runRefundSweep({ limit: 100, provider });

        const row = await refundRow(refundId);
        assert.equal(row.status, 'refunded');
        assert.equal(provider.calls.create.filter(c => c.refundKey === key).length, 0, 'a crashed claim must never be resubmitted');
    });

    test('23. Provider not implemented fails closed to manual review without any submission', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);

        const result = await processRefund({ refundId });

        assert.equal(result.outcome, 'manual_review');
        assert.equal((await refundRow(refundId)).status, 'manual_review');
    });

    test('24. Refunded orders are not affected by the refund: order status is unchanged', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        await processRefund({
            refundId,
            provider: mockProvider({ create: async () => ({ status: 'SUCCEEDED', providerRefundId: 'RF-ORDER' }) }),
        });

        const order = await query(`SELECT status, payment_status FROM orders WHERE id = $1`, [fx.orderId]);
        assert.equal(order.rows[0].status, 'confirmed');
        assert.equal(order.rows[0].payment_status, 'paid');
    });

    test('25. Provider reference already attached to another refund goes to manual review, never attached twice', async () => {
        const first = await createPaidOrder();
        const second = await createPaidOrder();
        const firstRefund = await approvedRefund(first);
        const secondRefund = await approvedRefund(second);

        await processRefund({
            refundId: firstRefund,
            provider: mockProvider({ create: async () => ({ status: 'SUCCEEDED', providerRefundId: 'RF-SHARED' }) }),
        });
        const clash = await processRefund({
            refundId: secondRefund,
            provider: mockProvider({ create: async () => ({ status: 'SUCCEEDED', providerRefundId: 'RF-SHARED' }) }),
        });

        assert.equal(clash.outcome, 'manual_review');
        const second_ = await refundRow(secondRefund);
        assert.equal(second_.status, 'manual_review');
        assert.equal(second_.provider_refund_id, null);
        assert.match(second_.last_error, /PROVIDER_REFUND_ID_CONFLICT/);
        assert.equal((await refundRow(firstRefund)).provider_refund_id, 'RF-SHARED');
    });

    test('26. Provider-pending refund keeps being polled across many attempts before manual review', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        const provider = mockProvider({
            create: async () => ({ status: 'PENDING', providerRefundId: 'RF-PENDING-26' }),
            lookup: async () => ({ found: true, status: 'PENDING', providerRefundId: 'RF-PENDING-26' }),
        });

        await processRefund({ refundId, provider });
        const afterSubmit = await refundRow(refundId);
        assert.equal(afterSubmit.status, 'reconciliation_required');
        assert.equal(afterSubmit.max_attempts, 20);

        // Six more rounds of provider-pending: still polled, never escalated early.
        for (let round = 0; round < 6; round++) {
            await query(`UPDATE refunds SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [refundId]);
            const outcome = await reconcileRefund({ refundId, provider });
            assert.equal(outcome.outcome, 'reconciliation_required');
        }

        const row = await refundRow(refundId);
        assert.equal(row.status, 'reconciliation_required');
        assert.equal(row.attempt_count, 7, '1 submission + 6 reconciliation attempts');
        assert.equal(row.resolved_at, null);
        assert.equal(provider.calls.create.length, 1, 'never resubmitted while provider reports pending');

        // Exhausting the budget escalates to manual review, never a silent resolution.
        await query(`UPDATE refunds SET attempt_count = max_attempts - 1, next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [refundId]);
        const last = await reconcileRefund({ refundId, provider });
        assert.equal(last.outcome, 'manual_review');
        assert.equal((await refundRow(refundId)).status, 'manual_review');
    });

    test('27. Late provider success after escalation is reconciled to refunded without any new submission', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        const pending = mockProvider({
            create: async () => ({ status: 'PENDING', providerRefundId: 'RF-LATE-27' }),
            lookup: async () => ({ found: true, status: 'PENDING', providerRefundId: 'RF-LATE-27' }),
        });
        await processRefund({ refundId, provider: pending });
        await query(`UPDATE refunds SET attempt_count = max_attempts, status = 'reconciliation_required', next_attempt_at = NOW() WHERE id = $1`, [refundId]);
        await expireStaleRefundClaims(); // exhausted -> manual_review
        assert.equal((await refundRow(refundId)).status, 'manual_review');

        const later = mockProvider({
            lookup: async () => ({ found: true, status: 'SUCCEEDED', providerRefundId: 'RF-LATE-27' }),
        });
        const outcome = await reconcileManualReviewRefund({ refundId, provider: later });

        assert.equal(outcome.outcome, 'refunded');
        const row = await refundRow(refundId);
        assert.equal(row.status, 'refunded');
        assert.equal(row.provider_refund_id, 'RF-LATE-27');
        assert.equal(later.calls.create.length, 0, 'late reconciliation must never submit');
        assert.equal(pending.calls.create.length, 1);
    });

    test('28. Late reconciliation that cannot confirm success leaves manual review in place and never submits', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        await query(`UPDATE refunds SET status = 'manual_review', resolved_at = NOW() WHERE id = $1`, [refundId]);

        const notFound = mockProvider({ lookup: async () => ({ found: false }) });
        assert.equal((await reconcileManualReviewRefund({ refundId, provider: notFound })).outcome, 'manual_review');

        const failing = mockProvider({ lookup: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } });
        await query(`UPDATE refunds SET status = 'manual_review' WHERE id = $1`, [refundId]);
        assert.equal((await reconcileManualReviewRefund({ refundId, provider: failing })).outcome, 'manual_review');

        const row = await refundRow(refundId);
        assert.equal(row.status, 'manual_review');
        assert.equal(notFound.calls.create.length + failing.calls.create.length, 0);
    });

    test('29. Late reconciliation is fenced: a stale late worker cannot overwrite a newer owner', async () => {
        const fx = await createPaidOrder();
        const refundId = await approvedRefund(fx);
        await query("UPDATE refunds SET status = 'manual_review', resolved_at = NOW() WHERE id = $1", [refundId]);

        const stale = mockProvider({
            lookup: async () => {
                // A newer owner takes the claim while this stale worker waits on the provider.
                await query('UPDATE refunds SET claim_token = gen_random_uuid() WHERE id = $1', [refundId]);
                return { found: true, status: 'SUCCEEDED', providerRefundId: 'RF-STALE-LATE' };
            },
        });

        const outcome = await reconcileManualReviewRefund({ refundId, provider: stale });

        assert.equal(outcome.outcome, 'lease_lost');
        const row = await refundRow(refundId);
        assert.equal(row.status, 'processing', 'the newer owner claim is left intact');
        assert.equal(row.provider_refund_id, null, 'stale worker must not record a provider reference');
        assert.equal(stale.calls.create.length, 0, 'late reconciliation never submits');
    });
});

// --------------------------------------------------------------------------
// Stock-shortage fixture (no anomaly, stock below requested quantity)
// --------------------------------------------------------------------------
async function createStockShortageCase({ quantity = 5, price = 100, onHand = 3 } = {}) {
    const variantRes = await query(
        `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, flavor,
                                       mrp, selling_price, cost_price, tax_rate, is_active)
         VALUES ($1, $2, 'Refund Stock Test', 100, 'Peri Peri', $3, $3, 50.00, 18.00, true)
         RETURNING id`,
        [testProductId, `REF-STK-${rand()}`, price]
    );
    const variantId = variantRes.rows[0].id;
    fixtureVariantIds.push(variantId);

    await query(
        `INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
         VALUES ($1, $2, 0, 5)`,
        [variantId, onHand]
    );

    const orderRes = await query(
        `INSERT INTO orders (order_number, customer_name, phone, shipping_address,
                             subtotal, total_amount, currency, status, payment_status)
         VALUES ($1, 'Stock Customer', '9876543210', '{"city":"Mumbai"}'::jsonb,
                 $2, $2, 'INR', 'pending_payment', 'pending')
         RETURNING id`,
        [`REF-STK-ORD-${rand()}`, price * quantity]
    );
    const orderId = orderRes.rows[0].id;
    fixtureOrderIds.push(orderId);

    await query(
        `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price, total_price)
         VALUES ($1, $2, 'Refund Stock Test', 'Refund Stock Test', 'REFSTK', $3, $4, $5)`,
        [orderId, variantId, quantity, price, price * quantity]
    );

    const providerOrderId = `TCH-REF-STK-${rand()}`;
    const providerPaymentId = `CF-REF-STK-${rand()}`;
    const paymentRes = await query(
        `INSERT INTO payments (order_id, provider, provider_order_id, amount, currency, status)
         VALUES ($1, 'cashfree', $2, $3, 'INR', 'created') RETURNING id`,
        [orderId, providerOrderId, price * quantity]
    );

    return {
        orderId,
        variantId,
        paymentId: paymentRes.rows[0].id,
        providerOrderId,
        providerPaymentId,
        amount: price * quantity,
    };
}

function settlementEvent(fx) {
    return {
        providerOrderId: fx.providerOrderId,
        providerPaymentId: fx.providerPaymentId,
        paymentAmount: fx.amount,
        paymentCurrency: 'INR',
    };
}
