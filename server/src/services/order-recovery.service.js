import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { generateGuestAccessToken } from '../utils/order-token.js';

/*
|--------------------------------------------------------------------------
| Guest order recovery (lost checkout response)
|--------------------------------------------------------------------------
| A guest who lost the checkout response has no guest token and no order number.
|
|   1. The guest submits an email address or a phone number. An idempotency key or
|      an order number is never accepted, so an order cannot be found from either.
|   2. The reply is always the same generic message, and it takes at least the same
|      minimum time whatever happened (see the controller).
|   3. If a recent order matches an email address, a six-digit code is sent to that
|      address. Only a keyed HMAC of the code is stored, bound to the challenge ID.
|   4. The guest submits the code. A correct, unexpired, unconsumed code consumes the
|      challenge and returns a guest token for that one order.
|
| Secrets: the HMAC key is RECOVERY_CODE_SECRET. It must be at least 32 characters, is
| read from the environment (or the secret manager), and is never stored in the
| database or in source control. If it is missing or too short, recovery fails closed
| with 503. A six-digit code has only a million values, so a plain hash could be
| brute-forced offline from a leaked table. The keyed HMAC cannot be.
|
| Rotation: rotating RECOVERY_CODE_SECRET invalidates codes issued before the rotation.
| Those codes expire within 10 minutes anyway, so rotation has no lasting effect.
|
| Rate limits (database-backed, so they hold across instances and restarts):
|   - requests per contact: 3 per hour
|   - requests per client IP: 20 per hour
|   - verification attempts per contact: 10 per 15 minutes
|   - verification attempts per client IP: 60 per 15 minutes
| Each check runs in its own transaction with a per-key advisory lock, so concurrent
| requests cannot exceed a limit by racing.
|
| Each challenge expires after 10 minutes, accepts 5 attempts, and is single-use.
| Verification locks the challenge row, so two concurrent submissions of the correct
| code cannot both succeed.
|--------------------------------------------------------------------------
*/

export const RECOVERY_WINDOW_HOURS = 24;
export const CHALLENGE_TTL_MINUTES = 10;
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const RECOVERY_SECRET_MIN_LENGTH = 32;

export const REQUEST_LIMITS = Object.freeze({
    contactPerHour: 3,
    ipPerHour: 20,
});

export const VERIFY_LIMITS = Object.freeze({
    contactPer15Minutes: 10,
    ipPer15Minutes: 60,
});

export const RECOVERY_GENERIC_MESSAGE =
    'If a recent order matches these details, a verification code will be sent to the email address on file.';

function recoveryError(code, message, statusCode) {
    return Object.assign(new Error(message), { code, statusCode });
}

/*
 * Returns the HMAC key, or fails closed. Read at call time so rotation takes effect
 * on the next request without a code change.
 */
export function getRecoveryCodeSecret(env = process.env) {
    const secret = env.RECOVERY_CODE_SECRET || '';
    if (secret.length < RECOVERY_SECRET_MIN_LENGTH) {
        throw recoveryError(
            'RECOVERY_UNAVAILABLE',
            'Order recovery is not available right now.',
            503
        );
    }
    return secret;
}

export function normalizeContact({ email, phone } = {}) {
    if (email) {
        const value = String(email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            throw recoveryError('VALIDATION', 'A valid email address is required.', 400);
        }
        return { kind: 'email', value };
    }

    if (phone) {
        const digits = String(phone).replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) {
            throw recoveryError('VALIDATION', 'A valid phone number is required.', 400);
        }
        return { kind: 'phone', value: digits };
    }

    throw recoveryError('VALIDATION', 'An email address or phone number is required.', 400);
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function hashContact(contact) {
    return sha256(`${contact.kind}:${contact.value}`);
}

function hashIp(ipAddress) {
    return sha256(`ip:${ipAddress}`);
}

function hashCode(secret, challengeId, code) {
    return crypto.createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');
}

