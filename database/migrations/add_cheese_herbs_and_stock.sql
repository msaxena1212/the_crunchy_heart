-- ==============================================================================
-- THE CRUNCHY HEART
-- Staging / Production Fix: Add 8th Flavour (Cheese & Herbs) and Restore Stock
-- ==============================================================================

BEGIN;

-- 1. Ensure the Flavoured Makhana product exists
DO $$
DECLARE
    v_prod_id UUID;
    v_variant_id UUID;
BEGIN
    SELECT id INTO v_prod_id FROM products WHERE slug = 'flavoured-makhana' LIMIT 1;

    IF v_prod_id IS NULL THEN
        RAISE EXCEPTION 'Product flavoured-makhana not found!';
    END IF;

    -- 2. Insert or update the 8th Flavour: Cheese & Herbs (70g)
    INSERT INTO product_variants (
        product_id,
        sku,
        variant_name,
        weight_grams,
        flavor,
        mrp,
        selling_price,
        cost_price,
        tax_rate,
        badge,
        tone,
        is_active,
        sort_order
    )
    VALUES (
        v_prod_id,
        'TCH-FLV-CHEESE',
        'Cheese & Herbs',
        70,
        'Cheese & Herbs',
        220,
        199,
        110,
        18,
        'Chef Special',
        'cheese',
        TRUE,
        8
    )
    ON CONFLICT (sku) DO UPDATE
    SET
        variant_name = EXCLUDED.variant_name,
        flavor = EXCLUDED.flavor,
        weight_grams = EXCLUDED.weight_grams,
        mrp = EXCLUDED.mrp,
        selling_price = EXCLUDED.selling_price,
        cost_price = EXCLUDED.cost_price,
        tax_rate = EXCLUDED.tax_rate,
        badge = EXCLUDED.badge,
        tone = EXCLUDED.tone,
        is_active = TRUE,
        sort_order = EXCLUDED.sort_order,
        updated_at = NOW()
    RETURNING id INTO v_variant_id;

    -- 3. Ensure inventory record exists for the new variant
    INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
    VALUES (v_variant_id, 100, 0, 15)
    ON CONFLICT (variant_id) DO UPDATE
    SET quantity_on_hand = GREATEST(inventory.quantity_on_hand, 100);

END $$;

-- 4. Restore/Ensure all active product variants have available stock (100 units on hand)
-- This fixes the issue on staging where availableQuantity was 0, causing all products
-- to display "Coming Soon" and disabling the "Add to Cart" button.
INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
SELECT
    pv.id,
    100,
    0,
    15
FROM product_variants pv
WHERE pv.is_active = TRUE
ON CONFLICT (variant_id) DO UPDATE
SET quantity_on_hand = GREATEST(inventory.quantity_on_hand, 100);

COMMIT;

-- Verification Query: Show all products, variants, prices, and stock
SELECT
    p.name AS product_category,
    pv.variant_name,
    pv.sku,
    pv.weight_grams,
    pv.selling_price,
    pv.mrp,
    pv.badge,
    i.quantity_on_hand,
    (i.quantity_on_hand - i.quantity_reserved) AS available_quantity
FROM product_variants pv
INNER JOIN products p ON p.id = pv.product_id
LEFT JOIN inventory i ON i.variant_id = pv.id
WHERE pv.is_active = TRUE
ORDER BY p.sort_order ASC, pv.sort_order ASC;

