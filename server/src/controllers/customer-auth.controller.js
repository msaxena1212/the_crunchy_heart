import {
    sendCustomerOtp,
    verifyCustomerOtp,
    getSessionCustomer,
    logoutCustomer,
    getCustomerOrders,
    updateCustomerProfile
} from '../services/customer-auth.service.js';
import { parseCookies } from '../middleware/admin-auth.js';

const CUSTOMER_COOKIE_NAME = 'tch_customer_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

function extractCustomerToken(req) {
    const cookies = req.cookies || parseCookies(req.headers.cookie);
    if (cookies && cookies[CUSTOMER_COOKIE_NAME]) {
        return cookies[CUSTOMER_COOKIE_NAME];
    }
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        const bearer = authHeader.slice(7).trim();
        if (bearer && bearer !== 'null' && bearer !== 'undefined') {
            return bearer;
        }
    }
    return null;
}

function setCustomerSessionCookie(res, token) {
    const isSecure = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' || (process.env.CLIENT_URL || '').startsWith('https://');
    const parts = [
        `${CUSTOMER_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    ];
    if (isSecure) {
        parts.push('Secure');
    }
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCustomerSessionCookie(res) {
    const isSecure = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' || (process.env.CLIENT_URL || '').startsWith('https://');
    const parts = [
        `${CUSTOMER_COOKIE_NAME}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0',
    ];
    if (isSecure) {
        parts.push('Secure');
    }
    res.setHeader('Set-Cookie', parts.join('; '));
}

export async function requestOtpController(req, res, next) {
    try {
        const { phone, channel, purpose } = req.body;
        const result = await sendCustomerOtp({ phone, channel, purpose });
        return res.json(result);
    } catch (error) {
        return res.status(error.statusCode || 400).json({
            success: false,
            message: error.message
        });
    }
}

export async function verifyOtpController(req, res, next) {
    try {
        const { phone, otp } = req.body;
        const ipAddress = req.ip || req.connection?.remoteAddress;
        const userAgent = req.headers['user-agent'] || '';

        const result = await verifyCustomerOtp({
            phone,
            otp,
            ipAddress,
            userAgent
        });

        if (result?.success && result?.token) {
            setCustomerSessionCookie(res, result.token);
        }

        return res.json(result);
    } catch (error) {
        return res.status(error.statusCode || 400).json({
            success: false,
            message: error.message
        });
    }
}

export async function getMeController(req, res, next) {
    try {
        const token = extractCustomerToken(req);

        if (!token) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const customer = await getSessionCustomer(token);
        if (!customer) {
            clearCustomerSessionCookie(res);
            return res.status(401).json({ success: false, message: 'Session expired or invalid.' });
        }

        return res.json({ success: true, customer });
    } catch (error) {
        next(error);
    }
}

export async function getOrdersController(req, res, next) {
    try {
        const token = extractCustomerToken(req);

        if (!token) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const customer = await getSessionCustomer(token);
        if (!customer) {
            clearCustomerSessionCookie(res);
            return res.status(401).json({ success: false, message: 'Session expired or invalid.' });
        }

        const orders = await getCustomerOrders(customer.id, customer.phone);
        return res.json({ success: true, orders });
    } catch (error) {
        next(error);
    }
}

export async function updateProfileController(req, res, next) {
    try {
        const token = extractCustomerToken(req);

        if (!token) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const customer = await getSessionCustomer(token);
        if (!customer) {
            clearCustomerSessionCookie(res);
            return res.status(401).json({ success: false, message: 'Session expired or invalid.' });
        }

        const updated = await updateCustomerProfile(customer.id, req.body || {});
        return res.json({ success: true, customer: updated });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }
}

export async function logoutController(req, res, next) {
    try {
        const token = extractCustomerToken(req);
        if (token) {
            await logoutCustomer(token);
        }
        clearCustomerSessionCookie(res);
        return res.json({ success: true, message: 'Logged out successfully.' });
    } catch (error) {
        next(error);
    }
}
