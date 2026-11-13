import {
    roundMoney
} from './money.js';

export const DEFAULT_STORE_STATE = 'Bihar';

export const HSN_CODES = Object.freeze({
    RAW_MAKHANA: '19041090',
    ROASTED_FLAVOURED_MAKHANA: '19041090',
});

export const FOOD_GST_RATES = Object.freeze({
    RAW: 0,                   // 0% GST on raw / plain unbranded makhana
    ROASTED_FLAVOURED: 5,     // 5% GST on roasted / flavoured makhana (HSN 19041090)
});

/**
 * Normalizes an Indian state string for place-of-supply comparison.
 */
export function normalizeState(state) {
    if (!state || typeof state !== 'string') return '';
    return state.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Determines whether a transaction is an inter-state or intra-state supply.
 * Intra-state: Buyer state matches Store/Seller state (e.g. Bihar -> Bihar) => CGST + SGST
 * Inter-state: Buyer state differs from Store/Seller state (e.g. Bihar -> Delhi/Maharashtra) => IGST
 */
export function isInterStateSupply(buyerState, sellerState = DEFAULT_STORE_STATE) {
    const buyer = normalizeState(buyerState);
    const seller = normalizeState(sellerState);
    if (!buyer || !seller) {
        // Default to inter-state for global/inter-state shipping safety if buyer state is unspecified
        return true;
    }
    return buyer !== seller;
}

/**
 * Determines the appropriate Food GST rate for a variant.
 * If the variant already specifies an explicit tax_rate > 0 (e.g. test overrides), it honors it.
 * Otherwise, roasted/flavoured makhana gets 5% (HSN 19041090) and raw makhana gets 0%.
 */
export function getProductGstRate(variant) {
    if (variant && variant.tax_rate !== undefined && variant.tax_rate !== null) {
        const parsedRate = Number(variant.tax_rate);
        if (Number.isFinite(parsedRate) && parsedRate > 0) {
            return parsedRate;
        }
    }
    const sku = String(variant?.sku || '').toUpperCase();
    const name = String(variant?.variant_name || variant?.name || '').toUpperCase();
    if (sku.includes('RAW') || name.includes('RAW')) {
        return FOOD_GST_RATES.RAW;
    }
    return FOOD_GST_RATES.ROASTED_FLAVOURED;
}

/**
 * Returns the HSN code for a variant.
 */
export function getProductHsnCode(variant) {
    const sku = String(variant?.sku || '').toUpperCase();
    if (sku.includes('RAW')) {
        return HSN_CODES.RAW_MAKHANA;
    }
    return HSN_CODES.ROASTED_FLAVOURED_MAKHANA;
}

/**
 * Calculate GST-inclusive breakdown for a given gross amount and tax rate.
 */
export function calculateInclusiveTax(
    grossAmount,
    taxRate = 5
) {
    const gross = Number(grossAmount || 0);
    const rate = Number(taxRate || 0);

    if (gross <= 0 || rate <= 0) {
        return {
            grossAmount: roundMoney(gross),
            taxableAmount: roundMoney(gross),
            taxAmount: 0,
            taxRate: rate
        };
    }

    const divisor = 1 + rate / 100;
    const taxableAmount = roundMoney(gross / divisor);
    const taxAmount = roundMoney(gross - taxableAmount);

    return {
        grossAmount: roundMoney(gross),
        taxableAmount,
        taxAmount,
        taxRate: rate
    };
}

/**
 * Calculates complete Place of Supply (POS) GST breakdown (CGST + SGST vs IGST).
 */
export function calculateGstBreakdown({
    grossAmount,
    taxRate = 5,
    shippingState = null,
    storeState = DEFAULT_STORE_STATE,
}) {
    const tax = calculateInclusiveTax(grossAmount, taxRate);
    const interState = isInterStateSupply(shippingState, storeState);

    let cgstRate = 0;
    let sgstRate = 0;
    let igstRate = 0;
    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    if (tax.taxAmount > 0) {
        if (interState) {
            igstRate = tax.taxRate;
            igstAmount = tax.taxAmount;
        } else {
            cgstRate = roundMoney(tax.taxRate / 2);
            sgstRate = roundMoney(tax.taxRate / 2);
            cgstAmount = roundMoney(tax.taxAmount / 2);
            sgstAmount = roundMoney(tax.taxAmount - cgstAmount);
        }
    }

    return {
        ...tax,
        placeOfSupply: shippingState || 'Inter-State',
        isInterState: interState,
        cgstRate,
        sgstRate,
        igstRate,
        cgstAmount,
        sgstAmount,
        igstAmount,
    };
}