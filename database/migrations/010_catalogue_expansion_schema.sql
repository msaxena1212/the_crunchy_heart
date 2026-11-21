-- ==============================================================================
-- THE CRUNCHY HEART
-- Migration 010: Catalogue Expansion Schema (Additive Domain Model Extensions)
--
-- Strictly additive and non-destructive.
-- 1. Creates `subcategories` table if not already present.
-- 2. Adds metadata columns to `products` (variety, grade, origin, form, heat level, FSSAI, publication status).
-- 3. Adds SKU attributes to `product_variants` (hsn_code, barcode_gtin, batch_number, pack_type).
-- 4. Creates isolated procurement tables: `suppliers` and `supplier_price_history`.
-- ==============================================================================

BEGIN;

-- 1. Subcategories table
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
CREATE INDEX IF NOT EXISTS idx_subcategories_category ON subcategories(category_id, sort_order);

-- 2. Additive columns to products
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

CREATE INDEX IF NOT EXISTS idx_products_publication_status ON products(publication_status);
CREATE INDEX IF NOT EXISTS idx_products_subcategory ON products(subcategory_id);

-- 3. Additive columns to product_variants
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS hsn_code varchar(16) DEFAULT '19041090',
  ADD COLUMN IF NOT EXISTS barcode_gtin varchar(32),
  ADD COLUMN IF NOT EXISTS batch_number varchar(64),
  ADD COLUMN IF NOT EXISTS pack_type varchar(50) DEFAULT 'pouch';

CREATE INDEX IF NOT EXISTS idx_product_variants_weight ON product_variants(weight_grams);

-- 4. Supplier procurement tracking tables (isolated internal cost ledger)
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

CREATE INDEX IF NOT EXISTS idx_supplier_history_variant ON supplier_price_history(variant_id);

COMMIT;
