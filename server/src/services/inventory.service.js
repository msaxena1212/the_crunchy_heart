import { query } from '../db/pool.js';

export async function getInventoryForVariants(
    variantIds
) {
    if (
        !Array.isArray(variantIds) ||
        !variantIds.length
    ) {
        return new Map();
    }

    const result =
        await query(
            `
        SELECT
          variant_id,
          quantity_on_hand,
          quantity_reserved,

          GREATEST(
            quantity_on_hand -
            quantity_reserved,
            0
          ) AS available_quantity

        FROM inventory

        WHERE variant_id =
          ANY($1::uuid[])
      `,
            [variantIds]
        );

    return new Map(
        result.rows.map(row => [
            row.variant_id,
            {
                quantityOnHand:
                    Number(
                        row.quantity_on_hand || 0
                    ),

                quantityReserved:
                    Number(
                        row.quantity_reserved || 0
                    ),

                availableQuantity:
                    Number(
                        row.available_quantity || 0
                    )
            }
        ])
    );
}

/**
 * Helper: Query active outstanding reservation for an order and variant from inventory_transactions.
 * Net active reservation = RESERVATION - RESERVATION_RELEASE - SALE_DEDUCTION.
 */
async function getActiveReservationForVariant(client, orderId, variantId) {
    if (!orderId) return 0;
    const res = await client.query(
        `
        SELECT GREATEST(COALESCE(SUM(
            CASE
                WHEN transaction_type = 'RESERVATION' THEN quantity
                WHEN transaction_type = 'RESERVATION_RELEASE' THEN -quantity
                WHEN transaction_type = 'SALE_DEDUCTION' THEN -quantity
                ELSE 0
            END
        ), 0), 0) AS active_reserved
        FROM inventory_transactions
        WHERE reference_type = 'ORDER'
          AND reference_id = $1
          AND variant_id = $2
        `,
        [String(orderId), variantId]
    );
    return Number(res.rows[0]?.active_reserved || 0);
}

/**
 * Helper: Query active outstanding reservations for an order across all variants.
 */
async function getActiveReservationsForOrder(client, orderId) {
    if (!orderId) return new Map();
    const res = await client.query(
        `
        SELECT
            variant_id,
            GREATEST(COALESCE(SUM(
                CASE
                    WHEN transaction_type = 'RESERVATION' THEN quantity
                    WHEN transaction_type = 'RESERVATION_RELEASE' THEN -quantity
                    WHEN transaction_type = 'SALE_DEDUCTION' THEN -quantity
                    ELSE 0
                END
            ), 0), 0) AS active_reserved
        FROM inventory_transactions
        WHERE reference_type = 'ORDER'
          AND reference_id = $1
        GROUP BY variant_id
        `,
        [String(orderId)]
    );
    return new Map(
        res.rows.map(r => [r.variant_id, Number(r.active_reserved || 0)])
    );
}

/**
 * Safely reserve inventory for a single variant.
 * Linked to orderId with idempotency: repeated calls for the same order do not duplicate reservations.
 */
export async function reserveInventory(
    client,
    variantId,
    quantity,
    orderId,
    notes = null
) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
        const error = new Error('Reservation quantity must be a positive integer.');
        error.statusCode = 400;
        throw error;
    }

    // 1. Idempotency check: if this order already holds an active reservation for this variant
    const activeReserved = orderId
        ? await getActiveReservationForVariant(client, orderId, variantId)
        : 0;

    if (activeReserved >= qty) {
        // Already fully reserved for this order — idempotent return
        const currentRes = await client.query(
            `SELECT variant_id, quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1`,
            [variantId]
        );
        return currentRes.rows[0];
    }

    const additionalNeeded = qty - activeReserved;

    // 2. Lock inventory row
    const result = await client.query(
        `
        SELECT
          variant_id,
          quantity_on_hand,
          quantity_reserved,
          GREATEST(
            quantity_on_hand - quantity_reserved,
            0
          ) AS available_quantity
        FROM inventory
        WHERE variant_id = $1
        FOR UPDATE
        `,
        [variantId]
    );

    if (!result.rows.length) {
        const error = new Error(`Inventory record not found for variant ${variantId}.`);
        error.code = 'INVENTORY_NOT_FOUND';
        error.statusCode = 404;
        throw error;
    }

    const row = result.rows[0];
    const available = Number(row.available_quantity || 0);

    if (available < additionalNeeded) {
        const error = new Error(
            `Insufficient inventory. Available: ${available}, requested: ${additionalNeeded}.`
        );
        error.code = 'INSUFFICIENT_STOCK';
        error.statusCode = 409;
        error.availableQuantity = available;
        error.requestedQuantity = additionalNeeded;
        throw error;
    }

    // 3. Atomically increment quantity_reserved
    const updateResult = await client.query(
        `
        UPDATE inventory
        SET
          quantity_reserved = quantity_reserved + $2,
          updated_at = NOW()
        WHERE variant_id = $1
        RETURNING variant_id, quantity_on_hand, quantity_reserved
        `,
        [variantId, additionalNeeded]
    );

    // 4. Record audit ledger entry
    await client.query(
        `
        INSERT INTO inventory_transactions (
          variant_id,
          transaction_type,
          quantity,
          reference_type,
          reference_id,
          notes
        )
        VALUES (
          $1,
          'RESERVATION',
          $2,
          'ORDER',
          $3,
          $4
        )
        `,
        [
            variantId,
            additionalNeeded,
            orderId ? String(orderId) : null,
            notes || (orderId ? `Inventory reserved for order ${orderId}` : 'Inventory reserved')
        ]
    );

    return updateResult.rows[0];
}

