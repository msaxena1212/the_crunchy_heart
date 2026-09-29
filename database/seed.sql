-- ============================================================
-- THE CRUNCHY HEART
-- Initial Catalog Seed
-- Prices are intentionally NULL/0 until commercial pricing is finalized.
-- ============================================================

INSERT INTO categories (name, slug, description, sort_order)
VALUES
    ('Raw Makhana', 'raw-makhana', 'Pure, natural makhana for everyday snacking.', 1),
    ('Flavoured Makhana', 'flavoured-makhana', 'Bold flavours with the signature makhana crunch.', 2)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO products (
    category_id,
    name,
    slug,
    description,
    short_description,
    is_active,
    is_featured,
    sort_order
)
SELECT
    c.id,
    'Raw Makhana',
    'raw-makhana',
    'Premium raw makhana, carefully selected and packed for everyday snacking.',
    'Pure, clean and naturally crunchy.',
    TRUE,
    TRUE,
    1
FROM categories c
WHERE c.slug = 'raw-makhana'
  AND NOT EXISTS (
      SELECT 1 FROM products WHERE slug = 'raw-makhana'
  );

INSERT INTO products (
    category_id,
    name,
    slug,
    description,
    short_description,
    is_active,
    is_featured,
    sort_order
)
SELECT
    c.id,
    'Flavoured Makhana',
    'flavoured-makhana',
    'Crunchy makhana with delicious flavours for every mood.',
    'Bold flavours. Better snacking.',
    TRUE,
    TRUE,
    2
FROM categories c
WHERE c.slug = 'flavoured-makhana'
  AND NOT EXISTS (
      SELECT 1 FROM products WHERE slug = 'flavoured-makhana'
  );

-- ============================================================
-- RAW VARIANTS
-- ============================================================

INSERT INTO product_variants
    (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, badge, tone, sort_order)
SELECT
    p.id,
    v.sku,
    v.variant_name,
    v.weight_grams,
    0,
    0,
    0,
    v.badge,
    'sand',
    v.sort_order
FROM products p
CROSS JOIN (
    VALUES
        ('TCH-RAW-100', '100g', 100, 'Trial Pack', 1),
        ('TCH-RAW-200', '200g', 200, 'Everyday Pack', 2),
        ('TCH-RAW-500', '500g', 500, 'Most Popular', 3),
        ('TCH-RAW-1KG', '1kg', 1000, 'Value Pack', 4)
) AS v(sku, variant_name, weight_grams, badge, sort_order)
WHERE p.slug = 'raw-makhana'
  AND NOT EXISTS (
      SELECT 1 FROM product_variants pv WHERE pv.sku = v.sku
  );

-- ============================================================
-- FLAVOURED VARIANTS
-- ============================================================

INSERT INTO product_variants
    (product_id, sku, variant_name, weight_grams, flavor, mrp, selling_price, cost_price, badge, tone, sort_order)
SELECT
    p.id,
    v.sku,
    v.variant_name,
    70,
    v.flavor,
    0,
    0,
    0,
    v.badge,
    v.tone,
    v.sort_order
FROM products p
CROSS JOIN (
    VALUES
        ('TCH-FLV-HIMALAYAN', 'Himalayan Salt', 'Himalayan Salt', '', 'rose', 1),
        ('TCH-FLV-PERI', 'Peri Peri', 'Peri Peri', 'Best Seller', 'orange', 2),
        ('TCH-FLV-PUDINA', 'Pudina', 'Pudina', '', 'green', 3),
        ('TCH-FLV-ONION', 'Cream & Onion', 'Cream & Onion', '', 'gold', 4)
) AS v(sku, variant_name, flavor, badge, tone, sort_order)
WHERE p.slug = 'flavoured-makhana'
  AND NOT EXISTS (
      SELECT 1 FROM product_variants pv WHERE pv.sku = v.sku
  );

-- ============================================================
-- INITIAL INVENTORY RECORDS
-- ============================================================

INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
SELECT
    pv.id,
    0,
    0,
    10
FROM product_variants pv
WHERE NOT EXISTS (
    SELECT 1
    FROM inventory i
    WHERE i.variant_id = pv.id
);

-- ============================================================
-- END
-- ============================================================
