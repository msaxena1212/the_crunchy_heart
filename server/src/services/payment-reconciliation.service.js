import crypto from 'node:crypto';
import { withTransaction } from '../db/transaction.js';

/*
|--------------------------------------------------------------------------
| Durable Payment Reconciliation Queue
|--------------------------------------------------------------------------
| A verified provider SUCCESS whose internal settlement is blocked by an
| inventory ledger anomaly must never be lost. This service persists the
| exception in payment_reconciliation_queue in its OWN transaction, after
| the failed settlement transaction has rolled back.
|
| Queue presence never fulfils an order, never refunds, and never charges
| again. Those actions belong to the admin workflow (not yet implemented).
|
| Outcomes of enqueuePaymentReconciliationEvent():
|   created         new queue row committed
|   duplicate       exact redelivery of the same event; nothing new written
|   conflict        same idempotency key, materially different stored data;
|                   the queue row is untouched and an IDEMPOTENCY_CONFLICT
|                   incident is committed
|   manual_review   verified SUCCESS without a provider payment ID, so the
|                   event cannot be uniquely identified; no queue row is
|                   written and an UNIDENTIFIED_PROVIDER_PAYMENT incident
|                   is committed
|
| Lock order (matches payment.service.js): orders -> payments.
|--------------------------------------------------------------------------
*/

export const RECONCILIATION_PROVIDER = 'cashfree';
export const SETTLEMENT_BLOCKED_EVENT = 'payment_success_settlement_blocked';
// New items are eligible for automatic settlement retry immediately.
export const QUEUE_STATUS_PENDING = 'pending';

export const INCIDENT_IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT';
export const INCIDENT_UNIDENTIFIED_PAYMENT = 'UNIDENTIFIED_PROVIDER_PAYMENT';

// Settlement errors that mean "provider captured the money, our ledger is
// inconsistent". Only these are queued. Every other error still fails the
// webhook (non-2xx) so the provider retries it.
export const QUEUEABLE_SETTLEMENT_ERROR_CODES = new Set([
    'INVENTORY_RECONCILIATION_REQUIRED',
]);

export function isQueueableSettlementError(error) {
    return Boolean(error && QUEUEABLE_SETTLEMENT_ERROR_CODES.has(error.code));
}

/*
 * Stable per-payment key. Requires a provider payment ID: two Cashfree
 * attempts on one order must never share a key, and an order-ID fallback
 * could make them look identical. Callers without a payment ID are routed to
 * manual review instead (see enqueuePaymentReconciliationEvent).
 */
export function buildReconciliationIdempotencyKey({ providerPaymentId }) {
    if (!providerPaymentId) {
        throw validationError('A provider payment ID is required to build a reconciliation key.');
    }

    return `${RECONCILIATION_PROVIDER}:${SETTLEMENT_BLOCKED_EVENT}:${providerPaymentId}`;
}

function validationError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function toMoney(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function sanitiseMessage(message) {
    // Keep only a short, single-line description. Never store stack traces.
    return String(message).replace(/\s+/g, ' ').slice(0, 500);
}

function fingerprintOf(fields) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(fields))
        .digest('hex');
}

/*
 * Writes an incident in the caller's transaction. Exact repeats of the same
 * event map to one row through the fingerprint constraint.
 */
async function recordIncident(client, {
    incidentType,
    orderId,
    queueId = null,
    providerOrderId,
    providerPaymentId,
    amount,
    currency,
    existingDetails = {},
}) {
    const incomingDetails = {
        providerOrderId,
        providerPaymentId,
        amount,
        currency,
    };

    const fingerprint = fingerprintOf({ incidentType, ...incomingDetails });

    const inserted = await client.query(
        `
        INSERT INTO payment_reconciliation_incidents (
            fingerprint,
            incident_type,
            severity,
            order_id,
            queue_id,
            provider,
            provider_order_id,
            provider_payment_id,
            incoming_details,
            existing_details
        )
        VALUES ($1, $2, 'high', $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
        ON CONFLICT (fingerprint) DO NOTHING
        RETURNING id
        `,
        [
            fingerprint,
            incidentType,
            orderId,
            queueId,
            RECONCILIATION_PROVIDER,
            providerOrderId,
            providerPaymentId,
            JSON.stringify(incomingDetails),
            JSON.stringify(existingDetails),
        ]
    );

    if (inserted.rows.length) {
        return { incidentId: inserted.rows[0].id, incidentCreated: true };
    }

    const existing = await client.query(
        `SELECT id FROM payment_reconciliation_incidents WHERE fingerprint = $1`,
        [fingerprint]
    );

    return { incidentId: existing.rows[0].id, incidentCreated: false };
}

/*
 * Persists the verified exception. Throws for invalid or unknown references
 * (statusCode 400/404). Those write nothing, so the caller must not
 * acknowledge them as queued.
 */
