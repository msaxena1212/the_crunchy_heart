import { query } from '../db/pool.js';
import {
    verifyPassword,
    generateAdminSessionToken,
    generateCsrfToken,
} from '../utils/admin-token.js';
import {
    listOrdersAdmin,
    getOrderDetailsAdmin,
    dispatchCodOrderAdmin,
    listPendingRefundsAdmin,
} from '../services/admin.service.js';

// In-memory rate limiting map for login attempts: ip -> { count, firstAttempt }
const loginAttemptMap = new Map();
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(ip) {
    const now = Date.now();
    const record = loginAttemptMap.get(ip);

    if (!record) return { allowed: true };

    if (now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
        loginAttemptMap.delete(ip);
        return { allowed: true };
    }

    if (record.count >= RATE_LIMIT_MAX_ATTEMPTS) {
        const retryAfterSeconds = Math.ceil(
            (record.firstAttempt + RATE_LIMIT_WINDOW_MS - now) / 1000
        );
        return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true };
}

function recordLoginFailure(ip) {
    const now = Date.now();
    const record = loginAttemptMap.get(ip);
    if (!record || now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
        loginAttemptMap.set(ip, { count: 1, firstAttempt: now });
    } else {
        record.count += 1;
    }
}

function clearLoginFailures(ip) {
    loginAttemptMap.delete(ip);
}

/**
 * Owner login controller
 */