/**
 * Atomically reserve inventory for all items in an order.
 * Sorts variant IDs deterministically (ORDER BY variant_id ASC) to guarantee deadlock prevention.
 */
export async function reserveOrderInventory(
    client,
    { orderId, items, notes }
) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    // 1. Aggregate quantities by variant_id
    const aggregatedMap = new Map();
    for (const item of items) {
        const vId = String(item.variantId || item.variant_id).trim();
        const qty = Number(item.quantity || 0);
        if (!vId || qty <= 0) continue;
        aggregatedMap.set(vId, (aggregatedMap.get(vId) || 0) + qty);
    }

    // 2. Deterministic sorting by variant_id to eliminate deadlocks
    const sortedVariantIds = Array.from(aggregatedMap.keys()).sort();
    if (sortedVariantIds.length === 0) {
        return [];
    }

    // 3. Check existing reservations for idempotency
    const activeReservations = orderId
        ? await getActiveReservationsForOrder(client, orderId)
        : new Map();

    // 4. Acquire row locks in sorted order
    const lockResult = await client.query(
        `
        SELECT
            variant_id,
            quantity_on_hand,
            quantity_reserved,
            GREATEST(quantity_on_hand - quantity_reserved, 0) AS available_quantity
        FROM inventory
        WHERE variant_id = ANY($1::uuid[])
        ORDER BY variant_id ASC
        FOR UPDATE
        `,
        [sortedVariantIds]
    );

    const inventoryMap = new Map(
        lockResult.rows.map(row => [row.variant_id, row])
    );

    // 5. Validate ALL items before modifying any row
    for (const variantId of sortedVariantIds) {
        const requiredQty = aggregatedMap.get(variantId);
        const inv = inventoryMap.get(variantId);

        if (!inv) {
            const error = new Error(`Inventory record not found for variant ${variantId}.`);
            error.code = 'INVENTORY_NOT_FOUND';
            error.statusCode = 404;
            throw error;
        }

        const currentlyReservedForOrder = activeReservations.get(variantId) || 0;
        const additionalNeeded = Math.max(0, requiredQty - currentlyReservedForOrder);
        const available = Number(inv.available_quantity || 0);

        if (available < additionalNeeded) {
            const error = new Error(
                `Insufficient inventory for variant ${variantId}. Available: ${available}, required: ${additionalNeeded}.`
            );
            error.code = 'INSUFFICIENT_STOCK';
            error.statusCode = 409;
            error.variantId = variantId;
            error.availableQuantity = available;
            error.requiredQuantity = additionalNeeded;
            throw error;
        }
    }

    // 6. Execute reservations and ledger writes
    const reservations = [];
    for (const variantId of sortedVariantIds) {
        const requiredQty = aggregatedMap.get(variantId);
        const currentlyReservedForOrder = activeReservations.get(variantId) || 0;
        const additionalNeeded = Math.max(0, requiredQty - currentlyReservedForOrder);

        if (additionalNeeded === 0) {
            reservations.push(inventoryMap.get(variantId));
            continue;
        }

        const updateResult = await client.query(
            `
            UPDATE inventory
            SET
                quantity_reserved = quantity_reserved + $2,
                updated_at = NOW()
            WHERE variant_id = $1
            RETURNING variant_id, quantity_on_hand, quantity_reserved
            `,
            [variantId, additionalNeeded]
        );

        await client.query(
            `
            INSERT INTO inventory_transactions (
                variant_id,
                transaction_type,
                quantity,
                reference_type,
                reference_id,
                notes
            )
            VALUES (
                $1,
                'RESERVATION',
                $2,
                'ORDER',
                $3,
                $4
            )
            `,
            [
                variantId,
                additionalNeeded,
                orderId ? String(orderId) : null,
                notes || `Inventory reserved for order ${orderId}`
            ]
        );

        reservations.push(updateResult.rows[0]);
    }

    return reservations;
}

