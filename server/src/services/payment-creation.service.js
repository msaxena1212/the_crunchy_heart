import { query } from '../db/pool.js';
import { getCashfreeOrder } from './cashfree.service.js';

/*
|--------------------------------------------------------------------------
| Cashfree create-order lifecycle
|--------------------------------------------------------------------------
| The first provider order for an online order uses the merchant order_id
| order_number. The payment row for that create carries the state below in
| payments.gateway_status:
|
|   CREATE_PENDING             Written with the order. No provider call has been made.
|                              The controller must claim it, or a retry may close it.
|   CREATE_NOT_SUBMITTED       Closed by a retry before any provider call. Safe to
|                              ignore; a new attempt is allowed.
|   ATTEMPT_INITIATED          Claimed by the controller right before the provider call.
|                              Owned by one request until the lease expires
|                              (updated_at + ATTEMPT_LEASE_MS).
|   ORDER_CREATED              Provider confirmed the order and returned a session.
|   GATEWAY_AMBIGUOUS_TIMEOUT The outcome is unknown. It blocks every new create
|                              until a lookup resolves it.
|   CREATION_REJECTED          Provider refused the request (4xx other than 409).
|                              No provider order exists, so a new attempt is safe.
|
| Rules:
|   - Only a definitive refusal may be treated as "nothing was created".
|   - A 409 "order already present" means the provider has the order: resolve by
|     lookup, never by creating another order.
|   - Lookup is GET /pg/orders/{order_id} with the merchant order_id. A 404 is
|     inconclusive, as in reconciliation.service.js.
|   - A lookup result without a payment session is not resumable and stays unresolved.
|   - Every write is conditional on the state it expects, so a stale owner cannot
|     overwrite a newer state.
|--------------------------------------------------------------------------
*/

/*
 * Attempt states an order can be in, derived from all of its payment rows. A single row is
 * never chosen by position in the list. The order is resolved by these rules, in this order:
 *   PAID        a row is paid. The order is paid, whatever other rows say.
 *   CONFLICT    two or more live sessions exist. Paying one could duplicate another. Fail closed.
 *   UNRESOLVED  an attempt has no known outcome. No new provider order may be created.
 *   RESUMABLE   exactly one live session exists, and nothing is unresolved.
 *   NO_LIVE     no live session, and nothing unresolved (rejected, closed, or never created).
 *   NO_ATTEMPT  the order has no payment rows.
 */
export const ATTEMPT_STATE = Object.freeze({
    PAID: 'PAID',
    CONFLICT: 'CONFLICT',
    UNRESOLVED: 'UNRESOLVED',
    RESUMABLE: 'RESUMABLE',
    NO_LIVE: 'NO_LIVE',
    NO_ATTEMPT: 'NO_ATTEMPT',
});

const UNRESOLVED_GATEWAY_STATES = new Set(['ATTEMPT_INITIATED', 'GATEWAY_AMBIGUOUS_TIMEOUT']);

const hasSession = row => Boolean(row?.raw_response?.payment_session_id);
const isPaidRow = row => row.status === 'paid';
const isLegacyUnbound = row => row.gateway_status === 'CASHFREE_PENDING' && !row.provider_order_id;
const isUnresolvedRow = row => UNRESOLVED_GATEWAY_STATES.has(row.gateway_status) || isLegacyUnbound(row);
const isLiveRow = row => row.gateway_status === 'ORDER_CREATED' && hasSession(row) && !isPaidRow(row);

