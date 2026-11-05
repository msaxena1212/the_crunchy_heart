/**
 * The Crunchy Heart - Deterministic interruption between provider success and persistence
 *
 * A stand-in for a crash after Cashfree has created the order but before the local
 * database records ORDER_CREATED. A test-only trigger rejects that one write, and only
 * for orders whose customer name carries a test marker, so suites running in parallel
 * against the same test database are unaffected. The trigger is dropped right after the
 * simulated crash, so the recovery steps persist normally.
 *
 * Not covered here: a real process kill (SIGKILL) at the same point. That remains an
 * open item in docs/payments/release-hardening.md. The Cashfree API is mocked at the
 * global fetch boundary. No live provider call is made.
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
process.env.CASHFREE_CLIENT_ID = 'TEST_INTERRUPT_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_INTERRUPT_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'TEST_INTERRUPT_ORDER_TOKEN_SECRET_0123456789abcdef';
process.env.OWNER_SESSION_SECRET = 'TEST_INTERRUPT_OWNER_SESSION_SECRET_0123456789ab';

const { query, pool } = await import('../src/db/pool.js');
const { createOrder, retryPaymentAttempt } = await import('../src/services/order.service.js');
const { reconcilePaymentAttempt } = await import('../src/services/reconciliation.service.js');
const { generateGuestAccessToken } = await import('../src/utils/order-token.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const originalFetch = globalThis.fetch;

// Cashfree boundary mock: answers immediately and counts provider order creations.
let posts = 0;
let recoverSession = null;

globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('cashfree.com')) return originalFetch(url, options);

    const method = (options.method || 'GET').toUpperCase();

    if (method === 'POST' && u.endsWith('/pg/orders')) {
        posts += 1;
        const body = JSON.parse(options.body || '{}');
        return new Response(JSON.stringify({
            order_id: body.order_id,
            cf_order_id: 900000 + posts,
            order_status: 'ACTIVE',
            payment_session_id: `sess_${body.order_id}_${posts}`,
            order_expiry_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'GET' && /\/pg\/orders\/[^/]+$/.test(u)) {
        const orderId = decodeURIComponent(u.split('/pg/orders/')[1]);
        return new Response(JSON.stringify({
            order_id: orderId,
            cf_order_id: 900999,
            order_status: 'ACTIVE',
            payment_session_id: recoverSession,
            order_expiry_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'GET' && u.endsWith('/payments')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
};

let testProductId;

async function createVariant() {
    const v = await query(
        `INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, flavor,
                                       mrp, selling_price, cost_price, tax_rate, is_active)
         VALUES ($1, $2, 'Interrupt Test', 100, 'Salt', 200, 100, 50, 18, true) RETURNING id`,
        [testProductId, `INT-${rand()}`]
    );
    await query(`INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, 100, 0, 5)`, [v.rows[0].id]);
    return v.rows[0].id;
}

async function paymentRows(orderId) {
    return (await query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at`, [orderId])).rows;
}

/*
 * Backdates an attempt. payments has a BEFORE UPDATE trigger that sets updated_at to
 * NOW(), so the trigger is skipped for this one connection only (session_replication_role).
 * Other connections, and so other suites, are not affected. Requires a superuser role,
 * which the local test database uses.
 */
async function ageAttempt(providerOrderId, minutes) {
    const client = await pool.connect();
    try {
        await client.query(`SET session_replication_role = replica`);
        await client.query(
            `UPDATE payments
             SET created_at = NOW() - ($2::int * INTERVAL '1 minute'),
                 updated_at = NOW() - ($2::int * INTERVAL '1 minute')
             WHERE provider_order_id = $1`,
            [providerOrderId, minutes]
        );
    } finally {
        await client.query(`RESET session_replication_role`).catch(() => {});
        client.release();
    }
}

