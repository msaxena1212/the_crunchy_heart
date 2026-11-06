-- ============================================================
-- THE CRUNCHY HEART
-- Production Database Initial Seed
-- Populates Categories, Products, Variants, Commercial Prices, and Initial Inventory
-- PostgreSQL / AWS RDS
-- ============================================================

-- 1. CATEGORIES
INSERT INTO categories (id, name, slug, description, is_active, sort_order)
VALUES
    ('c0000000-0000-0000-0000-000000000001', 'Raw Makhana', 'raw-makhana', 'Pure, natural makhana for everyday snacking.', TRUE, 1),
    ('c0000000-0000-0000-0000-000000000002', 'Flavoured Makhana', 'flavoured-makhana', 'Bold flavours with the signature makhana crunch.', TRUE, 2)
ON CONFLICT (slug) DO UPDATE
SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_active = TRUE,
    sort_order = EXCLUDED.sort_order;

-- 2. PRODUCTS
INSERT INTO products (id, category_id, name, slug, description, short_description, brand, is_active, is_featured, sort_order)
VALUES
    (
        'p0000000-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-000000000001',
        'Raw Makhana',
        'raw-makhana',
        'Premium raw makhana, carefully selected and packed for everyday snacking.',
        'Pure, clean and naturally crunchy.',
        'The Crunchy Heart',
        TRUE,
        TRUE,
        1
    ),
    (
        'p0000000-0000-0000-0000-000000000002',
        'c0000000-0000-0000-0000-000000000002',
        'Flavoured Makhana',
        'flavoured-makhana',
        'Crunchy makhana with delicious flavours for every mood.',
        'Bold flavours. Better snacking.',
        'The Crunchy Heart',
        TRUE,
        TRUE,
        2
    )
ON CONFLICT (slug) DO UPDATE
SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    short_description = EXCLUDED.short_description,
    is_active = TRUE,
    is_featured = TRUE,
    sort_order = EXCLUDED.sort_order;

-- 3. PRODUCT VARIANTS (RAW MAKHANA)
INSERT INTO product_variants (
    product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order
)
VALUES
    ('p0000000-0000-0000-0000-000000000001', 'TCH-RAW-100', '100g', 100, NULL, 249, 229, 120, 18, 'Trial Pack', 'sand', TRUE, 1),
    ('p0000000-0000-0000-0000-000000000001', 'TCH-RAW-200', '200g', 200, NULL, 449, 399, 220, 18, 'Everyday Pack', 'sand', TRUE, 2),
    ('p0000000-0000-0000-0000-000000000001', 'TCH-RAW-500', '500g', 500, NULL, 999, 899, 500, 18, 'Most Popular', 'sand', TRUE, 3),
    ('p0000000-0000-0000-0000-000000000001', 'TCH-RAW-1KG', '1kg', 1000, NULL, 1899, 1649, 950, 18, 'Value Pack', 'sand', TRUE, 4)
ON CONFLICT (sku) DO UPDATE
SET
    variant_name = EXCLUDED.variant_name,
    weight_grams = EXCLUDED.weight_grams,
    mrp = EXCLUDED.mrp,
    selling_price = EXCLUDED.selling_price,
    cost_price = EXCLUDED.cost_price,
    tax_rate = EXCLUDED.tax_rate,
    badge = EXCLUDED.badge,
    tone = EXCLUDED.tone,
    is_active = TRUE,
    sort_order = EXCLUDED.sort_order,
    updated_at = NOW();

-- 4. PRODUCT VARIANTS (FLAVOURED MAKHANA - 70g)
INSERT INTO product_variants (
    product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order
)
VALUES
    ('p0000000-0000-0000-0000-000000000002', 'TCH-FLV-HIMALAYAN', 'Himalayan Salt', 70, 'Himalayan Salt', 220, 199, 110, 18, 'Classic', 'himalayan', TRUE, 1),
    ('p0000000-0000-0000-0000-000000000002', 'TCH-FLV-PERI', 'Peri Peri', 70, 'Peri Peri', 220, 199, 110, 18, 'Spicy', 'peri', TRUE, 2),
    ('p0000000-0000-0000-0000-000000000002', 'TCH-FLV-PUDINA', 'Mint Pudina', 70, 'Mint Pudina', 220, 199, 110, 18, 'Refreshing', 'pudina', TRUE, 3),
    ('p0000000-0000-0000-0000-000000000002', 'TCH-FLV-ONION', 'Cream & Onion', 70, 'Cream & Onion', 220, 195, 110, 18, 'Savory', 'onion', TRUE, 4),
    ('p0000000-0000-0000-0000-000000000002', 'TCH-FLV-TOMATO', 'Tomato Tangy', 70, 'Tomato Tangy', 220, 199, 110, 18, 'Tangy', 'tomato', TRUE, 5),
    ('p0000000-0000-0000-0000-000000000002', 'TCH-FLV-CHILLI', 'Chilli Garlic', 70, 'Chilli Garlic', 220, 199, 110, 18, 'Zesty', 'chilli', TRUE, 6),
    ('p0000000-0000-0000-0000-000000000002', 'TCH-FLV-BIHARI', 'Bihari Chat', 70, 'Bihari Chat', 250, 229, 125, 18, 'Desi Spices', 'bihari', TRUE, 7),
    ('p0000000-0000-0000-0000-000000000002', 'TCH-FLV-CHEESE', 'Cheese & Herbs', 70, 'Cheese & Herbs', 220, 199, 110, 18, 'Chef Special', 'cheese', TRUE, 8)
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
    updated_at = NOW();

-- 5. INITIAL INVENTORY ROWS
-- Initializes stock on hand (100 units each) and sets reorder level to 15.
INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
SELECT
    pv.id,
    100,
    0,
    15
FROM product_variants pv
ON CONFLICT (variant_id) DO UPDATE
SET quantity_on_hand = GREATEST(inventory.quantity_on_hand, 100);

-- 6. STORE SETTINGS (Shipping & Tax)
INSERT INTO store_settings(setting_key, setting_value, description)
VALUES
    ('shipping', '{"free_shipping_threshold":499,"flat_shipping_amount":149,"currency":"INR"}'::jsonb, 'Free shipping at or above ₹499; ₹149 below ₹499.'),
    ('tax', '{"default_rate":18,"prices_include_tax":true,"currency":"INR"}'::jsonb, 'Website prices are GST-inclusive at 18%.'),
    ('checkout', '{"allow_cod":true,"allow_online_payment":true,"allow_coupon_stacking":false}'::jsonb, 'Customer checkout configuration.')
ON CONFLICT (setting_key) DO UPDATE
SET
    setting_value = EXCLUDED.setting_value,
    description = EXCLUDED.description,
    updated_at = NOW();

