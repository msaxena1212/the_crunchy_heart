-- ============================================================
-- THE CRUNCHY HEART
-- Initial catalogue, pricing and opening stock
-- ============================================================

INSERT INTO categories (name, slug, description, sort_order)
VALUES
    ('Raw Makhana', 'raw-makhana', 'Pure, natural makhana for everyday snacking.', 1),
    ('Flavoured Makhana', 'flavoured-makhana', 'Bold flavours with the signature makhana crunch.', 2)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO products (category_id, name, slug, description, short_description, is_active, is_featured, sort_order)
SELECT c.id, v.name, v.slug, v.description, v.short_description, TRUE, TRUE, v.sort_order
FROM (
    VALUES
        ('raw-makhana', 'Raw Makhana', 'raw-makhana',
         'Premium raw makhana, carefully selected and packed for everyday snacking.',
         'Pure, clean and naturally crunchy.', 1),
        ('flavoured-makhana', 'Flavoured Makhana', 'flavoured-makhana',
         'Crunchy makhana with delicious flavours for every mood.',
         'Bold flavours. Better snacking.', 2)
) AS v(category_slug, name, slug, description, short_description, sort_order)
INNER JOIN categories c ON c.slug = v.category_slug
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- RAW VARIANTS
-- ============================================================

INSERT INTO product_variants
    (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, badge, tone, sort_order)
SELECT p.id, v.sku, v.variant_name, v.weight_grams, 0, v.price, 0, v.badge, 'sand', v.sort_order
FROM products p
CROSS JOIN (
    VALUES
        ('TCH-RAW-100', '100g', 100, 229, 'Trial Pack', 1),
        ('TCH-RAW-200', '200g', 200, 399, 'Everyday Pack', 2),
        ('TCH-RAW-500', '500g', 500, 899, 'Most Popular', 3),
        ('TCH-RAW-1KG', '1kg', 1000, 1649, 'Value Pack', 4)
) AS v(sku, variant_name, weight_grams, price, badge, sort_order)
WHERE p.slug = 'raw-makhana'
ON CONFLICT (sku) DO NOTHING;

-- ============================================================
-- FLAVOURED VARIANTS
-- ============================================================

INSERT INTO product_variants
    (product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, badge, tone, sort_order)
SELECT p.id, v.sku, v.variant_name, 70, v.variant_name, 0, v.price, 0, v.badge, v.tone, v.sort_order
FROM products p
CROSS JOIN (
    VALUES
        ('TCH-FLV-HIMALAYAN', 'Himalayan Salt', 199, NULL, 'rose', 1),
        ('TCH-FLV-PERI', 'Peri Peri', 199, 'Best Seller', 'orange', 2),
        ('TCH-FLV-PUDINA', 'Mint Pudina', 199, NULL, 'green', 3),
        ('TCH-FLV-ONION', 'Cream & Onion', 195, NULL, 'gold', 4),
        ('TCH-FLV-TOMATO', 'Tomato Tangy', 199, NULL, 'tomato', 5),
        ('TCH-FLV-CHILLI', 'Chilli Garlic', 199, NULL, 'chilli', 6),
        ('TCH-FLV-BIHARI', 'Bihari Chat', 229, NULL, 'bihari', 7)
) AS v(sku, variant_name, price, badge, tone, sort_order)
WHERE p.slug = 'flavoured-makhana'
ON CONFLICT (sku) DO NOTHING;

-- ============================================================
-- OPENING STOCK
-- Adjust quantity_on_hand in the inventory table as real stock changes.
-- ============================================================

INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
SELECT pv.id, 100, 0, 10
FROM product_variants pv
ON CONFLICT (variant_id) DO NOTHING;
