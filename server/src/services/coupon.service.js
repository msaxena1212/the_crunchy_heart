/*
|--------------------------------------------------------------------------
| Coupons
|--------------------------------------------------------------------------
| One place for every coupon rule, used by the checkout preview, order creation and the admin
| editor so they can never disagree.
|
| - Discount applies to the goods total after any festive combo discount. Never to shipping.
| - It stacks on top of the combo discount.
| - The payable amount never drops below Rs 1, so a payment can always be created.
| - Redemptions are counted when an order is created and given back if that order is cancelled
|   or its payment hold expires.
|--------------------------------------------------------------------------
*/

import { query } from '../db/pool.js';
import { roundMoney } from '../utils/money.js';

export const COUPON_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,29}$/;
const MIN_PAYABLE = 1;

/** Last 10 digits, so +91 / spaces / dashes cannot be used to dodge per-customer limits. */
export function phoneKey(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
}

export function normalizeCouponCode(raw) {
    if (raw === undefined || raw === null) return null;
    const code = String(raw).trim().toUpperCase();
    return code || null;
}

function couponError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

const rupees = value => `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** Pure discount maths: how much a coupon takes off `discountableAmount`. */
export function computeCouponDiscount(coupon, discountableAmount) {
    const base = Number(discountableAmount) || 0;
    const value = Number(coupon.discount_value) || 0;
    let amount = coupon.discount_type === 'percentage' ? (base * value) / 100 : value;
    if (coupon.maximum_discount !== null && coupon.maximum_discount !== undefined) {
        amount = Math.min(amount, Number(coupon.maximum_discount));
    }
    // Leave at least Rs 1 payable.
    amount = Math.min(amount, Math.max(base - MIN_PAYABLE, 0));
    return roundMoney(Math.max(amount, 0));
}

/**
 * Validate a coupon for a cart and work out its discount.
 *
 * @param {{query: Function}} db  a pool-like object or a transaction client
 * @param {object} p
 * @param {string} p.code
 * @param {number} p.subtotal             goods total before any discount (checked against the minimum order)
 * @param {number} p.discountableAmount   goods total after the combo discount (the discount base)
 * @param {string|null} p.phone           customer phone; per-customer and first-order rules need it
 * @param {boolean} p.lock                lock the coupon row (use inside the order transaction)
 */
export async function evaluateCoupon(db, { code, subtotal, discountableAmount, phone = null, lock = false }) {
    const normalized = normalizeCouponCode(code);
    if (!normalized) return null;

    const found = await db.query(
        `SELECT id, code, description, discount_type, discount_value, minimum_order_value, maximum_discount,
                usage_limit, usage_count, per_customer_limit, starts_at, expires_at, is_active, first_order_only
         FROM coupons WHERE lower(code) = lower($1) ${lock ? 'FOR UPDATE' : ''}`,
        [normalized]
    );
    const coupon = found.rows[0];
    if (!coupon || !coupon.is_active) {
        throw couponError('COUPON_INVALID', 'This coupon code is not valid.');
    }

    const now = new Date();
    if (coupon.starts_at && new Date(coupon.starts_at) > now) {
        throw couponError('COUPON_NOT_STARTED', 'This coupon is not active yet.');
    }
    if (coupon.expires_at && new Date(coupon.expires_at) <= now) {
        throw couponError('COUPON_EXPIRED', 'This coupon has expired.');
    }
    if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) {
        throw couponError('COUPON_EXHAUSTED', 'This coupon has been fully redeemed.');
    }

    const minimum = Number(coupon.minimum_order_value) || 0;
    if (Number(subtotal) < minimum) {
        throw couponError(
            'COUPON_MIN_ORDER',
            `Add ${rupees(minimum - Number(subtotal))} more to use this coupon (minimum order ${rupees(minimum)}).`
        );
    }

    const key = phoneKey(phone);
    if (key) {
        if (coupon.per_customer_limit !== null) {
            const used = await db.query(
                `SELECT COUNT(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND phone = $2`,
                [coupon.id, key]
            );
            if (used.rows[0].n >= coupon.per_customer_limit) {
                throw couponError('COUPON_LIMIT_REACHED', 'You have already used this coupon.');
            }
        }
        if (coupon.first_order_only) {
            const prior = await db.query(
                `SELECT 1 FROM orders
                 WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1 AND status <> 'cancelled' LIMIT 1`,
                [key]
            );
            if (prior.rows.length) {
                throw couponError('COUPON_FIRST_ORDER_ONLY', 'This coupon is only for first orders.');
            }
        }
    }

    const discountAmount = computeCouponDiscount(coupon, discountableAmount);
    if (discountAmount <= 0) {
        throw couponError('COUPON_NO_DISCOUNT', 'This coupon does not reduce the price of this cart.');
    }
    return { coupon, discountAmount };
}

/** Preview helper: validate without locking and report errors as data instead of throwing. */
export async function previewCoupon(params) {
    try {
        const result = await evaluateCoupon({ query }, params);
        if (!result) return { applied: false };
        return {
            applied: true,
            code: result.coupon.code,
            description: result.coupon.description || null,
            discountAmount: result.discountAmount,
        };
    } catch (error) {
        if (error.code && error.code.startsWith('COUPON_')) {
            return { applied: false, code: normalizeCouponCode(params.code), error: error.message, errorCode: error.code };
        }
        throw error;
    }
}

/** Count a redemption against an order. Call inside the order transaction, after the order row exists. */
export async function recordRedemption(client, { couponId, orderId, phone, discountAmount }) {
    await client.query(
        `INSERT INTO coupon_redemptions (coupon_id, order_id, phone, discount_amount) VALUES ($1, $2, $3, $4)`,
        [couponId, orderId, phoneKey(phone), discountAmount]
    );
    await client.query(`UPDATE coupons SET usage_count = usage_count + 1, updated_at = NOW() WHERE id = $1`, [couponId]);
}

/** Give a redemption back when its order is cancelled or never paid. Safe to call repeatedly. */
export async function releaseCouponRedemption(client, orderId) {
    const removed = await client.query(
        `DELETE FROM coupon_redemptions WHERE order_id = $1 RETURNING coupon_id`,
        [orderId]
    );
    for (const row of removed.rows) {
        await client.query(
            `UPDATE coupons SET usage_count = GREATEST(usage_count - 1, 0), updated_at = NOW() WHERE id = $1`,
            [row.coupon_id]
        );
    }
    return removed.rowCount;
}

// ---------------------------------------------------------------------------- admin

const MAX_MONEY = 1_000_000;

function toMoney(value, field, { required = false, allowZero = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw couponError('VALIDATION', `${field} is required.`);
        return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY || (!allowZero && n === 0)) {
        throw couponError('VALIDATION', `${field} must be a valid amount.`);
    }
    return roundMoney(n);
}

function toLimit(value, field) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
        throw couponError('VALIDATION', `${field} must be a whole number of at least 1.`);
    }
    return n;
}

function toDate(value, field) {
    if (value === undefined || value === null || value === '') return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw couponError('VALIDATION', `${field} is not a valid date.`);
    return d;
}

/** Validate and normalise admin input. `partial` allows omitted fields on update. */
export function validateCouponInput(input, { partial = false } = {}) {
    const out = {};
    const has = key => input[key] !== undefined;

    if (!partial || has('code')) {
        const code = normalizeCouponCode(input.code);
        if (!code || !COUPON_CODE_RE.test(code)) {
            throw couponError('VALIDATION', 'Code must be 3-30 letters, digits, hyphens or underscores.');
        }
        out.code = code;
    }
    if (!partial || has('discountType')) {
        if (!['percentage', 'fixed'].includes(input.discountType)) {
            throw couponError('VALIDATION', 'Discount type must be percentage or fixed.');
        }
        out.discountType = input.discountType;
    }
    if (!partial || has('discountValue')) {
        out.discountValue = toMoney(input.discountValue, 'Discount value', { required: true, allowZero: false });
    }
    if (has('description')) out.description = String(input.description || '').trim().slice(0, 200) || null;
    if (has('minimumOrderValue')) out.minimumOrderValue = toMoney(input.minimumOrderValue, 'Minimum order') ?? 0;
    if (has('maximumDiscount')) out.maximumDiscount = toMoney(input.maximumDiscount, 'Maximum discount', { allowZero: false });
    if (has('usageLimit')) out.usageLimit = toLimit(input.usageLimit, 'Usage limit');
    if (has('perCustomerLimit')) out.perCustomerLimit = toLimit(input.perCustomerLimit, 'Per-customer limit');
    if (has('startsAt')) out.startsAt = toDate(input.startsAt, 'Start date');
    if (has('expiresAt')) out.expiresAt = toDate(input.expiresAt, 'Expiry date');
    if (has('isActive')) out.isActive = Boolean(input.isActive);
    if (has('firstOrderOnly')) out.firstOrderOnly = Boolean(input.firstOrderOnly);

    const type = out.discountType ?? input.discountType;
    const value = out.discountValue ?? Number(input.discountValue);
    if (type === 'percentage' && value > 100) {
        throw couponError('VALIDATION', 'A percentage discount cannot be more than 100.');
    }
    if (out.startsAt && out.expiresAt && out.expiresAt <= out.startsAt) {
        throw couponError('VALIDATION', 'Expiry must be after the start date.');
    }
    return out;
}