/**
 * Atomically deduct inventory for a single variant within an active transaction.
 * Reconciles pre-existing reservations by decrementing quantity_reserved alongside quantity_on_hand,
 * strictly maintaining the constraint quantity_reserved <= quantity_on_hand.
 */
export async function deductInventoryAtomic(
    client,
    { variantId, quantity, orderId, notes, reservedQuantity = null }
) {
    const qty = Number(quantity);

    if (!Number.isInteger(qty) || qty <= 0) {
        const error = new Error('Deduction quantity must be a positive integer.');
        error.statusCode = 400;
        throw error;
    }

    // 1. Idempotency guard: check if SALE_DEDUCTION already exists for this order & variant
    if (orderId) {
        const orderIdStr = String(orderId).trim();
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!UUID_REGEX.test(orderIdStr)) {
            const error = new Error(`Order ${orderId} not found.`);
            error.code = 'ORDER_NOT_FOUND';
            error.statusCode = 404;
            error.orderId = orderId;
            throw error;
        }

        // Enforce parent order lock first using primary key index
        const orderLock = await client.query(
            `SELECT id FROM orders WHERE id = $1::uuid FOR UPDATE`,
            [orderIdStr]
        );

        if (!orderLock.rows.length) {
            const error = new Error(`Order ${orderId} not found.`);
            error.code = 'ORDER_NOT_FOUND';
            error.statusCode = 404;
            error.orderId = orderId;
            throw error;
        }

        const existingDeduction = await client.query(
            `
            SELECT
                COALESCE(SUM(quantity), 0) AS already_deducted,
                COUNT(*) AS tx_count
            FROM inventory_transactions
            WHERE reference_type = 'ORDER'
              AND reference_id = $1
              AND variant_id = $2
              AND transaction_type = 'SALE_DEDUCTION'
            `,
            [String(orderId), variantId]
        );

        const txCount = Number(existingDeduction.rows[0]?.tx_count || 0);
        const alreadyDeducted = Number(existingDeduction.rows[0]?.already_deducted || 0);

        if (txCount === 0) {
            // Case 1: Fresh order item — proceed to normal deduction
        } else if (alreadyDeducted === qty && txCount > 0) {
            // Case 2: Exact match — idempotent return
            const currentRes = await client.query(
                `SELECT variant_id, quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1`,
                [variantId]
            );
            return currentRes.rows[0];
        } else {
            // Case 3: Inconsistent ledger (partial, over-deducted, or malformed) — fail closed
            const error = new Error(
                `Partial inventory deduction anomaly detected for order ${orderId}, variant ${variantId}. Recorded: ${alreadyDeducted}, expected: ${qty}. Manual reconciliation required.`
            );
            error.code = 'INVENTORY_RECONCILIATION_REQUIRED';
            error.statusCode = 409;
            error.variantId = variantId;
            error.orderId = orderId;
            error.alreadyDeducted = alreadyDeducted;
            error.requestedQuantity = qty;
            throw error;
        }
    }

    // 2. Determine effective reserved quantity for this order
    let effectiveReserved = 0;
    if (Number.isInteger(Number(reservedQuantity)) && Number(reservedQuantity) >= 0) {
        effectiveReserved = Math.min(qty, Number(reservedQuantity));
    } else if (orderId) {
        const activeRes = await getActiveReservationForVariant(client, orderId, variantId);
        effectiveReserved = Math.min(qty, activeRes);
    }

    const unreservedNeeded = qty - effectiveReserved;

    // 3. Acquire row lock
    const lockResult = await client.query(
        `
        SELECT
            variant_id,
            quantity_on_hand,
            quantity_reserved,
            GREATEST(quantity_on_hand - quantity_reserved, 0) AS available_quantity
        FROM inventory
        WHERE variant_id = $1
        FOR UPDATE
        `,
        [variantId]
    );

    if (!lockResult.rows.length) {
        const error = new Error(`Inventory record not found for variant ${variantId}.`);
        error.code = 'INVENTORY_NOT_FOUND';
        error.statusCode = 404;
        throw error;
    }

    const current = lockResult.rows[0];
    const onHand = Number(current.quantity_on_hand || 0);
    const available = Number(current.available_quantity || 0);

    if (onHand < qty || available < unreservedNeeded) {
        const error = new Error(
            `Insufficient inventory for variant ${variantId}. Available: ${available}, requested: ${qty}.`
        );
        error.code = 'INSUFFICIENT_STOCK';
        error.statusCode = 409;
        error.availableQuantity = available;
        error.onHand = onHand;
        throw error;
    }

    // 4. Atomically deduct quantity_on_hand and consume corresponding quantity_reserved
    const updateResult = await client.query(
        `
        UPDATE inventory
        SET
            quantity_on_hand = quantity_on_hand - $2,
            quantity_reserved = GREATEST(quantity_reserved - $3, 0),
            updated_at = NOW()
        WHERE variant_id = $1
          AND quantity_on_hand >= $2
          AND (quantity_on_hand - quantity_reserved) >= ($2 - $3)
        RETURNING variant_id, quantity_on_hand, quantity_reserved
        `,
        [variantId, qty, effectiveReserved]
    );

    if (!updateResult.rows.length) {
        const error = new Error(
            `Concurrent inventory deduction conflict for variant ${variantId}.`
        );
        error.code = 'INSUFFICIENT_STOCK';
        error.statusCode = 409;
        throw error;
    }

    await client.query(
        `
        INSERT INTO inventory_transactions (
            variant_id,
            transaction_type,
            quantity,
            reference_type,
            reference_id,
            notes
        )
        VALUES (
            $1,
            'SALE_DEDUCTION',
            $2,
            'ORDER',
            $3,
            $4
        )
        `,
        [
            variantId,
            qty,
            orderId ? String(orderId) : null,
            notes || (orderId ? `Inventory settled for order ${orderId}` : 'Inventory settled')
        ]
    );

    return updateResult.rows[0];
}