function newestFirst(rows) {
    return [...rows].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/*
 * Pure function over an order's payment rows. It returns the authoritative row (or null),
 * the state, and short reason codes. The reasons never contain provider payloads or secrets.
 */
export function summarizeAttempts(rows) {
    const all = Array.isArray(rows) ? rows : [];
    if (!all.length) {
        return { state: ATTEMPT_STATE.NO_ATTEMPT, authoritative: null, reasons: [] };
    }

    const paid = all.filter(isPaidRow);
    const live = all.filter(isLiveRow);
    const unresolved = all.filter(isUnresolvedRow);

    if (paid.length) {
        const reasons = [];
        if (live.length) reasons.push('LIVE_SESSION_ON_PAID_ORDER');
        if (unresolved.length) reasons.push('UNRESOLVED_ATTEMPT_ON_PAID_ORDER');
        return { state: ATTEMPT_STATE.PAID, authoritative: newestFirst(paid)[0], reasons };
    }

    if (live.length > 1) {
        return { state: ATTEMPT_STATE.CONFLICT, authoritative: newestFirst(live)[0], reasons: ['MULTIPLE_LIVE_SESSIONS'] };
    }

    if (unresolved.length) {
        return {
            state: ATTEMPT_STATE.UNRESOLVED,
            authoritative: live[0] ?? newestFirst(unresolved)[0],
            reasons: ['UNRESOLVED_ATTEMPT'],
        };
    }

    if (live.length === 1) {
        return { state: ATTEMPT_STATE.RESUMABLE, authoritative: live[0], reasons: [] };
    }

    return { state: ATTEMPT_STATE.NO_LIVE, authoritative: newestFirst(all)[0], reasons: [] };
}

/*
 * Loads every payment row for an order, oldest first, so that summarizeAttempts sees the full set.
 */
export async function loadOrderAttempts(orderId) {
    const result = await query(
        `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at ASC`,
        [orderId]
    );
    return result.rows;
}

export const CREATE_OUTCOME = Object.freeze({
    ORDER_CREATED: 'ORDER_CREATED',
    UNRESOLVED: 'UNRESOLVED',
    CONFLICT: 'CONFLICT',
});

const PAYMENT_COLUMNS = `
    id,
    order_id,
    provider,
    provider_order_id,
    amount,
    currency,
    status,
    payment_method,
    gateway_status,
    created_at,
    updated_at
`;

/*
 * A 4xx response other than 409 means the provider refused the request, so no order was
 * created. Missing credentials are detected before any network call.
 */
export function isDefinitiveRefusal(error) {
    if (error?.code === 'CASHFREE_NOT_CONFIGURED') return true;
    const status = Number(error?.statusCode);
    return status >= 400 && status < 500 && status !== 409;
}

export function isOrderAlreadyPresent(error) {
    return Number(error?.statusCode) === 409;
}

/*
 * Claims the create row before the provider call. Only a successful claim may contact
 * Cashfree. The claim fails if a retry has already closed the row, so the two can never
 * both proceed.
 */
export async function claimCreateForProvider({ paymentId, orderNumber }) {
    const result = await query(
        `
        UPDATE payments
        SET
            provider = 'cashfree',
            provider_order_id = $2,
            gateway_status = 'ATTEMPT_INITIATED',
            status = 'created',
            updated_at = NOW()
        WHERE id = $1
          AND gateway_status = 'CREATE_PENDING'
          AND provider_order_id IS NULL
        RETURNING id, gateway_status
        `,
        [paymentId, orderNumber]
    );

    return result.rows[0] || null;
}

/*
 * Stores the provider session. Succeeds only while the create row still awaits a result
 * and holds no session. Returns null when another request or reconciliation already
 * moved it on, so the caller never overwrites newer state.
 */
export async function recordCreateSession({ paymentId, orderNumber, cashfreeOrder }) {
    const result = await query(
        `
        UPDATE payments
        SET
            provider = 'cashfree',
            provider_order_id = $2,
            gateway_status = 'ORDER_CREATED',
            status = 'created',
            raw_response = $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
          AND (provider_order_id IS NULL OR provider_order_id = $2)
          AND gateway_status IN ('ATTEMPT_INITIATED', 'GATEWAY_AMBIGUOUS_TIMEOUT', 'CASHFREE_PENDING')
          AND (raw_response->>'payment_session_id') IS NULL
        RETURNING ${PAYMENT_COLUMNS}
        `,
        [paymentId, orderNumber, JSON.stringify(cashfreeOrder)]
    );

    return result.rows[0] || null;
}

/*
 * Records an unknown outcome. Only an attempt that is still awaiting a result can move to
 * ambiguous. Returns null if the state had already changed.
 */
export async function markCreateAmbiguous({ paymentId, orderNumber }) {
    const result = await query(
        `
        UPDATE payments
        SET
            gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT',
            provider_order_id = COALESCE(provider_order_id, $2),
            updated_at = NOW()
        WHERE id = $1
          AND gateway_status IN ('ATTEMPT_INITIATED', 'CASHFREE_PENDING')
        RETURNING id, gateway_status
        `,
        [paymentId, orderNumber]
    );

    return result.rows[0] || null;
}

/*
 * Records a definitive refusal. Only an attempt that is still awaiting a result can move to
 * rejected.
 */
export async function markCreateRejected({ paymentId, rawResponse }) {
    const result = await query(
        `
        UPDATE payments
        SET
            gateway_status = 'CREATION_REJECTED',
            status = 'failed',
            raw_response = $2::jsonb,
            updated_at = NOW()
        WHERE id = $1
          AND gateway_status IN ('ATTEMPT_INITIATED', 'CASHFREE_PENDING')
        RETURNING id, gateway_status
        `,
        [paymentId, JSON.stringify(rawResponse ?? null)]
    );

    return result.rows[0] || null;
}

export async function isCreateLeaseExpired({ paymentId, leaseMs }) {
    const result = await query(
        `
        SELECT (updated_at < NOW() - ($2::int * INTERVAL '1 millisecond')) AS stale
        FROM payments
        WHERE id = $1
        `,
        [paymentId, leaseMs]
    );

    return Boolean(result.rows[0]?.stale);
}

/*
 * Resolves an unknown create by looking up the merchant order_id. It never creates an order.
 * Returns ORDER_CREATED only when the provider returns the same order with a payment session.
 */
export async function resolveCreateByLookup({ paymentId, orderNumber }) {
    let cashfreeOrder;

    try {
        cashfreeOrder = await getCashfreeOrder(orderNumber);
    } catch {
        await markCreateAmbiguous({ paymentId, orderNumber });
        return { outcome: CREATE_OUTCOME.UNRESOLVED, reason: 'LOOKUP_INCONCLUSIVE' };
    }

    const sessionId = cashfreeOrder?.payment_session_id;
    if (cashfreeOrder?.order_id !== orderNumber || !sessionId || typeof sessionId !== 'string') {
        await markCreateAmbiguous({ paymentId, orderNumber });
        return { outcome: CREATE_OUTCOME.UNRESOLVED, reason: 'NO_RESUMABLE_SESSION' };
    }

    const recorded = await recordCreateSession({ paymentId, orderNumber, cashfreeOrder });
    if (!recorded) {
        return { outcome: CREATE_OUTCOME.CONFLICT, reason: 'STATE_CHANGED' };
    }

    return { outcome: CREATE_OUTCOME.ORDER_CREATED, cashfreeOrder, payment: recorded };
}
