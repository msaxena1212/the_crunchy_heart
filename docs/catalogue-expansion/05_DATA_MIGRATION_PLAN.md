# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 05: Data Migration & Seeding Plan (Phase 0)

**Date**: November 18, 2026  
**Scope**: Migration Execution Sequence, Seed Scripts, Rollback Procedures, and Integrity Verification

---

### 1. Migration Execution Sequence

All migrations run against the Neon PostgreSQL branch (`staging` first). Every script is idempotent and wrapped in a transaction block.

```sql
-- Step 1: Subcategory and Product Field Extensions
-- database/migrations/010_catalogue_expansion_schema.sql
BEGIN;

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
  ADD COLUMN IF NOT EXISTS fssai_license_number varchar(32) DEFAULT '10424000000001',
  ADD COLUMN IF NOT EXISTS shelf_life_days integer DEFAULT 180,
  ADD COLUMN IF NOT EXISTS publication_status varchar(30) NOT NULL DEFAULT 'active';

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS hsn_code varchar(16) DEFAULT '19041090',
  ADD COLUMN IF NOT EXISTS barcode_gtin varchar(32),
  ADD COLUMN IF NOT EXISTS batch_number varchar(64),
  ADD COLUMN IF NOT EXISTS pack_type varchar(50) DEFAULT 'pouch';

COMMIT;
```

---

### 2. Seeding & Ingestion Strategy

1. **Category Hierarchy Insertion**:
   - Verify categories 01 through 10 exist.
   - Insert subcategories with parent `category_id` lookup.
2. **Product Ingestion**:
   - `INSERT INTO products ... ON CONFLICT (slug) DO UPDATE SET ...` to update metadata without disrupting foreign key relationships to existing orders.
3. **Pack Variant Generation**:
   - Deterministic pack weights: Dry fruits (250g, 500g, 1000g), Spices (100g, 250g, 500g, 1000g), Makhana (100g, 200g, 500g, 1kg), Wholesale (5kg, 10kg).
   - Selling prices computed from per-kg rates rounded to the nearest integer.
4. **Opening Inventory**:
   - Default opening stock set to 20 units per sellable variant.

---

### 3. Verification & Health Check Queries

```sql
-- 1. Ensure no orphan variants
SELECT COUNT(*) FROM product_variants pv 
LEFT JOIN products p ON pv.product_id = p.id 
WHERE p.id IS NULL; -- Must be 0

-- 2. Ensure all variants have inventory rows
SELECT COUNT(*) FROM product_variants pv
LEFT JOIN inventory i ON pv.id = i.variant_id
WHERE i.variant_id IS NULL; -- Must be 0

-- 3. Verify price integrity (selling_price <= mrp)
SELECT COUNT(*) FROM product_variants 
WHERE selling_price > mrp AND mrp > 0; -- Must be 0

-- 4. Check SKU uniqueness
SELECT sku, COUNT(*) FROM product_variants 
GROUP BY sku HAVING COUNT(*) > 1; -- Must be 0
```

---

### 4. Rollback & Disaster Recovery Strategy

1. **Neon Branch Snapshots**: Before applying migrations, take a point-in-time snapshot or branch checkpoint via Neon CLI/MCP (`create_branch` / `create_snapshot`).
2. **Zero Destructive Drops**: No table or column drops are executed. If a rollback is required, setting `is_active = false` or `publication_status = 'archived'` hides new items without breaking referential integrity.
