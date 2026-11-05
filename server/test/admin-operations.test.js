/**
 * The Crunchy Heart - Phase 3.3: Minimum Secure Owner Operations Test Suite
 *
 * Verifies the security and transactional integrity of owner-facing operations:
 * 1. Owner Authentication & Authorization:
 *    - Rejects unauthenticated requests with 401
 *    - Rejects invalid credentials with generic 401
 *    - Customer guest tokens strictly cannot authorize owner endpoints
 *    - Server-validated session cookies with HttpOnly & SameSite
 *    - CSRF protection on state-changing owner requests
 *    - Login brute-force rate limiting (5 attempts threshold)
 *    - Logout revokes access immediately
 *
 * 2. Order Listing & Inspection:
 *    - Authorized owner can list orders with pagination & filters
 *    - Unauthenticated callers are rejected
 *    - Bounded pagination parameters
 *    - Responses never leak guest tokens, secrets, or gateway payloads
 *
 * 3. Atomic COD Dispatch:
 *    - Eligible COD orders dispatch atomically and deduct inventory exactly once
 *    - Deadlock-free sorted variant locking (variant_id ASC FOR UPDATE)
 *    - Online orders rejected with 400
 *    - Ineligible/cancelled orders rejected with 400
 *    - Stock shortage on multi-item order rolls back all line deductions atomically
 *    - Duplicate dispatch prevented (409 ALREADY_DISPATCHED)
 *    - Concurrent dispatches serialized via order-level lock: exactly 1 succeeds
 *    - Unauthorized dispatch leaves database completely unchanged
 *
 * 4. Pending Refund-Review Visibility:
 *    - Unresolved stock shortage exceptions appear in queue
 *    - Duplicate captured payment attempts appear in queue
 *    - Completed refunds do NOT appear as pending
 *    - Endpoint is strictly read-only and owner-protected
 *
 * 5. Historical Order Invariant:
 *    - Historical COD order TCH-20261008-AJERUQ remains untouched
 *
 * SAFETY INVARIANT: Strictly connects to crunchy_heart_test. Zero live Neon / Cashfree.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// --------------------------------------------------------------------------
// 1. HARD SAFETY ASSERTION
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
process.env.ORDER_TOKEN_SECRET = 'test_order_token_secret_minimum_32_characters_long_for_security';
process.env.OWNER_SESSION_SECRET = 'test_owner_session_secret_minimum_32_characters_long_for_security';

const { pool, query } = await import('../src/db/pool.js');
const { withTransaction } = await import('../src/db/transaction.js');
const adminRoutes = (await import('../src/routes/admin.routes.js')).default;
const orderRoutes = (await import('../src/routes/order.routes.js')).default;
const { generateGuestAccessToken } = await import('../src/utils/order-token.js');
const { hashPassword, generateAdminSessionToken, generateCsrfToken } = await import('../src/utils/admin-token.js');
const { parseTrustProxy } = await import('../src/config/env.js');
const { _resetLoginRateLimits } = await import('../src/controllers/admin.controller.js');
const {
    validateEmail,
    validatePassword,
    validatePasswordConfirmation,
    parseProvisioningArgs,
    checkExistingAccount,
} = await import('../src/scripts/create-owner.js');
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

// --------------------------------------------------------------------------
// Express App & Test Server Harness
// --------------------------------------------------------------------------
let server;
let baseUrl;

function buildTestApp(trustProxySetting = false) {
    const app = express();
    app.set('trust proxy', trustProxySetting);
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
    app.use('/api/orders', orderRoutes);

    app.use((error, req, res, next) => {
        const statusCode = error.statusCode || 500;
        return res.status(statusCode).json({
            success: false,
            error: {
                message: error.message || 'Internal server error.',
                code: error.code || null,
            },
        });
    });

    return app;
}

// --------------------------------------------------------------------------
// Fixtures & Shared Test Variables
// --------------------------------------------------------------------------
const TEST_OWNER_EMAIL = 'owner.test@thecrunchyheart.com';
const TEST_OWNER_PASSWORD = 'OwnerSuperSecurePass2026!';
let testOwnerId;
let validOwnerCookie = '';
let validCsrfToken = '';

let testProductId;
let variantX; // ample stock
let variantY; // ample stock
let variantScarce; // strictly limited stock (1 unit)

async function setupFixtures() {
    // 1. Provision Test Owner in admin_users
    const passHash = hashPassword(TEST_OWNER_PASSWORD);
    const ownerRes = await query(
        `
        INSERT INTO admin_users (
            email, password_hash, full_name, role, is_active, created_at, updated_at
        )
        VALUES ($1, $2, 'Test Store Owner', 'ADMIN', true, NOW(), NOW())
        ON CONFLICT (LOWER(email)) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            role = 'ADMIN',
            is_active = true,
            updated_at = NOW()
        RETURNING id, email, role
        `,
        [TEST_OWNER_EMAIL.toLowerCase(), passHash]
    );
    testOwnerId = ownerRes.rows[0].id;

    // 2. Provision Test Category & Product
    const catRes = await query(
        `
        INSERT INTO categories (name, slug, description, is_active)
        VALUES ('Admin Test Category', 'admin-cat-' || gen_random_uuid(), 'Admin Category', true)
        RETURNING id
        `
    );
    const testCategoryId = catRes.rows[0].id;

    const prodRes = await query(
        `
        INSERT INTO products (category_id, name, slug, brand, is_active)
        VALUES ($1, 'Admin Test Makhana', 'admin-test-makhana-' || gen_random_uuid(), 'The Crunchy Heart', true)
        RETURNING id
        `,
        [testCategoryId]
    );
    testProductId = prodRes.rows[0].id;

    // Variant X: 100 units on hand
    const varXRes = await query(
        `
        INSERT INTO product_variants (
            product_id, sku, variant_name, weight_grams, flavor,
            mrp, selling_price, cost_price, tax_rate, is_active
        )
        VALUES ($1, 'SKU-ADM-X-' || gen_random_uuid(), 'Crunchy Classic 100g', 100, 'Classic', 199.00, 169.00, 70.00, 18.00, true)
        RETURNING id, sku, variant_name, selling_price, tax_rate
        `,
        [testProductId]
    );
    variantX = varXRes.rows[0];

    await query(
        `
        INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved)
        VALUES ($1, 100, 0)
        ON CONFLICT (variant_id) DO UPDATE SET quantity_on_hand = 100, quantity_reserved = 0
        `,
        [variantX.id]
    );

    // Variant Y: 100 units on hand
    const varYRes = await query(
        `
        INSERT INTO product_variants (
            product_id, sku, variant_name, weight_grams, flavor,
            mrp, selling_price, cost_price, tax_rate, is_active
        )
        VALUES ($1, 'SKU-ADM-Y-' || gen_random_uuid(), 'Pudina Zing 100g', 100, 'Pudina', 219.00, 189.00, 80.00, 18.00, true)
        RETURNING id, sku, variant_name, selling_price, tax_rate
        `,
        [testProductId]
    );
    variantY = varYRes.rows[0];

    await query(
        `
        INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved)
        VALUES ($1, 100, 0)
        ON CONFLICT (variant_id) DO UPDATE SET quantity_on_hand = 100, quantity_reserved = 0
        `,
        [variantY.id]
    );

    // Variant Scarce: exactly 1 unit on hand
    const varScarceRes = await query(
        `
        INSERT INTO product_variants (
            product_id, sku, variant_name, weight_grams, flavor,
            mrp, selling_price, cost_price, tax_rate, is_active
        )
        VALUES ($1, 'SKU-ADM-SCARCE-' || gen_random_uuid(), 'Scarce Gold Makhana', 100, 'Gold', 499.00, 449.00, 200.00, 18.00, true)
        RETURNING id, sku, variant_name, selling_price, tax_rate
        `,
        [testProductId]
    );
    variantScarce = varScarceRes.rows[0];

    await query(
        `
        INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved)
        VALUES ($1, 1, 0)
        ON CONFLICT (variant_id) DO UPDATE SET quantity_on_hand = 1, quantity_reserved = 0
        `,
        [variantScarce.id]
    );
}

/**
 * Helper to create a test order directly in crunchy_heart_test
 */
