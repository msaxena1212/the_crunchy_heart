/**
 * The Crunchy Heart - RECOVERY_CODE_SECRET startup validation
 *
 * Production must not start without a valid recovery-code key. Development validates it
 * only when it is set. Error messages name the variable but never echo a value.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { validateSecrets, MINIMUM_SECRET_LENGTH } = await import('../src/config/env.js');

const ORDER = 'startup_order_token_secret_minimum_32_chars_aaaa';
const OWNER = 'startup_owner_session_secret_minimum_32_chars_bbbb';
const RECOVERY = 'startup_recovery_code_secret_minimum_32_chars_cc';

describe('RECOVERY_CODE_SECRET startup validation', () => {
    test('1. Production fails when RECOVERY_CODE_SECRET is missing', () => {
        assert.throws(
            () => validateSecrets({ nodeEnv: 'production', orderTokenSecret: ORDER, ownerSessionSecret: OWNER, recoveryCodeSecret: '' }),
            /RECOVERY_CODE_SECRET is missing/
        );
    });

    test('2. Production fails when RECOVERY_CODE_SECRET is shorter than the minimum', () => {
        assert.throws(
            () => validateSecrets({ nodeEnv: 'production', orderTokenSecret: ORDER, ownerSessionSecret: OWNER, recoveryCodeSecret: 'too_short' }),
            new RegExp(`RECOVERY_CODE_SECRET is too short \\(minimum ${MINIMUM_SECRET_LENGTH}`)
        );
    });

    test('3. Production fails when RECOVERY_CODE_SECRET equals another secret', () => {
        assert.throws(
            () => validateSecrets({ nodeEnv: 'production', orderTokenSecret: ORDER, ownerSessionSecret: OWNER, recoveryCodeSecret: ORDER }),
            /RECOVERY_CODE_SECRET must not equal/
        );
        assert.throws(
            () => validateSecrets({ nodeEnv: 'production', orderTokenSecret: ORDER, ownerSessionSecret: OWNER, recoveryCodeSecret: OWNER }),
            /RECOVERY_CODE_SECRET must not equal/
        );
    });

    test('4. Production passes with three distinct secrets of sufficient length', () => {
        assert.strictEqual(
            validateSecrets({ nodeEnv: 'production', orderTokenSecret: ORDER, ownerSessionSecret: OWNER, recoveryCodeSecret: RECOVERY }),
            true
        );
    });

    test('5. Existing production checks still report their own errors first', () => {
        assert.throws(
            () => validateSecrets({ nodeEnv: 'production', orderTokenSecret: '', ownerSessionSecret: OWNER, recoveryCodeSecret: RECOVERY }),
            /ORDER_TOKEN_SECRET is missing/
        );
    });

    test('6. Development allows RECOVERY_CODE_SECRET to be absent', () => {
        assert.strictEqual(
            validateSecrets({ nodeEnv: 'development', orderTokenSecret: '', ownerSessionSecret: '', recoveryCodeSecret: '' }),
            true
        );
    });

    test('7. Development rejects a short RECOVERY_CODE_SECRET when one is provided', () => {
        assert.throws(
            () => validateSecrets({ nodeEnv: 'development', orderTokenSecret: '', ownerSessionSecret: '', recoveryCodeSecret: 'short' }),
            /RECOVERY_CODE_SECRET must be at least 32 characters/
        );
    });

    test('8. Error messages never echo the secret value', () => {
        const candidates = ['short-value-123', ORDER];
        for (const value of candidates) {
            try {
                validateSecrets({ nodeEnv: 'production', orderTokenSecret: ORDER, ownerSessionSecret: OWNER, recoveryCodeSecret: value });
            } catch (error) {
                assert.ok(!error.message.includes(value), 'the message must not contain the secret');
            }
        }
    });
});
