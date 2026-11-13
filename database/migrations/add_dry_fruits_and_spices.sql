-- ==============================================================================
-- THE CRUNCHY HEART
-- Migration: Dry Fruits and Spices catalogue (categories, products, pack sizes, stock, images)
--
-- GENERATED FILE. Edit database/catalogue/catalogue_data.py and re-run
-- `python database/catalogue/build_sql.py` instead of editing this file by hand.
--
-- Safe to re-run: existing rows are left untouched (ON CONFLICT DO NOTHING), so prices, stock and
-- images edited in Admin > Products are never overwritten.
--
-- Notes
--   * Prices are per-kg rates pro-rated to each pack size. Rates marked "indicative" below were
--     added as placeholders; review every price in Admin > Products before launch.
--   * Opening stock is a placeholder. Set real quantities in Admin > Inventory / Products.
--   * GST is set to 5% on every variant. Confirm with your accountant.
-- ==============================================================================

BEGIN;

-- Tables used below already exist in schema.sql; these guards keep older databases working.
CREATE TABLE IF NOT EXISTS subcategories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name varchar(150) NOT NULL,
  slug varchar(180) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_subcategories_slug ON subcategories(slug);
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory_id uuid REFERENCES subcategories(id) ON DELETE SET NULL;

-- 1. Categories
INSERT INTO categories (name, slug, description, sort_order, is_active)
VALUES ('Dry Fruits', 'dry-fruits', 'Premium almonds, cashews, walnuts, raisins and more, sorted by grade and packed fresh.', 5, TRUE)
ON CONFLICT (slug) DO NOTHING;
INSERT INTO categories (name, slug, description, sort_order, is_active)
VALUES ('Spices', 'spices', 'Whole and ground spices, freshly packed to keep their aroma and flavour.', 6, TRUE)
ON CONFLICT (slug) DO NOTHING;

-- 2. Subcategories (product families)
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Almonds', 'almonds', 1, TRUE FROM categories WHERE slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Cashews', 'cashews', 2, TRUE FROM categories WHERE slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Walnuts', 'walnuts', 3, TRUE FROM categories WHERE slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Raisins (Kishmish)', 'raisins', 4, TRUE FROM categories WHERE slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Pistachios', 'pistachios', 5, TRUE FROM categories WHERE slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Dates & Figs', 'dates-and-figs', 6, TRUE FROM categories WHERE slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Dried Fruits & Seeds', 'dried-fruits-and-seeds', 7, TRUE FROM categories WHERE slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Whole Spices', 'whole-spices', 1, TRUE FROM categories WHERE slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Seeds & Herbs', 'seeds-and-herbs', 2, TRUE FROM categories WHERE slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
SELECT id, 'Ground Spices & Blends', 'ground-and-blends', 3, TRUE FROM categories WHERE slug = 'spices'
ON CONFLICT (slug) DO NOTHING;

