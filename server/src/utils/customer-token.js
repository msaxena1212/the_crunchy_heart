import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || process.env.ORDER_TOKEN_SECRET || 'tch_customer_auth_token_jwt_secret_32_characters';

export function generateCustomerToken(customer) {
    if (!customer?.id) {
        throw new Error('Customer ID is required to generate customer token.');
    }
    return jwt.sign(
        {
            sub: customer.id,
            phone: customer.phone,
            email: customer.email || null,
            role: 'customer',
        },
        CUSTOMER_JWT_SECRET,
        { expiresIn: '30d' }
    );
}

export function verifyCustomerToken(token) {
    if (!token) {
        return { valid: false, reason: 'TOKEN_MISSING' };
    }
    try {
        const decoded = jwt.verify(token, CUSTOMER_JWT_SECRET);
        return { valid: true, payload: decoded };
    } catch (err) {
        return { valid: false, reason: err.name || 'INVALID_TOKEN' };
    }
}

export function authenticateCustomer(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'Authentication token required.',
            code: 'AUTH_REQUIRED',
        });
    }

    const token = authHeader.slice(7).trim();
    const result = verifyCustomerToken(token);

    if (!result.valid) {
        return res.status(401).json({
            success: false,
            message: 'Invalid or expired customer session.',
            code: result.reason,
        });
    }

    req.customer = result.payload;
    next();
}
