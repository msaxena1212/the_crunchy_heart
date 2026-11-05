import crypto from 'node:crypto';
import { env } from '../config/env.js';

const TOKEN_VERSION = 'v1';
const TOKEN_PURPOSE = 'owner_session';
const DEFAULT_SESSION_DURATION_SECONDS = 8 * 60 * 60; // 8 hours
const MINIMUM_SECRET_LENGTH = 32;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/**
 * Retrieve and strictly validate the dedicated server-side secret for owner sessions.
 * Fails closed immediately if missing or too short.
 */
export function getOwnerSessionSecret() {
    const secret =
        (typeof env.ownerSessionSecret === 'string' && env.ownerSessionSecret.trim()) ||
        (typeof process.env.OWNER_SESSION_SECRET === 'string' && process.env.OWNER_SESSION_SECRET.trim()) ||
        '';

    if (!secret || secret.length < MINIMUM_SECRET_LENGTH) {
        const error = new Error(
            `OWNER_SESSION_SECRET is not configured or too short (minimum ${MINIMUM_SECRET_LENGTH} characters required).`
        );
        error.statusCode = 500;
        throw error;
    }

    return secret;
}

/**
 * Hash a password using scrypt with a cryptographically secure random salt.
 * Format: scrypt$<N>$<r>$<p>$<salt_hex>$<derived_key_hex>
 */
export function hashPassword(password) {
    if (!password || typeof password !== 'string' || password.length < 8) {
        throw new Error('Password must be a string of at least 8 characters.');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, KEY_LEN, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 32 * 1024 * 1024,
    }).toString('hex');

    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derivedKey}`;
}

/**
 * Verify a plaintext password against a stored scrypt password hash in constant time.
 */
export function verifyPassword(password, storedHash) {
    if (!password || !storedHash || typeof password !== 'string' || typeof storedHash !== 'string') {
        return false;
    }

    const parts = storedHash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
        return false;
    }

    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = parts[4];
    const expectedKeyHex = parts[5];

    if (!salt || !expectedKeyHex) {
        return false;
    }

    try {
        const expectedKeyBuf = Buffer.from(expectedKeyHex, 'hex');
        const derivedKeyBuf = crypto.scryptSync(password, salt, expectedKeyBuf.length, {
            N,
            r,
            p,
            maxmem: 32 * 1024 * 1024,
        });

        if (derivedKeyBuf.length !== expectedKeyBuf.length) {
            return false;
        }

        return crypto.timingSafeEqual(derivedKeyBuf, expectedKeyBuf);
    } catch {
        return false;
    }
}

/**
 * Generate a cryptographically signed, tamper-proof owner session token.
 * Token format: v1.<base64url(payload)>.<base64url(hmac_signature)>
 */
export function generateAdminSessionToken(admin, { expiresInSeconds = DEFAULT_SESSION_DURATION_SECONDS } = {}) {
    if (!admin?.id || !admin?.email) {
        throw new Error('Admin user must have id and email to issue a session token.');
    }

    const secret = getOwnerSessionSecret();
    const now = Math.floor(Date.now() / 1000);

    const payload = {
        adminId: String(admin.id).trim(),
        email: String(admin.email).trim().toLowerCase(),
        role: String(admin.role || 'ADMIN').trim().toUpperCase(),
        iat: now,
        exp: now + expiresInSeconds,
        purpose: TOKEN_PURPOSE,
    };

    const serializedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signedData = `${TOKEN_VERSION}.${serializedPayload}`;

    const signature = crypto
        .createHmac('sha256', secret)
        .update(signedData)
        .digest('base64url');

    return `${signedData}.${signature}`;
}

/**
 * Verify an owner session token in constant time.
 * Returns { valid: true, payload } or { valid: false, reason: string }.
 */
export function verifyAdminSessionToken(token) {
    if (!token || typeof token !== 'string') {
        return { valid: false, reason: 'TOKEN_MISSING' };
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3) {
        return { valid: false, reason: 'INVALID_TOKEN_FORMAT' };
    }

    const [version, encodedPayload, signature] = parts;

    if (version !== TOKEN_VERSION) {
        return { valid: false, reason: 'UNSUPPORTED_TOKEN_VERSION' };
    }

    let secret;
    try {
        secret = getOwnerSessionSecret();
    } catch {
        return { valid: false, reason: 'SECRET_UNAVAILABLE' };
    }

    const signedData = `${version}.${encodedPayload}`;
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(signedData)
        .digest('base64url');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { valid: false, reason: 'SIGNATURE_MISMATCH' };
    }

    let payload;
    try {
        const json = Buffer.from(encodedPayload, 'base64url').toString('utf8');
        payload = JSON.parse(json);
    } catch {
        return { valid: false, reason: 'MALFORMED_PAYLOAD' };
    }

    if (payload?.purpose !== TOKEN_PURPOSE) {
        return { valid: false, reason: 'INVALID_PURPOSE' };
    }

    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || now > payload.exp) {
        return { valid: false, reason: 'TOKEN_EXPIRED' };
    }

    if (payload.role !== 'ADMIN') {
        return { valid: false, reason: 'INSUFFICIENT_ROLE' };
    }

    return { valid: true, payload };
}

/**
 * Generate a CSRF token cryptographically derived from the session signature and secret.
 */
export function generateCsrfToken(sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') return '';
    const parts = sessionToken.trim().split('.');
    if (parts.length !== 3) return '';

    const secret = getOwnerSessionSecret();
    return crypto
        .createHmac('sha256', secret)
        .update(`csrf:${parts[2]}`)
        .digest('base64url');
}

/**
 * Verify a CSRF token in constant time against the active session token.
 */
export function verifyCsrfToken(csrfToken, sessionToken) {
    if (!csrfToken || !sessionToken || typeof csrfToken !== 'string') return false;
    const expected = generateCsrfToken(sessionToken);
    if (!expected) return false;

    const csrfBuf = Buffer.from(csrfToken, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');

    if (csrfBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(csrfBuf, expBuf);
}