-- 3. Products
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Premium Almond', 'premium-almond', 'Premium almonds with a crisp bite and a naturally sweet, buttery flavour. Sorted for size and packed fresh for snacking, baking and everyday cooking.', 'Crisp, naturally sweet almonds, sorted for size.', 'The Crunchy Heart', TRUE, TRUE, 110
FROM categories c JOIN subcategories sc ON sc.slug = 'almonds' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Gurbandi Almond', 'gurbandi-almond', 'Gurbandi almonds are small, dense and rich in natural oils, prized for their intense nutty taste. A favourite for sweets, thandai and daily nutrition.', 'Small, dense almonds with an intense nutty flavour.', 'The Crunchy Heart', FALSE, TRUE, 120
FROM categories c JOIN subcategories sc ON sc.slug = 'almonds' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Mamra Almond', 'mamra-almond', 'Mamra almonds are rare, oil-rich and deeply flavoured, often called the finest almonds of all. Best enjoyed on their own or soaked overnight.', 'Rare, oil-rich Mamra almonds. The finest of the family.', 'The Crunchy Heart', TRUE, TRUE, 130
FROM categories c JOIN subcategories sc ON sc.slug = 'almonds' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Cashew Small', 'cashew-small', 'Small, creamy cashews that are ideal for gravies, sweets and everyday cooking. Mildly sweet with a smooth, buttery crunch.', 'Small whole cashews. Great for cooking and gravies.', 'The Crunchy Heart', FALSE, TRUE, 140
FROM categories c JOIN subcategories sc ON sc.slug = 'cashews' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Cashew Medium', 'cashew-medium', 'Medium-sized whole cashews with a creamy texture. A versatile choice for snacking, sweets and festive cooking.', 'Medium whole cashews for snacking and sweets.', 'The Crunchy Heart', FALSE, TRUE, 150
FROM categories c JOIN subcategories sc ON sc.slug = 'cashews' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Cashew Large', 'cashew-large', 'Large, plump cashews with a rich, buttery flavour. Excellent roasted, in trail mixes or in gifting boxes.', 'Large, plump whole cashews.', 'The Crunchy Heart', FALSE, TRUE, 160
FROM categories c JOIN subcategories sc ON sc.slug = 'cashews' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Cashew Jumbo', 'cashew-jumbo', 'Jumbo cashews, the largest and most impressive grade. Creamy, sweet and beautifully whole, ideal for gifting and special occasions.', 'Our largest whole cashews. Perfect for gifting.', 'The Crunchy Heart', TRUE, TRUE, 170
FROM categories c JOIN subcategories sc ON sc.slug = 'cashews' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Walnut Chilean', 'walnut-chilean', 'Chilean walnut kernels are light in colour with a mild, slightly sweet flavour. Great for baking, salads, breakfast bowls and desserts.', 'Light, mild walnut kernels.', 'The Crunchy Heart', FALSE, TRUE, 180
FROM categories c JOIN subcategories sc ON sc.slug = 'walnuts' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Walnut Kashmiri', 'walnut-kashmiri', 'Kashmiri walnuts have a rich, earthy flavour and a naturally darker kernel. A traditional favourite for sweets, chutneys and everyday nutrition.', 'Rich, earthy Kashmiri walnuts.', 'The Crunchy Heart', FALSE, TRUE, 190
FROM categories c JOIN subcategories sc ON sc.slug = 'walnuts' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Kishmish Long', 'kishmish-long', 'Long green seedless raisins with a light, sweet-tart taste. Perfect for kheer, pulao, sweets and snacking.', 'Long, green seedless raisins.', 'The Crunchy Heart', FALSE, TRUE, 200
FROM categories c JOIN subcategories sc ON sc.slug = 'raisins' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Kishmish Kandhari', 'kishmish-kandhari', 'Kandhari raisins are plump, juicy and deeply sweet with a rich amber colour. A premium choice for desserts, festive dishes and gifting.', 'Plump, juicy Kandhari raisins.', 'The Crunchy Heart', TRUE, TRUE, 210
FROM categories c JOIN subcategories sc ON sc.slug = 'raisins' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Kishmish Indian', 'kishmish-indian', 'Golden Indian raisins with a soft bite and a honeyed sweetness. An easy everyday choice for cooking, baking and snacking.', 'Everyday golden Indian raisins.', 'The Crunchy Heart', FALSE, TRUE, 220
FROM categories c JOIN subcategories sc ON sc.slug = 'raisins' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Pistachio Roasted & Salted', 'pistachio-roasted-salted', 'Pistachios in the shell, lightly roasted and salted. A crunchy, savoury snack that is easy to share.', 'Lightly roasted, lightly salted pistachios.', 'The Crunchy Heart', FALSE, TRUE, 230
FROM categories c JOIN subcategories sc ON sc.slug = 'pistachios' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Pistachio Kernels', 'pistachio-kernels', 'Shelled, vibrant green pistachio kernels for desserts, kulfi, baking and garnishing.', 'Shelled green pistachio kernels.', 'The Crunchy Heart', FALSE, TRUE, 240
FROM categories c JOIN subcategories sc ON sc.slug = 'pistachios' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Anjeer (Dried Fig)', 'anjeer-dried-fig', 'Soft, chewy dried figs with a honeyed sweetness and a gentle seed crunch. Enjoy them as they are, soaked, or in desserts.', 'Soft, chewy dried figs.', 'The Crunchy Heart', FALSE, TRUE, 250
FROM categories c JOIN subcategories sc ON sc.slug = 'dates-and-figs' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Medjool Dates', 'medjool-dates', 'Large, soft Medjool dates with a caramel-like sweetness. A natural energy booster and a perfect dessert on their own.', 'Large, caramel-soft Medjool dates.', 'The Crunchy Heart', TRUE, TRUE, 260
FROM categories c JOIN subcategories sc ON sc.slug = 'dates-and-figs' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Khajur (Kimia Dates)', 'khajur-kimia', 'Soft, sweet everyday dates. A wholesome choice for snacking, shakes and sweets.', 'Everyday soft dates.', 'The Crunchy Heart', FALSE, TRUE, 270
FROM categories c JOIN subcategories sc ON sc.slug = 'dates-and-figs' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Apricot (Khubani)', 'apricot-khubani', 'Tangy-sweet dried apricots with a soft chew. Great in trail mixes, desserts and the classic khubani ka meetha.', 'Tangy-sweet dried apricots.', 'The Crunchy Heart', FALSE, TRUE, 280
FROM categories c JOIN subcategories sc ON sc.slug = 'dried-fruits-and-seeds' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Prunes (Dried Plum)', 'prunes-dried-plum', 'Soft, dark, naturally sweet dried plums. Rich in fibre and perfect for breakfast bowls and baking.', 'Soft, pitted dried plums.', 'The Crunchy Heart', FALSE, TRUE, 290
FROM categories c JOIN subcategories sc ON sc.slug = 'dried-fruits-and-seeds' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Dried Cranberry', 'dried-cranberry', 'Ruby red cranberries with a sweet-tart taste. Brighten up cereals, salads, cakes and trail mixes.', 'Sweet-tart dried cranberries.', 'The Crunchy Heart', FALSE, TRUE, 300
FROM categories c JOIN subcategories sc ON sc.slug = 'dried-fruits-and-seeds' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Pumpkin Seeds', 'pumpkin-seeds', 'Crunchy, nutrient-dense pumpkin seeds. Sprinkle on salads and smoothie bowls, or snack on them roasted.', 'Crunchy green pumpkin seeds.', 'The Crunchy Heart', FALSE, TRUE, 310
FROM categories c JOIN subcategories sc ON sc.slug = 'dried-fruits-and-seeds' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Sunflower Seeds', 'sunflower-seeds', 'Light, nutty sunflower seeds that add crunch to bakes, salads and breakfast bowls.', 'Light, nutty sunflower seeds.', 'The Crunchy Heart', FALSE, TRUE, 320
FROM categories c JOIN subcategories sc ON sc.slug = 'dried-fruits-and-seeds' AND sc.category_id = c.id
WHERE c.slug = 'dry-fruits'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Turmeric Powder (Haldi)', 'turmeric-powder', 'Finely ground turmeric with a vibrant golden colour and a warm, earthy aroma. An everyday essential for dals, curries and golden milk.', 'Bright golden turmeric with a warm, earthy aroma.', 'The Crunchy Heart', FALSE, TRUE, 330
FROM categories c JOIN subcategories sc ON sc.slug = 'ground-and-blends' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Kashmiri Red Chilli Powder', 'kashmiri-chilli-powder', 'Kashmiri red chilli powder gives dishes a rich red colour with gentle heat. Perfect for tandoori marinades, gravies and tadka.', 'Deep red colour with mild heat.', 'The Crunchy Heart', TRUE, TRUE, 340
FROM categories c JOIN subcategories sc ON sc.slug = 'ground-and-blends' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Coriander Powder (Dhania)', 'coriander-powder', 'Freshly ground coriander with a citrusy, slightly sweet fragrance. The backbone of countless curries and spice blends.', 'Fragrant, citrusy ground coriander.', 'The Crunchy Heart', FALSE, TRUE, 350
FROM categories c JOIN subcategories sc ON sc.slug = 'ground-and-blends' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Garam Masala', 'garam-masala', 'A balanced, aromatic blend of whole spices ground fresh. Add a pinch at the end of cooking for a warm, layered finish.', 'A warm, aromatic finishing blend.', 'The Crunchy Heart', FALSE, TRUE, 360
FROM categories c JOIN subcategories sc ON sc.slug = 'ground-and-blends' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Black Pepper (Kali Mirch)', 'black-pepper', 'Bold, pungent whole black peppercorns. Crack them fresh for the best aroma in curries, soups and marinades.', 'Bold, pungent whole peppercorns.', 'The Crunchy Heart', FALSE, TRUE, 370
FROM categories c JOIN subcategories sc ON sc.slug = 'whole-spices' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Green Cardamom (Elaichi)', 'green-cardamom', 'Aromatic green cardamom pods with a sweet, floral fragrance. A must for chai, kheer, biryani and festive sweets.', 'Fragrant green cardamom pods.', 'The Crunchy Heart', TRUE, TRUE, 380
FROM categories c JOIN subcategories sc ON sc.slug = 'whole-spices' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Black Cardamom (Badi Elaichi)', 'black-cardamom', 'Large, smoky black cardamom pods with a robust, earthy aroma. Ideal for slow-cooked meats, dals and rich gravies.', 'Smoky, robust black cardamom.', 'The Crunchy Heart', FALSE, TRUE, 390
FROM categories c JOIN subcategories sc ON sc.slug = 'whole-spices' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Cloves (Laung)', 'cloves', 'Intensely aromatic whole cloves with a warm, sweet-pungent flavour. Used in rice, masalas, chai and desserts.', 'Intensely aromatic whole cloves.', 'The Crunchy Heart', FALSE, TRUE, 400
FROM categories c JOIN subcategories sc ON sc.slug = 'whole-spices' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Cinnamon Sticks (Dalchini)', 'cinnamon-sticks', 'Fragrant cinnamon sticks with a sweet, woody warmth. Infuse in chai, biryani, curries and mulled drinks.', 'Sweet, woody cinnamon quills.', 'The Crunchy Heart', FALSE, TRUE, 410
FROM categories c JOIN subcategories sc ON sc.slug = 'whole-spices' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Star Anise (Chakra Phool)', 'star-anise', 'Beautiful star-shaped pods with a sweet licorice aroma. A key flavour in biryani, garam masala and spiced teas.', 'Star-shaped pods with a licorice note.', 'The Crunchy Heart', FALSE, TRUE, 420
FROM categories c JOIN subcategories sc ON sc.slug = 'whole-spices' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Cumin Seeds (Jeera)', 'cumin-seeds', 'Earthy, warm whole cumin seeds for tempering. Bloom them in hot ghee or oil to start almost any Indian dish.', 'Earthy, warm whole cumin seeds.', 'The Crunchy Heart', FALSE, TRUE, 430
FROM categories c JOIN subcategories sc ON sc.slug = 'seeds-and-herbs' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Fennel Seeds (Saunf)', 'fennel-seeds', 'Sweet, cooling fennel seeds with a gentle anise flavour. Enjoy as an after-meal freshener or add to curries and pickles.', 'Sweet, cooling fennel seeds.', 'The Crunchy Heart', FALSE, TRUE, 440
FROM categories c JOIN subcategories sc ON sc.slug = 'seeds-and-herbs' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Mustard Seeds (Rai)', 'mustard-seeds', 'Small, sharp mustard seeds that pop in hot oil and release a nutty, pungent flavour. Essential for tadka and pickles.', 'Sharp, nutty whole mustard seeds.', 'The Crunchy Heart', FALSE, TRUE, 450
FROM categories c JOIN subcategories sc ON sc.slug = 'seeds-and-herbs' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Fenugreek Seeds (Methi)', 'fenugreek-seeds', 'Golden fenugreek seeds with a pleasant bitter-sweet taste. Used in tempering, pickles and spice blends.', 'Bitter-sweet golden methi seeds.', 'The Crunchy Heart', FALSE, TRUE, 460
FROM categories c JOIN subcategories sc ON sc.slug = 'seeds-and-herbs' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Carom Seeds (Ajwain)', 'ajwain', 'Tiny, pungent carom seeds with a thyme-like aroma. A traditional digestive and a favourite in parathas and snacks.', 'Pungent, thyme-like carom seeds.', 'The Crunchy Heart', FALSE, TRUE, 470
FROM categories c JOIN subcategories sc ON sc.slug = 'seeds-and-herbs' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;
INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)
SELECT c.id, sc.id, 'Bay Leaf (Tej Patta)', 'bay-leaf', 'Aromatic dried bay leaves that add a subtle, savoury depth to rice, dals and slow-cooked dishes.', 'Aromatic dried bay leaves.', 'The Crunchy Heart', FALSE, TRUE, 480
FROM categories c JOIN subcategories sc ON sc.slug = 'seeds-and-herbs' AND sc.category_id = c.id
WHERE c.slug = 'spices'
ON CONFLICT (slug) DO NOTHING;

