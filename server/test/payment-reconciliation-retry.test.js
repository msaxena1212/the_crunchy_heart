/**
 * The Crunchy Heart - Settlement Retry for Payment Reconciliation
 *
 * Verifies the retry workflow for queued verified payments:
 * claiming, provider re-verification (mocked), atomic settlement and queue
 * resolution, manual-review routing, and recovery after inventory repair.
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 * Provider verification is always injected as a mock. No Cashfree call occurs.
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
process.env.CASHFREE_CLIENT_ID = 'TEST_RETRY_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_RETRY_CLIENT_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const { query } = await import('../src/db/pool.js');
const { markPaymentSuccess } = await import('../src/services/payment.service.js');
const { enqueuePaymentReconciliationEvent } = await import('../src/services/payment-reconciliation.service.js');
const {
    retryPaymentReconciliation,
    processDueReconciliationItems,
    computeBackoffMs,
    BASE_BACKOFF_MS,
    MAX_BACKOFF_MS,
} = await import('../src/services/payment-reconciliation-retry.service.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const verifiedOk = async () => ({ verified: true });

const fixtureOrderIds = [];
const fixtureVariantIds = [];
const fixtureAdminIds = [];
let testProductId;

/*
 * Builds a paid-but-blocked case: stock available, order of `quantity` units,
 * and a partial SALE_DEDUCTION ledger row that makes settlement fail closed.
 * Returns the queue row created through the durable enqueue path.
 */
async function createBlockedCase({ quantity = 5, price = 100, onHand = 20, reserved = quantity, withAnomaly = true } = {}) {
    const variantRes = await query(
        `
        INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, flavor,
                                      mrp, selling_price, cost_price, tax_rate, is_active)
        VALUES ($1, $2, 'Retry Test', 100, 'Peri Peri', $3, $3, 50.00, 18.00, true)
        RETURNING id
        `,
        [testProductId, `RETRY-${rand()}`, price]
    );
    const variantId = variantRes.rows[0].id;
    fixtureVariantIds.push(variantId);

    await query(
        `INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
         VALUES ($1, $2, $3, 5)`,
        [variantId, onHand, reserved]
    );

    const orderRes = await query(
        `INSERT INTO orders (order_number, customer_name, phone, shipping_address,
                             subtotal, total_amount, currency, status, payment_status)
         VALUES ($1, 'Retry Customer', '9876543210', '{"city":"Mumbai"}'::jsonb,
                 $2, $2, 'INR', 'pending_payment', 'pending')
         RETURNING id`,
        [`RETRY-ORD-${rand()}`, price * quantity]
    );
    const orderId = orderRes.rows[0].id;
    fixtureOrderIds.push(orderId);

    await query(
        `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price, total_price)
         VALUES ($1, $2, 'Retry Test', 'Retry Test', 'RETRY', $3, $4, $5)`,
        [orderId, variantId, quantity, price, price * quantity]
    );

    const anomaly = withAnomaly ? await query(
        `INSERT INTO inventory_transactions (variant_id, transaction_type, quantity, reference_type, reference_id, notes)
         VALUES ($1, 'SALE_DEDUCTION', 2, 'ORDER', $2, 'Retry test partial deduction')
         RETURNING id`,
        [variantId, orderId]
    ) : { rows: [{ id: null }] };

    const providerOrderId = `TCH-RETRY-${rand()}`;
    const providerPaymentId = `CF-RETRY-${rand()}`;
    const paymentRes = await query(
        `INSERT INTO payments (order_id, provider, provider_order_id, amount, currency, status)
         VALUES ($1, 'cashfree', $2, $3, 'INR', 'created') RETURNING id`,
        [orderId, providerOrderId, price * quantity]
    );

    if (!withAnomaly) {
        return { orderId, variantId, paymentId: paymentRes.rows[0].id, anomalyId: null, providerOrderId, providerPaymentId, amount: price * quantity, queueId: null };
    }

    // Real settlement path: blocked by the anomaly, so it must roll back.
    await assert.rejects(
        () => markPaymentSuccess({
            providerOrderId,
            providerPaymentId,
            paymentAmount: price * quantity,
            paymentCurrency: 'INR',
        }),
        (err) => err.code === 'INVENTORY_RECONCILIATION_REQUIRED'
    );

    const queued = await enqueuePaymentReconciliationEvent({
        providerOrderId,
        providerPaymentId,
        paymentAmount: price * quantity,
        paymentCurrency: 'INR',
        failureCode: 'INVENTORY_RECONCILIATION_REQUIRED',
        failureMessage: 'seeded',
    });

    return {
        orderId,
        variantId,
        paymentId: paymentRes.rows[0].id,
        anomalyId: anomaly.rows[0].id,
        providerOrderId,
        providerPaymentId,
        amount: price * quantity,
        queueId: queued.queueId,
    };
}

