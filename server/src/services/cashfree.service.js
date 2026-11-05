import crypto from 'node:crypto';

import { env } from '../config/env.js';


const CASHFREE_SANDBOX_URL =
    'https://sandbox.cashfree.com';

const CASHFREE_PRODUCTION_URL =
    'https://api.cashfree.com';


export function getBaseUrl() {
    return env.cashfreeEnvironment === 'production'
        ? CASHFREE_PRODUCTION_URL
        : CASHFREE_SANDBOX_URL;
}


export function ensureConfigured() {
    // Thrown before any network call, so the provider was never contacted.
    if (!env.cashfreeClientId) {
        throw Object.assign(new Error(
            'CASHFREE_CLIENT_ID is not configured.'
        ), { code: 'CASHFREE_NOT_CONFIGURED' });
    }

    if (!env.cashfreeClientSecret) {
        throw Object.assign(new Error(
            'CASHFREE_CLIENT_SECRET is not configured.'
        ), { code: 'CASHFREE_NOT_CONFIGURED' });
    }
}


export function buildHeaders() {
    ensureConfigured();

    return {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-client-id': env.cashfreeClientId,
        'x-client-secret': env.cashfreeClientSecret,
        'x-api-version': env.cashfreeApiVersion,
    };
}


/**
 * Create an order in Cashfree.
 *
 * Cashfree returns:
 * - cf_order_id
 * - order_id
 * - payment_session_id
 */
// Upper bound for the order-creation call. Kept well below ATTEMPT_LEASE_MS in
// order.service.js, so a live call can never look stale to another request.
export const CASHFREE_CREATE_TIMEOUT_MS = 15000;

export async function createCashfreeOrder({
    orderId,
    orderAmount,
    customer,
    orderNote,
}) {
    ensureConfigured();

    const url =
        `${getBaseUrl()}/pg/orders`;

    const payload = {
        order_amount: Number(orderAmount),
        order_currency: 'INR',

        order_id: orderId,

        customer_details: {
            customer_id:
                customer?.customerId ||
                customer?.phone ||
                `customer_${orderId}`,

            customer_name:
                customer?.name || '',

            customer_email:
                customer?.email || '',

            customer_phone:
                customer?.phone || '',
        },

        order_meta: {
            return_url:
                `${env.cashfreeReturnUrl}?order_id={order_id}`,

            notify_url:
                env.cashfreeWebhookUrl,
        },

        order_note:
            orderNote ||
            `The Crunchy Heart order ${orderId}`,
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CASHFREE_CREATE_TIMEOUT_MS),
    });

    const responseText = await response.text();

    let data;

    try {
        data = responseText
            ? JSON.parse(responseText)
            : {};
    } catch {
        data = {
            raw: responseText,
        };
    }

    if (!response.ok) {
        const error = new Error(
            data?.message ||
            data?.type ||
            `Cashfree Create Order failed with HTTP ${response.status}.`
        );

        error.statusCode = response.status;
        error.cashfreeResponse = data;

        throw error;
    }

    if (!data.payment_session_id) {
        const error = new Error(
            'Cashfree did not return payment_session_id.'
        );

        error.cashfreeResponse = data;

        throw error;
    }

    return data;
}


/**
 * Fetch Cashfree order details by merchant order_id.
 *
 * GET /pg/orders/{order_id}
 */
export async function getCashfreeOrder(orderId) {
    if (!orderId || typeof orderId !== 'string') {
        const error = new Error('Cashfree order_id is required.');
        error.statusCode = 400;
        throw error;
    }

    ensureConfigured();

    const url =
        `${getBaseUrl()}/pg/orders/${encodeURIComponent(orderId)}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(),
    });

    const responseText = await response.text();

    let data;

    try {
        data = responseText
            ? JSON.parse(responseText)
            : {};
    } catch {
        data = {
            raw: responseText,
        };
    }

    if (!response.ok) {
        const error = new Error(
            data?.message ||
            data?.type ||
            `Cashfree get order failed with HTTP ${response.status}.`
        );

        error.statusCode = response.status;
        error.cashfreeResponse = data;

        throw error;
    }

    if (!data || typeof data !== 'object') {
        const error = new Error('Cashfree returned malformed order data.');
        error.statusCode = 502;
        error.cashfreeResponse = data;
        throw error;
    }

    return data;
}


/**
 * Fetch all payment attempts for a Cashfree order.
 */
export async function getCashfreePayments(orderId) {
    if (!orderId || typeof orderId !== 'string') {
        const error = new Error('Cashfree order_id is required.');
        error.statusCode = 400;
        throw error;
    }

    ensureConfigured();

    const url =
        `${getBaseUrl()}/pg/orders/${encodeURIComponent(orderId)}/payments`;

    const response = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(),
    });

    const responseText = await response.text();

    let data;

    try {
        data = responseText
            ? JSON.parse(responseText)
            : [];
    } catch {
        data = {
            raw: responseText,
        };
    }

    if (!response.ok) {
        const error = new Error(
            data?.message ||
            `Cashfree payment status request failed with HTTP ${response.status}.`
        );

        error.statusCode = response.status;
        error.cashfreeResponse = data;

        throw error;
    }

    return Array.isArray(data)
        ? data
        : data?.data || data;
}


/**
 * Determine the aggregate payment state from Cashfree transactions.
 */
export function resolveCashfreePaymentStatus(payments) {
    const transactions =
        Array.isArray(payments)
            ? payments
            : [];

    if (
        transactions.some(
            payment =>
                payment?.payment_status === 'SUCCESS'
        )
    ) {
        return 'SUCCESS';
    }

    if (
        transactions.some(
            payment =>
                payment?.payment_status === 'PENDING'
        )
    ) {
        return 'PENDING';
    }

    if (transactions.length > 0) {
        return 'FAILED';
    }

    return 'UNKNOWN';
}


/**
 * Verify Cashfree webhook signature.
 *
 * Cashfree signature:
 * base64(HMAC-SHA256(timestamp + rawBody, secret))
 */
export function verifyCashfreeWebhookSignature({
    signature,
    timestamp,
    rawBody,
}) {
    if (
        !signature ||
        !timestamp ||
        typeof rawBody !== 'string'
    ) {
        return false;
    }

    ensureConfigured();

    const signedPayload =
        `${timestamp}${rawBody}`;

    const expectedSignature =
        crypto
            .createHmac(
                'sha256',
                env.cashfreeClientSecret
            )
            .update(signedPayload)
            .digest('base64');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    } catch {
        return false;
    }
}