-- 4. Pack sizes (variants). Price = per-kg rate x weight, rounded to the nearest rupee.
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PREMIUMALMOND-250', '250g', 250, 0, 300, 0, 5, 'Bestseller', 'sand', TRUE, 1
FROM products WHERE slug = 'premium-almond'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PREMIUMALMOND-500', '500g', 500, 0, 600, 0, 5, 'Bestseller', 'sand', TRUE, 2
FROM products WHERE slug = 'premium-almond'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PREMIUMALMOND-1000', '1kg', 1000, 0, 1200, 0, 5, 'Bestseller', 'sand', TRUE, 3
FROM products WHERE slug = 'premium-almond'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-GURBANDIALMOND-250', '250g', 250, 0, 375, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'gurbandi-almond'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-GURBANDIALMOND-500', '500g', 500, 0, 750, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'gurbandi-almond'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-GURBANDIALMOND-1000', '1kg', 1000, 0, 1500, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'gurbandi-almond'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-MAMRAALMOND-250', '250g', 250, 0, 1200, 0, 5, 'Premium Pick', 'sand', TRUE, 1
FROM products WHERE slug = 'mamra-almond'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-MAMRAALMOND-500', '500g', 500, 0, 2400, 0, 5, 'Premium Pick', 'sand', TRUE, 2
FROM products WHERE slug = 'mamra-almond'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-MAMRAALMOND-1000', '1kg', 1000, 0, 4800, 0, 5, 'Premium Pick', 'sand', TRUE, 3
FROM products WHERE slug = 'mamra-almond'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWSMALL-250', '250g', 250, 0, 350, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'cashew-small'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWSMALL-500', '500g', 500, 0, 700, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'cashew-small'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWSMALL-1000', '1kg', 1000, 0, 1400, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'cashew-small'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWMEDIUM-250', '250g', 250, 0, 400, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'cashew-medium'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWMEDIUM-500', '500g', 500, 0, 800, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'cashew-medium'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWMEDIUM-1000', '1kg', 1000, 0, 1600, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'cashew-medium'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWLARGE-250', '250g', 250, 0, 450, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'cashew-large'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWLARGE-500', '500g', 500, 0, 900, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'cashew-large'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWLARGE-1000', '1kg', 1000, 0, 1800, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'cashew-large'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWJUMBO-250', '250g', 250, 0, 475, 0, 5, 'Jumbo', 'sand', TRUE, 1
FROM products WHERE slug = 'cashew-jumbo'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWJUMBO-500', '500g', 500, 0, 950, 0, 5, 'Jumbo', 'sand', TRUE, 2
FROM products WHERE slug = 'cashew-jumbo'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-CASHEWJUMBO-1000', '1kg', 1000, 0, 1900, 0, 5, 'Jumbo', 'sand', TRUE, 3
FROM products WHERE slug = 'cashew-jumbo'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-WALNUTCHILEAN-250', '250g', 250, 0, 600, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'walnut-chilean'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-WALNUTCHILEAN-500', '500g', 500, 0, 1200, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'walnut-chilean'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-WALNUTCHILEAN-1000', '1kg', 1000, 0, 2400, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'walnut-chilean'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-WALNUTKASHMIRI-250', '250g', 250, 0, 400, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'walnut-kashmiri'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-WALNUTKASHMIRI-500', '500g', 500, 0, 800, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'walnut-kashmiri'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-WALNUTKASHMIRI-1000', '1kg', 1000, 0, 1600, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'walnut-kashmiri'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KISHMISHLONG-250', '250g', 250, 0, 238, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'kishmish-long'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KISHMISHLONG-500', '500g', 500, 0, 475, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'kishmish-long'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KISHMISHLONG-1000', '1kg', 1000, 0, 950, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'kishmish-long'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KISHMISHKANDHA-250', '250g', 250, 0, 450, 0, 5, 'Premium Pick', 'sand', TRUE, 1
FROM products WHERE slug = 'kishmish-kandhari'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KISHMISHKANDHA-500', '500g', 500, 0, 900, 0, 5, 'Premium Pick', 'sand', TRUE, 2
FROM products WHERE slug = 'kishmish-kandhari'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KISHMISHKANDHA-1000', '1kg', 1000, 0, 1800, 0, 5, 'Premium Pick', 'sand', TRUE, 3
FROM products WHERE slug = 'kishmish-kandhari'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KISHMISHINDIAN-250', '250g', 250, 0, 213, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'kishmish-indian'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KISHMISHINDIAN-500', '500g', 500, 0, 425, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'kishmish-indian'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KISHMISHINDIAN-1000', '1kg', 1000, 0, 850, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'kishmish-indian'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PISTACHIOROAST-250', '250g', 250, 0, 550, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'pistachio-roasted-salted'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PISTACHIOROAST-500', '500g', 500, 0, 1100, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'pistachio-roasted-salted'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PISTACHIOROAST-1000', '1kg', 1000, 0, 2200, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'pistachio-roasted-salted'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PISTACHIOKERNE-250', '250g', 250, 0, 700, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'pistachio-kernels'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PISTACHIOKERNE-500', '500g', 500, 0, 1400, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'pistachio-kernels'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PISTACHIOKERNE-1000', '1kg', 1000, 0, 2800, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'pistachio-kernels'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-ANJEERDRIEDFIG-250', '250g', 250, 0, 450, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'anjeer-dried-fig'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-ANJEERDRIEDFIG-500', '500g', 500, 0, 900, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'anjeer-dried-fig'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-ANJEERDRIEDFIG-1000', '1kg', 1000, 0, 1800, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'anjeer-dried-fig'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-MEDJOOLDATES-250', '250g', 250, 0, 375, 0, 5, 'Premium Pick', 'sand', TRUE, 1
FROM products WHERE slug = 'medjool-dates'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-MEDJOOLDATES-500', '500g', 500, 0, 750, 0, 5, 'Premium Pick', 'sand', TRUE, 2
FROM products WHERE slug = 'medjool-dates'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-MEDJOOLDATES-1000', '1kg', 1000, 0, 1500, 0, 5, 'Premium Pick', 'sand', TRUE, 3
FROM products WHERE slug = 'medjool-dates'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KHAJURKIMIA-250', '250g', 250, 0, 125, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'khajur-kimia'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KHAJURKIMIA-500', '500g', 500, 0, 250, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'khajur-kimia'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-KHAJURKIMIA-1000', '1kg', 1000, 0, 500, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'khajur-kimia'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-APRICOTKHUBANI-250', '250g', 250, 0, 225, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'apricot-khubani'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-APRICOTKHUBANI-500', '500g', 500, 0, 450, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'apricot-khubani'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-APRICOTKHUBANI-1000', '1kg', 1000, 0, 900, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'apricot-khubani'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PRUNESDRIEDPLU-250', '250g', 250, 0, 275, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'prunes-dried-plum'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PRUNESDRIEDPLU-500', '500g', 500, 0, 550, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'prunes-dried-plum'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PRUNESDRIEDPLU-1000', '1kg', 1000, 0, 1100, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'prunes-dried-plum'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-DRIEDCRANBERRY-250', '250g', 250, 0, 275, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'dried-cranberry'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-DRIEDCRANBERRY-500', '500g', 500, 0, 550, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'dried-cranberry'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-DRIEDCRANBERRY-1000', '1kg', 1000, 0, 1100, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'dried-cranberry'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PUMPKINSEEDS-250', '250g', 250, 0, 200, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'pumpkin-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PUMPKINSEEDS-500', '500g', 500, 0, 400, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'pumpkin-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-PUMPKINSEEDS-1000', '1kg', 1000, 0, 800, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'pumpkin-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-SUNFLOWERSEEDS-250', '250g', 250, 0, 125, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'sunflower-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-SUNFLOWERSEEDS-500', '500g', 500, 0, 250, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'sunflower-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-DF-SUNFLOWERSEEDS-1000', '1kg', 1000, 0, 500, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'sunflower-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-TURMERICPOWDER-100', '100g', 100, 0, 32, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'turmeric-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-TURMERICPOWDER-250', '250g', 250, 0, 80, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'turmeric-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-TURMERICPOWDER-500', '500g', 500, 0, 160, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'turmeric-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-TURMERICPOWDER-1000', '1kg', 1000, 0, 320, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'turmeric-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-KASHMIRICHILLI-100', '100g', 100, 0, 75, 0, 5, 'Bestseller', 'sand', TRUE, 1
FROM products WHERE slug = 'kashmiri-chilli-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-KASHMIRICHILLI-250', '250g', 250, 0, 188, 0, 5, 'Bestseller', 'sand', TRUE, 2
FROM products WHERE slug = 'kashmiri-chilli-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-KASHMIRICHILLI-500', '500g', 500, 0, 375, 0, 5, 'Bestseller', 'sand', TRUE, 3
FROM products WHERE slug = 'kashmiri-chilli-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-KASHMIRICHILLI-1000', '1kg', 1000, 0, 750, 0, 5, 'Bestseller', 'sand', TRUE, 4
FROM products WHERE slug = 'kashmiri-chilli-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CORIANDERPOWDE-100', '100g', 100, 0, 28, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'coriander-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CORIANDERPOWDE-250', '250g', 250, 0, 70, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'coriander-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CORIANDERPOWDE-500', '500g', 500, 0, 140, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'coriander-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CORIANDERPOWDE-1000', '1kg', 1000, 0, 280, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'coriander-powder'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-GARAMMASALA-100', '100g', 100, 0, 95, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'garam-masala'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-GARAMMASALA-250', '250g', 250, 0, 238, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'garam-masala'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-GARAMMASALA-500', '500g', 500, 0, 475, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'garam-masala'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-GARAMMASALA-1000', '1kg', 1000, 0, 950, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'garam-masala'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BLACKPEPPER-100', '100g', 100, 0, 95, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'black-pepper'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BLACKPEPPER-250', '250g', 250, 0, 238, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'black-pepper'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BLACKPEPPER-500', '500g', 500, 0, 475, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'black-pepper'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BLACKPEPPER-1000', '1kg', 1000, 0, 950, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'black-pepper'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-GREENCARDAMOM-100', '100g', 100, 0, 320, 0, 5, 'Premium Pick', 'sand', TRUE, 1
FROM products WHERE slug = 'green-cardamom'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-GREENCARDAMOM-250', '250g', 250, 0, 800, 0, 5, 'Premium Pick', 'sand', TRUE, 2
FROM products WHERE slug = 'green-cardamom'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-GREENCARDAMOM-500', '500g', 500, 0, 1600, 0, 5, 'Premium Pick', 'sand', TRUE, 3
FROM products WHERE slug = 'green-cardamom'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-GREENCARDAMOM-1000', '1kg', 1000, 0, 3200, 0, 5, 'Premium Pick', 'sand', TRUE, 4
FROM products WHERE slug = 'green-cardamom'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BLACKCARDAMOM-100', '100g', 100, 0, 220, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'black-cardamom'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BLACKCARDAMOM-250', '250g', 250, 0, 550, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'black-cardamom'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BLACKCARDAMOM-500', '500g', 500, 0, 1100, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'black-cardamom'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BLACKCARDAMOM-1000', '1kg', 1000, 0, 2200, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'black-cardamom'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CLOVES-100', '100g', 100, 0, 170, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'cloves'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CLOVES-250', '250g', 250, 0, 425, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'cloves'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CLOVES-500', '500g', 500, 0, 850, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'cloves'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CLOVES-1000', '1kg', 1000, 0, 1700, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'cloves'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CINNAMONSTICKS-100', '100g', 100, 0, 75, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'cinnamon-sticks'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CINNAMONSTICKS-250', '250g', 250, 0, 188, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'cinnamon-sticks'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CINNAMONSTICKS-500', '500g', 500, 0, 375, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'cinnamon-sticks'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CINNAMONSTICKS-1000', '1kg', 1000, 0, 750, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'cinnamon-sticks'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-STARANISE-100', '100g', 100, 0, 150, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'star-anise'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-STARANISE-250', '250g', 250, 0, 375, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'star-anise'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-STARANISE-500', '500g', 500, 0, 750, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'star-anise'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-STARANISE-1000', '1kg', 1000, 0, 1500, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'star-anise'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CUMINSEEDS-100', '100g', 100, 0, 52, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'cumin-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CUMINSEEDS-250', '250g', 250, 0, 130, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'cumin-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CUMINSEEDS-500', '500g', 500, 0, 260, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'cumin-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-CUMINSEEDS-1000', '1kg', 1000, 0, 520, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'cumin-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-FENNELSEEDS-100', '100g', 100, 0, 48, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'fennel-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-FENNELSEEDS-250', '250g', 250, 0, 120, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'fennel-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-FENNELSEEDS-500', '500g', 500, 0, 240, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'fennel-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-FENNELSEEDS-1000', '1kg', 1000, 0, 480, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'fennel-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-MUSTARDSEEDS-100', '100g', 100, 0, 18, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'mustard-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-MUSTARDSEEDS-250', '250g', 250, 0, 45, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'mustard-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-MUSTARDSEEDS-500', '500g', 500, 0, 90, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'mustard-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-MUSTARDSEEDS-1000', '1kg', 1000, 0, 180, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'mustard-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-FENUGREEKSEEDS-100', '100g', 100, 0, 20, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'fenugreek-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-FENUGREEKSEEDS-250', '250g', 250, 0, 50, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'fenugreek-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-FENUGREEKSEEDS-500', '500g', 500, 0, 100, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'fenugreek-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-FENUGREEKSEEDS-1000', '1kg', 1000, 0, 200, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'fenugreek-seeds'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-AJWAIN-100', '100g', 100, 0, 45, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'ajwain'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-AJWAIN-250', '250g', 250, 0, 113, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'ajwain'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-AJWAIN-500', '500g', 500, 0, 225, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'ajwain'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-AJWAIN-1000', '1kg', 1000, 0, 450, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'ajwain'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BAYLEAF-100', '100g', 100, 0, 28, 0, 5, NULL, 'sand', TRUE, 1
FROM products WHERE slug = 'bay-leaf'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BAYLEAF-250', '250g', 250, 0, 70, 0, 5, NULL, 'sand', TRUE, 2
FROM products WHERE slug = 'bay-leaf'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BAYLEAF-500', '500g', 500, 0, 140, 0, 5, NULL, 'sand', TRUE, 3
FROM products WHERE slug = 'bay-leaf'
ON CONFLICT (sku) DO NOTHING;
INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)
SELECT id, 'TCH-SP-BAYLEAF-1000', '1kg', 1000, 0, 280, 0, 5, NULL, 'sand', TRUE, 4
FROM products WHERE slug = 'bay-leaf'
ON CONFLICT (sku) DO NOTHING;

