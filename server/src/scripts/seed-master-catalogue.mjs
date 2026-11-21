/**
 * THE CRUNCHY HEART — Master Product Catalogue Ingestion Script
 *
 * Implements Phase 1 & 2 Master Catalogue Expansion:
 * 1. Ensures 010 schema migration columns and tables exist.
 * 2. Ingests master categories 01 to 10 (with slug conflict protection).
 * 3. Ingests subcategories.
 * 4. Adds new products with deterministic SKUs, pack sizes, and default attributes.
 * 5. Strictly protects the 42 existing products and their active retail pricing.
 * 6. Records private supplier benchmark rates in supplier_price_history and cost_price without touching selling_price.
 * 7. Enforces quarantine publication_status = 'draft' for Category 08 (Healthy Snacks & Mixes).
 *
 * Safe and idempotent to run multiple times.
 */

import { pool, query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';

// -----------------------------------------------------------------------------
// 1. Master Categories Definition
// -----------------------------------------------------------------------------
const MASTER_CATEGORIES = [
    { name: 'Raw Makhana', slug: 'raw-makhana', description: 'Pure, naturally harvested Mithila fox nuts sorted by grade.', sortOrder: 1, isActive: true },
    { name: 'Flavoured Makhana', slug: 'flavoured-makhana', description: 'Artisanal slow-roasted makhana with signature spices.', sortOrder: 2, isActive: true },
    { name: 'Dry Fruits & Nuts', slug: 'dry-fruits', description: 'Hand-picked almonds, cashews, walnuts, raisins and exotic dried fruits.', sortOrder: 3, isActive: true },
    { name: 'Seeds & Superfoods', slug: 'seeds-and-superfoods', description: 'Nutrient-dense raw and roasted seeds for daily vitality.', sortOrder: 4, isActive: true },
    { name: 'Whole Spices', slug: 'whole-spices', description: 'Aromatic whole spices hand-selected from heritage origins.', sortOrder: 5, isActive: true },
    { name: 'Ground Spices', slug: 'ground-spices', description: 'Pure single-origin ground spices with intense natural aroma.', sortOrder: 6, isActive: true },
    { name: 'Blended Masalas', slug: 'blended-masalas', description: 'Traditional recipe-crafted Indian spice blends without fillers.', sortOrder: 7, isActive: true },
    { name: 'Grains & Millets', slug: 'grains-and-millets', description: 'Ancient Indian super grains, heritage rice and unpolished millets.', sortOrder: 8, isActive: true },
    { name: 'Healthy Snacks & Mixes', slug: 'healthy-snacks', description: 'Nutritious roasted snacks, trail mixes, and energizing nibbles.', sortOrder: 9, isActive: false }, // Quarantined draft
    { name: 'Gifting & Hampers', slug: 'gifting-and-hampers', description: 'Curated royal pantry gift boxes and bespoke festive hampers.', sortOrder: 10, isActive: true },
    { name: 'Bulk & Wholesale', slug: 'bulk-and-wholesale', description: 'B2B supply bags for foodservice, sweetmakers and distributors.', sortOrder: 11, isActive: true },
];

// -----------------------------------------------------------------------------
// 2. Subcategories Definition
// -----------------------------------------------------------------------------
const MASTER_SUBCATEGORIES = [
    // Dry Fruits
    { categorySlug: 'dry-fruits', slug: 'almonds', name: 'Almonds', sortOrder: 1 },
    { categorySlug: 'dry-fruits', slug: 'cashews', name: 'Cashews', sortOrder: 2 },
    { categorySlug: 'dry-fruits', slug: 'walnuts', name: 'Walnuts', sortOrder: 3 },
    { categorySlug: 'dry-fruits', slug: 'raisins', name: 'Raisins (Kishmish)', sortOrder: 4 },
    { categorySlug: 'dry-fruits', slug: 'pistachios', name: 'Pistachios', sortOrder: 5 },
    { categorySlug: 'dry-fruits', slug: 'dates-and-figs', name: 'Dates & Figs', sortOrder: 6 },
    { categorySlug: 'dry-fruits', slug: 'exotic-nuts-berries', name: 'Exotic Nuts & Berries', sortOrder: 7 },

    // Seeds & Superfoods
    { categorySlug: 'seeds-and-superfoods', slug: 'single-seeds', name: 'Single Seeds', sortOrder: 1 },
    { categorySlug: 'seeds-and-superfoods', slug: 'seed-mixes', name: 'Seed Mixes', sortOrder: 2 },
    { categorySlug: 'seeds-and-superfoods', slug: 'superfood-grains', name: 'Superfood Grains', sortOrder: 3 },

    // Whole Spices
    { categorySlug: 'whole-spices', slug: 'whole-chillies', name: 'Whole Chillies', sortOrder: 1 },
    { categorySlug: 'whole-spices', slug: 'peppercorns-cardamom', name: 'Cardamom & Peppercorns', sortOrder: 2 },
    { categorySlug: 'whole-spices', slug: 'seeds-herbs', name: 'Seeds & Herbs', sortOrder: 3 },
    { categorySlug: 'whole-spices', slug: 'cinnamon-cloves-bark', name: 'Cinnamon & Cloves', sortOrder: 4 },

    // Ground Spices
    { categorySlug: 'ground-spices', slug: 'chilli-powders', name: 'Chilli Powders', sortOrder: 1 },
    { categorySlug: 'ground-spices', slug: 'turmeric-powders', name: 'Turmeric Powders', sortOrder: 2 },
    { categorySlug: 'ground-spices', slug: 'core-ground-spices', name: 'Core Ground Spices', sortOrder: 3 },

    // Blended Masalas
    { categorySlug: 'blended-masalas', slug: 'everyday-blends', name: 'Everyday Kitchen Blends', sortOrder: 1 },
    { categorySlug: 'blended-masalas', slug: 'festive-rich-blends', name: 'Festive & Rich Blends', sortOrder: 2 },

    // Grains & Millets
    { categorySlug: 'grains-and-millets', slug: 'heritage-millets', name: 'Heritage Millets', sortOrder: 1 },
    { categorySlug: 'grains-and-millets', slug: 'unpolished-rice', name: 'Unpolished & Heritage Rice', sortOrder: 2 },

    // Healthy Snacks (Draft)
    { categorySlug: 'healthy-snacks', slug: 'roasted-trail-mixes', name: 'Roasted Trail Mixes', sortOrder: 1 },

    // Gifting
    { categorySlug: 'gifting-and-hampers', slug: 'festive-gift-boxes', name: 'Festive Gift Boxes', sortOrder: 1 },
    { categorySlug: 'gifting-and-hampers', slug: 'corporate-hampers', name: 'Corporate Hampers', sortOrder: 2 },

    // Bulk
    { categorySlug: 'bulk-and-wholesale', slug: 'bulk-makhana', name: 'Bulk Makhana Bags', sortOrder: 1 },
    { categorySlug: 'bulk-and-wholesale', slug: 'wholesale-dry-fruits', name: 'Wholesale Dry Fruits', sortOrder: 2 },
];

// -----------------------------------------------------------------------------
// 3. New Expansion Products & Pack Sizes
// -----------------------------------------------------------------------------
const EXPANSION_PRODUCTS = [
    // --- CATEGORY 02: DRY FRUITS (Additions not currently in DB) ---
    {
        categorySlug: 'dry-fruits',
        subcategorySlug: 'almonds',
        slug: 'regular-almond',
        name: 'Regular California Almond',
        shortDescription: 'Everyday crisp California almonds, fresh and sweet.',
        description: 'Selected everyday California almonds with balanced crunch and natural sweetness. Ideal for daily breakfast and culinary use.',
        supplierRatePerKg: 350,
        mrpPerKg: 1000,
        sellingRatePerKg: 850,
        hsnCode: '08021200',
        packSizes: [
            { weight: 250, skuSuffix: '250G', name: '250g Pouch' },
            { weight: 500, skuSuffix: '500G', name: '500g Everyday Pack' },
            { weight: 1000, skuSuffix: '1KG', name: '1kg Value Pack' },
        ],
        skuPrefix: 'TCH-ALM-REG',
        publicationStatus: 'active',
    },
    {
        categorySlug: 'dry-fruits',
        subcategorySlug: 'walnuts',
        slug: 'whole-in-shell-walnut',
        name: 'Whole In-Shell Kashmiri Walnut',
        shortDescription: 'Uncracked organic Kashmiri walnuts packed in shell.',
        description: 'Sun-dried paper-shell Kashmiri walnuts preserved in their natural protective hard shell. Fresh, rich in natural omega-3 oils.',
        supplierRatePerKg: 500,
        mrpPerKg: 1100,
        sellingRatePerKg: 900,
        hsnCode: '08023100',
        packSizes: [
            { weight: 500, skuSuffix: '500G', name: '500g Mesh Bag' },
            { weight: 1000, skuSuffix: '1KG', name: '1kg Jute Sack' },
        ],
        skuPrefix: 'TCH-WAL-SHELL',
        publicationStatus: 'active',
    },
    {
        categorySlug: 'dry-fruits',
        subcategorySlug: 'dates-and-figs',
        slug: 'royal-medjool-dates',
        name: 'Royal Medjool Dates',
        shortDescription: 'Large, soft, caramel-sweet king of dates.',
        description: 'Jumbo Medjool dates imported fresh with tender, melt-in-mouth flesh and natural caramel notes. 100% natural, no added glucose or sugar.',
        supplierRatePerKg: 650,
        mrpPerKg: 1600,
        sellingRatePerKg: 1350,
        hsnCode: '08041020',
        packSizes: [
            { weight: 250, skuSuffix: '250G', name: '250g Gift Box' },
            { weight: 500, skuSuffix: '500G', name: '500g Fresh Pack' },
            { weight: 1000, skuSuffix: '1KG', name: '1kg Royal Box' },
        ],
        skuPrefix: 'TCH-DAT-MEDJ',
        publicationStatus: 'active',
    },

    // --- CATEGORY 03: SEEDS & SUPERFOODS ---
    {
        categorySlug: 'seeds-and-superfoods',
        subcategorySlug: 'single-seeds',
        slug: 'flax-seeds-raw',
        name: 'Raw Brown Flax Seeds (Alsi)',
        shortDescription: 'Golden brown flax seeds rich in dietary fiber & Omega-3.',
        description: 'Sortex-cleaned raw brown flax seeds sourced from Rajasthan. Great for roasting, adding to warm rotis, or blending into morning smoothies.',
        supplierRatePerKg: 95,
        mrpPerKg: 350,
        sellingRatePerKg: 280,
        hsnCode: '12040090',
        packSizes: [
            { weight: 250, skuSuffix: '250G', name: '250g Pouch' },
            { weight: 500, skuSuffix: '500G', name: '500g Jar Pack' },
        ],
        skuPrefix: 'TCH-SED-FLAX',
        publicationStatus: 'active',
    },
    {
        categorySlug: 'seeds-and-superfoods',
        subcategorySlug: 'single-seeds',
        slug: 'chia-seeds-raw',
        name: 'Raw Black Chia Seeds',
        shortDescription: 'Premium organic whole black chia seeds.',
        description: 'Micro-farmed clean black chia seeds. Packed with hydrophilic soluble fiber, calcium, and plant proteins.',
        supplierRatePerKg: 220,
        mrpPerKg: 650,
        sellingRatePerKg: 520,
        hsnCode: '12079990',
        packSizes: [
            { weight: 250, skuSuffix: '250G', name: '250g Pouch' },
            { weight: 500, skuSuffix: '500G', name: '500g Resealable Jar' },
        ],
        skuPrefix: 'TCH-SED-CHIA',
        publicationStatus: 'active',
    },
    {
        categorySlug: 'seeds-and-superfoods',
        subcategorySlug: 'single-seeds',
        slug: 'sweet-basil-seeds-sabja',
        name: 'Sweet Basil Seeds (Sabja)',
        shortDescription: 'Cooling Tukmaria / Sabja seeds for falooda & drinks.',
        description: 'Naturally cooling edible sweet basil seeds with fast gelatinous bloom. Ideal for summer lemonades, falooda, and gut health.',
        supplierRatePerKg: 180,
        mrpPerKg: 550,
        sellingRatePerKg: 440,
        hsnCode: '12079990',
        packSizes: [
            { weight: 200, skuSuffix: '200G', name: '200g Pouch' },
            { weight: 500, skuSuffix: '500G', name: '500g Pack' },
        ],
        skuPrefix: 'TCH-SED-SABJA',
        publicationStatus: 'active',
    },
    {
        categorySlug: 'seeds-and-superfoods',
        subcategorySlug: 'seed-mixes',
        slug: 'daily-nutrition-seven-seed-mix',
        name: 'Daily 7-Seed Superfood Mix',
        shortDescription: 'Roasted mix of Pumpkin, Sunflower, Flax, Chia, Watermelon, Sesame & Muskmelon.',
        description: 'Lightly roasted, unsalted artisanal mix of 7 power seeds. Perfect daily crunch for yogurts, breakfast bowls, and salads.',
        supplierRatePerKg: 380,
        mrpPerKg: 850,
        sellingRatePerKg: 699,
        hsnCode: '20081990',
        packSizes: [
            { weight: 250, skuSuffix: '250G', name: '250g Pouch' },
            { weight: 500, skuSuffix: '500G', name: '500g Table Jar' },
        ],
        skuPrefix: 'TCH-SED-7MIX',
        publicationStatus: 'active',
    },

    // --- CATEGORY 04: WHOLE SPICES ---
    {
        categorySlug: 'whole-spices',
        subcategorySlug: 'whole-chillies',
        slug: 'byadgi-chilli-whole',
        name: 'Byadgi Red Chilli (Dabbi)',
        shortDescription: 'Deep crimson Karnataka whole chilli with mild heat.',
        description: 'Authentic Byadgi Dabbi chillies from Haveri, Karnataka. Celebrated for rich natural deep red oil release with gentle, pleasant warmth.',
        supplierRatePerKg: 280,
        mrpPerKg: 750,
        sellingRatePerKg: 580,
        hsnCode: '09042110',
        packSizes: [
            { weight: 100, skuSuffix: '100G', name: '100g Pouch' },
            { weight: 250, skuSuffix: '250G', name: '250g Pouch' },
        ],
        skuPrefix: 'TCH-CHL-BYD-WHL',
        publicationStatus: 'active',
    },
    {
        categorySlug: 'whole-spices',
        subcategorySlug: 'peppercorns-cardamom',
        slug: 'malabar-black-peppercorns-bold',
        name: 'Malabar Bold Black Peppercorns',
        shortDescription: 'Grade 1 Tellicherry / Malabar large black peppercorns.',
        description: 'Harvested from high-altitude estates of Wayanad and Idukki. High piperine, sharp citrus notes, and warm lingering pungency.',
        supplierRatePerKg: 480,
        mrpPerKg: 1200,
        sellingRatePerKg: 950,
        hsnCode: '09041130',
        packSizes: [
            { weight: 100, skuSuffix: '100G', name: '100g Spice Jar' },
            { weight: 250, skuSuffix: '250G', name: '250g Pouch' },
        ],
        skuPrefix: 'TCH-PEP-MAL-WHL',
        publicationStatus: 'active',
    },
    {
        categorySlug: 'whole-spices',
        subcategorySlug: 'peppercorns-cardamom',
        slug: 'green-cardamom-bold-8mm',
        name: 'Idukki Bold Green Cardamom (8mm+)',
        shortDescription: 'Plump emerald green cardamom pods bursting with sweet aroma.',
        description: 'Hand-graded Jumbo 8mm+ green cardamom pods from the Cardamom Hills of Kerala. Dense volatile oil content and intoxicating perfume.',
        supplierRatePerKg: 2200,
        mrpPerKg: 4800,
        sellingRatePerKg: 3900,
        hsnCode: '09083110',
        packSizes: [
            { weight: 50, skuSuffix: '50G', name: '50g Glass Jar' },
            { weight: 100, skuSuffix: '100G', name: '100g Pouch' },
            { weight: 250, skuSuffix: '250G', name: '250g Aroma Lock Pack' },
        ],
        skuPrefix: 'TCH-CRD-GRN-8MM',
        publicationStatus: 'active',
    },

    // --- CATEGORY 05: GROUND SPICES ---
    {
        categorySlug: 'ground-spices',
        subcategorySlug: 'turmeric-powders',
        slug: 'lakadong-turmeric-powder',
        name: 'Meghalaya Lakadong Turmeric Powder (7%+ Curcumin)',
        shortDescription: 'World renowned high-curcumin single-origin golden haldi.',
        description: 'Cultivated in Jaintia Hills, Meghalaya. Lab-verified 7% to 9% natural curcumin content, earthy warmth, and luminous deep golden pigment.',
        supplierRatePerKg: 240,
        mrpPerKg: 700,
        sellingRatePerKg: 550,
        hsnCode: '09103030',
        packSizes: [
            { weight: 100, skuSuffix: '100G', name: '100g Tin' },
            { weight: 250, skuSuffix: '250G', name: '250g Pouch' },
            { weight: 500, skuSuffix: '500G', name: '500g Kitchen Pack' },
        ],
        skuPrefix: 'TCH-TUR-LAK-PWD',
        publicationStatus: 'active',
    },

    // --- CATEGORY 06: BLENDED MASALAS ---
    {
        categorySlug: 'blended-masalas',
        subcategorySlug: 'everyday-blends',
        slug: 'royal-kitchen-king-masala',
        name: 'Royal Kitchen King Masala',
        shortDescription: 'Master all-purpose curry blend of 20 whole spices.',
        description: 'The crowning jewel of the Indian home kitchen. Slow stone-ground cardamom, mace, cinnamon, cumin, and coriander balanced for rich, restaurant-style gravies.',
        supplierRatePerKg: 350,
        mrpPerKg: 900,
        sellingRatePerKg: 720,
        hsnCode: '09109100',
        packSizes: [
            { weight: 100, skuSuffix: '100G', name: '100g Box' },
            { weight: 250, skuSuffix: '250G', name: '250g Resealable Pack' },
        ],
        skuPrefix: 'TCH-MSL-KITCHEN',
        publicationStatus: 'active',
    },
    {
        categorySlug: 'blended-masalas',
        subcategorySlug: 'everyday-blends',
        slug: 'mumbai-pav-bhaji-masala',
        name: 'Artisanal Mumbai Pav Bhaji Masala',
        shortDescription: 'Street-style zesty spice blend with amchur, star anise & stone flower.',
        description: 'Recreates the legendary Chowpatty aroma. Stone-pounded dry mango, star anise, black cardamom, and Kashmiri chillies.',
        supplierRatePerKg: 320,
        mrpPerKg: 850,
        sellingRatePerKg: 680,
        hsnCode: '09109100',
        packSizes: [
            { weight: 100, skuSuffix: '100G', name: '100g Box' },
            { weight: 250, skuSuffix: '250G', name: '250g Pouch' },
        ],
        skuPrefix: 'TCH-MSL-PAV',
        publicationStatus: 'active',
    },

    // --- CATEGORY 07: GRAINS & MILLETS ---
    {
        categorySlug: 'grains-and-millets',
        subcategorySlug: 'heritage-millets',
        slug: 'foxtail-millet-unpolished',
        name: 'Unpolished Foxtail Millet (Kangni)',
        shortDescription: 'Low-GI, iron-rich whole ancient grain millet.',
        description: 'Naturally grown unpolished Foxtail millet sourced from smallholder farmers in Karnataka and Andhra. Rich in low glycemic index complex carbs.',
        supplierRatePerKg: 65,
        mrpPerKg: 250,
        sellingRatePerKg: 195,
        hsnCode: '10082900',
        packSizes: [
            { weight: 500, skuSuffix: '500G', name: '500g Pouch' },
            { weight: 1000, skuSuffix: '1KG', name: '1kg Value Bag' },
        ],
        skuPrefix: 'TCH-GRN-FOX',
        publicationStatus: 'active',
    },
    {
        categorySlug: 'grains-and-millets',
        subcategorySlug: 'superfood-grains',
        slug: 'royal-white-quinoa',
        name: 'Royal Indian White Quinoa (Saponin-Free)',
        shortDescription: 'Complete plant protein whole quinoa grains.',
        description: 'Pre-washed, bitter saponin-free white quinoa grown in Rajasthan. Fluffy texture, gluten-free, with all 9 essential amino acids.',
        supplierRatePerKg: 120,
        mrpPerKg: 450,
        sellingRatePerKg: 360,
        hsnCode: '10085000',
        packSizes: [
            { weight: 500, skuSuffix: '500G', name: '500g Jar Pack' },
            { weight: 1000, skuSuffix: '1KG', name: '1kg Pack' },
        ],
        skuPrefix: 'TCH-GRN-QUIN',
        publicationStatus: 'active',
    },

    // --- CATEGORY 08: HEALTHY SNACKS (Quarantined in Draft) ---
    {
        categorySlug: 'healthy-snacks',
        subcategorySlug: 'roasted-trail-mixes',
        slug: 'royal-superfood-trail-mix',
        name: 'Royal Superfood Trail Mix (Quarantined)',
        shortDescription: 'Roasted almonds, berries, pumpkin seeds and makhana bites.',
        description: 'Energy-dense snacking blend awaiting final nutritional lab certification and packaging verification.',
        supplierRatePerKg: 450,
        mrpPerKg: 950,
        sellingRatePerKg: 799,
        hsnCode: '20081990',
        packSizes: [
            { weight: 200, skuSuffix: '200G', name: '200g Pouch' },
        ],
        skuPrefix: 'TCH-SNK-TRAIL',
        publicationStatus: 'draft', // Stays in draft
    },

    // --- CATEGORY 09: GIFTING & HAMPERS ---
    {
        categorySlug: 'gifting-and-hampers',
        subcategorySlug: 'festive-gift-boxes',
        slug: 'heritage-mithila-royal-pantry-box',
        name: 'Heritage Mithila Royal Pantry Box',
        shortDescription: 'Luxury hardbound keepsake gift box with 4 dry fruits & 2 makhana jars.',
        description: 'Presented in deep forest green and gold embossed bespoke box. Includes 7S Mithila Makhana, Mamra Almonds, Jumbo Cashews, Kashmiri Walnuts, and Saffron.',
        supplierRatePerKg: 900,
        mrpPerKg: 2800,
        sellingRatePerKg: 2299,
        hsnCode: '21069099',
        packSizes: [
            { weight: 800, skuSuffix: '800G', name: 'Royal Keepsake Hamper' },
        ],
        skuPrefix: 'TCH-GFT-HERITAGE',
        publicationStatus: 'active',
    },
];

// -----------------------------------------------------------------------------
// 4. Migration & Ingestion Engine
// -----------------------------------------------------------------------------
export async function seedMasterCatalogue() {
    console.log('[INFO] Starting Master Catalogue Expansion Ingestion...');

    return withTransaction(async (client) => {
        // Step 1: Ensure additive columns and tables
        await client.query(`
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

            ALTER TABLE products 
                ADD COLUMN IF NOT EXISTS subcategory_id uuid REFERENCES subcategories(id) ON DELETE SET NULL,
                ADD COLUMN IF NOT EXISTS variety varchar(100),
                ADD COLUMN IF NOT EXISTS grade varchar(100),
                ADD COLUMN IF NOT EXISTS origin varchar(150),
                ADD COLUMN IF NOT EXISTS product_form varchar(50) DEFAULT 'standard',
                ADD COLUMN IF NOT EXISTS heat_level varchar(50),
                ADD COLUMN IF NOT EXISTS ingredients text,
                ADD COLUMN IF NOT EXISTS allergen_info text,
                ADD COLUMN IF NOT EXISTS storage_instructions text,
                ADD COLUMN IF NOT EXISTS fssai_license_number varchar(32),
                ADD COLUMN IF NOT EXISTS shelf_life_days integer DEFAULT 180,
                ADD COLUMN IF NOT EXISTS publication_status varchar(30) NOT NULL DEFAULT 'active';

            ALTER TABLE product_variants
                ADD COLUMN IF NOT EXISTS hsn_code varchar(16) DEFAULT '19041090',
                ADD COLUMN IF NOT EXISTS barcode_gtin varchar(32),
                ADD COLUMN IF NOT EXISTS batch_number varchar(64),
                ADD COLUMN IF NOT EXISTS pack_type varchar(50) DEFAULT 'pouch';

            CREATE TABLE IF NOT EXISTS suppliers (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                name varchar(200) NOT NULL,
                contact_person varchar(150),
                phone varchar(32),
                email varchar(150),
                city varchar(100),
                state varchar(100),
                gstin varchar(32),
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS supplier_price_history (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
                supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
                rate numeric(12, 2) NOT NULL,
                unit varchar(32) NOT NULL DEFAULT 'kg',
                is_pending_confirmation boolean NOT NULL DEFAULT true,
                notes text,
                effective_date date NOT NULL DEFAULT CURRENT_DATE,
                created_at timestamptz NOT NULL DEFAULT now()
            );
        `);

        // Step 2: Seed default procurement supplier
        const supplierRes = await client.query(`
            INSERT INTO suppliers (name, contact_person, city, state, is_active)
            VALUES ('The Crunchy Heart Heritage Procurement', 'Pantry Sourcing Desk', 'Darbhanga', 'Bihar', true)
            ON CONFLICT DO NOTHING
            RETURNING id;
        `);

        let defaultSupplierId = supplierRes.rows[0]?.id;
        if (!defaultSupplierId) {
            const s = await client.query(`SELECT id FROM suppliers LIMIT 1;`);
            defaultSupplierId = s.rows[0]?.id;
        }

        // Step 3: Upsert Categories
        for (const cat of MASTER_CATEGORIES) {
            await client.query(`
                INSERT INTO categories (name, slug, description, sort_order, is_active)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (slug) DO UPDATE
                SET description = COALESCE(categories.description, EXCLUDED.description),
                    sort_order = EXCLUDED.sort_order;
            `, [cat.name, cat.slug, cat.description, cat.sortOrder, cat.isActive]);
        }

        // Step 4: Upsert Subcategories
        for (const sub of MASTER_SUBCATEGORIES) {
            await client.query(`
                INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)
                SELECT id, $2, $3, $4, true
                FROM categories WHERE slug = $1
                ON CONFLICT (slug) DO UPDATE
                SET name = EXCLUDED.name,
                    sort_order = EXCLUDED.sort_order;
            `, [sub.categorySlug, sub.name, sub.slug, sub.sortOrder]);
        }

        // Step 5: Ingest New Products & Variants
        let newProductCount = 0;
        let newVariantCount = 0;

        for (const p of EXPANSION_PRODUCTS) {
            // Check if product already exists (by slug)
            let prodRow = await client.query(`SELECT id FROM products WHERE slug = $1;`, [p.slug]);
            let productId = prodRow.rows[0]?.id;

            if (!productId) {
                // Insert Product
                const insertProdRes = await client.query(`
                    INSERT INTO products (
                        category_id, subcategory_id, name, slug, description, short_description,
                        brand, is_featured, is_active, publication_status
                    )
                    SELECT 
                        c.id, 
                        sc.id, 
                        $3, $4, $5, $6,
                        'The Crunchy Heart', false, 
                        CASE WHEN $7 = 'draft' THEN false ELSE true END, 
                        $7
                    FROM categories c
                    LEFT JOIN subcategories sc ON sc.slug = $2 AND sc.category_id = c.id
                    WHERE c.slug = $1
                    RETURNING id;
                `, [p.categorySlug, p.subcategorySlug, p.name, p.slug, p.description, p.shortDescription, p.publicationStatus]);

                productId = insertProdRes.rows[0]?.id;
                newProductCount++;
            }

            if (!productId) continue;

            // Ingest Variants for this product
            for (const pack of p.packSizes) {
                const sku = `${p.skuPrefix}-${pack.skuSuffix}`;
                const weightGrams = pack.weight;

                // Calculate pro-rated MRP and Selling Price
                const factor = weightGrams / 1000;
                const sellingPrice = Math.round(p.sellingRatePerKg * factor);
                const mrp = Math.max(sellingPrice, Math.round(p.mrpPerKg * factor));
                const costPrice = Math.round(p.supplierRatePerKg * factor);

                const variantInsertRes = await client.query(`
                    INSERT INTO product_variants (
                        product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price,
                        tax_rate, hsn_code, is_active
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, 5.00, $8, true)
                    ON CONFLICT (sku) DO NOTHING
                    RETURNING id;
                `, [productId, sku, pack.name, weightGrams, mrp, sellingPrice, costPrice, p.hsnCode]);

                const variantId = variantInsertRes.rows[0]?.id;

                if (variantId) {
                    newVariantCount++;

                    // Create baseline inventory record
                    await client.query(`
                        INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
                        VALUES ($1, 25, 0, 5)
                        ON CONFLICT (variant_id) DO NOTHING;
                    `, [variantId]);

                    // Record benchmark supplier price history
                    if (defaultSupplierId) {
                        await client.query(`
                            INSERT INTO supplier_price_history (
                                variant_id, supplier_id, rate, unit, is_pending_confirmation, notes
                            )
                            VALUES ($1, $2, $3, 'kg', true, 'Phase 1-2 Master Catalogue Expansion Benchmark');
                        `, [variantId, defaultSupplierId, p.supplierRatePerKg]);
                    }
                }
            }
        }

        console.log(`[SUCCESS] Master Catalogue Expansion completed.`);
        console.log(`[STATS] Ingested ${newProductCount} new products, ${newVariantCount} new variants with inventory and supplier cost benchmarks.`);

        return {
            success: true,
            newProductCount,
            newVariantCount,
        };
    });
}

// Auto-run if executed directly
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) {
    seedMasterCatalogue()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('[FATAL] Failed to seed master catalogue:', err);
            process.exit(1);
        });
}