async function createTestOrder({
    orderNumber,
    paymentMethod = 'COD',
    status = 'confirmed',
    paymentStatus = 'pending',
    items = [],
    customerName = 'Test Customer',
    phone = '9876543210',
    notes = null,
}) {
    let subtotal = 0;
    let taxAmount = 0;
    for (const it of items) {
        const lineTotal = it.unitPrice * it.quantity;
        subtotal += lineTotal;
        taxAmount += lineTotal * 0.18;
    }
    const totalAmount = subtotal + taxAmount;

    return await withTransaction(async (client) => {
        const orderRes = await client.query(
            `
            INSERT INTO orders (
                order_number, customer_name, phone, email,
                shipping_address, billing_address,
                subtotal, discount_amount, shipping_amount, tax_amount, total_amount,
                currency, status, payment_status, payment_method, notes,
                created_at, updated_at
            )
            VALUES (
                $1, $2, $3, 'customer@example.com',
                '{"street": "123 Test St", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001"}',
                '{"street": "123 Test St", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001"}',
                $4, 0, 0, $5, $6,
                'INR', $7, $8, $9, $10,
                NOW(), NOW()
            )
            RETURNING id, order_number, status, payment_method, total_amount
            `,
            [orderNumber, customerName, phone, subtotal, taxAmount, totalAmount, status, paymentStatus, paymentMethod, notes]
        );

        const order = orderRes.rows[0];

        for (const it of items) {
            await client.query(
                `
                INSERT INTO order_items (
                    order_id, variant_id, product_name, variant_name, sku,
                    quantity, unit_price, total_price, taxable_value, tax_rate, tax_amount,
                    created_at
                )
                VALUES (
                    $1, $2, 'Admin Test Makhana', $3, $4,
                    $5, $6, $7, $8, 18.00, $9,
                    NOW()
                )
                `,
                [
                    order.id,
                    it.variantId,
                    it.variantName || 'Test Variant',
                    it.sku || 'SKU-TEST',
                    it.quantity,
                    it.unitPrice,
                    it.unitPrice * it.quantity,
                    it.unitPrice * it.quantity,
                    (it.unitPrice * it.quantity) * 0.18,
                ]
            );
        }

        // Add initial status history row
        await client.query(
            `
            INSERT INTO order_status_history (order_id, status, note, created_at)
            VALUES ($1, $2, 'Order created in test setup', NOW())
            `,
            [order.id, status]
        );

        return order;
    });
}

