import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Environment loading priority:
// 1. Explicit file via ENV_FILE or DOTENV_CONFIG_PATH takes highest precedence if provided.
// 2. If DATABASE_URL is already supplied in process.env (e.g. systemd EnvironmentFile,
//    container env, or test harness), skip local dotfile loading entirely to avoid overriding process env.
// 3. Fall back to local developer file (../../../.env.local) if it exists.
const defaultLocalEnvPath = path.resolve(__dirname, '../../../.env.local');
const customEnvPath = process.env.ENV_FILE || process.env.DOTENV_CONFIG_PATH;
const envPath = customEnvPath || defaultLocalEnvPath;

let loadedDefaultLocalFile = false;

if (customEnvPath) {
    if (fs.existsSync(customEnvPath)) {
        dotenv.config({ path: customEnvPath });
    }
} else if (!process.env.DATABASE_URL && fs.existsSync(defaultLocalEnvPath)) {
    dotenv.config({ path: defaultLocalEnvPath });
    loadedDefaultLocalFile = true;
}

if (!process.env.DATABASE_URL) {
    throw new Error(
        'DATABASE_URL is missing. Configure it in the process environment or environment file.'
    );
}

// Fail closed: the default .env.local points at the live Neon production branch. Outside
// production, a database URL taken from that file is refused so that a script or dev server
// started without an explicit DATABASE_URL cannot write to live data by accident.
if (loadedDefaultLocalFile && (process.env.NODE_ENV || 'development') !== 'production') {
    throw new Error(
        'Refusing to use DATABASE_URL from the default .env.local outside production. ' +
        'Set DATABASE_URL explicitly in the process environment (for example the local ' +
        'crunchy_heart_test database) or point ENV_FILE at the file you intend to use.'
    );
}

export const env = {
    nodeEnv: process.env.NODE_ENV || 'development',

    port: Number(process.env.PORT || 5000),

    host: process.env.HOST || '127.0.0.1',

    clientUrl:
        process.env.CLIENT_URL ||
        'http://localhost:4200',

    databaseUrl:
        process.env.DATABASE_URL,

    databaseUrlUnpooled:
        process.env.DATABASE_URL_UNPOOLED ||
        process.env.DATABASE_URL,

    cashfreeClientId:
        process.env.CASHFREE_CLIENT_ID || '',

    cashfreeClientSecret:
        process.env.CASHFREE_CLIENT_SECRET || '',

    cashfreeEnvironment:
        process.env.CASHFREE_ENVIRONMENT || 'sandbox',

    cashfreeApiVersion:
        process.env.CASHFREE_API_VERSION || '2025-01-01',

    cashfreeReturnUrl:
        process.env.CASHFREE_RETURN_URL ||
        'http://localhost:4200/payment/callback',

    cashfreeWebhookUrl:
        process.env.CASHFREE_WEBHOOK_URL ||
        'http://localhost:5000/api/payments/cashfree/webhook',

    orderTokenSecret:
        process.env.ORDER_TOKEN_SECRET || '',

    ownerSessionSecret:
        process.env.OWNER_SESSION_SECRET || '',

    trustProxy:
        parseTrustProxy(process.env.TRUST_PROXY),

    envPath,
};

export const MINIMUM_SECRET_LENGTH = 32;

/**
 * Validate ORDER_TOKEN_SECRET and OWNER_SESSION_SECRET.
 *
 * Requirements:
 * - In production: both must be explicitly configured, >= 32 characters, and non-identical.
 * - In non-production: if either is set, it must satisfy length and uniqueness rules.
 * - Fails fast at startup with clear, non-sensitive errors. Never logs secrets.
 */
