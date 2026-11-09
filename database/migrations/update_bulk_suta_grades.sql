-- ==============================================================================
-- THE CRUNCHY HEART
-- Migration: Upgrade Bulk Raw Makhana to 5 Suta, 6 Suta & 7 Suta Size Grades
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    v_prod_id UUID;
    v_cat_id UUID;
BEGIN
    SELECT id INTO v_cat_id FROM categories WHERE slug = 'bulk-wholesale' LIMIT 1;
    IF v_cat_id IS NULL THEN
        INSERT INTO categories (name, slug, description, sort_order, is_active)
        VALUES ('Bulk & Wholesale', 'bulk-wholesale', 'Direct-from-origin bulk raw makhana in 5, 6 and 7 Suta grades for businesses, caterers and retailers.', 4, TRUE)
        RETURNING id INTO v_cat_id;
    END IF;

    -- Upsert Product
    INSERT INTO products (
        category_id, name, slug, description, short_description, brand, is_featured, sort_order, is_active
    )
    VALUES (
        v_cat_id,
        'Direct-from-Origin Bulk Raw Makhana (5, 6 & 7 Suta)',
        'bulk-raw-makhana',
        'Direct-from-origin phool makhana harvested in Darbhanga & Madhubani, Mithilanchal (Bihar). Available in 5 Suta (Classic 13-15mm), 6 Suta (Export Jumbo 16-18mm), and 7 Suta (Royal King 20mm+) grades in 5kg and 10kg food-grade bulk packaging for caterers, retailers, sweet makers, and institutional buyers.',
        '5, 6 & 7 Suta Handpicked Grades • Direct from Mithilanchal',
        'The Crunchy Heart',
        TRUE,
        4,
        TRUE
    )
    ON CONFLICT (slug) DO UPDATE
    SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        short_description = EXCLUDED.short_description,
        is_featured = TRUE,
        is_active = TRUE,
        updated_at = NOW()
    RETURNING id INTO v_prod_id;

    -- Deactivate old generic variants if present
    UPDATE product_variants
    SET is_active = FALSE
    WHERE sku IN ('TCH-BLK-5KG', 'TCH-BLK-10KG');

    -- 1. 5 Suta Classic - 5kg
    INSERT INTO product_variants (
        product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order
    ) VALUES (
        v_prod_id, 'TCH-BLK-5S-5KG', '5 Suta Classic (5kg Bag)', 5000, '5 Suta Classic (13-15mm)', 4699.00, 3999.00, 3200.00, 5.00, '5 Suta Classic', 'sand', TRUE, 1
    ) ON CONFLICT (sku) DO UPDATE SET
        variant_name = EXCLUDED.variant_name, weight_grams = EXCLUDED.weight_grams, flavor = EXCLUDED.flavor,
        mrp = EXCLUDED.mrp, selling_price = EXCLUDED.selling_price, badge = EXCLUDED.badge, is_active = TRUE, sort_order = 1;

    -- 2. 5 Suta Classic - 10kg
    INSERT INTO product_variants (
        product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order
    ) VALUES (
        v_prod_id, 'TCH-BLK-5S-10KG', '5 Suta Classic (10kg Master Carton)', 10000, '5 Suta Classic (13-15mm)', 8999.00, 7699.00, 6200.00, 5.00, 'Wholesale Saver', 'sand', TRUE, 2
    ) ON CONFLICT (sku) DO UPDATE SET
        variant_name = EXCLUDED.variant_name, weight_grams = EXCLUDED.weight_grams, flavor = EXCLUDED.flavor,
        mrp = EXCLUDED.mrp, selling_price = EXCLUDED.selling_price, badge = EXCLUDED.badge, is_active = TRUE, sort_order = 2;

    -- 3. 6 Suta Jumbo - 5kg
    INSERT INTO product_variants (
        product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order
    ) VALUES (
        v_prod_id, 'TCH-BLK-6S-5KG', '6 Suta Jumbo Export (5kg Bag)', 5000, '6 Suta Jumbo Export (16-18mm)', 5699.00, 4899.00, 3900.00, 5.00, '6 Suta Export Jumbo', 'gold', TRUE, 3
    ) ON CONFLICT (sku) DO UPDATE SET
        variant_name = EXCLUDED.variant_name, weight_grams = EXCLUDED.weight_grams, flavor = EXCLUDED.flavor,
        mrp = EXCLUDED.mrp, selling_price = EXCLUDED.selling_price, badge = EXCLUDED.badge, is_active = TRUE, sort_order = 3;

    -- 4. 6 Suta Jumbo - 10kg
    INSERT INTO product_variants (
        product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order
    ) VALUES (
        v_prod_id, 'TCH-BLK-6S-10KG', '6 Suta Jumbo Export (10kg Master Carton)', 10000, '6 Suta Jumbo Export (16-18mm)', 10999.00, 9499.00, 7700.00, 5.00, 'Most Popular B2B', 'gold', TRUE, 4
    ) ON CONFLICT (sku) DO UPDATE SET
        variant_name = EXCLUDED.variant_name, weight_grams = EXCLUDED.weight_grams, flavor = EXCLUDED.flavor,
        mrp = EXCLUDED.mrp, selling_price = EXCLUDED.selling_price, badge = EXCLUDED.badge, is_active = TRUE, sort_order = 4;

    -- 5. 7 Suta King Giant - 5kg
    INSERT INTO product_variants (
        product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order
    ) VALUES (
        v_prod_id, 'TCH-BLK-7S-5KG', '7 Suta King Giant (5kg Luxury Bag)', 5000, '7 Suta King Blossom (20mm+)', 6999.00, 5999.00, 4800.00, 5.00, '7 Suta King Giant', 'royal', TRUE, 5
    ) ON CONFLICT (sku) DO UPDATE SET
        variant_name = EXCLUDED.variant_name, weight_grams = EXCLUDED.weight_grams, flavor = EXCLUDED.flavor,
        mrp = EXCLUDED.mrp, selling_price = EXCLUDED.selling_price, badge = EXCLUDED.badge, is_active = TRUE, sort_order = 5;

    -- 6. 7 Suta King Giant - 10kg
    INSERT INTO product_variants (
        product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order
    ) VALUES (
        v_prod_id, 'TCH-BLK-7S-10KG', '7 Suta King Giant (10kg Master Carton)', 10000, '7 Suta King Blossom (20mm+)', 13499.00, 11799.00, 9500.00, 5.00, 'Royal Reserve Grade', 'royal', TRUE, 6
    ) ON CONFLICT (sku) DO UPDATE SET
        variant_name = EXCLUDED.variant_name, weight_grams = EXCLUDED.weight_grams, flavor = EXCLUDED.flavor,
        mrp = EXCLUDED.mrp, selling_price = EXCLUDED.selling_price, badge = EXCLUDED.badge, is_active = TRUE, sort_order = 6;

END $$;

-- 7. Ensure Inventory Records with 100 Units each
INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
SELECT
    pv.id,
    100,
    0,
    10
FROM product_variants pv
WHERE pv.sku IN (
    'TCH-BLK-5S-5KG', 'TCH-BLK-5S-10KG',
    'TCH-BLK-6S-5KG', 'TCH-BLK-6S-10KG',
    'TCH-BLK-7S-5KG', 'TCH-BLK-7S-10KG'
)
ON CONFLICT (variant_id) DO UPDATE
SET quantity_on_hand = GREATEST(inventory.quantity_on_hand, 100);

COMMIT;