export function generateRecoveryCode() {
    return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

/*
 * Consumes one unit of a rate limit inside the caller's transaction. A per-key
 * advisory lock serialises concurrent checks, including across instances. Returns
 * false, without recording anything, once the limit is reached.
 */
async function consumeRateLimit(client, { scope, key, limit, windowMinutes }) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${scope}:${key}`]);

    const counted = await client.query(
        `SELECT COUNT(*)::int AS n FROM rate_limit_events
         WHERE scope = $1 AND key_hash = $2
           AND created_at > NOW() - ($3::int * INTERVAL '1 minute')`,
        [scope, key, windowMinutes]
    );

    if (counted.rows[0].n >= limit) {
        return false;
    }

    await client.query(
        `INSERT INTO rate_limit_events (scope, key_hash, created_at) VALUES ($1, $2, NOW())`,
        [scope, key]
    );
    return true;
}

async function allowRequest({ scope, key, limit, windowMinutes }) {
    return withTransaction(client => consumeRateLimit(client, { scope, key, limit, windowMinutes }));
}

/*
 * Default sender. Fails closed until customer email delivery is configured.
 */
export async function unconfiguredRecoverySender() {
    throw recoveryError('EMAIL_NOT_CONFIGURED', 'Recovery email delivery is not configured.', 503);
}

/*
 * Starts a recovery challenge. Resolves to the same generic reply whether or not an
 * order matched, a limit applied, or the code could not be sent. The outcome is
 * returned for operational logging only and is never sent to the client.
 */
export async function requestOrderRecovery({
    contact: rawContact,
    ipAddress = null,
    sender = unconfiguredRecoverySender,
    clock = () => new Date(),
    env = process.env,
}) {
    // Fail closed first: without the HMAC key no code can be issued or verified.
    const secret = getRecoveryCodeSecret(env);

    const contact = normalizeContact(rawContact);
    const contactHash = hashContact(contact);
    const generic = { accepted: true, message: RECOVERY_GENERIC_MESSAGE };

    // Counted before the match is checked, so a limited contact cannot tell whether it matched.
    const contactAllowed = await allowRequest({
        scope: 'recovery_request_contact',
        key: contactHash,
        limit: REQUEST_LIMITS.contactPerHour,
        windowMinutes: 60,
    });
    if (!contactAllowed) {
        return { ...generic, outcome: 'rate_limited' };
    }

    if (ipAddress) {
        const ipAllowed = await allowRequest({
            scope: 'recovery_request_ip',
            key: hashIp(ipAddress),
            limit: REQUEST_LIMITS.ipPerHour,
            windowMinutes: 60,
        });
        if (!ipAllowed) {
            return { ...generic, outcome: 'rate_limited' };
        }
    }

    // Only email can receive a code. A phone-only match cannot be verified, so no challenge is made.
    const matchColumn = contact.kind === 'email'
        ? `lower(o.email) = $1`
        : `regexp_replace(o.phone, '\\D', '', 'g') = $1`;

    const matched = await query(
        `SELECT o.id, o.email
         FROM orders o
         WHERE ${matchColumn}
           AND o.status <> 'cancelled'
           AND o.created_at > NOW() - ($2::int * INTERVAL '1 hour')
         ORDER BY o.created_at DESC
         LIMIT 1`,
        [contact.value, RECOVERY_WINDOW_HOURS]
    );

    if (!matched.rows.length || !matched.rows[0].email) {
        return { ...generic, outcome: 'no_match' };
    }

    const order = matched.rows[0];
    const challengeId = crypto.randomUUID();
    const code = generateRecoveryCode();
    const expiresAt = new Date(clock().getTime() + CHALLENGE_TTL_MINUTES * 60 * 1000);

    await query(
        `INSERT INTO order_recovery_challenges (id, order_id, contact_hash, code_hash, expires_at, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [challengeId, order.id, contactHash, hashCode(secret, challengeId, code), expiresAt, MAX_CHALLENGE_ATTEMPTS]
    );

    try {
        await sender({ to: order.email, code, expiresAt });
    } catch (error) {
        // The code never reached the guest. Mark the challenge consumed so it cannot be used.
        await query(`UPDATE order_recovery_challenges SET consumed_at = NOW() WHERE id = $1`, [challengeId]);
        return { ...generic, outcome: 'send_failed', sendErrorCode: error.code || 'SEND_FAILED' };
    }

    return { ...generic, outcome: 'sent' };
}

