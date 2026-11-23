import { releaseCouponRedemption } from './coupon.service.js';
import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import {
    reserveInventory,
    reserveOrderInventory,
    releaseInventoryReservation,
    releaseOrderInventoryReservations,
} from './inventory.service.js';

/*
|--------------------------------------------------------------------------
| 15-Minute Checkout Inventory Hold & Auto-Expiry Service
|--------------------------------------------------------------------------
| Supports both session-based holds (pre-order checkout flow) and order-based
| holds (pending payment window).
|--------------------------------------------------------------------------
*/

export const DEFAULT_HOLD_MINUTES = 15;
export const HOLD_DURATION_MINUTES = 15;
export const HOLD_DURATION_MS = HOLD_DURATION_MINUTES * 60 * 1000;
export const INVENTORY_HOLD_SWEEP_LOCK_KEY = 849201931;

export async function ensureHoldSchema() {
    await query(`
        ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS hold_released_at TIMESTAMPTZ;

        CREATE INDEX IF NOT EXISTS idx_orders_hold_expiry
        ON orders(status, payment_status, hold_expires_at)
        WHERE hold_expires_at IS NOT NULL AND hold_released_at IS NULL;
    `).catch(() => {});
}

/*
|--------------------------------------------------------------------------
| Session-Based Inventory Holds (Used by checkout.controller.js)
|--------------------------------------------------------------------------
*/

/**
 * Creates or updates an active 15-minute inventory hold for a checkout session.
 * Idempotent: releases previous holds for the same session before locking new items.
 */
export async function createInventoryHold({ sessionId, orderId = null, items }) {
    if (!sessionId || !items?.length) {
        throw new Error('sessionId and items are required for inventory hold.');
    }

    return await withTransaction(async (client) => {
        // 1. Release any existing active hold for this session
        await releaseSessionHoldTx(client, sessionId, 'SUPERSEDED');

        // 2. Lock and reserve stock for each item
        const expiresAt = new Date(Date.now() + HOLD_DURATION_MS);
        const holdResult = await client.query(
            `INSERT INTO inventory_holds (session_id, order_id, expires_at, status)
             VALUES ($1, $2, $3, 'ACTIVE')
             RETURNING id, session_id, order_id, expires_at, status, created_at`,
            [sessionId, orderId, expiresAt]
        );
        const hold = holdResult.rows[0];

        const holdItems = [];
        for (const item of items) {
            const variantId = item.variantId || item.variant_id;
            const quantity = Number(item.quantity);

            // Use core reserveInventory function
            await reserveInventory(client, variantId, quantity, hold.id, `Hold #${hold.id} for session ${sessionId}`);

            const itemRes = await client.query(
                `INSERT INTO inventory_hold_items (hold_id, variant_id, quantity)
                 VALUES ($1, $2, $3)
                 RETURNING id, hold_id, variant_id, quantity`,
                [hold.id, variantId, quantity]
            );
            holdItems.push(itemRes.rows[0]);
        }

        return {
            ...hold,
            items: holdItems,
            expiresAtMs: expiresAt.getTime(),
            remainingSeconds: Math.floor(HOLD_DURATION_MS / 1000)
        };
    });
}

/**
 * Helper to release an existing session hold within an open transaction.
 */
async function releaseSessionHoldTx(client, sessionId, reason = 'RELEASED') {
    const existing = await client.query(
        `SELECT id FROM inventory_holds WHERE session_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
        [sessionId]
    );

    for (const row of existing.rows) {
        const holdId = row.id;
        const holdItems = await client.query(
            `SELECT variant_id, quantity FROM inventory_hold_items WHERE hold_id = $1`,
            [holdId]
        );

        for (const it of holdItems.rows) {
            await releaseInventoryReservation(client, {
                variantId: it.variant_id,
                quantity: it.quantity,
                orderId: holdId,
                notes: `Hold ${reason}: session ${sessionId}`
            });
        }

        await client.query(
            `UPDATE inventory_holds SET status = $2, updated_at = NOW() WHERE id = $1`,
            [holdId, reason]
        );
    }
}

/**
 * Public release function for cancelled or abandoned sessions.
 */
export async function releaseInventoryHold(sessionId) {
    if (!sessionId) return;
    return await withTransaction(async (client) => {
        await releaseSessionHoldTx(client, sessionId, 'RELEASED');
    });
}

/**
 * Mark a hold as converted to a confirmed/paid order.
 */
export async function convertInventoryHold(sessionId, orderId) {
    if (!sessionId) return;
    await query(
        `UPDATE inventory_holds
         SET status = 'CONVERTED', order_id = $2, updated_at = NOW()
         WHERE session_id = $1 AND status = 'ACTIVE'`,
        [sessionId, orderId]
    );
}

/**
 * Auto-expiry sweep for session-based holds.
 */
export async function expireOverdueHolds() {
    let expiredCount = 0;

    await withTransaction(async (client) => {
        const overdue = await client.query(
            `SELECT id, session_id FROM inventory_holds
             WHERE status = 'ACTIVE' AND expires_at <= NOW()
             FOR UPDATE SKIP LOCKED
             LIMIT 50`
        );

        for (const hold of overdue.rows) {
            const holdItems = await client.query(
                `SELECT variant_id, quantity FROM inventory_hold_items WHERE hold_id = $1`,
                [hold.id]
            );

            for (const it of holdItems.rows) {
                await releaseInventoryReservation(client, {
                    variantId: it.variant_id,
                    quantity: it.quantity,
                    orderId: hold.id,
                    notes: `Hold EXPIRED automatically after ${HOLD_DURATION_MINUTES} minutes`
                });
            }

            await client.query(
                `UPDATE inventory_holds SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
                [hold.id]
            );
            expiredCount++;
        }
    });

    return { expiredCount };
}