-- 5. Opening stock (20 per pack size: placeholder, update in the admin panel)
INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
SELECT id, 20, 0, 5 FROM product_variants WHERE sku IN ('TCH-DF-ANJEERDRIEDFIG-1000', 'TCH-DF-ANJEERDRIEDFIG-250', 'TCH-DF-ANJEERDRIEDFIG-500', 'TCH-DF-APRICOTKHUBANI-1000', 'TCH-DF-APRICOTKHUBANI-250', 'TCH-DF-APRICOTKHUBANI-500', 'TCH-DF-CASHEWJUMBO-1000', 'TCH-DF-CASHEWJUMBO-250', 'TCH-DF-CASHEWJUMBO-500', 'TCH-DF-CASHEWLARGE-1000', 'TCH-DF-CASHEWLARGE-250', 'TCH-DF-CASHEWLARGE-500', 'TCH-DF-CASHEWMEDIUM-1000', 'TCH-DF-CASHEWMEDIUM-250', 'TCH-DF-CASHEWMEDIUM-500', 'TCH-DF-CASHEWSMALL-1000', 'TCH-DF-CASHEWSMALL-250', 'TCH-DF-CASHEWSMALL-500', 'TCH-DF-DRIEDCRANBERRY-1000', 'TCH-DF-DRIEDCRANBERRY-250', 'TCH-DF-DRIEDCRANBERRY-500', 'TCH-DF-GURBANDIALMOND-1000', 'TCH-DF-GURBANDIALMOND-250', 'TCH-DF-GURBANDIALMOND-500', 'TCH-DF-KHAJURKIMIA-1000', 'TCH-DF-KHAJURKIMIA-250', 'TCH-DF-KHAJURKIMIA-500', 'TCH-DF-KISHMISHINDIAN-1000', 'TCH-DF-KISHMISHINDIAN-250', 'TCH-DF-KISHMISHINDIAN-500', 'TCH-DF-KISHMISHKANDHA-1000', 'TCH-DF-KISHMISHKANDHA-250', 'TCH-DF-KISHMISHKANDHA-500', 'TCH-DF-KISHMISHLONG-1000', 'TCH-DF-KISHMISHLONG-250', 'TCH-DF-KISHMISHLONG-500', 'TCH-DF-MAMRAALMOND-1000', 'TCH-DF-MAMRAALMOND-250', 'TCH-DF-MAMRAALMOND-500', 'TCH-DF-MEDJOOLDATES-1000', 'TCH-DF-MEDJOOLDATES-250', 'TCH-DF-MEDJOOLDATES-500', 'TCH-DF-PISTACHIOKERNE-1000', 'TCH-DF-PISTACHIOKERNE-250', 'TCH-DF-PISTACHIOKERNE-500', 'TCH-DF-PISTACHIOROAST-1000', 'TCH-DF-PISTACHIOROAST-250', 'TCH-DF-PISTACHIOROAST-500', 'TCH-DF-PREMIUMALMOND-1000', 'TCH-DF-PREMIUMALMOND-250', 'TCH-DF-PREMIUMALMOND-500', 'TCH-DF-PRUNESDRIEDPLU-1000', 'TCH-DF-PRUNESDRIEDPLU-250', 'TCH-DF-PRUNESDRIEDPLU-500', 'TCH-DF-PUMPKINSEEDS-1000', 'TCH-DF-PUMPKINSEEDS-250', 'TCH-DF-PUMPKINSEEDS-500', 'TCH-DF-SUNFLOWERSEEDS-1000', 'TCH-DF-SUNFLOWERSEEDS-250', 'TCH-DF-SUNFLOWERSEEDS-500', 'TCH-DF-WALNUTCHILEAN-1000', 'TCH-DF-WALNUTCHILEAN-250', 'TCH-DF-WALNUTCHILEAN-500', 'TCH-DF-WALNUTKASHMIRI-1000', 'TCH-DF-WALNUTKASHMIRI-250', 'TCH-DF-WALNUTKASHMIRI-500', 'TCH-SP-AJWAIN-100', 'TCH-SP-AJWAIN-1000', 'TCH-SP-AJWAIN-250', 'TCH-SP-AJWAIN-500', 'TCH-SP-BAYLEAF-100', 'TCH-SP-BAYLEAF-1000', 'TCH-SP-BAYLEAF-250', 'TCH-SP-BAYLEAF-500', 'TCH-SP-BLACKCARDAMOM-100', 'TCH-SP-BLACKCARDAMOM-1000', 'TCH-SP-BLACKCARDAMOM-250', 'TCH-SP-BLACKCARDAMOM-500', 'TCH-SP-BLACKPEPPER-100', 'TCH-SP-BLACKPEPPER-1000', 'TCH-SP-BLACKPEPPER-250', 'TCH-SP-BLACKPEPPER-500', 'TCH-SP-CINNAMONSTICKS-100', 'TCH-SP-CINNAMONSTICKS-1000', 'TCH-SP-CINNAMONSTICKS-250', 'TCH-SP-CINNAMONSTICKS-500', 'TCH-SP-CLOVES-100', 'TCH-SP-CLOVES-1000', 'TCH-SP-CLOVES-250', 'TCH-SP-CLOVES-500', 'TCH-SP-CORIANDERPOWDE-100', 'TCH-SP-CORIANDERPOWDE-1000', 'TCH-SP-CORIANDERPOWDE-250', 'TCH-SP-CORIANDERPOWDE-500', 'TCH-SP-CUMINSEEDS-100', 'TCH-SP-CUMINSEEDS-1000', 'TCH-SP-CUMINSEEDS-250', 'TCH-SP-CUMINSEEDS-500', 'TCH-SP-FENNELSEEDS-100', 'TCH-SP-FENNELSEEDS-1000', 'TCH-SP-FENNELSEEDS-250', 'TCH-SP-FENNELSEEDS-500', 'TCH-SP-FENUGREEKSEEDS-100', 'TCH-SP-FENUGREEKSEEDS-1000', 'TCH-SP-FENUGREEKSEEDS-250', 'TCH-SP-FENUGREEKSEEDS-500', 'TCH-SP-GARAMMASALA-100', 'TCH-SP-GARAMMASALA-1000', 'TCH-SP-GARAMMASALA-250', 'TCH-SP-GARAMMASALA-500', 'TCH-SP-GREENCARDAMOM-100', 'TCH-SP-GREENCARDAMOM-1000', 'TCH-SP-GREENCARDAMOM-250', 'TCH-SP-GREENCARDAMOM-500', 'TCH-SP-KASHMIRICHILLI-100', 'TCH-SP-KASHMIRICHILLI-1000', 'TCH-SP-KASHMIRICHILLI-250', 'TCH-SP-KASHMIRICHILLI-500', 'TCH-SP-MUSTARDSEEDS-100', 'TCH-SP-MUSTARDSEEDS-1000', 'TCH-SP-MUSTARDSEEDS-250', 'TCH-SP-MUSTARDSEEDS-500', 'TCH-SP-STARANISE-100', 'TCH-SP-STARANISE-1000', 'TCH-SP-STARANISE-250', 'TCH-SP-STARANISE-500', 'TCH-SP-TURMERICPOWDER-100', 'TCH-SP-TURMERICPOWDER-1000', 'TCH-SP-TURMERICPOWDER-250', 'TCH-SP-TURMERICPOWDER-500')
ON CONFLICT (variant_id) DO NOTHING;