/*
 * Verifies a code. Every failure returns the same error, so the response does not reveal
 * which part was wrong, whether an order exists, or whether a limit applied.
 */
export async function verifyOrderRecovery({
    contact: rawContact,
    code,
    ipAddress = null,
    clock = () => new Date(),
    env = process.env,
}) {
    const secret = getRecoveryCodeSecret(env);
    const genericFailure = () => recoveryError('RECOVERY_FAILED', 'The verification code is invalid or has expired.', 401);

    const contact = normalizeContact(rawContact);
    const submitted = String(code || '').trim();
    const contactHash = hashContact(contact);

    // Every attempt counts against these limits, correct or not. Exceeding one returns
    // the generic failure, so a limit cannot be distinguished from a wrong code.
    const contactAttempt = await allowRequest({
        scope: 'recovery_verify_contact',
        key: contactHash,
        limit: VERIFY_LIMITS.contactPer15Minutes,
        windowMinutes: 15,
    });
    if (!contactAttempt) {
        throw genericFailure();
    }
    if (ipAddress) {
        const ipAttempt = await allowRequest({
            scope: 'recovery_verify_ip',
            key: hashIp(ipAddress),
            limit: VERIFY_LIMITS.ipPer15Minutes,
            windowMinutes: 15,
        });
        if (!ipAttempt) {
            throw genericFailure();
        }
    }

    if (!/^\d{6}$/.test(submitted)) {
        throw genericFailure();
    }

    // Failures are returned from the transaction, not thrown inside it. A thrown error
    // would roll back the failed-attempt counter, and the attempt limit would never apply.
    const outcome = await withTransaction(async client => {
        const found = await client.query(
            `SELECT c.id, c.code_hash, c.attempts, c.max_attempts, c.order_id
             FROM order_recovery_challenges c
             WHERE c.contact_hash = $1
               AND c.consumed_at IS NULL
               AND c.expires_at > $2
             ORDER BY c.created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [contactHash, clock()]
        );

        if (!found.rows.length) {
            return { ok: false };
        }

        const challenge = found.rows[0];
        if (challenge.attempts >= challenge.max_attempts) {
            return { ok: false };
        }

        const expected = Buffer.from(challenge.code_hash, 'hex');
        const actual = Buffer.from(hashCode(secret, challenge.id, submitted), 'hex');
        const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

        if (!matches) {
            await client.query(
                `UPDATE order_recovery_challenges SET attempts = attempts + 1 WHERE id = $1`,
                [challenge.id]
            );
            return { ok: false };
        }

        await client.query(
            `UPDATE order_recovery_challenges SET consumed_at = NOW() WHERE id = $1`,
            [challenge.id]
        );

        const orderRes = await client.query(
            `SELECT * FROM orders WHERE id = $1`,
            [challenge.order_id]
        );
        const order = orderRes.rows[0];
        if (!order) {
            return { ok: false };
        }

        return {
            ok: true,
            order: {
                order_number: order.order_number,
                status: order.status,
                payment_status: order.payment_status,
                total_amount: Number(order.total_amount),
                created_at: order.created_at,
            },
            guestAccessToken: generateGuestAccessToken(order),
        };
    });

    if (!outcome.ok) {
        throw genericFailure();
    }

    return { order: outcome.order, guestAccessToken: outcome.guestAccessToken };
}
