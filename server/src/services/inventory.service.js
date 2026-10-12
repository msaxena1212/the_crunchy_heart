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

export async function reserveInventory(
    client,
    variantId,
    quantity,
    orderId
) {
    const result =
        await client.query(
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

        WHERE variant_id = $1

        FOR UPDATE
      `,
            [variantId]
        );

    if (!result.rows.length) {
        throw new Error(
            `Inventory record not found for variant ${variantId}.`
        );
    }

    const row =
        result.rows[0];

    const available =
        Number(
            row.available_quantity || 0
        );

    if (
        available < quantity
    ) {
        const error =
            new Error(
                `Insufficient inventory. Available: ${available}, requested: ${quantity}.`
            );

        error.statusCode = 409;

        throw error;
    }

    await client.query(
        `
      UPDATE inventory

      SET
        quantity_reserved =
          quantity_reserved + $2,

        updated_at = NOW()

      WHERE variant_id = $1
    `,
        [
            variantId,
            quantity
        ]
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
        'Inventory reserved during checkout'
      )
    `,
        [
            variantId,
            quantity,
            orderId
        ]
    );
}