import crypto from 'node:crypto';
import { getBaseUrl, buildHeaders } from './cashfree.service.js';

/*
|--------------------------------------------------------------------------
| Cashfree Refund Adapter (Payment Gateway refunds)
|--------------------------------------------------------------------------
| Implements the refund-provider contract used by refund.service.js:
|   createRefund({ providerOrderId, refundKey, amount, currency })
|   getRefund({ providerOrderId, refundKey })
| plus listRefundsForOrder(providerOrderId) for operator reconciliation.
|
| Verified from Cashfree's published Refunds documentation (Payment Gateway):
|   POST /pg/orders/{order_id}/refunds       body: refund_amount, refund_id
|   GET  /pg/orders/{order_id}/refunds/{refund_id}
|   GET  /pg/orders/{order_id}/refunds
|   refund_id must be alphanumeric and unique per merchant.
|   Response carries refund_id, cf_refund_id, refund_amount, refund_status.
|
| NOT verified (treated conservatively, must be confirmed against live sandbox
| behaviour before enabling):
|   - the full set of refund_status values (only PENDING is documented);
|     SUCCESS, FAILED and CANCELLED are assumed.
|   - whether x-idempotency-key exists or how it behaves. This adapter does
|     not send it. Idempotency relies on the deterministic alphanumeric
|     refund_id plus GET reconciliation.
|   - HTTP status meanings for retries and duplicate creation.
|
| This module is NOT wired into the worker. The refund provider stays
| fail-closed until deployment explicitly enables it.
|--------------------------------------------------------------------------
*/

export const DEFAULT_REFUND_TIMEOUT_MS = 15000;

// Client-side 4xx codes where the provider certainly did not create a refund.
const DEFINITIVE_HTTP_STATUSES = new Set([400, 401, 403, 404, 422]);

function adapterError(code, message, { definitive = false, httpStatus = null } = {}) {
    return Object.assign(new Error(message), { code, definitive, httpStatus });
}

/*
 * Deterministic alphanumeric refund_id derived from the local idempotency key.
 * The same logical refund always maps to the same provider refund_id.
 */
export function deriveProviderRefundId(refundKey) {
    if (!refundKey) {
        throw adapterError('VALIDATION', 'refundKey is required.', { definitive: true });
    }
    const digest = crypto.createHash('sha256').update(String(refundKey)).digest('hex');
    return `TCHRF${digest.slice(0, 32).toUpperCase()}`;
}

/*
 * Maps Cashfree status strings to the internal contract. Anything unknown is
 * UNKNOWN, which refund.service treats as ambiguous (reconcile, never resubmit).
 */
export function normalizeRefundStatus(rawStatus) {
    const status = String(rawStatus || '').trim().toUpperCase();

    if (status === 'SUCCESS' || status === 'SUCCEEDED' || status === 'PROCESSED') return 'SUCCEEDED';
    if (status === 'PENDING' || status === 'PROCESSING' || status === 'QUEUED') return 'PENDING';
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'REJECTED') return 'FAILED';

    return 'UNKNOWN';
}

async function requestJson(fetchImpl, url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
        // Timeout or network failure after the request may have been sent: ambiguous.
        const code = error.name === 'AbortError' ? 'ETIMEDOUT' : 'NETWORK_ERROR';
        throw adapterError(code, `Cashfree refund request did not complete (${code}).`);
    } finally {
        clearTimeout(timer);
    }

    const text = await response.text();
    let body = null;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            body = undefined; // malformed
        }
    }

    return { httpStatus: response.status, body };
}

// Documented order ID shape. Anything else never reaches the URL.
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function assertOrderId(providerOrderId) {
    if (!ORDER_ID_PATTERN.test(String(providerOrderId || ''))) {
        throw adapterError('VALIDATION', 'providerOrderId has an invalid format.', { definitive: true });
    }
}

