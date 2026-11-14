import {
    getVariantsForCheckout,
    calculateItemPricing,
} from '../services/pricing.service.js';

import {
    getInventoryForVariants,
} from '../services/inventory.service.js';

import {
    calculateShipping,
} from '../services/shipping.service.js';

import {
    isInterStateSupply,
} from '../utils/gst.js';

import {
    createInventoryHold,
    releaseInventoryHold
} from '../services/inventory-hold.service.js';

export async function createHoldController(req, res, next) {
    try {
        const { sessionId, items } = req.body;
        if (!sessionId || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'sessionId and at least one item are required for hold.'
            });
        }

        const hold = await createInventoryHold({ sessionId, items });
        return res.json({
            success: true,
            hold
        });
    } catch (error) {
        if (error.code === 'INSUFFICIENT_STOCK') {
            return res.status(409).json({
                success: false,
                code: error.code,
                message: error.message,
                availableQuantity: error.availableQuantity
            });
        }
        next(error);
    }
}

export async function releaseHoldController(req, res, next) {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({
                success: false,
                message: 'sessionId is required.'
            });
        }
        await releaseInventoryHold(sessionId);
        return res.json({ success: true, message: 'Hold released.' });
    } catch (error) {
        next(error);
    }
}

export async function previewCheckout(req, res, next) {
    try {
        const { items, shippingAddress, state } = req.body;
        const shippingState = shippingAddress?.state || state || null;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'At least one item is required.',
            });
        }

        // --------------------------------------------------
        // Validate incoming items
        // --------------------------------------------------

        for (const item of items) {
            if (!item.variantId) {
                return res.status(400).json({
                    success: false,
                    message: 'variantId is required for every item.',
                });
            }

            if (
                !Number.isInteger(Number(item.quantity)) ||
                Number(item.quantity) <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Quantity must be a positive integer.',
                });
            }
        }

        // --------------------------------------------------
        // Aggregate duplicate variant items
        // --------------------------------------------------

        const aggregatedMap = new Map();
        for (const item of items) {
            const vId = String(item.variantId).trim();
            const qty = Number(item.quantity);
            if (!aggregatedMap.has(vId)) {
                aggregatedMap.set(vId, { variantId: vId, quantity: qty });
            } else {
                aggregatedMap.get(vId).quantity += qty;
            }
        }
        const aggregatedItems = Array.from(aggregatedMap.values());

        // --------------------------------------------------
        // Fetch variants
        // --------------------------------------------------

        const variantIds = aggregatedItems.map(
            (item) => item.variantId
        );

        const variants = await getVariantsForCheckout(
            variantIds
        );

        const variantMap = new Map(
            variants.map((variant) => [
                String(variant.id),
                variant,
            ])
        );

        // --------------------------------------------------
        // Check all requested variants exist
        // --------------------------------------------------

        for (const item of aggregatedItems) {
            const variant = variantMap.get(
                String(item.variantId)
            );

            if (!variant) {
                return res.status(404).json({
                    success: false,
                    message: `Product variant not found: ${item.variantId}`,
                });
            }
        }

        // --------------------------------------------------
        // Fetch inventory
        // --------------------------------------------------

        const inventoryMap =
            await getInventoryForVariants(
                variants.map((variant) =>
                    String(variant.id)
                )
            );

        // --------------------------------------------------
        // Calculate pricing
        // --------------------------------------------------

        const pricedItems = [];

        let subtotal = 0;
        let taxableSubtotal = 0;
        let taxAmount = 0;

        for (const item of aggregatedItems) {
            const variant = variantMap.get(
                String(item.variantId)
            );

            const quantity = Number(item.quantity);

            const inventory =
                inventoryMap.get(
                    String(variant.id)
                );

            if (!inventory) {
                return res.status(409).json({
                    success: false,
                    message: `Inventory not found for ${variant.sku}.`,
                });
            }

            // ----------------------------------------------
            // Inventory availability
            // ----------------------------------------------

            if (
                inventory.availableQuantity <
                quantity
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        inventory.availableQuantity === 0
                            ? `${variant.variant_name} is currently out of stock.`
                            : `Only ${inventory.availableQuantity} unit(s) of ${variant.variant_name} are available.`,
                    availableQuantity:
                        inventory.availableQuantity,
                });
            }

            // ----------------------------------------------
            // Price calculation
            // ----------------------------------------------

            const pricing =
                calculateItemPricing(
                    variant,
                    quantity,
                    shippingState
                );

            subtotal += pricing.grossAmount;
            taxableSubtotal +=
                pricing.taxableAmount;
            taxAmount +=
                pricing.taxAmount;

            pricedItems.push({
                variantId: variant.id,
                productId: variant.product_id,
                productName: variant.product_name,
                variantName: variant.variant_name,
                sku: variant.sku,
                quantity,
                unitPrice: pricing.unitPrice,
                grossAmount: pricing.grossAmount,
                taxableAmount: pricing.taxableAmount,
                taxRate: pricing.taxRate,
                taxAmount: pricing.taxAmount,
                hsnCode: pricing.hsnCode,
                gstBreakdown: pricing.gstBreakdown,
                availableQuantity:
                    inventory.availableQuantity,
            });
        }

        subtotal = Number(subtotal.toFixed(2));
        taxableSubtotal =
            Number(taxableSubtotal.toFixed(2));
        taxAmount =
            Number(taxAmount.toFixed(2));

        // --------------------------------------------------
        // Shipping
        // --------------------------------------------------

        const shipping =
            await calculateShipping(subtotal);

        // --------------------------------------------------
        // Discount (Festive Combo Milestone Discounts)
        // 4 to 6 items: 5% OFF | 7 to 9 items: 8% OFF | 10+ items: 10% OFF
        // --------------------------------------------------

        let flavouredCount = 0;
        let flavouredSubtotal = 0;
        for (const item of pricedItems) {
            const sku = item.sku || '';
            if (sku.startsWith('TCH-FLV-') || sku.includes('FLV')) {
                flavouredCount += item.quantity;
                flavouredSubtotal += item.grossAmount;
            }
        }

        let comboDiscountPercent = 0;
        if (flavouredCount >= 10) {
            comboDiscountPercent = 10;
        } else if (flavouredCount >= 7) {
            comboDiscountPercent = 8;
        } else if (flavouredCount >= 4) {
            comboDiscountPercent = 5;
        }

        const discountAmount = comboDiscountPercent > 0
            ? Number((flavouredSubtotal * (comboDiscountPercent / 100)).toFixed(2))
            : 0;

        // --------------------------------------------------
        // Final total
        // --------------------------------------------------

        const totalAmount = Number(
            (
                subtotal -
                discountAmount +
                shipping
            ).toFixed(2)
        );

        let totalCgst = 0;
        let totalSgst = 0;
        let totalIgst = 0;
        for (const item of pricedItems) {
            if (item.gstBreakdown) {
                totalCgst += item.gstBreakdown.cgstAmount;
                totalSgst += item.gstBreakdown.sgstAmount;
                totalIgst += item.gstBreakdown.igstAmount;
            }
        }
        totalCgst = Number(totalCgst.toFixed(2));
        totalSgst = Number(totalSgst.toFixed(2));
        totalIgst = Number(totalIgst.toFixed(2));
        const interState = isInterStateSupply(shippingState);

        return res.json({
            success: true,

            currency: 'INR',

            items: pricedItems,

            subtotal,

            discountAmount,

            shippingAmount: shipping,

            taxableAmount: taxableSubtotal,

            taxAmount,

            taxRate: pricedItems.length > 0 ? pricedItems[0].taxRate : 5,

            priceIncludesTax: true,

            gstBreakdown: {
                placeOfSupply: shippingState || 'Inter-State',
                isInterState: interState,
                cgstAmount: totalCgst,
                sgstAmount: totalSgst,
                igstAmount: totalIgst,
            },

            totalAmount,

            coupon: null,
        });
    } catch (error) {
        next(error);
    }
}