/**
 * Atomically deduct inventory for all items in an order.
 * Sorts variant IDs deterministically (ORDER BY variant_id ASC) to guarantee deadlock prevention.
 * Reconciles order reservations by reducing quantity_reserved when reserved stock is sold.
 */
export async function deductOrderInventory(
    client,
    { orderId, items, reservedQuantities = null }
) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    // 1. Aggregate quantities by variant_id
    const aggregatedMap = new Map();
    for (const item of items) {
        const vId = String(item.variantId || item.variant_id).trim();
        const qty = Number(item.quantity || 0);

        if (!vId || qty <= 0) continue;

        aggregatedMap.set(vId, (aggregatedMap.get(vId) || 0) + qty);
    }

    // 2. Deterministic sorting by variant_id to eliminate deadlocks
    const sortedVariantIds = Array.from(aggregatedMap.keys()).sort();

    if (sortedVariantIds.length === 0) {
        return [];
    }

    // 3. Order-level serialization & idempotency guard: evaluate order-level deduction ledger state
    if (orderId) {
        const orderIdStr = String(orderId).trim();
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!UUID_REGEX.test(orderIdStr)) {
            const error = new Error(`Order ${orderId} not found.`);
            error.code = 'ORDER_NOT_FOUND';
            error.statusCode = 404;
            error.orderId = orderId;
            throw error;
        }

        // Enforce parent order lock first using primary key index
        const orderLock = await client.query(
            `SELECT id FROM orders WHERE id = $1::uuid FOR UPDATE`,
            [orderIdStr]
        );

        if (!orderLock.rows.length) {
            const error = new Error(`Order ${orderId} not found.`);
            error.code = 'ORDER_NOT_FOUND';
            error.statusCode = 404;
            error.orderId = orderId;
            throw error;
        }

        const existingDeductionsRes = await client.query(
            `
            SELECT variant_id, COALESCE(SUM(quantity), 0) AS already_deducted
            FROM inventory_transactions
            WHERE reference_type = 'ORDER'
              AND reference_id = $1
              AND transaction_type = 'SALE_DEDUCTION'
            GROUP BY variant_id
            `,
            [String(orderId)]
        );

        const rowCount = existingDeductionsRes.rows.length;

        if (rowCount === 0) {
            // Case 1: Fresh order with 0 previous deduction records — proceed to normal atomic deduction
        } else {
            const deductionMap = new Map(
                existingDeductionsRes.rows.map(r => [r.variant_id, Number(r.already_deducted || 0)])
            );

            // Case 2: Exact match:
            // - Every expected variant has exactly its required quantity deducted (non-negative exact match)
            // - Every variant in the ledger belongs to this order's expected variants
            const allItemsExactMatch = sortedVariantIds.every(
                vId => (deductionMap.get(vId) || 0) === aggregatedMap.get(vId)
            );
            const noUnexpectedVariants = existingDeductionsRes.rows.every(
                r => aggregatedMap.has(r.variant_id) && Number(r.already_deducted || 0) > 0
            );

            if (allItemsExactMatch && noUnexpectedVariants && rowCount === sortedVariantIds.length) {
                // Fully and identically deducted — idempotent return without mutating stock
                const currentRes = await client.query(
                    `
                    SELECT variant_id, quantity_on_hand, quantity_reserved
                    FROM inventory
                    WHERE variant_id = ANY($1::uuid[])
                    ORDER BY variant_id ASC
                    `,
                    [sortedVariantIds]
                );
                return currentRes.rows;
            }

            // Case 3: Any mismatch (mixed variants, partial deductions, extra variants, or mismatched quantities)
            // Fail closed before acquiring locks or modifying inventory balances
            const mismatchedVariant = sortedVariantIds.find(
                vId => (deductionMap.get(vId) || 0) !== aggregatedMap.get(vId)
            ) || existingDeductionsRes.rows[0]?.variant_id;

            const error = new Error(
                `Inconsistent inventory deduction ledger detected for order ${orderId}. Existing deductions do not match expected order items. Manual reconciliation required.`
            );
            error.code = 'INVENTORY_RECONCILIATION_REQUIRED';
            error.statusCode = 409;
            error.orderId = orderId;
            if (mismatchedVariant) {
                error.variantId = mismatchedVariant;
                error.alreadyDeducted = deductionMap.get(mismatchedVariant) || 0;
                error.requiredQuantity = aggregatedMap.get(mismatchedVariant) || 0;
            }
            error.recordedDeductions = Object.fromEntries(deductionMap);
            error.expectedDeductions = Object.fromEntries(aggregatedMap);
            throw error;
        }
    }

    // 4. Resolve active reservation per variant for this order
    const activeReservations = orderId
        ? await getActiveReservationsForOrder(client, orderId)
        : new Map();

    // 5. Acquire row locks in sorted order
    const lockResult = await client.query(
        `
        SELECT
            variant_id,
            quantity_on_hand,
            quantity_reserved,
            GREATEST(quantity_on_hand - quantity_reserved, 0) AS available_quantity
        FROM inventory
        WHERE variant_id = ANY($1::uuid[])
        ORDER BY variant_id ASC
        FOR UPDATE
        `,
        [sortedVariantIds]
    );

    const inventoryMap = new Map(
        lockResult.rows.map(row => [row.variant_id, row])
    );

    // 6. Validate ALL items before modifying any row
    for (const variantId of sortedVariantIds) {
        const requiredQty = aggregatedMap.get(variantId);
        const inv = inventoryMap.get(variantId);

        if (!inv) {
            const error = new Error(`Inventory record not found for variant ${variantId}.`);
            error.code = 'INVENTORY_NOT_FOUND';
            error.statusCode = 404;
            throw error;
        }

        const explicitReserved = reservedQuantities?.[variantId];
        const effectiveReserved = Number.isInteger(Number(explicitReserved)) && Number(explicitReserved) >= 0
            ? Math.min(requiredQty, Number(explicitReserved))
            : Math.min(requiredQty, activeReservations.get(variantId) || 0);

        const unreservedNeeded = requiredQty - effectiveReserved;
        const available = Number(inv.available_quantity || 0);
        const onHand = Number(inv.quantity_on_hand || 0);

        if (onHand < requiredQty || available < unreservedNeeded) {
            const error = new Error(
                `Insufficient inventory for variant ${variantId}. Available: ${available}, required: ${requiredQty}.`
            );
            error.code = 'INSUFFICIENT_STOCK';
            error.statusCode = 409;
            error.variantId = variantId;
            error.availableQuantity = available;
            error.requiredQuantity = requiredQty;
            throw error;
        }
    }

    // 7. All items confirmed available — execute atomic deduction and ledger writes
    const deductions = [];
    for (const variantId of sortedVariantIds) {
        const qty = aggregatedMap.get(variantId);
        const explicitReserved = reservedQuantities?.[variantId];
        const effectiveReserved = Number.isInteger(Number(explicitReserved)) && Number(explicitReserved) >= 0
            ? Math.min(qty, Number(explicitReserved))
            : Math.min(qty, activeReservations.get(variantId) || 0);

        const updateResult = await client.query(
            `
            UPDATE inventory
            SET
                quantity_on_hand = quantity_on_hand - $2,
                quantity_reserved = GREATEST(quantity_reserved - $3, 0),
                updated_at = NOW()
            WHERE variant_id = $1
              AND quantity_on_hand >= $2
              AND (quantity_on_hand - quantity_reserved) >= ($2 - $3)
            RETURNING variant_id, quantity_on_hand, quantity_reserved
            `,
            [variantId, qty, effectiveReserved]
        );

        await client.query(
            `
            INSERT INTO inventory_transactions (
                variant_id,
                transaction_type,
                quantity,
                reference_type,
                reference_id,
                notes
            )
            VALUES (
                $1,
                'SALE_DEDUCTION',
                $2,
                'ORDER',
                $3,
                $4
            )
            `,
            [
                variantId,
                qty,
                orderId ? String(orderId) : null,
                `Inventory settled for order ${orderId}`
            ]
        );

        deductions.push(updateResult.rows[0]);
    }

    return deductions;
}

