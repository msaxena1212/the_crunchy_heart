/*
|--------------------------------------------------------------------------
| COD order cancellation
|--------------------------------------------------------------------------
| A Cash on Delivery order may be cancelled by the customer or an admin
| until it is dispatched. Nothing has been paid, so cancelling only releases
| the stock reserved at checkout and marks the order cancelled.
*/

import { withTransaction } from '../db/transaction.js';
import { releaseOrderInventoryReservations } from './inventory.service.js';
import { releaseCouponRedemption } from './coupon.service.js';

const CANCELLABLE_STATUSES = new Set(['pending', 'confirmed', 'processing']);

function fail(statusCode, code, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

/**
 * Cancel a COD order that has not shipped.
 *
 * @param {object} params
 * @param {string} params.orderNumber
 * @param {'customer'|'admin'} params.actor
 * @param {string} [params.reason]
 * @param {(order: object) => boolean} [params.authorize] customer-side ownership check
 */
export async function cancelCodOrder({ orderNumber, actor, reason = null, authorize = null }) {
    if (!orderNumber || typeof orderNumber !== 'string') {
        throw fail(400, 'ORDER_NUMBER_REQUIRED', 'A valid order number is required.');
    }
    const cleanReason = reason ? String(reason).trim().slice(0, 300) : null;

    return withTransaction(async (client) => {
        const res = await client.query(
            `SELECT id, order_number, status, payment_status, payment_method, phone, customer_id, total_amount, notes
             FROM orders WHERE order_number = $1 FOR UPDATE`,
            [orderNumber.trim()]
        );
        if (!res.rows.length) {
            throw fail(404, 'ORDER_NOT_FOUND', `Order ${orderNumber} was not found.`);
        }
        const order = res.rows[0];

        if (authorize && !authorize(order)) {
            throw fail(403, 'NOT_ORDER_OWNER', 'You are not allowed to cancel this order.');
        }
        if (order.payment_method !== 'COD') {
            throw fail(400, 'NOT_COD_ORDER', 'Only Cash on Delivery orders can be cancelled here. Paid orders need a refund.');
        }
        if (order.status === 'cancelled') {
            return { orderNumber: order.order_number, status: 'cancelled', alreadyCancelled: true };
        }
        if (!CANCELLABLE_STATUSES.has(order.status)) {
            throw fail(409, 'ORDER_ALREADY_SHIPPED',
                `Order ${order.order_number} is '${order.status}' and can no longer be cancelled.`);
        }

        await releaseOrderInventoryReservations(client, {
            orderId: order.id,
            notes: `COD order ${order.order_number} cancelled by ${actor}`,
        });

        await releaseCouponRedemption(client, order.id);

        const note = `[CANCELLED by ${actor}${cleanReason ? `: ${cleanReason}` : ''}]`;
        const updated = await client.query(
            `UPDATE orders
             SET status = 'cancelled',
                 notes = CASE WHEN notes IS NULL OR notes = '' THEN $2 ELSE notes || E'\n' || $2 END,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING order_number, status`,
            [order.id, note]
        );

        return { orderNumber: updated.rows[0].order_number, status: updated.rows[0].status, alreadyCancelled: false };
    });
}
