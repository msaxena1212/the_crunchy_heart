import { verifyAdminSessionToken, verifyCsrfToken } from '../utils/admin-token.js';
import { env } from '../config/env.js';

/**
 * Parse cookies from the raw Cookie header string safely without external dependencies.
 */
export function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;

    const parts = cookieHeader.split(';');
    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx !== -1) {
            const key = part.slice(0, idx).trim();
            const val = part.slice(idx + 1).trim();
            try {
                cookies[key] = decodeURIComponent(val);
            } catch {
                cookies[key] = val;
            }
        }
    }
    return cookies;
}

/**
 * Allowed client origins for origin verification.
 */
const ALLOWED_ORIGINS = new Set([
    'http://localhost:4200',
    'http://127.0.0.1:4200',
    env.clientUrl,
].filter(Boolean));

/**
 * Express middleware to authenticate owner/admin requests.
 * Fails closed on any authentication or authorization gap.
 */
export function requireAdminAuth(req, res, next) {
    const cookies = req.cookies || parseCookies(req.headers.cookie);
    let sessionToken = null;
    let authSource = null;

    // 1. Extract session token: prioritize HttpOnly cookie, then Authorization header, then x-admin-token
    if (cookies.tch_admin_session) {
        sessionToken = cookies.tch_admin_session;
        authSource = 'cookie';
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        sessionToken = req.headers.authorization.slice(7).trim();
        authSource = 'header';
    } else if (req.headers['x-admin-token']) {
        sessionToken = String(req.headers['x-admin-token']).trim();
        authSource = 'header';
    }

    if (!sessionToken) {
        return res.status(401).json({
            success: false,
            code: 'ADMIN_AUTHENTICATION_REQUIRED',
            message: 'Authentication required. Please sign in as an owner.',
            error: {
                code: 'UNAUTHENTICATED',
                message: 'Authentication required. Please sign in as an owner.',
            },
        });
    }

    // 2. Cryptographic session verification
    const verification = verifyAdminSessionToken(sessionToken);

    if (!verification.valid) {
        if (verification.reason === 'TOKEN_EXPIRED') {
            return res.status(401).json({
                success: false,
                code: 'SESSION_EXPIRED',
                message: 'Your owner session has expired. Please sign in again.',
                error: {
                    code: 'SESSION_EXPIRED',
                    message: 'Your owner session has expired. Please sign in again.',
                },
            });
        }

        if (verification.reason === 'INSUFFICIENT_ROLE') {
            return res.status(403).json({
                success: false,
                code: 'FORBIDDEN_ROLE',
                message: 'Access restricted to administrators.',
                error: {
                    code: 'FORBIDDEN',
                    message: 'Access restricted to administrators.',
                },
            });
        }

        // Fails closed on signature mismatch, malformed payload, purpose mismatch (e.g. guest token passed)
        return res.status(401).json({
            success: false,
            code: 'INVALID_ADMIN_TOKEN',
            message: 'Invalid owner authentication credentials.',
            error: {
                code: 'SESSION_INVALID',
                message: 'Invalid owner authentication credentials.',
            },
        });
    }

    // 3. CSRF Protection for state-changing requests when authenticated via cookie
    const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method.toUpperCase());

    if (authSource === 'cookie' && isStateChanging) {
        // Origin validation (if Origin or Referer header is sent by browser)
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        if (origin && !ALLOWED_ORIGINS.has(origin)) {
            return res.status(403).json({
                success: false,
                code: 'CSRF_ORIGIN_REJECTED',
                message: 'Request origin is not authorized.',
                error: {
                    code: 'CSRF_ORIGIN_REJECTED',
                    message: 'Request origin is not authorized.',
                },
            });
        }

        // Token synchronizer / double-submit CSRF verification
        const csrfTokenHeader = req.headers['x-csrf-token'];
        const csrfCookie = cookies.tch_csrf_token;

        if (!csrfTokenHeader) {
            return res.status(403).json({
                success: false,
                code: 'CSRF_TOKEN_MISSING',
                message: 'CSRF token is required for state-changing operations.',
                error: {
                    code: 'CSRF_REQUIRED',
                    message: 'CSRF token is required for state-changing operations.',
                },
            });
        }

        const validCsrf =
            verifyCsrfToken(csrfTokenHeader, sessionToken) ||
            (csrfCookie && csrfTokenHeader === csrfCookie);

        if (!validCsrf) {
            return res.status(403).json({
                success: false,
                code: 'CSRF_VALIDATION_FAILED',
                message: 'Invalid CSRF token.',
                error: {
                    code: 'CSRF_INVALID',
                    message: 'Invalid CSRF token.',
                },
            });
        }
    }

    // 4. Attach authenticated admin identity
    req.admin = {
        id: verification.payload.adminId,
        email: verification.payload.email,
        role: verification.payload.role,
        authSource,
    };

    next();
}
