import { query } from '../db/pool.js';

import {
    roundMoney,
} from '../utils/money.js';


const DEFAULT_SHIPPING_CONFIG = {
    free_shipping_threshold: 499,
    flat_shipping_amount: 149,
    currency: 'INR',
};


/**
 * Load shipping configuration from store_settings.
 */
export async function getShippingConfig() {
    const result = await query(
        `
        SELECT
            setting_value
        FROM store_settings
        WHERE setting_key = 'shipping'
        LIMIT 1
        `
    );

    if (!result.rows.length) {
        return {
            ...DEFAULT_SHIPPING_CONFIG,
        };
    }

    const storedConfig =
        result.rows[0].setting_value || {};

    return {
        free_shipping_threshold:
            Number(
                storedConfig.free_shipping_threshold ??
                DEFAULT_SHIPPING_CONFIG.free_shipping_threshold
            ),

        flat_shipping_amount:
            Number(
                storedConfig.flat_shipping_amount ??
                DEFAULT_SHIPPING_CONFIG.flat_shipping_amount
            ),

        currency:
            storedConfig.currency ||
            DEFAULT_SHIPPING_CONFIG.currency,
    };
}


/**
 * Calculate shipping based on merchandise subtotal.
 *
 * Business rule:
 *
 * >= ₹499  → FREE
 * < ₹499   → ₹149
 */
export async function calculateShipping(
    subtotal
) {
    const amount = roundMoney(subtotal);

    const config =
        await getShippingConfig();

    if (
        amount >=
        config.free_shipping_threshold
    ) {
        return 0;
    }

    return roundMoney(
        config.flat_shipping_amount
    );
}