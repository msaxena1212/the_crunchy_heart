import { query } from '../db/pool.js';

import {
    calculateInclusiveTax,
} from '../utils/gst.js';

import {
    multiplyMoney,
    roundMoney,
} from '../utils/money.js';


/**
 * Fetch active product variants for checkout.
 *
 * @param {string[]} variantIds
 * @returns {Promise<Array>}
 */
export async function getVariantsForCheckout(
    variantIds
) {
    if (
        !Array.isArray(variantIds) ||
        variantIds.length === 0
    ) {
        return [];
    }

    const normalizedVariantIds = [
        ...new Set(
            variantIds
                .filter(Boolean)
                .map((id) => String(id).trim())
        ),
    ];

    if (normalizedVariantIds.length === 0) {
        return [];
    }

    const result = await query(
        `
        SELECT
            v.id,
            v.product_id,
            v.sku,
            v.variant_name,
            v.weight_grams,
            v.flavor,
            v.selling_price,
            v.tax_rate,
            v.is_active,

            p.name AS product_name,
            p.slug AS product_slug,
            p.is_active AS product_is_active

        FROM product_variants v

        INNER JOIN products p
            ON p.id = v.product_id

        WHERE
            v.id = ANY($1::uuid[])
            AND v.is_active = true
            AND p.is_active = true
        `,
        [normalizedVariantIds]
    );

    return result.rows;
}


/**
 * Calculate GST-inclusive pricing for a checkout item.
 *
 * Website selling prices already include GST.
 *
 * Example:
 * ₹229 inclusive of 18% GST
 * Taxable value = ₹229 / 1.18 = ₹194.07
 * GST = ₹229 - ₹194.07 = ₹34.93
 */
export function calculateItemPricing(
    variant,
    quantity
) {
    const qty = Number(quantity);

    if (
        !Number.isInteger(qty) ||
        qty <= 0
    ) {
        throw new Error(
            'Quantity must be a positive integer.'
        );
    }

    const unitPrice = Number(
        variant.selling_price || 0
    );

    if (unitPrice < 0) {
        throw new Error(
            `Invalid selling price for ${variant.sku}.`
        );
    }

    const taxRate = Number(
        variant.tax_rate ?? 18
    );

    const grossAmount = multiplyMoney(
        unitPrice,
        qty
    );

    const tax = calculateInclusiveTax(
        grossAmount,
        taxRate
    );

    return {
        variantId: variant.id,

        productId: variant.product_id,

        sku: variant.sku,

        productName: variant.product_name,

        variantName: variant.variant_name,

        quantity: qty,

        unitPrice: roundMoney(unitPrice),

        grossAmount: tax.grossAmount,

        taxableAmount: tax.taxableAmount,

        taxAmount: tax.taxAmount,

        taxRate,
    };
}