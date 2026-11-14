import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';

export const OTP_EXPIRY_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 3;
export const SESSION_DURATION_DAYS = 30;

function hashOtp(phone, otp) {
    return crypto
        .createHash('sha256')
        .update(`${phone}:${otp}:${process.env.ORDER_TOKEN_SECRET || 'tch-salt'}`)
        .digest('hex');
}

/**
 * Normalizes an Indian phone number to 10 digits (without country code)
 */
export function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 10) return digits;
    if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
    throw new Error('Please enter a valid 10-digit mobile number.');
}

/**
 * Requests an OTP for a given mobile number and channel (sms/whatsapp).
 * In development/test mode, prints OTP to console or returns mock '123456'.
 */
export async function sendCustomerOtp({ phone, channel = 'sms', purpose = 'LOGIN' }) {
    const cleanPhone = normalizePhone(phone);
    const validChannels = ['sms', 'whatsapp'];
    const chosenChannel = validChannels.includes(channel) ? channel : 'sms';

    // Generate 6-digit numeric OTP
    const otp = process.env.NODE_ENV === 'production'
        ? String(Math.floor(100000 + Math.random() * 900000))
        : '123456';

    const otpHash = hashOtp(cleanPhone, otp);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Invalidate prior active OTPs for this phone
    await query(
        `UPDATE customer_otps
         SET consumed_at = NOW()
         WHERE phone = $1 AND consumed_at IS NULL`,
        [cleanPhone]
    );

    await query(
        `INSERT INTO customer_otps (phone, otp_hash, purpose, channel, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [cleanPhone, otpHash, purpose, chosenChannel, expiresAt]
    );

    // Simulate / log OTP delivery
    if (process.env.NODE_ENV !== 'production') {
        console.log(`[AUTH-DEV] Generated ${chosenChannel.toUpperCase()} OTP for +91${cleanPhone}: ${otp}`);
    }

    return {
        success: true,
        channel: chosenChannel,
        phone: cleanPhone,
        expiresInSeconds: OTP_EXPIRY_MINUTES * 60,
        mockCode: process.env.NODE_ENV !== 'production' ? otp : undefined
    };
}

/**
 * Verifies the OTP, creates/finds the customer record, and generates a customer session token.
 */
export async function verifyCustomerOtp({ phone, otp, ipAddress = null, userAgent = null }) {
    const cleanPhone = normalizePhone(phone);
    const code = String(otp || '').trim();

    if (!code || code.length !== 6) {
        throw new Error('Please enter a valid 6-digit verification code.');
    }

    return await withTransaction(async (client) => {
        // Find latest active OTP
        const otpResult = await client.query(
            `SELECT * FROM customer_otps
             WHERE phone = $1 AND consumed_at IS NULL AND expires_at > NOW()
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [cleanPhone]
        );

        if (!otpResult.rows.length) {
            const err = new Error('Verification code has expired or was not requested. Please request a new code.');
            err.statusCode = 400;
            throw err;
        }

        const otpRecord = otpResult.rows[0];

        if (otpRecord.attempts >= otpRecord.max_attempts) {
            await client.query(
                `UPDATE customer_otps SET consumed_at = NOW() WHERE id = $1`,
                [otpRecord.id]
            );
            const err = new Error('Too many invalid attempts. Please request a fresh code.');
            err.statusCode = 429;
            throw err;
        }

        const expectedHash = hashOtp(cleanPhone, code);
        if (expectedHash !== otpRecord.otp_hash) {
            await client.query(
                `UPDATE customer_otps SET attempts = attempts + 1 WHERE id = $1`,
                [otpRecord.id]
            );
            const remaining = otpRecord.max_attempts - (otpRecord.attempts + 1);
            const err = new Error(`Incorrect verification code. ${remaining} attempt(s) remaining.`);
            err.statusCode = 400;
            throw err;
        }

        // Consume OTP
        await client.query(
            `UPDATE customer_otps SET consumed_at = NOW() WHERE id = $1`,
            [otpRecord.id]
        );

        // Find or create customer
        let customerRes = await client.query(
            `SELECT * FROM customers WHERE phone = $1`,
            [cleanPhone]
        );

        let customer;
        if (!customerRes.rows.length) {
            const insertRes = await client.query(
                `INSERT INTO customers (phone, first_name, is_guest, is_active)
                 VALUES ($1, 'Crunch Lover', false, true)
                 RETURNING *`,
                [cleanPhone]
            );
            customer = insertRes.rows[0];
        } else {
            customer = customerRes.rows[0];
        }

        // Create 30-day session
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const sessionExpiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

        await client.query(
            `INSERT INTO customer_sessions (
                customer_id, session_token, auth_provider, ip_address, user_agent, expires_at
             ) VALUES ($1, $2, 'phone_otp', $3, $4, $5)`,
            [customer.id, sessionToken, ipAddress, userAgent, sessionExpiresAt]
        );

        return {
            success: true,
            token: sessionToken,
            expiresAt: sessionExpiresAt.toISOString(),
            customer: {
                id: customer.id,
                phone: customer.phone,
                name: customer.first_name ? `${customer.first_name} ${customer.last_name || ''}`.trim() : 'Customer',
                email: customer.email
            }
        };
    });
}

/**
 * Validates a session token and returns the authenticated customer.
 */
export async function getSessionCustomer(token) {
    if (!token) return null;

    const res = await query(
        `SELECT c.id, c.phone, c.first_name, c.last_name, c.email, cs.expires_at, cs.auth_provider
         FROM customer_sessions cs
         JOIN customers c ON cs.customer_id = c.id
         WHERE cs.session_token = $1 AND cs.expires_at > NOW() AND c.is_active = true`,
        [token]
    );

    if (!res.rows.length) return null;
    const row = res.rows[0];
    return {
        id: row.id,
        phone: row.phone,
        name: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : 'Customer',
        email: row.email,
        authProvider: row.auth_provider
    };
}

/**
 * Logs out a customer by terminating their active session.
 */
export async function logoutCustomer(token) {
    if (!token) return;
    await query(`DELETE FROM customer_sessions WHERE session_token = $1`, [token]);
}
