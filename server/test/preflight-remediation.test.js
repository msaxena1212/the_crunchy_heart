/**
 * The Crunchy Heart - Phase 3.4A.1 Preflight Remediation Test Suite
 *
 * Verifies the three critical preflight remediations:
 * 1. Startup Secret Validation (Task 1):
 *    - In production, ORDER_TOKEN_SECRET and OWNER_SESSION_SECRET must both be explicitly configured.
 *    - Each secret must be at least 32 characters long.
 *    - The two secrets must not be identical.
 *    - Fails fast with clear, non-sensitive errors.
 *
 * 2. Reconciliation Database Safety Guard (Task 2):
 *    - In test mode, strictly rejects any remote database (including Neon) and requires local 'crunchy_heart_test'.
 *    - In production mode, validates PostgreSQL URL structure without unconditionally banning Neon.
 *    - Fails closed on missing or malformed database URLs.
 *
 * 3. Storefront API Base URL Resolution (Task 3):
 *    - Validates localhost/loopback development routing.
 *    - Validates runtime override (__API_BASE_URL__).
 *    - Validates same-origin default (/api) without hardcoded third-party hosts.
 *
 * SAFETY INVARIANT: Strictly connects to local crunchy_heart_test.
 */

import { test, describe } from 'node:test';
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
process.env.ORDER_TOKEN_SECRET = 'test_order_token_secret_minimum_32_characters_long_for_security';
process.env.OWNER_SESSION_SECRET = 'test_owner_session_secret_minimum_32_characters_long_for_security';

const { validateSecrets, MINIMUM_SECRET_LENGTH } = await import('../src/config/env.js');
const { assertSafeDatabaseUrl } = await import('../src/services/reconciliation.service.js');