/*
|--------------------------------------------------------------------------
| Order-Based Inventory Holds (Used by order checkout & auto-expiry worker)
|--------------------------------------------------------------------------
*/

/**
 * Create or refresh a 15-minute checkout inventory hold on an existing order.
 */
export async function createCheckoutHold({ orderId, holdMinutes = DEFAULT_HOLD_MINUTES }) {
    await ensureHoldSchema();

    return withTransaction(async (client) => {
        const orderRes = await client.query(
            `SELECT id, order_number, status, payment_status, payment_method, hold_expires_at, hold_released_at
             FROM orders WHERE id = $1 FOR UPDATE`,
            [orderId]
        );

        if (!orderRes.rows.length) {
            throw Object.assign(new Error(`Order ${orderId} not found.`), { statusCode: 404, code: 'ORDER_NOT_FOUND' });
        }

        const order = orderRes.rows[0];

        if (order.status !== 'pending' || order.payment_status === 'paid') {
            throw Object.assign(new Error(`Cannot place inventory hold on order in status '${order.status}'.`), {
                statusCode: 400,
                code: 'INVALID_ORDER_STATUS',
            });
        }

        // Fetch order items to reserve
        const itemsRes = await client.query(
            `SELECT variant_id, quantity FROM order_items WHERE order_id = $1`,
            [orderId]
        );

        const items = itemsRes.rows.map(r => ({ variantId: r.variant_id, quantity: r.quantity }));

        // Atomically place reservations
        await reserveOrderInventory(client, {
            orderId,
            items,
            notes: `15-minute checkout hold for order ${order.order_number}`,
        });

        const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000);

        await client.query(
            `UPDATE orders
             SET hold_expires_at = $2,
                 hold_released_at = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [orderId, expiresAt]
        );

        return {
            orderId,
            orderNumber: order.order_number,
            holdExpiresAt: expiresAt,
            holdMinutes,
        };
    });
}

/**
 * Release an expired inventory hold for a single order.
 */
export async function releaseExpiredOrderHold(client, orderId) {
    const released = await releaseOrderInventoryReservations(client, {
        orderId,
        notes: `Auto-expiry: 15-minute checkout inventory hold expired`,
    });

    await releaseCouponRedemption(client, orderId);

    await client.query(
        `UPDATE orders
         SET hold_released_at = NOW(),
             status = CASE WHEN status = 'pending' AND payment_status = 'pending' THEN 'cancelled' ELSE status END,
             notes = COALESCE(notes, '') || ' [inventory hold expired after 15m]',
             updated_at = NOW()
         WHERE id = $1`,
        [orderId]
    );

    return released;
}

/**
 * Sweep function executed periodically by the background worker.
 * Identifies all pending orders whose 15-minute hold has expired and releases reservations.
 */
export async function runInventoryHoldExpirySweep({ limit = 50 } = {}) {
    await ensureHoldSchema();

    return withTransaction(async (client) => {
        // Advisory lock to ensure single-instance execution
        const lockRes = await client.query(`SELECT pg_try_advisory_xact_lock($1) AS acquired`, [INVENTORY_HOLD_SWEEP_LOCK_KEY]);
        if (!lockRes.rows[0].acquired) {
            return { skipped: true, expiredCount: 0 };
        }

        const expiredOrdersRes = await client.query(
            `SELECT id, order_number, hold_expires_at
             FROM orders
             WHERE status = 'pending'
               AND payment_status = 'pending'
               AND hold_expires_at IS NOT NULL
               AND hold_expires_at <= NOW()
               AND hold_released_at IS NULL
             ORDER BY hold_expires_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED`,
            [limit]
        );

        const expiredOrders = expiredOrdersRes.rows;
        const results = [];

        for (const order of expiredOrders) {
            try {
                await releaseExpiredOrderHold(client, order.id);
                results.push({ orderId: order.id, orderNumber: order.order_number, status: 'expired_and_released' });
            } catch (err) {
                console.error(`[HIGH] Failed to release expired hold for order ${order.order_number}:`, err.message);
                results.push({ orderId: order.id, orderNumber: order.order_number, error: err.message });
            }
        }

        return {
            skipped: false,
            expiredCount: results.length,
            results,
        };
    });
}
