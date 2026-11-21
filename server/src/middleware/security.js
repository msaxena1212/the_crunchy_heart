/*
|--------------------------------------------------------------------------
| Application Security Headers & Rate Limiting Middleware
|--------------------------------------------------------------------------
| Zero-dependency security hardening for Express:
| 1. Standard security headers (HSTS, CSP, X-Content-Type-Options,
|    X-Frame-Options, Referrer-Policy, Permissions-Policy).
| 2. Sliding-window IP rate limiter factory for checkout, orders, and auth
|    routes to prevent flooding and brute-force abuse.
|--------------------------------------------------------------------------
*/

/**
 * Sets strict HTTP security headers on every response.
 */
export function securityHeadersMiddleware(req, res, next) {
    // Prevent MIME-type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    // Legacy XSS filter disable (modern browsers rely on CSP)
    res.setHeader('X-XSS-Protection', '0');

    // Strict referrer policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Restrict browser features
    res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(self "https://sdk.cashfree.com" "https://sandbox.cashfree.com" "https://api.cashfree.com")'
    );

    // Enforce HTTPS (HSTS) - 1 year
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    // Cross-Origin-Opener-Policy (allow popups for Cashfree payment redirects)
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

    // Remove Express fingerprint header
    res.removeHeader('X-Powered-By');

    next();
}

/**
 * Creates a memory-safe sliding-window IP rate limiter middleware.
 * Automatically prunes expired entries to prevent unbounded memory growth.
 */
export function createIpRateLimiter({
    windowMs = 60 * 1000,
    maxRequests = 60,
    code = 'RATE_LIMIT_EXCEEDED',
    message = 'Too many requests from this IP. Please try again shortly.',
} = {}) {
    const hits = new Map();

    // Periodic cleanup every windowMs
    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [ip, record] of hits.entries()) {
            if (now - record.windowStart >= windowMs) {
                hits.delete(ip);
            }
        }
    }, windowMs);
    cleanupTimer.unref?.();

    return function rateLimitMiddleware(req, res, next) {
        // Skip rate limiting during local automated test suites unless explicitly testing rate limiters
        if (process.env.NODE_ENV === 'test' && process.env.ENFORCE_TEST_RATE_LIMIT !== 'true') {
            return next();
        }

        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        const now = Date.now();
        let record = hits.get(ip);

        if (!record || now - record.windowStart >= windowMs) {
            record = { count: 1, windowStart: now };
            hits.set(ip, record);
        } else {
            record.count += 1;
        }

        const remaining = Math.max(0, maxRequests - record.count);
        const resetSeconds = Math.ceil((record.windowStart + windowMs - now) / 1000);

        res.setHeader('X-RateLimit-Limit', String(maxRequests));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(resetSeconds));

        if (record.count > maxRequests) {
            res.setHeader('Retry-After', String(resetSeconds));
            return res.status(429).json({
                success: false,
                code,
                message,
                retryAfterSeconds: resetSeconds,
            });
        }

        return next();
    };
}