/**
 * Safely release an existing reservation without mutating quantity_on_hand.
 * Validates outstanding reservation for orderId to prevent over-release.
 */
export async function releaseInventoryReservation(
    client,
    { variantId, quantity, orderId, notes }
) {
    const qty = Number(quantity);

    if (!Number.isInteger(qty) || qty <= 0) {
        const error = new Error('Release quantity must be a positive integer.');
        error.statusCode = 400;
        throw error;
    }

    // 1. If orderId is provided, clamp release to active reservation for this order
    let releaseQty = qty;
    if (orderId) {
        const activeReserved = await getActiveReservationForVariant(client, orderId, variantId);
        if (activeReserved <= 0) {
            // No active reservation to release for this order — idempotent return
            const currentRes = await client.query(
                `SELECT variant_id, quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1`,
                [variantId]
            );
            return currentRes.rows[0] || null;
        }
        releaseQty = Math.min(qty, activeReserved);
    }

    // 2. Lock row to prevent concurrency race
    const lockResult = await client.query(
        `SELECT variant_id, quantity_reserved FROM inventory WHERE variant_id = $1 FOR UPDATE`,
        [variantId]
    );

    if (!lockResult.rows.length) {
        const error = new Error(`Inventory record not found for variant ${variantId}.`);
        error.code = 'INVENTORY_NOT_FOUND';
        error.statusCode = 404;
        throw error;
    }

    const currentReserved = Number(lockResult.rows[0].quantity_reserved || 0);
    const finalReleaseQty = Math.min(releaseQty, currentReserved);

    if (finalReleaseQty <= 0) {
        return lockResult.rows[0];
    }

    const updateResult = await client.query(
        `
        UPDATE inventory
        SET
            quantity_reserved = GREATEST(quantity_reserved - $2, 0),
            updated_at = NOW()
        WHERE variant_id = $1
        RETURNING variant_id, quantity_on_hand, quantity_reserved
        `,
        [variantId, finalReleaseQty]
    );

    await client.query(
        `
        INSERT INTO inventory_transactions (
            variant_id,
            transaction_type,
            quantity,
            reference_type,
            reference_id,
            notes
        )
        VALUES (
            $1,
            'RESERVATION_RELEASE',
            $2,
            'ORDER',
            $3,
            $4
        )
        `,
        [
            variantId,
            finalReleaseQty,
            orderId ? String(orderId) : null,
            notes || (orderId ? `Reservation released for order ${orderId}` : 'Reservation released')
        ]
    );

    return updateResult.rows[0];
}

/**
 * Release all outstanding reservations for an order across all its line items.
 */
export async function releaseOrderInventoryReservations(
    client,
    { orderId, notes }
) {
    if (!orderId) {
        return [];
    }

    const activeReservations = await getActiveReservationsForOrder(client, orderId);
    const variantIds = Array.from(activeReservations.keys()).sort();

    if (variantIds.length === 0) {
        return [];
    }

    const releases = [];
    for (const variantId of variantIds) {
        const reservedQty = activeReservations.get(variantId);
        if (reservedQty > 0) {
            const rel = await releaseInventoryReservation(client, {
                variantId,
                quantity: reservedQty,
                orderId,
                notes: notes || `Order ${orderId} cancelled/failed: releasing reservation`
            });
            releases.push(rel);
        }
    }

    return releases;
}