describe('Process interruption between provider success and persistence', () => {
    const marker = `INTERRUPT ${rand()}`;
    let order;
    let token;
    let providerOrderId;

    before(async () => {
        const cat = await query(
            `INSERT INTO categories (name, slug, description, is_active)
             VALUES ('Interrupt Category', 'interrupt-cat-' || gen_random_uuid(), 'Interrupt', true) RETURNING id`
        );
        const prod = await query(
            `INSERT INTO products (category_id, name, slug, brand, is_active)
             VALUES ($1, 'Interrupt Product', 'interrupt-prod-' || gen_random_uuid(), 'The Crunchy Heart', true) RETURNING id`,
            [cat.rows[0].id]
        );
        testProductId = prod.rows[0].id;

        // Test-only: fails the ORDER_CREATED write for marked orders, simulating a crash
        // between the provider's success and the local record.
        await query(`DROP TRIGGER IF EXISTS test_interrupt_payments ON payments`);
        await query(`DROP FUNCTION IF EXISTS test_interrupt_order_created()`);
        await query(`
            CREATE FUNCTION test_interrupt_order_created() RETURNS trigger LANGUAGE plpgsql AS $fn$
            BEGIN
                IF NEW.gateway_status = 'ORDER_CREATED' AND EXISTS (
                    SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.customer_name LIKE 'INTERRUPT %'
                ) THEN
                    RAISE EXCEPTION 'simulated process interruption before persistence';
                END IF;
                RETURN NEW;
            END
            $fn$
        `);
        await query(`
            CREATE TRIGGER test_interrupt_payments
            BEFORE UPDATE ON payments
            FOR EACH ROW EXECUTE FUNCTION test_interrupt_order_created()
        `);
    });

    after(async () => {
        await query(`DROP TRIGGER IF EXISTS test_interrupt_payments ON payments`);
        await query(`DROP FUNCTION IF EXISTS test_interrupt_order_created()`);
        globalThis.fetch = originalFetch;
        if (order) {
            await query(`DELETE FROM inventory_transactions WHERE reference_id = $1`, [order.id]);
            await query(`DELETE FROM payments WHERE order_id = $1`, [order.id]);
            await query(`DELETE FROM orders WHERE id = $1`, [order.id]);
        }
        await pool.end().catch(() => {});
    });

    test('1. The attempt is durable before the provider call, and survives the interruption', async () => {
        const variantId = await createVariant();
        const created = await createOrder({
            customer: { name: marker, phone: '9876543210', email: 'interrupt@example.test' },
            shippingAddress: { name: marker, phone: '9876543210', addressLine1: '1 Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', country: 'India' },
            items: [{ variantId, quantity: 1 }],
            paymentMethod: 'ONLINE',
            idempotencyKey: `int-${rand()}-${Date.now()}`,
        });
        order = (await query(`SELECT * FROM orders WHERE order_number = $1`, [created.order.order_number])).rows[0];
        assert.ok(order, 'the order row was committed');
        token = generateGuestAccessToken(order);

        // The provider order is created inside the payment retry. Cashfree answers, then
        // the write that records ORDER_CREATED is refused by the trigger.
        const postsBefore = posts;
        await assert.rejects(() => retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }));

        assert.equal(posts, postsBefore + 1, 'the provider created exactly one order before the interruption');

        // createOrder records its own CASHFREE_PENDING row. The retry adds the attempt row.
        const attempts = (await paymentRows(order.id)).filter(r => r.gateway_status === 'ATTEMPT_INITIATED');
        assert.equal(attempts.length, 1, 'exactly one attempt is recorded, still in flight');
        assert.ok(attempts[0].provider_order_id, 'the provider order id was recorded before the call');
        providerOrderId = attempts[0].provider_order_id;

        // The crash is over. Later steps must persist normally.
        await query(`DROP TRIGGER IF EXISTS test_interrupt_payments ON payments`);
    });

    test('2. Within the lease, a retry is refused and creates no second provider order', async () => {
        const postsBefore = posts;
        await assert.rejects(
            () => retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }),
            (err) => err.statusCode === 409
        );
        assert.equal(posts, postsBefore, 'no provider order was created while the attempt is in flight');
    });

    test('3. After the lease, the attempt becomes ambiguous and reconciliation recovers it without a new order', async () => {
        // Age the stranded attempt past the lease, as a real interruption would after time passes.
        await ageAttempt(providerOrderId, 10);

        const postsBefore = posts;
        await assert.rejects(
            () => retryPaymentAttempt({ orderNumber: order.order_number, guestAccessToken: token }),
            (err) => err.statusCode === 504
        );
        assert.equal(posts, postsBefore, 'the stale attempt is not retried at the provider');

        const ambiguous = (await paymentRows(order.id)).find(r => r.provider_order_id === providerOrderId);
        assert.equal(ambiguous.gateway_status, 'GATEWAY_AMBIGUOUS_TIMEOUT');

        recoverSession = `recovered_${providerOrderId}`;
        try {
            await reconcilePaymentAttempt({ providerOrderId });
        } finally {
            recoverSession = null;
        }

        assert.equal(posts, postsBefore, 'reconciliation never creates a provider order');
        const recovered = (await paymentRows(order.id)).find(r => r.provider_order_id === providerOrderId);
        assert.equal(recovered.gateway_status, 'ORDER_CREATED');
        assert.equal(recovered.provider_order_id, providerOrderId, 'the same provider order is kept');
    });
});