-- 6. Product images (served from the storefront's assets folder; editable in the admin panel)
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/premium-almond.webp', 'Premium Almond by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'premium-almond'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/gurbandi-almond.webp', 'Gurbandi Almond by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'gurbandi-almond'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/mamra-almond.webp', 'Mamra Almond by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'mamra-almond'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/cashew-small.webp', 'Cashew Small by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'cashew-small'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/cashew-medium.webp', 'Cashew Medium by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'cashew-medium'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/cashew-large.webp', 'Cashew Large by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'cashew-large'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/cashew-jumbo.webp', 'Cashew Jumbo by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'cashew-jumbo'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/walnut-chilean.webp', 'Walnut Chilean by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'walnut-chilean'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/walnut-kashmiri.webp', 'Walnut Kashmiri by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'walnut-kashmiri'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/kishmish-long.webp', 'Kishmish Long by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'kishmish-long'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/kishmish-kandhari.webp', 'Kishmish Kandhari by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'kishmish-kandhari'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/kishmish-indian.webp', 'Kishmish Indian by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'kishmish-indian'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/pistachio-roasted-salted.webp', 'Pistachio Roasted & Salted by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'pistachio-roasted-salted'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/pistachio-kernels.webp', 'Pistachio Kernels by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'pistachio-kernels'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/anjeer-dried-fig.webp', 'Anjeer (Dried Fig) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'anjeer-dried-fig'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/medjool-dates.webp', 'Medjool Dates by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'medjool-dates'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/khajur-kimia.webp', 'Khajur (Kimia Dates) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'khajur-kimia'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/apricot-khubani.webp', 'Apricot (Khubani) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'apricot-khubani'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/prunes-dried-plum.webp', 'Prunes (Dried Plum) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'prunes-dried-plum'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/dried-cranberry.webp', 'Dried Cranberry by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'dried-cranberry'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/pumpkin-seeds.webp', 'Pumpkin Seeds by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'pumpkin-seeds'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/sunflower-seeds.webp', 'Sunflower Seeds by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'sunflower-seeds'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/turmeric-powder.webp', 'Turmeric Powder (Haldi) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'turmeric-powder'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/kashmiri-chilli-powder.webp', 'Kashmiri Red Chilli Powder by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'kashmiri-chilli-powder'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/coriander-powder.webp', 'Coriander Powder (Dhania) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'coriander-powder'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/garam-masala.webp', 'Garam Masala by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'garam-masala'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/black-pepper.webp', 'Black Pepper (Kali Mirch) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'black-pepper'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/green-cardamom.webp', 'Green Cardamom (Elaichi) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'green-cardamom'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/black-cardamom.webp', 'Black Cardamom (Badi Elaichi) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'black-cardamom'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/cloves.webp', 'Cloves (Laung) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'cloves'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/cinnamon-sticks.webp', 'Cinnamon Sticks (Dalchini) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'cinnamon-sticks'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/star-anise.webp', 'Star Anise (Chakra Phool) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'star-anise'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/cumin-seeds.webp', 'Cumin Seeds (Jeera) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'cumin-seeds'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/fennel-seeds.webp', 'Fennel Seeds (Saunf) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'fennel-seeds'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/mustard-seeds.webp', 'Mustard Seeds (Rai) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'mustard-seeds'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/fenugreek-seeds.webp', 'Fenugreek Seeds (Methi) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'fenugreek-seeds'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/ajwain.webp', 'Carom Seeds (Ajwain) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'ajwain'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);
INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
SELECT id, 'assets/products/bay-leaf.webp', 'Bay Leaf (Tej Patta) by The Crunchy Heart', 'product', 0, TRUE
FROM products WHERE slug = 'bay-leaf'
AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);