export async function enqueuePaymentReconciliationEvent({
    providerOrderId,
    providerPaymentId = null,
    paymentAmount = null,
    paymentCurrency = null,
    failureCode,
    failureMessage,
}) {
    if (!providerOrderId) {
        throw validationError('Cashfree merchant order ID is required.');
    }

    return withTransaction(async client => {
        // 1. Resolve the internal payment attempt for this provider order.
        const lookup = await client.query(
            `
            SELECT id, order_id, amount, currency
            FROM payments
            WHERE provider_order_id = $1
              AND provider = $2
            `,
            [providerOrderId, RECONCILIATION_PROVIDER]
        );

        if (!lookup.rows.length) {
            throw validationError(`Payment not found for Cashfree order ${providerOrderId}.`, 404);
        }

        const payment = lookup.rows[0];

        // 2. Lock order first, then payment (global lock order).
        await client.query(
            `SELECT id FROM orders WHERE id = $1 FOR UPDATE`,
            [payment.order_id]
        );

        await client.query(
            `SELECT id FROM payments WHERE id = $1 FOR UPDATE`,
            [payment.id]
        );

        // 3. Verify the provider-reported amount and currency against our record.
        //    Mismatches are never queued: they indicate an untrusted event.
        const expectedAmount = toMoney(payment.amount);
        const reportedAmount = paymentAmount === null || paymentAmount === undefined
            ? expectedAmount
            : toMoney(paymentAmount);
        const expectedCurrency = String(payment.currency).trim().toUpperCase();
        const reportedCurrency = paymentCurrency === null || paymentCurrency === undefined
            ? expectedCurrency
            : String(paymentCurrency).trim().toUpperCase();

        if (reportedAmount === null || Math.abs(reportedAmount - expectedAmount) > 0.01) {
            throw validationError('Reconciliation event amount does not match the payment record.');
        }

        if (reportedCurrency !== expectedCurrency) {
            throw validationError('Reconciliation event currency does not match the payment record.');
        }

        // 4. Unidentifiable event: never guess that it is a duplicate.
        if (!providerPaymentId) {
            const { incidentId, incidentCreated } = await recordIncident(client, {
                incidentType: INCIDENT_UNIDENTIFIED_PAYMENT,
                orderId: payment.order_id,
                providerOrderId,
                providerPaymentId: null,
                amount: expectedAmount,
                currency: expectedCurrency,
            });

            return { result: 'manual_review', incidentId, incidentCreated };
        }

        const idempotencyKey = buildReconciliationIdempotencyKey({ providerPaymentId });

        // 5. Sanitised, minimal snapshot. No raw webhook body, no customer data.
        const sanitisedPayload = {
            provider: RECONCILIATION_PROVIDER,
            providerOrderId,
            providerPaymentId,
            paymentStatus: 'SUCCESS',
            amount: expectedAmount,
            currency: expectedCurrency,
        };

        const inserted = await client.query(
            `
            INSERT INTO payment_reconciliation_queue (
                idempotency_key,
                provider,
                provider_order_id,
                provider_payment_id,
                provider_event_id,
                order_id,
                payment_id,
                verified_amount,
                verified_currency,
                event_type,
                status,
                raw_provider_payload,
                last_error
            )
            VALUES ($1, $2, $3, $4, $3, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
            `,
            [
                idempotencyKey,
                RECONCILIATION_PROVIDER,
                providerOrderId,
                providerPaymentId,
                payment.order_id,
                payment.id,
                expectedAmount,
                expectedCurrency,
                SETTLEMENT_BLOCKED_EVENT,
                QUEUE_STATUS_PENDING,
                JSON.stringify(sanitisedPayload),
                sanitiseMessage(`${failureCode || 'SETTLEMENT_BLOCKED'}: ${failureMessage || 'settlement blocked'}`),
            ]
        );

        if (inserted.rows.length) {
            return { result: 'created', queueId: inserted.rows[0].id };
        }

        // 6. Key already exists: compare material fields, never overwrite.
        const existing = await client.query(
            `
            SELECT id, order_id, provider_payment_id, verified_amount, verified_currency, event_type, status
            FROM payment_reconciliation_queue
            WHERE idempotency_key = $1
            `,
            [idempotencyKey]
        );

        const row = existing.rows[0];
        const materialMatch =
            row.order_id === payment.order_id &&
            row.provider_payment_id === providerPaymentId &&
            toMoney(row.verified_amount) === expectedAmount &&
            row.verified_currency === expectedCurrency;

        if (materialMatch) {
            return { result: 'duplicate', queueId: row.id };
        }

        // Conflict: the stored row is preserved. The incident carries both sides.
        const { incidentId, incidentCreated } = await recordIncident(client, {
            incidentType: INCIDENT_IDEMPOTENCY_CONFLICT,
            orderId: payment.order_id,
            queueId: row.id,
            providerOrderId,
            providerPaymentId,
            amount: expectedAmount,
            currency: expectedCurrency,
            existingDetails: {
                orderId: row.order_id,
                providerPaymentId: row.provider_payment_id,
                amount: toMoney(row.verified_amount),
                currency: row.verified_currency,
                queueStatus: row.status,
            },
        });

        return { result: 'conflict', queueId: row.id, incidentId, incidentCreated };
    });
}
