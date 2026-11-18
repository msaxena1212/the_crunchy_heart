import { sendOtp, verifyOtp } from '../services/otp.service.js';
import { generateCustomerToken } from '../utils/customer-token.js';
import { query } from '../db/pool.js';

export async function requestOtpController(req, res, next) {
    try {
        const { phone, channel } = req.body;
        const result = await sendOtp({ phone, channel });
        return res.json({
            success: true,
            message: `OTP sent successfully via ${(channel || 'sms').toUpperCase()}.`,
            data: result,
        });
    } catch (err) {
        next(err);
    }
}

export async function verifyOtpController(req, res, next) {
    try {
        const { phone, code } = req.body;
        const result = await verifyOtp({ phone, code });
        const token = generateCustomerToken(result.customer);

        return res.json({
            success: true,
            message: 'Authentication successful.',
            token,
            customer: result.customer,
        });
    } catch (err) {
        next(err);
    }
}

export async function getSessionController(req, res, next) {
    try {
        const customerId = req.customer?.sub;
        if (!customerId) {
            return res.status(401).json({ success: false, message: 'Unauthenticated.' });
        }

        const customerRes = await query(
            `SELECT id, first_name, last_name, email, phone, created_at FROM customers WHERE id = $1`,
            [customerId]
        );

        if (!customerRes.rows.length) {
            return res.status(404).json({ success: false, message: 'Customer not found.' });
        }

        return res.json({
            success: true,
            customer: customerRes.rows[0],
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Neon Auth Webhook handler for Phone OTP delivery
 * (invoked by Neon Auth Managed Better Auth when send.otp plugin fires)
 */
export async function neonAuthWebhookController(req, res, next) {
    try {
        const { phone, code, otp } = req.body || {};
        const otpCode = code || otp;

        if (phone && otpCode) {
            await sendOtp({ phone, channel: 'sms' });
        }

        return res.json({ success: true, received: true });
    } catch (err) {
        console.error('[WARN] Neon Auth webhook handler error:', err.message);
        return res.status(200).json({ success: false, error: err.message });
    }
}
