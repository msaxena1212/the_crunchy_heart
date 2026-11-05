import crypto from 'node:crypto';
import { env } from '../config/env.js';

const TOKEN_VERSION = 'v1';
const TOKEN_PURPOSE = 'guest_order_access';
const DEFAULT_EXPIRATION_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MINIMUM_SECRET_LENGTH = 32;

/**
 * Retrieve and strictly validate the dedicated server-side secret for guest order tokens.
 * Fails closed immediately if missing or insufficient in length.
 */
export function getOrderTokenSecret() {
    const secret =
        (typeof env.orderTokenSecret === 'string' && env.orderTokenSecret.trim()) ||
        (typeof process.env.ORDER_TOKEN_SECRET === 'string' && process.env.ORDER_TOKEN_SECRET.trim()) ||
        '';

    if (!secret || secret.length < MINIMUM_SECRET_LENGTH) {
        const error = new Error(
            `ORDER_TOKEN_SECRET is not configured or too short (minimum ${MINIMUM_SECRET_LENGTH} characters required).`
        );
        error.statusCode = 500;
        throw error;
    }

    return secret;
}

/**
 * Generate a cryptographically signed, order-bound, time-limited guest access token.
 *
 * Token format:
 *   v1.<base64url(payload)>.<base64url(hmac_signature)>
 */
export function generateGuestAccessToken(order, { expiresInSeconds = DEFAULT_EXPIRATION_SECONDS } = {}) {
    if (!order?.order_number || !order?.id) {
        throw new Error('Order must have order_number and id to issue a guest access token.');
    }

    const secret = getOrderTokenSecret();
    const now = Math.floor(Date.now() / 1000);

    const payload = {
        orderNumber: String(order.order_number).trim(),
        orderId: String(order.id).trim(),
        phone: String(order.phone || '').trim(),
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
 * Verify a guest access token using constant-time comparison and order property binding.
 *
 * Returns { valid: true, payload } if valid, or { valid: false, reason: string } if invalid.
 */
export function verifyGuestAccessToken({ token, orderNumber, order = null }) {
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
        secret = getOrderTokenSecret();
    } catch {
        return { valid: false, reason: 'SECRET_UNAVAILABLE' };
    }

    const signedData = `${version}.${encodedPayload}`;
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(signedData)
        .digest('base64url');

    // Constant-time signature comparison to defeat timing attacks
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { valid: false, reason: 'SIGNATURE_MISMATCH' };
    }

    // Decode and validate payload contents
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

    if (orderNumber && payload.orderNumber !== String(orderNumber).trim()) {
        return { valid: false, reason: 'ORDER_MISMATCH' };
    }

    if (order) {
        if (order.id && payload.orderId !== String(order.id).trim()) {
            return { valid: false, reason: 'ORDER_ID_MISMATCH' };
        }
        if (order.phone && payload.phone !== String(order.phone).trim()) {
            return { valid: false, reason: 'PHONE_MISMATCH' };
        }
    }

    return { valid: true, payload };
}