export function validateSecrets({
    nodeEnv = process.env.NODE_ENV || 'development',
    orderTokenSecret = process.env.ORDER_TOKEN_SECRET || '',
    ownerSessionSecret = process.env.OWNER_SESSION_SECRET || '',
    recoveryCodeSecret = process.env.RECOVERY_CODE_SECRET || '',
} = {}) {
    const isProd = (String(nodeEnv || '').toLowerCase() === 'production');
    const orderSecret = String(orderTokenSecret || '').trim();
    const ownerSecret = String(ownerSessionSecret || '').trim();
    const recoverySecret = String(recoveryCodeSecret || '').trim();

    if (isProd) {

        if (!orderSecret) {
            throw new Error(
                'Invalid production configuration: ORDER_TOKEN_SECRET is missing. ' +
                'Both ORDER_TOKEN_SECRET and OWNER_SESSION_SECRET must be explicitly configured in production.'
            );
        }

        if (!ownerSecret) {
            throw new Error(
                'Invalid production configuration: OWNER_SESSION_SECRET is missing. ' +
                'Both ORDER_TOKEN_SECRET and OWNER_SESSION_SECRET must be explicitly configured in production.'
            );
        }

        if (orderSecret.length < MINIMUM_SECRET_LENGTH) {
            throw new Error(
                `Invalid production configuration: ORDER_TOKEN_SECRET is too short (minimum ${MINIMUM_SECRET_LENGTH} characters required).`
            );
        }

        if (ownerSecret.length < MINIMUM_SECRET_LENGTH) {
            throw new Error(
                `Invalid production configuration: OWNER_SESSION_SECRET is too short (minimum ${MINIMUM_SECRET_LENGTH} characters required).`
            );
        }

        if (orderSecret === ownerSecret) {
            throw new Error(
                'Invalid production configuration: ORDER_TOKEN_SECRET and OWNER_SESSION_SECRET must not be identical. ' +
                'Cryptographically distinct secrets are required for token domain separation.'
            );
        }

        // Order recovery signs its six-digit codes with this key. Without it, recovery answers
        // 503, so a production process must not start without it.
        if (!recoverySecret) {
            throw new Error(
                'Invalid production configuration: RECOVERY_CODE_SECRET is missing. ' +
                'Order recovery requires it. Set it in the secret manager, never in source control.'
            );
        }

        if (recoverySecret.length < MINIMUM_SECRET_LENGTH) {
            throw new Error(
                `Invalid production configuration: RECOVERY_CODE_SECRET is too short (minimum ${MINIMUM_SECRET_LENGTH} characters required).`
            );
        }

        if (recoverySecret === orderSecret || recoverySecret === ownerSecret) {
            throw new Error(
                'Invalid production configuration: RECOVERY_CODE_SECRET must not equal ORDER_TOKEN_SECRET or OWNER_SESSION_SECRET. ' +
                'Cryptographically distinct secrets are required for domain separation.'
            );
        }
    } else {
        // Non-production validations if values are provided
        if (orderSecret && orderSecret.length < MINIMUM_SECRET_LENGTH) {
            throw new Error(
                `Invalid configuration: ORDER_TOKEN_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters if provided.`
            );
        }

        if (ownerSecret && ownerSecret.length < MINIMUM_SECRET_LENGTH) {
            throw new Error(
                `Invalid configuration: OWNER_SESSION_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters if provided.`
            );
        }

        if (orderSecret && ownerSecret && orderSecret === ownerSecret) {
            throw new Error(
                'Invalid configuration: ORDER_TOKEN_SECRET and OWNER_SESSION_SECRET must not be identical.'
            );
        }

        if (recoverySecret && recoverySecret.length < MINIMUM_SECRET_LENGTH) {
            throw new Error(
                `Invalid configuration: RECOVERY_CODE_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters if provided.`
            );
        }
    }

    return true;
}

// Validate secrets at startup if running in production
if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    validateSecrets({
        nodeEnv: 'production',
        orderTokenSecret: process.env.ORDER_TOKEN_SECRET,
        ownerSessionSecret: process.env.OWNER_SESSION_SECRET,
        recoveryCodeSecret: process.env.RECOVERY_CODE_SECRET,
    });
}

/**
 * Safely parse and validate the TRUST_PROXY configuration for Express.
 *
 * Security rationale:
 * - Default: false (conservative: direct connection, ignores X-Forwarded-For completely).
 * - "false" -> false
 * - Integer (e.g. "1", "2") -> trusted proxy hop count (e.g. 1 behind AWS ALB, Cloudflare, or Nginx).
 * - Comma-separated list of keywords/CIDRs/IPs (e.g. "loopback", "127.0.0.1", "10.0.0.0/8").
 * - "true" is strictly REJECTED to prevent blind left-most IP spoofing.
 * - Malformed values throw immediately to fail closed at startup.
 */
export function parseTrustProxy(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
        return false;
    }

    const trimmed = String(rawValue).trim().toLowerCase();

    if (trimmed === 'false') {
        return false;
    }

    if (trimmed === 'true') {
        throw new Error(
            'Invalid TRUST_PROXY configuration: Blind "true" is rejected for security to prevent client IP spoofing. ' +
            'Specify an explicit hop count (e.g., "1") or trusted subnet/CIDR (e.g., "loopback").'
        );
    }

    // Number of hops (e.g., "1", "2")
    if (/^\d+$/.test(trimmed)) {
        const hopCount = parseInt(trimmed, 10);
        if (hopCount < 1 || hopCount > 10) {
            throw new Error(
                `Invalid TRUST_PROXY hop count: "${trimmed}". Must be an integer between 1 and 10.`
            );
        }
        return hopCount;
    }

    // Keywords or list of subnets / IPs
    const allowedKeywords = new Set(['loopback', 'linklocal', 'uniquelocal']);
    const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);

    if (parts.length === 0) {
        throw new Error('Invalid TRUST_PROXY configuration: Empty value provided.');
    }

    // Validate each token: keyword, IPv4, IPv6, or CIDR notation
    const ipOrCidrRegex = /^([0-9a-f.:]+)(\/\d+)?$/i;
    for (const part of parts) {
        if (!allowedKeywords.has(part) && !ipOrCidrRegex.test(part)) {
            throw new Error(
                `Invalid TRUST_PROXY token: "${part}". Must be "false", an integer hop count (1-10), ` +
                `or a comma-separated list of trusted keywords ("loopback", "linklocal", "uniquelocal") / IP / CIDR addresses.`
            );
        }
    }

    return parts.length === 1 ? parts[0] : parts;
}