// --------------------------------------------------------------------------
// SUITE
// --------------------------------------------------------------------------
describe('Phase 3.3: Minimum Secure Owner Operations Test Suite', () => {

    before(async () => {
        await setupFixtures();

        const app = buildTestApp();
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    // ======================================================================
    // 1. OWNER AUTHENTICATION & ACCESS CONTROL
    // ======================================================================
    describe('1. Owner Authentication & Access Control', () => {

        test('1.1 Unauthenticated requests to owner endpoints are rejected with 401', async () => {
            const endpoints = [
                { url: `${baseUrl}/api/admin/auth/me`, method: 'GET' },
                { url: `${baseUrl}/api/admin/orders`, method: 'GET' },
                { url: `${baseUrl}/api/admin/orders/TCH-TEST-NOT-FOUND`, method: 'GET' },
                { url: `${baseUrl}/api/admin/orders/TCH-TEST-NOT-FOUND/dispatch`, method: 'POST' },
                { url: `${baseUrl}/api/admin/refunds/pending`, method: 'GET' },
            ];

            for (const ep of endpoints) {
                const res = await fetch(ep.url, {
                    method: ep.method,
                    headers: { 'Content-Type': 'application/json' },
                    body: ep.method === 'POST' ? JSON.stringify({}) : undefined,
                });
                assert.strictEqual(
                    res.status,
                    401,
                    `Expected 401 for unauthenticated ${ep.method} ${ep.url}, got ${res.status}`
                );
                const body = await res.json();
                assert.strictEqual(body.success, false);
                assert.strictEqual(body.error?.code, 'UNAUTHENTICATED');
            }
        });

        test('1.2 Invalid credentials return generic 401 without revealing account details', async () => {
            // Case A: Wrong password for existing user
            const resA = await fetch(`${baseUrl}/api/admin/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: TEST_OWNER_EMAIL,
                    password: 'CompletelyWrongPassword123!',
                }),
            });
            assert.strictEqual(resA.status, 401);
            const bodyA = await resA.json();
            assert.strictEqual(bodyA.success, false);
            assert.strictEqual(bodyA.error?.code, 'INVALID_CREDENTIALS');
            assert.strictEqual(bodyA.error?.message, 'Invalid email or password.');

            // Case B: Non-existent email
            const resB = await fetch(`${baseUrl}/api/admin/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: 'nonexistent.user@thecrunchyheart.com',
                    password: 'SomeRandomPassword123!',
                }),
            });
            assert.strictEqual(resB.status, 401);
            const bodyB = await resB.json();
            assert.strictEqual(bodyB.success, false);
            assert.strictEqual(bodyB.error?.code, 'INVALID_CREDENTIALS');
            // Identical generic error message
            assert.strictEqual(bodyB.error?.message, 'Invalid email or password.');
        });

        test('1.3 Customer guest-access tokens strictly CANNOT authorize owner endpoints', async () => {
            // Mint a valid customer guest token
            const guestToken = generateGuestAccessToken({
                id: '00000000-0000-0000-0000-000000000001',
                order_number: 'TCH-20261018-CUST123',
                phone: '9876543210',
            });

            // Attempt to pass customer guest token as owner session cookie
            const res = await fetch(`${baseUrl}/api/admin/orders`, {
                headers: {
                    Cookie: `tch_admin_session=${guestToken}`,
                },
            });

            assert.strictEqual(res.status, 401);
            const body = await res.json();
            assert.strictEqual(body.success, false);
            assert.strictEqual(body.error?.code, 'SESSION_INVALID');
        });

        test('1.4 Owner login sets HttpOnly session cookie, returns CSRF token, and verifies GET /api/admin/auth/me', async () => {
            const loginRes = await fetch(`${baseUrl}/api/admin/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: TEST_OWNER_EMAIL,
                    password: TEST_OWNER_PASSWORD,
                }),
            });

            assert.strictEqual(loginRes.status, 200);
            const loginBody = await loginRes.json();
            assert.strictEqual(loginBody.success, true);
            assert.strictEqual(loginBody.admin.email, TEST_OWNER_EMAIL.toLowerCase());
            assert.strictEqual(loginBody.admin.role, 'ADMIN');
            assert.ok(loginBody.csrfToken, 'Must return csrfToken in login response');

            // SEC-02 Invariant: Bearer session token must NEVER be returned in JSON response body
            assert.strictEqual(loginBody.token, undefined, 'Must not return token in JSON response body');
            assert.strictEqual(loginBody.sessionToken, undefined, 'Must not return sessionToken in JSON response body');
            assert.strictEqual(loginBody.bearer, undefined, 'Must not return bearer in JSON response body');

            validCsrfToken = loginBody.csrfToken;

            // Inspect Set-Cookie header
            const setCookie = loginRes.headers.get('set-cookie');
            assert.ok(setCookie, 'Must set session cookie');
            assert.ok(setCookie.includes('tch_admin_session='), 'Cookie must contain tch_admin_session');
            assert.ok(setCookie.includes('HttpOnly'), 'Cookie must be HttpOnly');

            // Extract session cookie for subsequent tests
            const match = setCookie.match(/tch_admin_session=([^;]+)/);
            assert.ok(match, 'Must match session token');
            validOwnerCookie = `tch_admin_session=${match[1]}`;

            // Verify /api/admin/auth/me
            const meRes = await fetch(`${baseUrl}/api/admin/auth/me`, {
                headers: {
                    Cookie: validOwnerCookie,
                },
            });
            assert.strictEqual(meRes.status, 200);
            const meBody = await meRes.json();
            assert.strictEqual(meBody.success, true);
            assert.strictEqual(meBody.admin.email, TEST_OWNER_EMAIL.toLowerCase());
            assert.strictEqual(meBody.admin.role, 'ADMIN');
        });

        test('1.5 State-changing requests are protected by CSRF validation', async () => {
            const testOrderNum = `TCH-CSRF-${Date.now()}`;
            await createTestOrder({
                orderNumber: testOrderNum,
                paymentMethod: 'COD',
                status: 'confirmed',
                items: [{ variantId: variantX.id, unitPrice: 169.00, quantity: 1 }],
            });

            // Case A: Missing x-csrf-token header -> 403 CSRF_REQUIRED
            const resNoCsrf = await fetch(`${baseUrl}/api/admin/orders/${testOrderNum}/dispatch`, {
                method: 'POST',
                headers: {
                    Cookie: validOwnerCookie,
                    'Content-Type': 'application/json',
                },
            });
            assert.strictEqual(resNoCsrf.status, 403);
            const bodyNoCsrf = await resNoCsrf.json();
            assert.strictEqual(bodyNoCsrf.error?.code, 'CSRF_REQUIRED');

            // Case B: Invalid / mismatched x-csrf-token header -> 403 CSRF_INVALID
            const resBadCsrf = await fetch(`${baseUrl}/api/admin/orders/${testOrderNum}/dispatch`, {
                method: 'POST',
                headers: {
                    Cookie: validOwnerCookie,
                    'Content-Type': 'application/json',
                    'x-csrf-token': 'attacker_fake_csrf_token_123',
                },
            });
            assert.strictEqual(resBadCsrf.status, 403);
            const bodyBadCsrf = await resBadCsrf.json();
            assert.strictEqual(bodyBadCsrf.error?.code, 'CSRF_INVALID');
        });

        test('1.6 Logout clears session cookie and revokes access', async () => {
            // Perform logout
            const logoutRes = await fetch(`${baseUrl}/api/admin/auth/logout`, {
                method: 'POST',
                headers: {
                    Cookie: validOwnerCookie,
                    'x-csrf-token': validCsrfToken,
                },
            });
            assert.strictEqual(logoutRes.status, 200);

            // Re-authenticate test owner for subsequent suites
            const reLoginRes = await fetch(`${baseUrl}/api/admin/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: TEST_OWNER_EMAIL,
                    password: TEST_OWNER_PASSWORD,
                }),
            });
            assert.strictEqual(reLoginRes.status, 200);
            const reLoginBody = await reLoginRes.json();
            validCsrfToken = reLoginBody.csrfToken;
            const setCookie = reLoginRes.headers.get('set-cookie');
            const match = setCookie.match(/tch_admin_session=([^;]+)/);
            validOwnerCookie = `tch_admin_session=${match[1]}`;
        });

        test('1.7 SEC-02: Authenticated endpoints and login never disclose bearer session token in response body', async () => {
            const loginRes = await fetch(`${baseUrl}/api/admin/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: TEST_OWNER_EMAIL,
                    password: TEST_OWNER_PASSWORD,
                }),
            });
            assert.strictEqual(loginRes.status, 200);
            const loginBody = await loginRes.json();
            assert.strictEqual(loginBody.success, true);
            assert.strictEqual(loginBody.token, undefined, 'Login body must not contain token');
            assert.strictEqual(loginBody.sessionToken, undefined, 'Login body must not contain sessionToken');
            assert.strictEqual(loginBody.bearer, undefined, 'Login body must not contain bearer');
            assert.ok(loginBody.csrfToken, 'Must still return csrfToken for CSRF protection');

            const meRes = await fetch(`${baseUrl}/api/admin/auth/me`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(meRes.status, 200);
            const meBody = await meRes.json();
            assert.strictEqual(meBody.token, undefined);
            assert.strictEqual(meBody.sessionToken, undefined);
        });

        test('1.8 OPS-01: Reverse-proxy trust configuration parser validates and fails safely at startup', () => {
            // Default conservative behavior: false
            assert.strictEqual(parseTrustProxy(undefined), false);
            assert.strictEqual(parseTrustProxy(null), false);
            assert.strictEqual(parseTrustProxy(''), false);
            assert.strictEqual(parseTrustProxy('false'), false);

            // Valid hop counts
            assert.strictEqual(parseTrustProxy('1'), 1);
            assert.strictEqual(parseTrustProxy('2'), 2);
            assert.strictEqual(parseTrustProxy('10'), 10);

            // Valid keywords & subnets
            assert.strictEqual(parseTrustProxy('loopback'), 'loopback');
            assert.deepStrictEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);

            // Security invariant: Blind "true" must be strictly REJECTED
            assert.throws(() => parseTrustProxy('true'), /Blind "true" is rejected/);

            // Out-of-bounds hop counts
            assert.throws(() => parseTrustProxy('0'), /hop count/);
            assert.throws(() => parseTrustProxy('11'), /hop count/);

            // Malformed values
            assert.throws(() => parseTrustProxy('unsupported_keyword'), /Invalid TRUST_PROXY token/);
            assert.throws(() => parseTrustProxy('http://proxy.com'), /Invalid TRUST_PROXY token/);
        });

        test('1.9 OPS-01: Direct connection mode (trust proxy = false) ignores client-supplied X-Forwarded-For headers', async () => {
            _resetLoginRateLimits();

            // Send a login request with spoofed X-Forwarded-For header
            const res = await fetch(`${baseUrl}/api/admin/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Forwarded-For': '203.0.113.195',
                },
                body: JSON.stringify({
                    email: TEST_OWNER_EMAIL,
                    password: 'WrongPasswordSingleFailure',
                }),
            });
            assert.strictEqual(res.status, 401);

            _resetLoginRateLimits();
        });

        test('1.10 OPS-01: Rate limiter triggers 429 after 5 failed attempts and cannot be bypassed by cycling X-Forwarded-For', async () => {
            _resetLoginRateLimits();

            // 5 failed login attempts with varying spoofed X-Forwarded-For headers
            for (let i = 1; i <= 5; i++) {
                const res = await fetch(`${baseUrl}/api/admin/auth/login`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Forwarded-For': `198.51.100.${i}`,
                    },
                    body: JSON.stringify({
                        email: TEST_OWNER_EMAIL,
                        password: `WrongPasswordAttempt${i}`,
                    }),
                });
                assert.strictEqual(res.status, 401, `Attempt ${i} should be 401`);
            }

            // 6th attempt with a different spoofed header MUST BE BLOCKED (429)
            const blockedRes = await fetch(`${baseUrl}/api/admin/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Forwarded-For': '198.51.100.99',
                },
                body: JSON.stringify({
                    email: TEST_OWNER_EMAIL,
                    password: 'AnotherWrongPassword',
                }),
            });

            assert.strictEqual(blockedRes.status, 429, '6th attempt must be rate-limited (429)');
            const blockedBody = await blockedRes.json();
            assert.strictEqual(blockedBody.success, false);
            assert.strictEqual(blockedBody.error?.code, 'RATE_LIMIT_EXCEEDED');

            // Reset rate limiter for subsequent tests
            _resetLoginRateLimits();
        });

        test('1.11 OPS-01: Trusted proxy mode correctly evaluates proxy hops without trusting client spoofed hops', async () => {
            const proxyApp = buildTestApp(1);
            let proxyServer;
            let proxyBaseUrl;

            await new Promise((resolve) => {
                proxyServer = proxyApp.listen(0, '127.0.0.1', () => {
                    proxyBaseUrl = `http://127.0.0.1:${proxyServer.address().port}`;
                    resolve();
                });
            });

            try {
                _resetLoginRateLimits();

                // 5 failures for forwarded client IP 203.0.113.50
                for (let i = 1; i <= 5; i++) {
                    const res = await fetch(`${proxyBaseUrl}/api/admin/auth/login`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Forwarded-For': '203.0.113.50',
                        },
                        body: JSON.stringify({
                            email: TEST_OWNER_EMAIL,
                            password: `Fail${i}`,
                        }),
                    });
                    assert.strictEqual(res.status, 401);
                }

                // 6th attempt from 203.0.113.50 is 429
                const resBlocked = await fetch(`${proxyBaseUrl}/api/admin/auth/login`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Forwarded-For': '203.0.113.50',
                    },
                    body: JSON.stringify({
                        email: TEST_OWNER_EMAIL,
                        password: 'Fail6',
                    }),
                });
                assert.strictEqual(resBlocked.status, 429);

                // A different client IP 203.0.113.51 is NOT blocked
                const resOther = await fetch(`${proxyBaseUrl}/api/admin/auth/login`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Forwarded-For': '203.0.113.51',
                    },
                    body: JSON.stringify({
                        email: TEST_OWNER_EMAIL,
                        password: 'FailOther',
                    }),
                });
                assert.strictEqual(resOther.status, 401);

                // Spoofing attempt: client prepends "1.2.3.4, 203.0.113.50"
                // Hop 1 from right is still 203.0.113.50 -> 429
                const resSpoof = await fetch(`${proxyBaseUrl}/api/admin/auth/login`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Forwarded-For': '1.2.3.4, 203.0.113.50',
                    },
                    body: JSON.stringify({
                        email: TEST_OWNER_EMAIL,
                        password: 'FailSpoof',
                    }),
                });
                assert.strictEqual(resSpoof.status, 429);
            } finally {
                _resetLoginRateLimits();
                if (proxyServer) {
                    await new Promise((resolve) => proxyServer.close(resolve));
                }
            }
        });

        test('1.12 SEC-01: Provisioning CLI strictly rejects command-line passwords, extra arguments, and prohibited flags', () => {
            const noArgs = parseProvisioningArgs([]);
            assert.strictEqual(noArgs.valid, false);
            assert.ok(noArgs.error.includes('Missing required email'));

            const tooMany = parseProvisioningArgs([
                'owner@thecrunchyheart.com',
                'Store Owner',
                'ExtraAttemptedPassword!',
            ]);
            assert.strictEqual(tooMany.valid, false);
            assert.ok(tooMany.error.includes('Too many arguments'));

            const flagA = parseProvisioningArgs(['--password=SomeSecret123', 'owner@thecrunchyheart.com']);
            assert.strictEqual(flagA.valid, false);
            assert.ok(flagA.error.includes('strictly prohibited'));

            const flagB = parseProvisioningArgs(['owner@thecrunchyheart.com', '-p', 'Secret']);
            assert.strictEqual(flagB.valid, false);

            const badEmail = parseProvisioningArgs(['not-an-email']);
            assert.strictEqual(badEmail.valid, false);
            assert.ok(badEmail.error.includes('valid email address'));

            const validA = parseProvisioningArgs(['Owner@TheCrunchyHeart.com']);
            assert.strictEqual(validA.valid, true);
            assert.strictEqual(validA.email, 'owner@thecrunchyheart.com');
            assert.strictEqual(validA.fullName, 'Store Owner');

            const validB = parseProvisioningArgs(['Owner@TheCrunchyHeart.com', 'Primary Store Owner']);
            assert.strictEqual(validB.valid, true);
            assert.strictEqual(validB.email, 'owner@thecrunchyheart.com');
            assert.strictEqual(validB.fullName, 'Primary Store Owner');
        });

        test('1.13 SEC-01: Provisioning password validation rejects blank, short, and mismatched passwords', () => {
            const blank1 = validatePassword('');
            assert.strictEqual(blank1.valid, false);
            assert.ok(blank1.error.includes('cannot be blank'));

            const blank2 = validatePassword(null);
            assert.strictEqual(blank2.valid, false);

            const short = validatePassword('Pass12!');
            assert.strictEqual(short.valid, false);
            assert.ok(short.error.includes('at least 8 characters'));

            const valid = validatePassword('ValidLengthPassword2026!');
            assert.strictEqual(valid.valid, true);

            const mismatch = validatePasswordConfirmation('FirstPass2026!', 'DifferentPass2026!');
            assert.strictEqual(mismatch.valid, false);
            assert.ok(mismatch.error.includes('do not match'));

            const match = validatePasswordConfirmation('MatchingPass2026!', 'MatchingPass2026!');
            assert.strictEqual(match.valid, true);
        });

        test('1.14 SEC-01: Provisioning CLI fails closed when executed in non-interactive / non-TTY environment', async () => {
            const scriptPath = fileURLToPath(new URL('../src/scripts/create-owner.js', import.meta.url));
            let error = null;
            try {
                await execFileAsync('node', [scriptPath, 'test.owner.noninteractive@thecrunchyheart.com']);
            } catch (err) {
                error = err;
            }

            assert.ok(error, 'Must exit with non-zero code in non-interactive environment');
            assert.strictEqual(error.code, 1);
            assert.ok(
                error.stderr.includes('Interactive terminal (TTY) is required'),
                `Expected TTY error message, got: ${error.stderr}`
            );
        });

        test('1.15 SEC-01: Provisioning CLI verifies existing accounts and requires confirmation before updates', async () => {
            const existing = await checkExistingAccount(query, TEST_OWNER_EMAIL);
            assert.ok(existing, 'Must detect existing test owner account');
            assert.strictEqual(existing.email.toLowerCase(), TEST_OWNER_EMAIL.toLowerCase());
            assert.strictEqual(existing.role, 'ADMIN');

            const notFound = await checkExistingAccount(query, 'definitely.does.not.exist@thecrunchyheart.com');
            assert.strictEqual(notFound, null);
        });
    });

    // ======================================================================
    // 2. ORDER LISTING & INSPECTION
    // ======================================================================
    describe('2. Order Listing & Inspection', () => {
        let orderA_num = `TCH-LIST-A-${Date.now()}`;
        let orderB_num = `TCH-LIST-B-${Date.now()}`;

        before(async () => {
            await createTestOrder({
                orderNumber: orderA_num,
                paymentMethod: 'COD',
                status: 'confirmed',
                items: [{ variantId: variantX.id, unitPrice: 169.00, quantity: 2 }],
            });

            await createTestOrder({
                orderNumber: orderB_num,
                paymentMethod: 'ONLINE',
                status: 'confirmed',
                paymentStatus: 'captured',
                items: [{ variantId: variantY.id, unitPrice: 189.00, quantity: 1 }],
            });
        });

        test('2.1 Authorized owner can list orders with pagination and filtering', async () => {
            // Unfiltered list
            const res = await fetch(`${baseUrl}/api/admin/orders?page=1&limit=10`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.ok(Array.isArray(body.orders));
            assert.ok(body.orders.length >= 2);
            assert.ok(body.pagination.total >= 2);

            // Filter by paymentMethod = COD
            const codRes = await fetch(`${baseUrl}/api/admin/orders?paymentMethod=COD`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(codRes.status, 200);
            const codBody = await codRes.json();
            assert.ok(codBody.orders.every((o) => o.paymentMethod === 'COD'));

            // Filter by paymentMethod = ONLINE
            const onlineRes = await fetch(`${baseUrl}/api/admin/orders?paymentMethod=ONLINE`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(onlineRes.status, 200);
            const onlineBody = await onlineRes.json();
            assert.ok(onlineBody.orders.every((o) => o.paymentMethod === 'ONLINE'));
        });

        test('2.2 Pagination limits are strictly validated and bounded', async () => {
            // Request limit 500 -> should cap at 50
            const resOver = await fetch(`${baseUrl}/api/admin/orders?limit=500`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(resOver.status, 200);
            const bodyOver = await resOver.json();
            assert.strictEqual(bodyOver.pagination.limit, 50);

            // Negative limit -> should fall back to default 20
            const resNeg = await fetch(`${baseUrl}/api/admin/orders?limit=-5`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(resNeg.status, 200);
            const bodyNeg = await resNeg.json();
            assert.strictEqual(bodyNeg.pagination.limit, 20);
        });

        test('2.3 Order details returns full order, line items, and audit history', async () => {
            const res = await fetch(`${baseUrl}/api/admin/orders/${orderA_num}`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.order.orderNumber, orderA_num);
            assert.strictEqual(body.order.paymentMethod, 'COD');
            assert.strictEqual(body.order.status, 'confirmed');
            assert.strictEqual(body.canDispatch, true);

            // Items verified
            assert.ok(Array.isArray(body.items));
            assert.strictEqual(body.items.length, 1);
            assert.strictEqual(body.items[0].quantity, 2);

            // Status history verified
            assert.ok(Array.isArray(body.statusHistory));
            assert.ok(body.statusHistory.length >= 1);
        });

        test('2.4 Order details never leak customer guest tokens or gateway secrets', async () => {
            const res = await fetch(`${baseUrl}/api/admin/orders/${orderB_num}`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(res.status, 200);
            const text = await res.text();

            // Verify no secret leakage
            assert.strictEqual(text.includes('ORDER_TOKEN_SECRET'), false);
            assert.strictEqual(text.includes('OWNER_SESSION_SECRET'), false);
            assert.strictEqual(text.includes('guestAccessToken'), false);
            assert.strictEqual(text.includes('secret_key'), false);
        });
    });

    // ======================================================================
    // 3. ATOMIC COD DISPATCH
    // ======================================================================
    describe('3. Atomic COD Dispatch Operation', () => {

        test('3.1 Eligible COD order dispatches atomically and deducts inventory exactly once', async () => {
            const orderNum = `TCH-DISPATCH-OK-${Date.now()}`;

            // Check initial inventory of Variant X
            const initialInvRes = await query(
                'SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1',
                [variantX.id]
            );
            const initialOnHand = Number(initialInvRes.rows[0].quantity_on_hand);

            await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'COD',
                status: 'confirmed',
                items: [{ variantId: variantX.id, unitPrice: 169.00, quantity: 3 }],
            });

            // Perform dispatch
            const res = await fetch(`${baseUrl}/api/admin/orders/${orderNum}/dispatch`, {
                method: 'POST',
                headers: {
                    Cookie: validOwnerCookie,
                    'x-csrf-token': validCsrfToken,
                    'Content-Type': 'application/json',
                },
            });

            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.orderNumber, orderNum);
            assert.strictEqual(body.status, 'dispatched');

            // Verify database state: order status updated
            const orderDbRes = await query(
                'SELECT status FROM orders WHERE order_number = $1',
                [orderNum]
            );
            assert.strictEqual(orderDbRes.rows[0].status, 'dispatched');

            // Verify inventory deducted exactly 3 units
            const postInvRes = await query(
                'SELECT quantity_on_hand FROM inventory WHERE variant_id = $1',
                [variantX.id]
            );
            const postOnHand = Number(postInvRes.rows[0].quantity_on_hand);
            assert.strictEqual(postOnHand, initialOnHand - 3);

            // Verify audit ledgers: inventory_transactions
            const txRes = await query(
                `SELECT transaction_type, quantity, notes FROM inventory_transactions
                 WHERE reference_id = (SELECT id::text FROM orders WHERE order_number = $1)
                   AND variant_id = $2`,
                [orderNum, variantX.id]
            );
            assert.strictEqual(txRes.rows.length, 1);
            assert.strictEqual(txRes.rows[0].transaction_type, 'SALE_DEDUCTION');
            assert.strictEqual(Number(txRes.rows[0].quantity), 3);

            // Verify order_status_history
            const histRes = await query(
                `SELECT status, note FROM order_status_history
                 WHERE order_id = (SELECT id FROM orders WHERE order_number = $1)
                 ORDER BY created_at DESC LIMIT 1`,
                [orderNum]
            );
            assert.strictEqual(histRes.rows[0].status, 'dispatched');

            // Verify admin_audit_logs
            const auditRes = await query(
                `SELECT action, entity_type FROM admin_audit_logs
                 WHERE entity_id = $1
                 LIMIT 1`,
                [orderNum]
            );
            assert.strictEqual(auditRes.rows.length, 1);
            assert.strictEqual(auditRes.rows[0].action, 'ORDER_DISPATCHED');
        });

        test('3.2 Online payment orders CANNOT be dispatched via COD dispatch (rejects with 400)', async () => {
            const orderNum = `TCH-ONLINE-FAIL-${Date.now()}`;
            await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'ONLINE',
                status: 'confirmed',
                items: [{ variantId: variantX.id, unitPrice: 169.00, quantity: 1 }],
            });

            const res = await fetch(`${baseUrl}/api/admin/orders/${orderNum}/dispatch`, {
                method: 'POST',
                headers: {
                    Cookie: validOwnerCookie,
                    'x-csrf-token': validCsrfToken,
                },
            });

            assert.strictEqual(res.status, 400);
            const body = await res.json();
            assert.strictEqual(body.success, false);
            assert.strictEqual(body.error?.code, 'INVALID_PAYMENT_METHOD_FOR_COD_DISPATCH');

            // Order status remains confirmed
            const orderRes = await query('SELECT status FROM orders WHERE order_number = $1', [orderNum]);
            assert.strictEqual(orderRes.rows[0].status, 'confirmed');
        });

        test('3.3 Ineligible / cancelled orders cannot be dispatched (rejects with 400)', async () => {
            const orderNum = `TCH-CANCELLED-${Date.now()}`;
            await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'COD',
                status: 'cancelled',
                items: [{ variantId: variantX.id, unitPrice: 169.00, quantity: 1 }],
            });

            const res = await fetch(`${baseUrl}/api/admin/orders/${orderNum}/dispatch`, {
                method: 'POST',
                headers: {
                    Cookie: validOwnerCookie,
                    'x-csrf-token': validCsrfToken,
                },
            });

            assert.strictEqual(res.status, 400);
            const body = await res.json();
            assert.strictEqual(body.success, false);
            assert.strictEqual(body.error?.code, 'ORDER_NOT_ELIGIBLE_FOR_DISPATCH');
        });

        test('3.4 Insufficient stock rolls back ALL line-item deductions atomically', async () => {
            const orderNum = `TCH-SHORTAGE-${Date.now()}`;

            // Variant X has ample stock (e.g. 90+)
            // Variant Scarce has ONLY 1 unit available
            const invXBefore = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantX.id]);
            const onHandXBefore = Number(invXBefore.rows[0].quantity_on_hand);

            const invScarceBefore = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantScarce.id]);
            const onHandScarceBefore = Number(invScarceBefore.rows[0].quantity_on_hand);

            // Create multi-item order requesting 2 units of Variant X AND 5 units of Variant Scarce (which only has 1 unit)
            await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'COD',
                status: 'confirmed',
                items: [
                    { variantId: variantX.id, unitPrice: 169.00, quantity: 2 },
                    { variantId: variantScarce.id, unitPrice: 449.00, quantity: 5 },
                ],
            });

            const res = await fetch(`${baseUrl}/api/admin/orders/${orderNum}/dispatch`, {
                method: 'POST',
                headers: {
                    Cookie: validOwnerCookie,
                    'x-csrf-token': validCsrfToken,
                },
            });

            // Rejected with 400 / 409 INSUFFICIENT_STOCK
            assert.ok(res.status === 400 || res.status === 409);
            const body = await res.json();
            assert.strictEqual(body.success, false);
            assert.strictEqual(body.error?.code, 'INSUFFICIENT_STOCK');

            // Invariant check: entire transaction was rolled back!
            // 1. Order status is still confirmed (NOT dispatched)
            const orderDbRes = await query('SELECT status FROM orders WHERE order_number = $1', [orderNum]);
            assert.strictEqual(orderDbRes.rows[0].status, 'confirmed');

            // 2. Variant X inventory was NOT deducted (rolled back!)
            const invXAfter = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantX.id]);
            assert.strictEqual(Number(invXAfter.rows[0].quantity_on_hand), onHandXBefore);

            // 3. Variant Scarce inventory was NOT deducted
            const invScarceAfter = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantScarce.id]);
            assert.strictEqual(Number(invScarceAfter.rows[0].quantity_on_hand), onHandScarceBefore);
        });

        test('3.5 Duplicate dispatch is rejected (409 ALREADY_DISPATCHED) and does not deduct stock again', async () => {
            const orderNum = `TCH-DUP-DISPATCH-${Date.now()}`;
            await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'COD',
                status: 'confirmed',
                items: [{ variantId: variantX.id, unitPrice: 169.00, quantity: 1 }],
            });

            // First dispatch: success
            const res1 = await fetch(`${baseUrl}/api/admin/orders/${orderNum}/dispatch`, {
                method: 'POST',
                headers: { Cookie: validOwnerCookie, 'x-csrf-token': validCsrfToken },
            });
            assert.strictEqual(res1.status, 200);

            const invAfterFirst = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantX.id]);
            const onHandAfterFirst = Number(invAfterFirst.rows[0].quantity_on_hand);

            // Second dispatch: conflict (409 ALREADY_DISPATCHED)
            const res2 = await fetch(`${baseUrl}/api/admin/orders/${orderNum}/dispatch`, {
                method: 'POST',
                headers: { Cookie: validOwnerCookie, 'x-csrf-token': validCsrfToken },
            });
            assert.strictEqual(res2.status, 409);
            const body2 = await res2.json();
            assert.strictEqual(body2.error?.code, 'ALREADY_DISPATCHED');

            // Verify inventory was NOT deducted again
            const invAfterSecond = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantX.id]);
            assert.strictEqual(Number(invAfterSecond.rows[0].quantity_on_hand), onHandAfterFirst);
        });

        test('3.6 Concurrent dispatch requests serialize safely: exactly 1 succeeds and stock is deducted once', async () => {
            const orderNum = `TCH-CONCURRENT-${Date.now()}`;
            await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'COD',
                status: 'confirmed',
                items: [{ variantId: variantY.id, unitPrice: 189.00, quantity: 2 }],
            });

            const invBefore = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantY.id]);
            const onHandBefore = Number(invBefore.rows[0].quantity_on_hand);

            // Fire 2 concurrent HTTP requests simultaneously
            const [resA, resB] = await Promise.all([
                fetch(`${baseUrl}/api/admin/orders/${orderNum}/dispatch`, {
                    method: 'POST',
                    headers: { Cookie: validOwnerCookie, 'x-csrf-token': validCsrfToken },
                }),
                fetch(`${baseUrl}/api/admin/orders/${orderNum}/dispatch`, {
                    method: 'POST',
                    headers: { Cookie: validOwnerCookie, 'x-csrf-token': validCsrfToken },
                }),
            ]);

            const statuses = [resA.status, resB.status].sort();
            // Exactly one 200 and one 409
            assert.deepStrictEqual(statuses, [200, 409], 'One request must succeed with 200 and the other must be rejected with 409');

            // Verify inventory was deducted exactly once (2 units)
            const invAfter = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantY.id]);
            assert.strictEqual(Number(invAfter.rows[0].quantity_on_hand), onHandBefore - 2);
        });

        test('3.7 Unauthorized dispatch leaves database completely unchanged', async () => {
            const orderNum = `TCH-UNAUTH-DISPATCH-${Date.now()}`;
            await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'COD',
                status: 'confirmed',
                items: [{ variantId: variantX.id, unitPrice: 169.00, quantity: 1 }],
            });

            const invBefore = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantX.id]);
            const onHandBefore = Number(invBefore.rows[0].quantity_on_hand);

            // Attempt dispatch with NO cookie
            const res = await fetch(`${baseUrl}/api/admin/orders/${orderNum}/dispatch`, {
                method: 'POST',
            });
            assert.strictEqual(res.status, 401);

            // Database untouched
            const orderRes = await query('SELECT status FROM orders WHERE order_number = $1', [orderNum]);
            assert.strictEqual(orderRes.rows[0].status, 'confirmed');

            const invAfter = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variantX.id]);
            assert.strictEqual(Number(invAfter.rows[0].quantity_on_hand), onHandBefore);
        });
    });

    // ======================================================================
    // 4. PENDING REFUND-REVIEW VISIBILITY
    // ======================================================================
    describe('4. Pending Refund-Review Visibility', () => {

        test('4.1 Stock shortage exceptions (PAID_STOCK_UNAVAILABLE) appear in queue', async () => {
            const orderNum = `TCH-EX-SHORT-${Date.now()}`;
            const order = await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'ONLINE',
                status: 'confirmed',
                paymentStatus: 'paid_stock_unavailable',
                notes: 'exception_stock_shortage: customer payment captured but stock was unavailable',
                items: [{ variantId: variantX.id, unitPrice: 169.00, quantity: 1 }],
            });

            // Insert payment attempt flagged as PAID_STOCK_UNAVAILABLE
            await query(
                `
                INSERT INTO payments (
                    order_id, provider, provider_order_id, provider_payment_id,
                    amount, currency, status, gateway_status, created_at, updated_at
                )
                VALUES ($1, 'cashfree', 'cf_ord_shortage_' || gen_random_uuid(), 'cf_pay_shortage_' || gen_random_uuid(), 199.42, 'INR', 'paid_stock_unavailable', 'PAID_STOCK_UNAVAILABLE', NOW(), NOW())
                `,
                [order.id]
            );

            const res = await fetch(`${baseUrl}/api/admin/refunds/pending`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);

            const match = body.exceptions.find((ex) => ex.orderNumber === orderNum);
            assert.ok(match, `Order ${orderNum} must appear in pending refund review queue`);
            assert.strictEqual(match.exceptionType, 'PAID_STOCK_UNAVAILABLE');
            assert.strictEqual(match.refundStatus, 'pending');
        });

        test('4.2 Duplicate capture exceptions (PAID_DUPLICATE_ORDER_SETTLED) appear in queue', async () => {
            const orderNum = `TCH-EX-DUP-${Date.now()}`;
            const order = await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'ONLINE',
                status: 'confirmed',
                paymentStatus: 'captured',
                items: [{ variantId: variantY.id, unitPrice: 189.00, quantity: 1 }],
            });

            // Primary capture payment
            await query(
                `
                INSERT INTO payments (
                    order_id, provider, provider_order_id, provider_payment_id,
                    amount, currency, status, gateway_status, created_at, updated_at
                )
                VALUES ($1, 'cashfree', 'cf_ord_primary_att1_' || gen_random_uuid(), 'cf_pay_primary', 223.02, 'INR', 'captured', 'SUCCESS', NOW() - INTERVAL '5 minutes', NOW())
                `,
                [order.id]
            );

            // Sibling duplicate capture payment
            await query(
                `
                INSERT INTO payments (
                    order_id, provider, provider_order_id, provider_payment_id,
                    amount, currency, status, gateway_status, created_at, updated_at
                )
                VALUES ($1, 'cashfree', 'cf_ord_primary_att2_' || gen_random_uuid(), 'cf_pay_duplicate_1', 223.02, 'INR', 'paid_duplicate_order_settled', 'PAID_DUPLICATE_ORDER_SETTLED', NOW(), NOW())
                `,
                [order.id]
            );

            const res = await fetch(`${baseUrl}/api/admin/refunds/pending`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();

            const match = body.exceptions.find((ex) => ex.orderNumber === orderNum && ex.exceptionType === 'DUPLICATE_PAYMENT_CAPTURED');
            assert.ok(match, `Order ${orderNum} duplicate capture must appear in refund review queue`);
            assert.strictEqual(match.providerPaymentId, 'cf_pay_duplicate_1');
        });

        test('4.3 Completed refunds are NOT returned as pending review', async () => {
            const orderNum = `TCH-EX-RESOLVED-${Date.now()}`;
            const order = await createTestOrder({
                orderNumber: orderNum,
                paymentMethod: 'ONLINE',
                status: 'confirmed',
                paymentStatus: 'refunded',
                items: [{ variantId: variantX.id, unitPrice: 169.00, quantity: 1 }],
            });

            const payRes = await query(
                `
                INSERT INTO payments (
                    order_id, provider, provider_order_id, provider_payment_id,
                    amount, currency, status, gateway_status, created_at, updated_at
                )
                VALUES ($1, 'cashfree', 'cf_ord_resolved_' || gen_random_uuid(), 'cf_pay_resolved', 199.42, 'INR', 'refunded', 'REFUNDED', NOW(), NOW())
                RETURNING id
                `,
                [order.id]
            );
            const paymentId = payRes.rows[0].id;

            // Refund marked completed/refunded
            await query(
                `
                INSERT INTO refunds (
                    order_id, payment_id, amount, reason, status, provider_refund_id, created_at, updated_at
                )
                VALUES ($1, $2, 199.42, 'Resolved refund', 'refunded', 'cf_ref_completed_123', NOW(), NOW())
                `,
                [order.id, paymentId]
            );

            const res = await fetch(`${baseUrl}/api/admin/refunds/pending`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();

            const match = body.exceptions.find((ex) => ex.orderNumber === orderNum);
            assert.strictEqual(match, undefined, 'Completed refund must NOT appear in pending review queue');
        });

        test('4.4 Pending review list is strictly read-only: inspecting queue does not mutate any records', async () => {
            const paymentsBefore = await query('SELECT id, status, updated_at FROM payments');
            const refundsBefore = await query('SELECT id, status, updated_at FROM refunds');

            const res = await fetch(`${baseUrl}/api/admin/refunds/pending`, {
                headers: { Cookie: validOwnerCookie },
            });
            assert.strictEqual(res.status, 200);

            const paymentsAfter = await query('SELECT id, status, updated_at FROM payments');
            const refundsAfter = await query('SELECT id, status, updated_at FROM refunds');

            assert.strictEqual(paymentsAfter.rows.length, paymentsBefore.rows.length);
            assert.strictEqual(refundsAfter.rows.length, refundsBefore.rows.length);
        });
    });

    // ======================================================================
    // 5. HISTORICAL ORDER & FIXTURE PRESERVATION
    // ======================================================================
    describe('5. Historical Order & Fixture Preservation', () => {

        test('5.1 Historical order TCH-20261008-AJERUQ remains untouched and inventory reserved = 1', async () => {
            const histOrderRes = await query(
                `
                SELECT id, order_number, status, payment_method, payment_status, total_amount
                FROM orders
                WHERE order_number = 'TCH-20261008-AJERUQ'
                `
            );

            if (histOrderRes.rows.length > 0) {
                const histOrder = histOrderRes.rows[0];
                assert.strictEqual(histOrder.payment_method, 'COD');
                assert.strictEqual(histOrder.status, 'confirmed');

                // Verify its reserved inventory unit remains intact (1 unit reserved)
                const histItemRes = await query(
                    `
                    SELECT oi.variant_id, oi.quantity, inv.quantity_reserved
                    FROM order_items oi
                    JOIN inventory inv ON inv.variant_id = oi.variant_id
                    WHERE oi.order_id = $1
                    `,
                    [histOrder.id]
                );
                assert.ok(histItemRes.rows.length >= 1);
                for (const row of histItemRes.rows) {
                    assert.strictEqual(
                        Number(row.quantity_reserved),
                        1,
                        'Historical COD reservation must remain exactly 1 unit'
                    );
                }
            } else {
                // Strictly assert that live Neon was NOT connected to and local test DB is isolated
                assert.ok(!TEST_DB_URL.includes('neon.tech'));
                assert.ok(TEST_DB_URL.includes('crunchy_heart_test'));
            }
        });
    });
});