-- Rate card (per kg) for reference
--   Premium Almond                     Rs  1200/kg   [owner]
--   Gurbandi Almond                    Rs  1500/kg   [owner]
--   Mamra Almond                       Rs  4800/kg   [owner]
--   Cashew Small                       Rs  1400/kg   [owner]
--   Cashew Medium                      Rs  1600/kg   [owner]
--   Cashew Large                       Rs  1800/kg   [owner]
--   Cashew Jumbo                       Rs  1900/kg   [owner]
--   Walnut Chilean                     Rs  2400/kg   [owner]
--   Walnut Kashmiri                    Rs  1600/kg   [owner]
--   Kishmish Long                      Rs   950/kg   [owner]
--   Kishmish Kandhari                  Rs  1800/kg   [owner]
--   Kishmish Indian                    Rs   850/kg   [owner]
--   Pistachio Roasted & Salted         Rs  2200/kg   [indicative]
--   Pistachio Kernels                  Rs  2800/kg   [indicative]
--   Anjeer (Dried Fig)                 Rs  1800/kg   [indicative]
--   Medjool Dates                      Rs  1500/kg   [indicative]
--   Khajur (Kimia Dates)               Rs   500/kg   [indicative]
--   Apricot (Khubani)                  Rs   900/kg   [indicative]
--   Prunes (Dried Plum)                Rs  1100/kg   [indicative]
--   Dried Cranberry                    Rs  1100/kg   [indicative]
--   Pumpkin Seeds                      Rs   800/kg   [indicative]
--   Sunflower Seeds                    Rs   500/kg   [indicative]
--   Turmeric Powder (Haldi)            Rs   320/kg   [indicative]
--   Kashmiri Red Chilli Powder         Rs   750/kg   [indicative]
--   Coriander Powder (Dhania)          Rs   280/kg   [indicative]
--   Garam Masala                       Rs   950/kg   [indicative]
--   Black Pepper (Kali Mirch)          Rs   950/kg   [indicative]
--   Green Cardamom (Elaichi)           Rs  3200/kg   [indicative]
--   Black Cardamom (Badi Elaichi)      Rs  2200/kg   [indicative]
--   Cloves (Laung)                     Rs  1700/kg   [indicative]
--   Cinnamon Sticks (Dalchini)         Rs   750/kg   [indicative]
--   Star Anise (Chakra Phool)          Rs  1500/kg   [indicative]
--   Cumin Seeds (Jeera)                Rs   520/kg   [indicative]
--   Fennel Seeds (Saunf)               Rs   480/kg   [indicative]
--   Mustard Seeds (Rai)                Rs   180/kg   [indicative]
--   Fenugreek Seeds (Methi)            Rs   200/kg   [indicative]
--   Carom Seeds (Ajwain)               Rs   450/kg   [indicative]
--   Bay Leaf (Tej Patta)               Rs   280/kg   [indicative]

COMMIT;
