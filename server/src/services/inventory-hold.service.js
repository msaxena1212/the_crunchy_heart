import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { reserveInventory, releaseInventoryReservation } from './inventory.service.js';

export const HOLD_DURATION_MINUTES = 15;
export const HOLD_DURATION_MS = HOLD_DURATION_MINUTES * 60 * 1000;

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
 * Auto-expiry sweep worker function:
 * Finds all active holds whose expires_at is past, releases reserved inventory,
 * and marks them 'EXPIRED'.
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