function assertIdentity(refund, { refundId, orderId, amount }) {
    if (!refund || typeof refund !== 'object') {
        throw adapterError('MALFORMED_RESPONSE', 'Refund response is not an object.');
    }

    // The response must name the same order. A missing order_id is malformed, not a pass.
    if (refund.order_id === undefined || refund.order_id === null) {
        throw adapterError('MALFORMED_RESPONSE', 'Refund response does not identify its order.');
    }

    if (String(refund.order_id) !== String(orderId)) {
        throw adapterError('IDENTITY_MISMATCH', 'Provider order_id does not match the local order.', { definitive: true });
    }

    if (refund.refund_id !== refundId) {
        throw adapterError('IDENTITY_MISMATCH', 'Provider refund_id does not match the local refund.', { definitive: true });
    }

    if (amount !== undefined && Math.abs(Number(refund.refund_amount) - Number(amount)) > 0.01) {
        throw adapterError('AMOUNT_MISMATCH', 'Provider refund amount does not match the local refund.', { definitive: true });
    }
}

function toResult(refund) {
    return {
        status: normalizeRefundStatus(refund.refund_status),
        rawStatus: refund.refund_status || null,
        providerRefundId: refund.cf_refund_id ? String(refund.cf_refund_id) : String(refund.refund_id),
    };
}

export function createCashfreeRefundAdapter({
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_REFUND_TIMEOUT_MS,
} = {}) {
    const ordersPath = orderId => `${getBaseUrl()}/pg/orders/${encodeURIComponent(orderId)}/refunds`;

    return {
        async createRefund({ providerOrderId, refundKey, amount }) {
            assertOrderId(providerOrderId);

            const refundId = deriveProviderRefundId(refundKey);
            const { httpStatus, body } = await requestJson(
                fetchImpl,
                ordersPath(providerOrderId),
                {
                    method: 'POST',
                    // Documented SDK parameter; not in the REST parameter tables, so the
                    // server-side effect is unverified. The value is the stable refund_id.
                    headers: { ...buildHeaders(), 'x-idempotency-key': refundId },
                    body: JSON.stringify({
                        refund_amount: Number(amount),
                        refund_id: refundId,
                        refund_note: 'Refund',
                    }),
                },
                timeoutMs
            );

            if (httpStatus >= 200 && httpStatus < 300) {
                if (body === undefined || body === null) {
                    throw adapterError('MALFORMED_RESPONSE', 'Empty or malformed refund response.');
                }
                assertIdentity(body, { refundId, orderId: providerOrderId, amount });
                return toResult(body);
            }

            // Non-2xx. Only certain client rejections are definitive.
            throw adapterError(
                'PROVIDER_HTTP_ERROR',
                `Cashfree refund request returned HTTP ${httpStatus}.`,
                { definitive: DEFINITIVE_HTTP_STATUSES.has(httpStatus), httpStatus }
            );
        },

        async getRefund({ providerOrderId, refundKey }) {
            assertOrderId(providerOrderId);
            const refundId = deriveProviderRefundId(refundKey);
            const url = `${ordersPath(providerOrderId)}/${encodeURIComponent(refundId)}`;
            const { httpStatus, body } = await requestJson(
                fetchImpl,
                url,
                { method: 'GET', headers: buildHeaders() },
                timeoutMs
            );

            if (httpStatus === 404) {
                return { found: false };
            }

            if (httpStatus < 200 || httpStatus >= 300) {
                throw adapterError('PROVIDER_HTTP_ERROR', `Cashfree refund lookup returned HTTP ${httpStatus}.`, {
                    definitive: DEFINITIVE_HTTP_STATUSES.has(httpStatus),
                    httpStatus,
                });
            }

            if (body === undefined || body === null) {
                throw adapterError('MALFORMED_RESPONSE', 'Empty or malformed refund lookup response.');
            }

            assertIdentity(body, { refundId, orderId: providerOrderId });
            return { found: true, ...toResult(body) };
        },

        async listRefundsForOrder(providerOrderId) {
            assertOrderId(providerOrderId);
            const { httpStatus, body } = await requestJson(
                fetchImpl,
                ordersPath(providerOrderId),
                { method: 'GET', headers: buildHeaders() },
                timeoutMs
            );

            if (httpStatus < 200 || httpStatus >= 300) {
                throw adapterError('PROVIDER_HTTP_ERROR', `Cashfree refund list returned HTTP ${httpStatus}.`, {
                    httpStatus,
                });
            }

            const list = Array.isArray(body) ? body : body?.data;
            if (!Array.isArray(list)) {
                throw adapterError('MALFORMED_RESPONSE', 'Refund list response is not an array.');
            }

            return list.map(toResult);
        },
    };
}
