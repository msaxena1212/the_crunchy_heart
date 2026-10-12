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

export async function previewCheckout(req, res, next) {
    try {
        const { items } = req.body;

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
        // Fetch variants
        // --------------------------------------------------

        const variantIds = items.map(
            (item) => String(item.variantId)
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

        for (const item of items) {
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

        for (const item of items) {
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
                    quantity
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
        // Discount
        // --------------------------------------------------

        const discountAmount = 0;

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

        return res.json({
            success: true,

            currency: 'INR',

            items: pricedItems,

            subtotal,

            discountAmount,

            shippingAmount: shipping,

            taxableAmount: taxableSubtotal,

            taxAmount,

            taxRate: 18,

            priceIncludesTax: true,

            totalAmount,

            coupon: null,
        });
    } catch (error) {
        next(error);
    }
}