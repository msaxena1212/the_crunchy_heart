-- ==============================================================================
-- THE CRUNCHY HEART
-- Migration: Add Festive Gifting & Bulk Wholesale Categories, Products & Variants
-- ==============================================================================

BEGIN;

-- 1. Insert Categories
INSERT INTO categories (name, slug, description, sort_order, is_active)
VALUES
    ('Festive & Gift Boxes', 'festive-gifting', 'Handcrafted luxury makhana gift hampers for celebrations, corporate gifting and festivals.', 3, TRUE),
    ('Bulk & Wholesale', 'bulk-wholesale', 'Direct-from-origin bulk raw makhana in 6+ Suta jumbo grade for caterers, businesses and large families.', 4, TRUE)
ON CONFLICT (slug) DO UPDATE
SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_active = TRUE,
    updated_at = NOW();

-- 2. Insert Products
DO $$
DECLARE
    v_gift_cat_id UUID;
    v_bulk_cat_id UUID;
    v_gift_prod_id UUID;
    v_bulk_prod_id UUID;
BEGIN
    SELECT id INTO v_gift_cat_id FROM categories WHERE slug = 'festive-gifting' LIMIT 1;
    SELECT id INTO v_bulk_cat_id FROM categories WHERE slug = 'bulk-wholesale' LIMIT 1;

    -- A. Festive Discovery Box Product
    INSERT INTO products (
        category_id,
        name,
        slug,
        description,
        short_description,
        brand,
        is_featured,
        sort_order,
        is_active
    )
    VALUES (
        v_gift_cat_id,
        'The Crunch Box — Festive Gift Set',
        'festive-discovery-box',
        'Celebrate special occasions with our handcrafted luxury gift box featuring signature flavours of The Crunchy Heart. Packaged in a festive sleeve with personalized gift notes.',
        'Signature Flavours. Handcrafted Luxury Hamper.',
        'The Crunchy Heart',
        TRUE,
        3,
        TRUE
    )
    ON CONFLICT (slug) DO UPDATE
    SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        short_description = EXCLUDED.short_description,
        is_featured = TRUE,
        sort_order = 3,
        is_active = TRUE,
        updated_at = NOW()
    RETURNING id INTO v_gift_prod_id;

    -- B. Bulk Raw Makhana Product
    INSERT INTO products (
        category_id,
        name,
        slug,
        description,
        short_description,
        brand,
        is_featured,
        sort_order,
        is_active
    )
    VALUES (
        v_bulk_cat_id,
        'Bulk Raw Makhana (6+ Suta Jumbo)',
        'bulk-raw-makhana',
        'Partner with The Crunchy Heart for direct-from-origin raw makhana supply. Handpicked jumbo 6+ Suta lotus seeds from Darbhanga, Bihar wetlands. Ideal for caterers, bulk gifting and wholesale.',
        'Direct-From-Origin Wholesale Supply. 6+ Suta Jumbo Grade.',
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
        sort_order = 4,
        is_active = TRUE,
        updated_at = NOW()
    RETURNING id INTO v_bulk_prod_id;

    -- 3. Insert Product Variants
    -- Festive All 8 Box
    INSERT INTO product_variants (
        product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, sort_order, is_active
    )
    VALUES
        (v_gift_prod_id, 'TCH-GIFT-ALL8', 'All 8 Flavours Box (8 x 70g)', 560, 'All 8 Flavours Set', 1799, 1499, 850, 18, 'Festive Bestseller', 'gold', 1, TRUE),
        (v_gift_prod_id, 'TCH-GIFT-4PACK', 'Celebration 4-Pack (4 x 70g)', 280, '4 Popular Flavours', 899, 749, 420, 18, 'Celebration Pack', 'orange', 2, TRUE)
    ON CONFLICT (sku) DO UPDATE
    SET
        variant_name = EXCLUDED.variant_name,
        weight_grams = EXCLUDED.weight_grams,
        flavor = EXCLUDED.flavor,
        mrp = EXCLUDED.mrp,
        selling_price = EXCLUDED.selling_price,
        badge = EXCLUDED.badge,
        tone = EXCLUDED.tone,
        sort_order = EXCLUDED.sort_order,
        is_active = TRUE,
        updated_at = NOW();

    -- Bulk Raw Makhana Variants
    INSERT INTO product_variants (
        product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, sort_order, is_active
    )
    VALUES
        (v_bulk_prod_id, 'TCH-BLK-5KG', '5kg Caterer Pack', 5000, NULL, 4999, 4299, 3200, 18, 'Wholesale Pack', 'sand', 1, TRUE),
        (v_bulk_prod_id, 'TCH-BLK-10KG', '10kg Master Carton', 10000, NULL, 9499, 7999, 6000, 18, 'Source Direct', 'sand', 2, TRUE)
    ON CONFLICT (sku) DO UPDATE
    SET
        variant_name = EXCLUDED.variant_name,
        weight_grams = EXCLUDED.weight_grams,
        flavor = EXCLUDED.flavor,
        mrp = EXCLUDED.mrp,
        selling_price = EXCLUDED.selling_price,
        badge = EXCLUDED.badge,
        tone = EXCLUDED.tone,
        sort_order = EXCLUDED.sort_order,
        is_active = TRUE,
        updated_at = NOW();

END $$;

-- 4. Ensure Inventory Records with 100 Units each
INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
SELECT
    pv.id,
    100,
    0,
    10
FROM product_variants pv
WHERE pv.sku IN ('TCH-GIFT-ALL8', 'TCH-GIFT-4PACK', 'TCH-BLK-5KG', 'TCH-BLK-10KG')
ON CONFLICT (variant_id) DO UPDATE
SET quantity_on_hand = GREATEST(inventory.quantity_on_hand, 100);

COMMIT;