export async function loginAdmin(req, res, next) {
    try {
        const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
        const rateLimit = checkLoginRateLimit(clientIp);

        if (!rateLimit.allowed) {
            return res.status(429).json({
                success: false,
                code: 'RATE_LIMIT_EXCEEDED',
                message: `Too many failed login attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`,
                error: {
                    code: 'RATE_LIMIT_EXCEEDED',
                    message: `Too many failed login attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`,
                },
            });
        }

        const { email, password } = req.body || {};

        if (
            !email ||
            !password ||
            typeof email !== 'string' ||
            typeof password !== 'string' ||
            !email.includes('@')
        ) {
            recordLoginFailure(clientIp);
            return res.status(401).json({
                success: false,
                code: 'INVALID_CREDENTIALS',
                message: 'Invalid email or password.',
                error: {
                    code: 'INVALID_CREDENTIALS',
                    message: 'Invalid email or password.',
                },
            });
        }

        const cleanEmail = email.trim().toLowerCase();

        // Query admin user
        const result = await query(
            `
            SELECT id, email, password_hash, full_name, role, is_active
            FROM admin_users
            WHERE LOWER(email) = $1
            LIMIT 1
            `,
            [cleanEmail]
        );

        if (!result.rows.length) {
            recordLoginFailure(clientIp);
            return res.status(401).json({
                success: false,
                code: 'INVALID_CREDENTIALS',
                message: 'Invalid email or password.',
                error: {
                    code: 'INVALID_CREDENTIALS',
                    message: 'Invalid email or password.',
                },
            });
        }

        const admin = result.rows[0];

        if (!admin.is_active) {
            recordLoginFailure(clientIp);
            return res.status(401).json({
                success: false,
                code: 'ACCOUNT_DEACTIVATED',
                message: 'This account has been deactivated. Please contact the administrator.',
                error: {
                    code: 'ACCOUNT_DEACTIVATED',
                    message: 'This account has been deactivated. Please contact the administrator.',
                },
            });
        }

        const passwordMatches = verifyPassword(password, admin.password_hash);

        if (!passwordMatches) {
            recordLoginFailure(clientIp);
            return res.status(401).json({
                success: false,
                code: 'INVALID_CREDENTIALS',
                message: 'Invalid email or password.',
                error: {
                    code: 'INVALID_CREDENTIALS',
                    message: 'Invalid email or password.',
                },
            });
        }

        // Authentication successful: clear rate limiter
        clearLoginFailures(clientIp);

        // Update last login timestamp
        await query(
            `UPDATE admin_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [admin.id]
        );

        // Generate session & CSRF tokens
        const sessionToken = generateAdminSessionToken(admin);
        const csrfToken = generateCsrfToken(sessionToken);

        // Record audit log
        await query(
            `
            INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details, created_at)
            VALUES ($1, 'LOGIN', 'admin_user', $2, $3::jsonb, NOW())
            `,
            [admin.id, admin.id, JSON.stringify({ ip: clientIp, email: admin.email })]
        );

        // Set HttpOnly session cookie
        const isProd = process.env.NODE_ENV === 'production';
        res.cookie('tch_admin_session', sessionToken, {
            httpOnly: true,
            secure: isProd,
            sameSite: 'Lax',
            maxAge: 8 * 60 * 60 * 1000, // 8 hours
            path: '/',
        });

        // Set readable CSRF cookie
        res.cookie('tch_csrf_token', csrfToken, {
            httpOnly: false,
            secure: isProd,
            sameSite: 'Lax',
            maxAge: 8 * 60 * 60 * 1000,
            path: '/',
        });

        return res.json({
            success: true,
            message: 'Signed in successfully.',
            admin: {
                id: admin.id,
                email: admin.email,
                fullName: admin.full_name,
                role: admin.role,
            },
            csrfToken,
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Test hook to reset login rate limiter map between isolated test runs.
 */
export function _resetLoginRateLimits() {
    loginAttemptMap.clear();
}

/**
 * Owner logout controller
 */
export async function logoutAdmin(req, res, next) {
    try {
        if (req.admin?.id) {
            await query(
                `
                INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details, created_at)
                VALUES ($1, 'LOGOUT', 'admin_user', $2, '{}'::jsonb, NOW())
                `,
                [req.admin.id, req.admin.id]
            );
        }

        res.clearCookie('tch_admin_session', { path: '/' });
        res.clearCookie('tch_csrf_token', { path: '/' });

        return res.json({
            success: true,
            message: 'Signed out successfully.',
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Current owner profile controller
 */
export async function getMeAdmin(req, res, next) {
    try {
        const result = await query(
            `
            SELECT id, email, full_name, role, is_active, last_login_at, created_at
            FROM admin_users
            WHERE id = $1
            LIMIT 1
            `,
            [req.admin.id]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                success: false,
                code: 'ADMIN_NOT_FOUND',
                message: 'Admin account not found.',
            });
        }

        const admin = result.rows[0];

        return res.json({
            success: true,
            admin: {
                id: admin.id,
                email: admin.email,
                fullName: admin.full_name,
                role: admin.role,
                isActive: admin.is_active,
                lastLoginAt: admin.last_login_at,
                createdAt: admin.created_at,
            },
        });
    } catch (error) {
        next(error);
    }
}

/**
 * List orders for owner dashboard
 */
export async function getOrdersAdmin(req, res, next) {
    try {
        const { page, limit, status, paymentMethod, paymentStatus, search } = req.query;
        const result = await listOrdersAdmin({
            page,
            limit,
            status,
            paymentMethod,
            paymentStatus,
            search,
        });

        return res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Get specific order details for owner dashboard
 */
export async function getOrderAdmin(req, res, next) {
    try {
        const { orderNumber } = req.params;
        const result = await getOrderDetailsAdmin(orderNumber);

        return res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Atomic COD dispatch controller
 */
export async function dispatchOrderAdmin(req, res, next) {
    try {
        const { orderNumber } = req.params;
        const adminUserId = req.admin?.id || null;

        const result = await dispatchCodOrderAdmin({
            orderNumber,
            adminUserId,
        });

        return res.json({
            success: true,
            message: `Order ${orderNumber} has been successfully dispatched.`,
            ...result,
        });
    } catch (error) {
        next(error);
    }
}

/**
 * List pending refund reviews controller
 */
export async function getPendingRefundsAdmin(req, res, next) {
    try {
        const { page, limit } = req.query;
        const result = await listPendingRefundsAdmin({ page, limit });

        return res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        next(error);
    }
}