// Simulates an operator restoring a consistent ledger from verified evidence.
async function repairLedger(fx) {
    await query(`DELETE FROM inventory_transactions WHERE id = $1`, [fx.anomalyId]);
}

async function queueRow(queueId) {
    return (await query(`SELECT * FROM payment_reconciliation_queue WHERE id = $1`, [queueId])).rows[0];
}

async function stockOf(variantId) {
    return (await query(`SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1`, [variantId])).rows[0];
}

async function paymentStatus(paymentId) {
    return (await query(`SELECT status FROM payments WHERE id = $1`, [paymentId])).rows[0].status;
}

async function orderStatus(orderId) {
    return (await query(`SELECT status, payment_status FROM orders WHERE id = $1`, [orderId])).rows[0];
}

async function deductionUnits(orderId) {
    const res = await query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS units
         FROM inventory_transactions
         WHERE reference_id = $1 AND transaction_type = 'SALE_DEDUCTION'`,
        [orderId]
    );
    return res.rows[0].units;
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------
describe('Settlement retry for payment reconciliation', () => {
    before(async () => {
        const catRes = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Retry Test Category', 'retry-cat-' || gen_random_uuid(), 'Retry', true)
             RETURNING id`
        );
        const prodRes = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Retry Test Product', 'retry-prod-' || gen_random_uuid(), 'The Crunchy Heart', true)
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

    test('1. Repaired inventory: retry settles once, resolves queue atomically, deducts exactly once', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);
        const before = await stockOf(fx.variantId);

        const result = await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });

        assert.equal(result.outcome, 'settled');
        assert.equal(await paymentStatus(fx.paymentId), 'paid');
        assert.deepEqual(await orderStatus(fx.orderId), { status: 'confirmed', payment_status: 'paid' });

        const row = await queueRow(fx.queueId);
        assert.equal(row.status, 'resolved');
        assert.equal(row.resolution_action, 'auto_retry_settled');
        assert.ok(row.resolved_at);
        assert.equal(row.last_error, null);

        const after = await stockOf(fx.variantId);
        assert.equal(before.quantity_on_hand - after.quantity_on_hand, 5);
        assert.equal(await deductionUnits(fx.orderId), 5);

        const audit = await query(
            `SELECT COUNT(*)::int AS n FROM admin_audit_logs WHERE action = 'reconciliation.settled' AND entity_id = $1`,
            [String(fx.queueId)]
        );
        assert.equal(audit.rows[0].n, 1);
    });

    test('2. Partial ledger still present: retry is blocked, nothing mutates, item goes to manual review', async () => {
        const fx = await createBlockedCase();
        const before = await stockOf(fx.variantId);

        const result = await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });

        assert.equal(result.outcome, 'manual_review');
        const row = await queueRow(fx.queueId);
        assert.equal(row.status, 'pending_admin');
        assert.equal(row.attempt_count, 1);
        assert.equal(row.next_retry_after, null);
        assert.match(row.last_error, /INVENTORY_RECONCILIATION_REQUIRED/);

        assert.equal(await paymentStatus(fx.paymentId), 'created');
        assert.deepEqual(await stockOf(fx.variantId), before);
        assert.equal(await deductionUnits(fx.orderId), 2);
    });

    test('3. Concurrent retries: exactly one claims and settles, deduction happens once', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);

        const [a, b] = await Promise.all([
            retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk }),
            retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk }),
        ]);

        const outcomes = [a.outcome, b.outcome].sort();
        assert.deepEqual(outcomes, ['not_claimed', 'settled']);
        assert.equal(await deductionUnits(fx.orderId), 5);
        assert.equal((await queueRow(fx.queueId)).status, 'resolved');
    });

    test('4. Worker crash: a stale processing claim is recoverable; a fresh one is not', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);

        // Fresh lease held by a live worker: must not be stolen.
        await query(
            `UPDATE payment_reconciliation_queue SET status = 'processing', last_attempted_at = NOW() WHERE id = $1`,
            [fx.queueId]
        );
        const blocked = await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });
        assert.equal(blocked.outcome, 'not_claimed');

        // Lease expired after a crash: recoverable.
        await query(
            `UPDATE payment_reconciliation_queue SET last_attempted_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
            [fx.queueId]
        );
        const recovered = await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });
        assert.equal(recovered.outcome, 'settled');
        assert.equal(await deductionUnits(fx.orderId), 5);
    });

    test('5. Repeated webhook after settlement does not deduct again', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);
        await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });
        const stockAfterSettle = await stockOf(fx.variantId);

        const redelivered = await markPaymentSuccess({
            providerOrderId: fx.providerOrderId,
            providerPaymentId: fx.providerPaymentId,
            paymentAmount: fx.amount,
            paymentCurrency: 'INR',
        });

        assert.equal(redelivered.alreadySettled, true);
        assert.deepEqual(await stockOf(fx.variantId), stockAfterSettle);
        assert.equal(await deductionUnits(fx.orderId), 5);
    });

    test('6. Provider identity mismatch is deterministic: manual review, no settlement', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);

        const result = await retryPaymentReconciliation({
            queueId: fx.queueId,
            mode: 'auto',
            verifyProvider: async () => ({ verified: false, reason: 'PROVIDER_IDENTITY_MISMATCH', deterministic: true }),
        });

        assert.equal(result.outcome, 'manual_review');
        assert.equal((await queueRow(fx.queueId)).status, 'pending_admin');
        assert.equal(await paymentStatus(fx.paymentId), 'created');
        assert.equal(await deductionUnits(fx.orderId), 0); // ledger repaired; nothing settled
    });

    test('7. Provider outage is ambiguous: retry scheduled with a future time, nothing settled', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);

        const result = await retryPaymentReconciliation({
            queueId: fx.queueId,
            mode: 'auto',
            verifyProvider: async () => { throw new Error('socket timeout'); },
        });

        assert.equal(result.outcome, 'retry_scheduled');
        const row = await queueRow(fx.queueId);
        assert.equal(row.status, 'pending');
        assert.equal(row.attempt_count, 1);
        assert.ok(new Date(row.next_retry_after).getTime() > Date.now());
        assert.equal(await paymentStatus(fx.paymentId), 'created');
        assert.equal(await deductionUnits(fx.orderId), 0); // ledger repaired; nothing settled
    });

    test('8. Backoff is bounded and jittered', () => {
        for (let attempt = 1; attempt <= 40; attempt++) {
            const delay = computeBackoffMs(attempt, () => 0.999999);
            assert.ok(delay <= MAX_BACKOFF_MS, `attempt ${attempt} exceeded cap`);
            assert.ok(delay >= 0);
        }
        assert.ok(computeBackoffMs(1, () => 0) >= BASE_BACKOFF_MS / 2);
        assert.equal(computeBackoffMs(1, () => 0), BASE_BACKOFF_MS / 2);
        assert.ok(computeBackoffMs(2, () => 0) > computeBackoffMs(1, () => 0));
    });

    test('9. Exhausted retries move to manual review and remain visible', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);
        await query(
            `UPDATE payment_reconciliation_queue SET attempt_count = max_attempts - 1 WHERE id = $1`,
            [fx.queueId]
        );

        const result = await retryPaymentReconciliation({
            queueId: fx.queueId,
            mode: 'auto',
            verifyProvider: async () => { throw new Error('still down'); },
        });

        assert.equal(result.outcome, 'manual_review');
        const row = await queueRow(fx.queueId);
        assert.equal(row.status, 'pending_admin');
        assert.equal(row.next_retry_after, null);
    });

    test('10. Terminal order state blocks settlement', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);
        await query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [fx.orderId]);

        const result = await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });

        assert.equal(result.outcome, 'manual_review');
        const row = await queueRow(fx.queueId);
        assert.equal(row.status, 'pending_admin');
        assert.match(row.last_error, /ORDER_TERMINAL_STATE/);
        assert.equal(await paymentStatus(fx.paymentId), 'created');
        assert.equal(await deductionUnits(fx.orderId), 0); // ledger repaired; nothing settled
    });

    test('11. Resolved item cannot be settled again', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);
        await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });

        const again = await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });
        assert.equal(again.outcome, 'not_claimed');
        assert.equal(await deductionUnits(fx.orderId), 5);
    });

    test('12. Admin retry requires an authenticated actor', async () => {
        const fx = await createBlockedCase();
        await assert.rejects(
            () => retryPaymentReconciliation({ queueId: fx.queueId, mode: 'admin', actorAdminId: null, verifyProvider: verifiedOk }),
            (err) => err.statusCode === 400
        );
        assert.equal((await queueRow(fx.queueId)).status, 'pending');
    });

    test('13. Admin retry settles a pending_admin item once the ledger is repaired', async () => {
        const fx = await createBlockedCase();
        const admin = await query(
            `INSERT INTO admin_users (email, password_hash, full_name, role, is_active)
             VALUES ($1, 'x', 'Retry Test Admin', 'owner', true) RETURNING id`,
            [`retry-admin-${rand()}@example.test`]
        );
        fixtureAdminIds.push(admin.rows[0].id);

        // First attempt is blocked and parks the item in manual review.
        await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });
        assert.equal((await queueRow(fx.queueId)).status, 'pending_admin');

        await repairLedger(fx);
        const result = await retryPaymentReconciliation({
            queueId: fx.queueId,
            mode: 'admin',
            actorAdminId: admin.rows[0].id,
            verifyProvider: verifiedOk,
        });

        assert.equal(result.outcome, 'settled');
        const row = await queueRow(fx.queueId);
        assert.equal(row.resolution_action, 'admin_retry_settled');
        assert.equal(row.resolved_by_admin_id, admin.rows[0].id);
        assert.equal(await deductionUnits(fx.orderId), 5);
    });

    test('14. Lease lost during provider verification: stale worker cannot settle or overwrite', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);

        let takeover;
        const staleVerify = async () => {
            // Our lease expires while this worker is inside the provider call...
            await query(
                `UPDATE payment_reconciliation_queue SET last_attempted_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
                [fx.queueId]
            );
            // ...and another worker takes over and settles the item.
            takeover = await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: verifiedOk });
            return { verified: true };
        };

        const stale = await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: staleVerify });

        assert.equal(takeover.outcome, 'settled');
        assert.equal(stale.outcome, 'lease_lost');
        assert.equal(await deductionUnits(fx.orderId), 5);
        const row = await queueRow(fx.queueId);
        assert.equal(row.status, 'resolved');
        assert.equal(row.claim_token, null);
    });

    test('15. Lease lost during a failed attempt: stale worker cannot record its failure over the new owner', async () => {
        const fx = await createBlockedCase();
        await repairLedger(fx);

        let takeoverOutcome;
        const staleVerify = async () => {
            await query(
                `UPDATE payment_reconciliation_queue SET last_attempted_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
                [fx.queueId]
            );
            // New owner is still processing (has not finished) when stale worker fails.
            takeoverOutcome = await retryPaymentReconciliation({
                queueId: fx.queueId,
                mode: 'auto',
                verifyProvider: async () => ({ verified: false, reason: 'PAYMENT_NOT_SUCCESS', deterministic: false }),
            });
            throw new Error('stale provider timeout');
        };

        const stale = await retryPaymentReconciliation({ queueId: fx.queueId, mode: 'auto', verifyProvider: staleVerify });

        assert.equal(takeoverOutcome.outcome, 'retry_scheduled');
        assert.equal(stale.outcome, 'lease_lost');
        const row = await queueRow(fx.queueId);
        assert.equal(row.status, 'pending');
        assert.equal(row.attempt_count, 2);
        assert.match(row.last_error, /PAYMENT_NOT_SUCCESS/);
        assert.equal(await deductionUnits(fx.orderId), 0);
    });

    test('16. Stock shortage: settlement commits the exception state and a refund intent once', async () => {
        const fx = await createBlockedCase({ withAnomaly: false, onHand: 3, reserved: 0 });
        const stockBefore = await stockOf(fx.variantId);

        const result = await markPaymentSuccess({
            providerOrderId: fx.providerOrderId,
            providerPaymentId: fx.providerPaymentId,
            paymentAmount: fx.amount,
            paymentCurrency: 'INR',
        });

        assert.equal(result.stockShortage, true);
        const payment = await query(`SELECT status, gateway_status FROM payments WHERE id = $1`, [fx.paymentId]);
        assert.equal(payment.rows[0].status, 'paid');
        assert.equal(payment.rows[0].gateway_status, 'PAID_STOCK_UNAVAILABLE');
        assert.equal((await orderStatus(fx.orderId)).status, 'exception_stock_shortage');
        assert.deepEqual(await stockOf(fx.variantId), stockBefore);

        const refunds = await query(`SELECT status FROM refunds WHERE payment_id = $1`, [fx.paymentId]);
        assert.equal(refunds.rows.length, 1);
        assert.equal(refunds.rows[0].status, 'pending');
    });

    test('17. Stock shortage: duplicate webhook delivery creates no second refund and no deduction', async () => {
        const fx = await createBlockedCase({ withAnomaly: false, onHand: 3, reserved: 0 });
        const event = {
            providerOrderId: fx.providerOrderId,
            providerPaymentId: fx.providerPaymentId,
            paymentAmount: fx.amount,
            paymentCurrency: 'INR',
        };
        await markPaymentSuccess(event);
        const redelivered = await markPaymentSuccess(event);

        assert.equal(redelivered.alreadySettled, true);
        const refunds = await query(`SELECT id FROM refunds WHERE payment_id = $1`, [fx.paymentId]);
        assert.equal(refunds.rows.length, 1);
        assert.equal(await deductionUnits(fx.orderId), 0);
    });

    test('18. Stock shortage: concurrent deliveries produce one exception and one refund intent', async () => {
        const fx = await createBlockedCase({ withAnomaly: false, onHand: 3, reserved: 0 });
        const event = {
            providerOrderId: fx.providerOrderId,
            providerPaymentId: fx.providerPaymentId,
            paymentAmount: fx.amount,
            paymentCurrency: 'INR',
        };

        const results = await Promise.all([markPaymentSuccess(event), markPaymentSuccess(event)]);

        const shortage = results.filter(r => r.stockShortage).length;
        const alreadySettled = results.filter(r => r.alreadySettled || r.duplicateSettlement).length;
        assert.equal(shortage, 1);
        assert.equal(alreadySettled, 1);

        const refunds = await query(`SELECT id FROM refunds WHERE payment_id = $1`, [fx.paymentId]);
        assert.equal(refunds.rows.length, 1);
        assert.equal(await deductionUnits(fx.orderId), 0);
    });

    test('19. Stock shortage never enters the automatic retry loop', async () => {
        const fx = await createBlockedCase({ withAnomaly: false, onHand: 3, reserved: 0 });
        const queued = await enqueuePaymentReconciliationEvent({
            providerOrderId: fx.providerOrderId,
            providerPaymentId: fx.providerPaymentId,
            paymentAmount: fx.amount,
            paymentCurrency: 'INR',
            failureCode: 'INSUFFICIENT_STOCK',
            failureMessage: 'stock short',
        });

        const first = await retryPaymentReconciliation({ queueId: queued.queueId, mode: 'auto', verifyProvider: verifiedOk });
        assert.equal(first.outcome, 'stock_shortage');
        const row = await queueRow(queued.queueId);
        assert.equal(row.status, 'pending_admin');
        assert.equal(row.next_retry_after, null);
        assert.equal(row.claim_token, null);

        // Worker sweep must not pick it up.
        const sweep = await processDueReconciliationItems({ limit: 50 });
        assert.equal(sweep.some(r => r.queueId === queued.queueId), false);
        assert.equal((await queueRow(queued.queueId)).status, 'pending_admin');
    });

    test('20. Sweep lock: a second sweeper is skipped while another instance holds the lock', async () => {
        const { pool } = await import('../src/db/pool.js');
        const { runReconciliationSweep, SWEEP_LOCK_KEY } = await import('../src/services/payment-reconciliation-retry.service.js');

        const holder = await pool.connect();
        try {
            const held = await holder.query('SELECT pg_try_advisory_lock($1) AS ok', [SWEEP_LOCK_KEY]);
            assert.equal(held.rows[0].ok, true);

            const skipped = await runReconciliationSweep({ limit: 5 });
            assert.equal(skipped.skipped, true);
            assert.equal(skipped.reason, 'another_instance_sweeping');
        } finally {
            await holder.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]);
            holder.release();
        }

        // Lock released: a sweep runs and releases it again.
        const ran = await runReconciliationSweep({ limit: 5 });
        assert.equal(ran.skipped, false);
    });
});