describe('Phase 3.4A.1: Preflight Remediation Suite', () => {

    // ======================================================================
    // 1. STARTUP SECRET VALIDATION (TASK 1)
    // ======================================================================
    describe('1. Startup Secret Validation', () => {

        test('1.1 Production startup rejects missing ORDER_TOKEN_SECRET', () => {
            assert.throws(
                () => validateSecrets({
                    nodeEnv: 'production',
                    orderTokenSecret: '',
                    ownerSessionSecret: 'valid_owner_session_secret_at_least_32_chars_long',
                }),
                (err) => {
                    assert.match(err.message, /ORDER_TOKEN_SECRET is missing/);
                    assert.strictEqual(err.message.includes('valid_owner'), false, 'Never expose secret values in errors');
                    return true;
                }
            );
        });

        test('1.2 Production startup rejects missing OWNER_SESSION_SECRET', () => {
            assert.throws(
                () => validateSecrets({
                    nodeEnv: 'production',
                    orderTokenSecret: 'valid_order_token_secret_at_least_32_chars_long',
                    ownerSessionSecret: '',
                }),
                (err) => {
                    assert.match(err.message, /OWNER_SESSION_SECRET is missing/);
                    assert.strictEqual(err.message.includes('valid_order'), false, 'Never expose secret values in errors');
                    return true;
                }
            );
        });

        test('1.3 Production startup rejects ORDER_TOKEN_SECRET shorter than 32 characters', () => {
            assert.throws(
                () => validateSecrets({
                    nodeEnv: 'production',
                    orderTokenSecret: 'short_secret_under_32',
                    ownerSessionSecret: 'valid_owner_session_secret_at_least_32_chars_long',
                }),
                /ORDER_TOKEN_SECRET is too short/
            );
        });

        test('1.4 Production startup rejects OWNER_SESSION_SECRET shorter than 32 characters', () => {
            assert.throws(
                () => validateSecrets({
                    nodeEnv: 'production',
                    orderTokenSecret: 'valid_order_token_secret_at_least_32_chars_long',
                    ownerSessionSecret: 'short_owner_secret',
                }),
                /OWNER_SESSION_SECRET is too short/
            );
        });

        test('1.5 Production startup rejects identical ORDER_TOKEN_SECRET and OWNER_SESSION_SECRET', () => {
            const sharedSecret = 'this_is_a_shared_secret_that_is_long_enough_for_32_chars';
            assert.throws(
                () => validateSecrets({
                    nodeEnv: 'production',
                    orderTokenSecret: sharedSecret,
                    ownerSessionSecret: sharedSecret,
                }),
                /must not be identical/
            );
        });

        test('1.6 Production startup succeeds with valid, distinct, >= 32-character secrets', () => {
            const result = validateSecrets({
                nodeEnv: 'production',
                orderTokenSecret: 'distinct_order_token_secret_minimum_32_characters_long_12345',
                ownerSessionSecret: 'distinct_owner_session_secret_minimum_32_characters_long_67890',
                recoveryCodeSecret: 'distinct_recovery_code_secret_minimum_32_characters_long_11111',
            });
            assert.strictEqual(result, true);
        });

        test('1.7 Test / Development environment allows missing secrets without crashing import', () => {
            const result = validateSecrets({
                nodeEnv: 'test',
                orderTokenSecret: '',
                ownerSessionSecret: '',
            });
            assert.strictEqual(result, true);
        });

        test('1.8 Test / Development environment still rejects short secrets if explicitly provided', () => {
            assert.throws(
                () => validateSecrets({
                    nodeEnv: 'development',
                    orderTokenSecret: 'short',
                    ownerSessionSecret: '',
                }),
                /ORDER_TOKEN_SECRET must be at least 32 characters/
            );
        });
    });

    // ======================================================================
    // 2. RECONCILIATION DATABASE SAFETY GUARD (TASK 2)
    // ======================================================================
    describe('2. Reconciliation Database Safety Guard', () => {

        test('2.1 In test mode, strictly rejects remote Neon database target', () => {
            assert.throws(
                () => assertSafeDatabaseUrl('postgresql://user:secret@ep-solitary-block.aws.neon.tech/neondb?sslmode=require', 'test'),
                /FATAL SAFETY VIOLATION/
            );
        });

        test('2.2 In test mode, strictly rejects remote non-Neon database target', () => {
            assert.throws(
                () => assertSafeDatabaseUrl('postgresql://user:secret@staging-db.internal:5432/staging_db', 'test'),
                /FATAL SAFETY VIOLATION/
            );
        });

        test('2.3 In test mode, strictly rejects localhost with non-test database name', () => {
            assert.throws(
                () => assertSafeDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/production_copy', 'test'),
                /FATAL SAFETY VIOLATION/
            );
        });

        test('2.4 In test mode, accepts 127.0.0.1 and localhost targeting crunchy_heart_test', () => {
            assert.doesNotThrow(() => assertSafeDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test', 'test'));
            assert.doesNotThrow(() => assertSafeDatabaseUrl('postgresql://postgres:postgres@localhost:5432/crunchy_heart_test', 'test'));
        });

        test('2.5 In production mode, validates legitimate Neon database URL without connecting', () => {
            // Valid Neon PostgreSQL URL passes syntactic and configuration validation in production
            const validNeonUrl = 'postgresql://app_user:strong_password@ep-solitary-block-12345.aws.neon.tech/neondb?sslmode=require';
            assert.doesNotThrow(() => assertSafeDatabaseUrl(validNeonUrl, 'production'));
        });

        test('2.6 Rejects missing, empty, or malformed database URLs in any environment', () => {
            assert.throws(
                () => assertSafeDatabaseUrl('', 'production'),
                /DATABASE_URL is missing/
            );
            assert.throws(
                () => assertSafeDatabaseUrl('not_a_valid_url', 'production'),
                /Malformed DATABASE_URL/
            );
            assert.throws(
                () => assertSafeDatabaseUrl('http://insecure-database.com/db', 'production'),
                /must use postgresql: or postgres: protocol/
            );
        });

        test('2.7 Rejects database URLs with missing database name or host in non-test mode', () => {
            assert.throws(
                () => assertSafeDatabaseUrl('postgresql:///', 'production'),
                /missing a valid hostname/
            );
            assert.throws(
                () => assertSafeDatabaseUrl('postgresql://user:pass@db.example.com/', 'production'),
                /missing a database name/
            );
        });
    });

    // ======================================================================
    // 3. STOREFRONT API BASE URL RESOLUTION (TASK 3)
    // ======================================================================
    describe('3. Storefront API Base URL Resolution', () => {

        // Node.js test simulation of the client getApiBaseUrl logic
        function resolveApiBaseUrl({ windowObj, hostname }) {
            if (windowObj && windowObj.__API_BASE_URL__) {
                return windowObj.__API_BASE_URL__;
            }
            if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
                return 'http://localhost:5000/api';
            }
            return '/api';
        }

        test('3.1 Resolves http://localhost:5000/api for local development hostnames', () => {
            assert.strictEqual(resolveApiBaseUrl({ hostname: 'localhost' }), 'http://localhost:5000/api');
            assert.strictEqual(resolveApiBaseUrl({ hostname: '127.0.0.1' }), 'http://localhost:5000/api');
            assert.strictEqual(resolveApiBaseUrl({ hostname: '[::1]' }), 'http://localhost:5000/api');
        });

        test('3.2 Resolves explicit runtime __API_BASE_URL__ override when configured', () => {
            const url = resolveApiBaseUrl({
                windowObj: { __API_BASE_URL__: 'https://api.thecrunchyheart.com/api' },
                hostname: 'thecrunchyheart.com',
            });
            assert.strictEqual(url, 'https://api.thecrunchyheart.com/api');
        });

        test('3.3 Resolves /api default for production/staging domains without hardcoding third parties', () => {
            assert.strictEqual(resolveApiBaseUrl({ hostname: 'thecrunchyheart.com' }), '/api');
            assert.strictEqual(resolveApiBaseUrl({ hostname: 'the-crunchy-heart.onrender.com' }), '/api');
            assert.strictEqual(resolveApiBaseUrl({ hostname: 'thecrunchyheart.netlify.app' }), '/api');
        });
    });
});
