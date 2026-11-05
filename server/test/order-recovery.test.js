/**
 * The Crunchy Heart - Guest order recovery (lost checkout response)
 *
 * Covers the recovery authorization model: generic replies, hashed single-use codes,
 * expiry, attempt limits, rate limits, cross-customer isolation, concurrent
 * verification, and no order lookup from an idempotency key. The sender is a mock
 * that records the code. No email is sent.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
process.env.CASHFREE_CLIENT_ID = 'TEST_RECOVERY_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_RECOVERY_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';
process.env.ORDER_TOKEN_SECRET = 'TEST_RECOVERY_ORDER_TOKEN_SECRET_0123456789abcdef';
process.env.OWNER_SESSION_SECRET = 'TEST_RECOVERY_OWNER_SESSION_SECRET_0123456789ab';
process.env.RECOVERY_CODE_SECRET = 'TEST_RECOVERY_HMAC_KEY_0123456789abcdef0123456789';

const { query, pool } = await import('../src/db/pool.js');
const {
    requestOrderRecovery,
    verifyOrderRecovery,
    normalizeContact,
    MAX_CHALLENGE_ATTEMPTS,
    REQUEST_LIMITS,
} = await import('../src/services/order-recovery.service.js');
const MAX_CHALLENGES_PER_CONTACT_PER_HOUR = REQUEST_LIMITS.contactPerHour;
const { verifyGuestAccessToken } = await import('../src/utils/order-token.js');
const { default: orderRoutes } = await import('../src/routes/order.routes.js');

const rand = () => Math.random().toString(36).substring(2, 9).toUpperCase();
const createdOrderIds = [];
const usedEmails = [];

// Mock sender: records the code it would have delivered. Never sends mail.
function recordingSender() {
    const sent = [];
    const sender = async message => { sent.push(message); };
    return { sent, sender };
}

function failingSender() {
    return async () => { throw Object.assign(new Error('smtp down'), { code: 'EMAIL_TRANSPORT_FAILED' }); };
}

async function createOrderRow({ email = null, phone = '9876543210', status = 'confirmed' } = {}) {
    const address = { name: 'Recovery Test', addressLine1: '1 Test Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', country: 'India' };
    const res = await query(
        `INSERT INTO orders (order_number, customer_name, phone, email, shipping_address,
                             subtotal, total_amount, currency, status, payment_status)
         VALUES ($1, 'Recovery Test', $2, $3, $4::jsonb, 100, 100, 'INR', $5, 'paid')
         RETURNING id, order_number`,
        [`REC-${rand()}`, phone, email, JSON.stringify(address), status]
    );
    createdOrderIds.push(res.rows[0].id);
    return res.rows[0];
}

async function challengesFor(contactEmail) {
    const hash = (await import('node:crypto')).createHash('sha256').update(`email:${contactEmail.toLowerCase()}`).digest('hex');
    return (await query(`SELECT * FROM order_recovery_challenges WHERE contact_hash = $1 ORDER BY created_at`, [hash])).rows;
}

function uniqueEmail() {
    const email = `recover-${rand().toLowerCase()}@example.test`;
    usedEmails.push(email);
    return email;
}

describe('Guest order recovery', () => {
    let server;
    let baseUrl;

    before(async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/orders', orderRoutes);
        app.use((error, req, res, next) => {
            res.status(error.statusCode || 500).json({ success: false, code: error.code, message: error.message });
        });
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
        for (const id of createdOrderIds) {
            await query(`DELETE FROM orders WHERE id = $1`, [id]);
        }
        await pool.end().catch(() => {});
    });

    test('1. Unknown contact gets the generic reply and no challenge or send', async () => {
        const { sent, sender } = recordingSender();
        const result = await requestOrderRecovery({ contact: { email: uniqueEmail() }, sender });

        assert.equal(result.outcome, 'no_match');
        assert.equal(result.accepted, true);
        assert.equal(sent.length, 0);
    });

    test('2. A matching recent order sends one code; only a hash is stored; the reply carries no code', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();

        const result = await requestOrderRecovery({ contact: { email }, sender });

        assert.equal(result.outcome, 'sent');
        assert.equal(sent.length, 1);
        assert.match(sent[0].code, /^\d{6}$/);
        assert.equal(sent[0].to, email);
        assert.doesNotMatch(JSON.stringify(result), new RegExp(sent[0].code));

        const rows = await challengesFor(email);
        assert.equal(rows.length, 1);
        assert.notEqual(rows[0].code_hash, sent[0].code, 'the code itself is never stored');
        assert.equal(rows[0].code_hash.length, 64);
    });

    test('3. The correct code returns the order and a guest token that verifies for that order only', async () => {
        const email = uniqueEmail();
        const order = await createOrderRow({ email });
        const { sent, sender } = recordingSender();
        await requestOrderRecovery({ contact: { email }, sender });

        const result = await verifyOrderRecovery({ contact: { email }, code: sent[0].code });

        assert.equal(result.order.order_number, order.order_number);
        assert.ok(result.guestAccessToken);
        const check = verifyGuestAccessToken({ token: result.guestAccessToken, orderNumber: order.order_number });
        assert.equal(check.valid, true);
        const otherOrder = verifyGuestAccessToken({ token: result.guestAccessToken, orderNumber: 'SOMEONE-ELSE' });
        assert.equal(otherOrder.valid, false, 'the token is bound to this order');
    });

    test('4. A code is single-use: replaying it fails with the generic error', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();
        await requestOrderRecovery({ contact: { email }, sender });

        await verifyOrderRecovery({ contact: { email }, code: sent[0].code });
        await assert.rejects(
            () => verifyOrderRecovery({ contact: { email }, code: sent[0].code }),
            (err) => err.code === 'RECOVERY_FAILED' && err.statusCode === 401
        );
    });

    test('5. Five wrong attempts lock the challenge, even for the correct code', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();
        await requestOrderRecovery({ contact: { email }, sender });
        const wrong = sent[0].code === '000000' ? '111111' : '000000';

        for (let i = 0; i < MAX_CHALLENGE_ATTEMPTS; i++) {
            await assert.rejects(() => verifyOrderRecovery({ contact: { email }, code: wrong }), (err) => err.code === 'RECOVERY_FAILED');
        }
        await assert.rejects(
            () => verifyOrderRecovery({ contact: { email }, code: sent[0].code }),
            (err) => err.code === 'RECOVERY_FAILED'
        );
    });

    test('6. An expired code fails even when correct', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();
        await requestOrderRecovery({ contact: { email }, sender });

        const later = new Date(Date.now() + 60 * 60 * 1000);
        await assert.rejects(
            () => verifyOrderRecovery({ contact: { email }, code: sent[0].code, clock: () => later }),
            (err) => err.code === 'RECOVERY_FAILED'
        );
    });

    test('7. Requests are rate limited per contact and send nothing once the limit is reached', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();

        for (let i = 0; i < MAX_CHALLENGES_PER_CONTACT_PER_HOUR; i++) {
            await requestOrderRecovery({ contact: { email }, sender });
        }
        const limited = await requestOrderRecovery({ contact: { email }, sender });

        assert.equal(limited.outcome, 'rate_limited');
        assert.equal(sent.length, MAX_CHALLENGES_PER_CONTACT_PER_HOUR);
    });

    test('8. A code for one customer cannot be used with another customer contact', async () => {
        const emailA = uniqueEmail();
        const emailB = uniqueEmail();
        await createOrderRow({ email: emailA });
        await createOrderRow({ email: emailB });
        const { sent, sender } = recordingSender();
        await requestOrderRecovery({ contact: { email: emailA }, sender });

        await assert.rejects(
            () => verifyOrderRecovery({ contact: { email: emailB }, code: sent[0].code }),
            (err) => err.code === 'RECOVERY_FAILED'
        );
    });

    test('9. A phone-only match creates no challenge, because no code can be delivered', async () => {
        const phone = '9123456789';
        await createOrderRow({ email: null, phone });
        const { sent, sender } = recordingSender();

        const result = await requestOrderRecovery({ contact: { phone }, sender });

        assert.equal(result.outcome, 'no_match');
        assert.equal(sent.length, 0);
    });

    test('10. A failed send leaves no usable code behind', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();

        const failed = await requestOrderRecovery({ contact: { email }, sender: failingSender() });
        assert.equal(failed.outcome, 'send_failed');

        const rows = await challengesFor(email);
        assert.ok(rows[0].consumed_at, 'the undelivered challenge is consumed');
        // A code that was never delivered cannot be used, even if it were guessed.
        const guess = '424242';
        await assert.rejects(() => verifyOrderRecovery({ contact: { email }, code: guess }), (err) => err.code === 'RECOVERY_FAILED');
        assert.equal(sent.length, 0);
    });

    test('11. Two concurrent submissions of the correct code: exactly one succeeds', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();
        await requestOrderRecovery({ contact: { email }, sender });

        const results = await Promise.allSettled([
            verifyOrderRecovery({ contact: { email }, code: sent[0].code }),
            verifyOrderRecovery({ contact: { email }, code: sent[0].code }),
        ]);

        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    });

    test('12. Recovery cannot start from an idempotency key or any other identifier', async () => {
        const res = await fetch(`${baseUrl}/api/orders/recovery/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'some-key-123' },
            body: JSON.stringify({ idempotencyKey: 'some-key-123', orderNumber: 'TCH-1' }),
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.code, 'VALIDATION');
    });

    test('13. The HTTP request reply is generic and never contains a code or token', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });

        // A real request uses the default sender, which fails closed. The reply must still be generic.
        const res = await fetch(`${baseUrl}/api/orders/recovery/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        });
        assert.equal(res.status, 202);
        const text = await res.text();
        const body = JSON.parse(text);
        assert.deepEqual(Object.keys(body).sort(), ['message', 'success']);
        assert.doesNotMatch(text, /guestAccessToken|order_number|d{6}/);
    });

    test('14. Verification rejects malformed codes and malformed contacts with generic or validation errors', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        await assert.rejects(() => verifyOrderRecovery({ contact: { email }, code: 'abc' }), (err) => err.code === 'RECOVERY_FAILED');
        assert.throws(() => normalizeContact({}), (err) => err.code === 'VALIDATION');
        assert.throws(() => normalizeContact({ email: 'not-an-email' }), (err) => err.code === 'VALIDATION');
        assert.throws(() => normalizeContact({ phone: '123' }), (err) => err.code === 'VALIDATION');
    });

    // ---- Workstream 1: keyed codes, limits, secrets, timing, logging ----

    test('15. A missing or short HMAC secret fails closed: no challenge, no send, no verification', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();

        await assert.rejects(
            () => requestOrderRecovery({ contact: { email }, sender, env: {} }),
            (err) => err.code === 'RECOVERY_UNAVAILABLE' && err.statusCode === 503
        );
        await assert.rejects(
            () => requestOrderRecovery({ contact: { email }, sender, env: { RECOVERY_CODE_SECRET: 'too-short' } }),
            (err) => err.code === 'RECOVERY_UNAVAILABLE'
        );
        await assert.rejects(
            () => verifyOrderRecovery({ contact: { email }, code: '123456', env: {} }),
            (err) => err.code === 'RECOVERY_UNAVAILABLE'
        );
        assert.equal(sent.length, 0);
        assert.equal((await challengesFor(email)).length, 0);
    });

    test('16. Stored codes are keyed: the plain SHA-256 of the code cannot reproduce the stored value', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();
        await requestOrderRecovery({ contact: { email }, sender });

        const row = (await challengesFor(email))[0];
        const plain = (await import('node:crypto')).createHash('sha256').update(`${row.id}:${sent[0].code}`).digest('hex');
        assert.notEqual(row.code_hash, plain, 'an unkeyed hash would allow offline guessing of six digits');

        // Guessing the stored value offline with the public scheme fails; the correct key is required.
        const keyed = (await import('node:crypto')).createHmac('sha256', process.env.RECOVERY_CODE_SECRET).update(`${row.id}:${sent[0].code}`).digest('hex');
        assert.equal(row.code_hash, keyed);
    });

    test('17. Rotating the secret invalidates codes issued before the rotation', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();
        await requestOrderRecovery({ contact: { email }, sender });

        const rotated = { RECOVERY_CODE_SECRET: 'ROTATED_RECOVERY_HMAC_KEY_0123456789abcdef0123' };
        await assert.rejects(
            () => verifyOrderRecovery({ contact: { email }, code: sent[0].code, env: rotated }),
            (err) => err.code === 'RECOVERY_FAILED'
        );
    });

    test('18. Requests from one client IP are limited across different contacts', async () => {
        const { sent, sender } = recordingSender();
        // A fresh address per run: rate-limit rows persist in the test database.
        const ip = `203.0.113.${crypto.randomInt(1, 255)}`;
        let last = null;
        for (let i = 0; i < 21; i++) {
            last = await requestOrderRecovery({ contact: { email: uniqueEmail() }, ipAddress: ip, sender });
        }
        assert.equal(last.outcome, 'rate_limited');
        assert.equal(sent.length, 0);
    });

    test('19. Parallel requests for one contact never exceed the contact limit', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();

        await Promise.all(Array.from({ length: 8 }, () => requestOrderRecovery({ contact: { email }, sender })));

        assert.ok(sent.length <= 3, `at most 3 codes may be sent per hour, got ${sent.length}`);
        assert.ok((await challengesFor(email)).length <= 3);
    });

    test('20. Parallel wrong guesses are capped by the verification limit, across challenges', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const { sent, sender } = recordingSender();
        await requestOrderRecovery({ contact: { email }, sender });
        const wrong = sent[0].code === '000000' ? '111111' : '000000';

        const results = await Promise.allSettled(
            Array.from({ length: 12 }, () => verifyOrderRecovery({ contact: { email }, code: wrong }))
        );
        assert.ok(results.every(r => r.status === 'rejected'));

        const hash = (await import('node:crypto')).createHash('sha256').update(`email:${email}`).digest('hex');
        const counted = (await query(
            `SELECT COUNT(*)::int AS n FROM rate_limit_events WHERE scope = 'recovery_verify_contact' AND key_hash = $1`,
            [hash]
        )).rows[0].n;
        assert.ok(counted <= 10, `verification attempts are capped at 10 per window, counted ${counted}`);
    });

    test('21. Every recovery reply takes at least the minimum response time, matched or not', async () => {
        const { RECOVERY_MIN_RESPONSE_MS } = await import('../src/controllers/order.controller.js');
        const email = uniqueEmail();
        await createOrderRow({ email });

        const timed = async body => {
            const started = Date.now();
            const res = await fetch(`${baseUrl}/api/orders/recovery/request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            await res.text();
            return Date.now() - started;
        };

        const matchedMs = await timed({ email });
        const unmatchedMs = await timed({ email: uniqueEmail() });
        assert.ok(matchedMs >= RECOVERY_MIN_RESPONSE_MS - 20, `matched took ${matchedMs} ms`);
        assert.ok(unmatchedMs >= RECOVERY_MIN_RESPONSE_MS - 20, `unmatched took ${unmatchedMs} ms`);
    });

    test('22. Logs never contain the contact, the code, or a token during a request', async () => {
        const email = uniqueEmail();
        await createOrderRow({ email });
        const lines = [];
        const original = console.info;
        console.info = (...args) => { lines.push(args.map(String).join(' ')); };
        try {
            await fetch(`${baseUrl}/api/orders/recovery/request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
        } finally {
            console.info = original;
        }
        const text = lines.join('\n');
        assert.doesNotMatch(text, new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(text, /\b\d{6}\b|guestAccessToken|eyJ/);
    });
});
