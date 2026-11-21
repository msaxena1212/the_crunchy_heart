-- Attach an image to every product that has none. Idempotent: skips products that already have a primary image.
-- Illustrated images are drawn by database/catalogue/build_missing_images.py; replace any from Admin > Products.
BEGIN;
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/regular-almond.webp', 'Regular California Almond by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'regular-almond'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/royal-medjool-dates.webp', 'Royal Medjool Dates by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'royal-medjool-dates'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/whole-in-shell-walnut.webp', 'Whole In-Shell Kashmiri Walnut by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'whole-in-shell-walnut'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/daily-nutrition-seven-seed-mix.webp', 'Daily 7-Seed Superfood Mix by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'daily-nutrition-seven-seed-mix'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/chia-seeds-raw.webp', 'Raw Black Chia Seeds by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'chia-seeds-raw'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/flax-seeds-raw.webp', 'Raw Brown Flax Seeds (Alsi) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'flax-seeds-raw'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/sweet-basil-seeds-sabja.webp', 'Sweet Basil Seeds (Sabja) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'sweet-basil-seeds-sabja'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/royal-white-quinoa.webp', 'Royal Indian White Quinoa (Saponin-Free) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'royal-white-quinoa'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/foxtail-millet-unpolished.webp', 'Unpolished Foxtail Millet (Kangni) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'foxtail-millet-unpolished'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/byadgi-chilli-whole.webp', 'Byadgi Red Chilli (Dabbi) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'byadgi-chilli-whole'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/green-cardamom-bold-8mm.webp', 'Idukki Bold Green Cardamom (8mm+) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'green-cardamom-bold-8mm'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/malabar-black-peppercorns-bold.webp', 'Malabar Bold Black Peppercorns by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'malabar-black-peppercorns-bold'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/lakadong-turmeric-powder.webp', 'Meghalaya Lakadong Turmeric Powder (7%+ Curcumin) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'lakadong-turmeric-powder'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/mumbai-pav-bhaji-masala.webp', 'Artisanal Mumbai Pav Bhaji Masala by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'mumbai-pav-bhaji-masala'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/royal-kitchen-king-masala.webp', 'Royal Kitchen King Masala by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'royal-kitchen-king-masala'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/royal-superfood-trail-mix.webp', 'Royal Superfood Trail Mix by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'royal-superfood-trail-mix'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/festive-discovery-box.webp', 'The Crunch Box — Festive Gift Set by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'festive-discovery-box'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/heritage-mithila-royal-pantry-box.webp', 'Heritage Mithila Royal Pantry Box by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'heritage-mithila-royal-pantry-box'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/raw-makhana-500g.webp', 'Raw Makhana by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'raw-makhana'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/bulk-makhana.webp', 'Direct-from-Origin Bulk Raw Makhana by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'bulk-raw-makhana'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/himalayan-salt.webp', 'Flavoured Makhana by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'flavoured-makhana'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
COMMIT;
