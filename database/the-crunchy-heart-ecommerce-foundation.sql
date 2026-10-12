-- The Crunchy Heart — Ecommerce Foundation Migration
-- Production-safe / idempotent migration for the current Neon schema.
-- Run this from the Neon psql session only after reviewing it.

BEGIN;

-- ============================================================
-- 1. TAX CONFIGURATION
-- Website prices are configured as GST-inclusive.
-- Current project configuration: 18%.
-- ============================================================

UPDATE product_variants
SET tax_rate = 18
WHERE tax_rate = 0
  AND is_active = true;

-- ============================================================
-- 2. SUBCATEGORIES
-- ============================================================

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

CREATE UNIQUE INDEX IF NOT EXISTS ux_subcategories_slug
ON subcategories(slug);

CREATE INDEX IF NOT EXISTS ix_subcategories_category_active
ON subcategories(category_id, is_active, sort_order);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS subcategory_id uuid
    REFERENCES subcategories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_products_subcategory
ON products(subcategory_id);

-- ============================================================
-- 3. COUPONS / OFFERS
-- ============================================================

ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS offer_type varchar(30) NOT NULL DEFAULT 'DISCOUNT',
  ADD COLUMN IF NOT EXISTS offer_scope varchar(30) NOT NULL DEFAULT 'CART',
  ADD COLUMN IF NOT EXISTS rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_stackable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS first_order_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS new_customers_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS ux_coupons_code_lower
ON coupons(lower(code));

CREATE INDEX IF NOT EXISTS ix_coupons_active_dates
ON coupons(is_active, starts_at, expires_at);

-- offer_type:
-- DISCOUNT | BOGO | COMBO | FREE_SHIPPING
--
-- offer_scope:
-- CATEGORY | SUBCATEGORY | PRODUCT | CART | BOGO | COMBO | CUSTOMER_VOUCHER

CREATE TABLE IF NOT EXISTS coupon_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coupon_id, product_id)
);

CREATE TABLE IF NOT EXISTS coupon_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coupon_id, variant_id)
);

CREATE TABLE IF NOT EXISTS coupon_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coupon_id, category_id)
);

CREATE TABLE IF NOT EXISTS coupon_subcategories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  subcategory_id uuid NOT NULL REFERENCES subcategories(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coupon_id, subcategory_id)
);

CREATE TABLE IF NOT EXISTS coupon_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coupon_id, customer_id)
);

CREATE INDEX IF NOT EXISTS ix_coupon_products_coupon
ON coupon_products(coupon_id);

CREATE INDEX IF NOT EXISTS ix_coupon_variants_coupon
ON coupon_variants(coupon_id);

CREATE INDEX IF NOT EXISTS ix_coupon_categories_coupon
ON coupon_categories(coupon_id);

CREATE INDEX IF NOT EXISTS ix_coupon_subcategories_coupon
ON coupon_subcategories(coupon_id);

CREATE INDEX IF NOT EXISTS ix_coupon_customers_coupon
ON coupon_customers(coupon_id);

-- ============================================================
-- 4. BOGO
-- ============================================================

CREATE TABLE IF NOT EXISTS coupon_bogo_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  buy_variant_id uuid NOT NULL REFERENCES product_variants(id),
  get_variant_id uuid NOT NULL REFERENCES product_variants(id),
  buy_quantity integer NOT NULL CHECK(buy_quantity > 0),
  get_quantity integer NOT NULL CHECK(get_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coupon_id)
);

-- ============================================================
-- 5. COMBOS
-- ============================================================

CREATE TABLE IF NOT EXISTS coupon_combo_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  required_quantity integer NOT NULL CHECK(required_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coupon_id, variant_id)
);

CREATE INDEX IF NOT EXISTS ix_coupon_combo_items_coupon
ON coupon_combo_items(coupon_id);

-- ============================================================
-- 6. COUPON REDEMPTION INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS ix_coupon_redemptions_customer_coupon
ON coupon_redemptions(customer_id, coupon_id);

CREATE INDEX IF NOT EXISTS ix_coupon_redemptions_order
ON coupon_redemptions(order_id);

-- ============================================================
-- 7. ORDERS — PAYMENT / PRICING SNAPSHOT
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS coupon_id uuid
    REFERENCES coupons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS coupon_code varchar(100),
  ADD COLUMN IF NOT EXISTS payment_method varchar(30) NOT NULL DEFAULT 'COD',
  ADD COLUMN IF NOT EXISTS tax_rate numeric(5,2) NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS price_includes_tax boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cashfree_order_id varchar(100),
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(100);

CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_cashfree_order_id
ON orders(cashfree_order_id)
WHERE cashfree_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_idempotency_key
ON orders(idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_orders_status_created
ON orders(status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_orders_payment_status_created
ON orders(payment_status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_orders_coupon
ON orders(coupon_id);

-- ============================================================
-- 8. ORDER ITEM — IMMUTABLE PRICE / DISCOUNT / GST SNAPSHOT
-- ============================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS discount_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxable_value numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate numeric(5,2) NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS tax_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_price_includes_tax boolean NOT NULL DEFAULT true;

-- Existing values are interpreted as GST-inclusive customer prices.
UPDATE order_items
SET taxable_value = CASE
    WHEN tax_rate > 0
      THEN round(total_price / (1 + tax_rate / 100), 2)
    ELSE total_price
  END,
  tax_amount = CASE
    WHEN tax_rate > 0
      THEN round(total_price - (total_price / (1 + tax_rate / 100)), 2)
    ELSE 0
  END
WHERE taxable_value = 0
  AND total_price > 0;

-- ============================================================
-- 9. CASHFREE PAYMENT FOUNDATION
-- ============================================================

ALTER TABLE payments
  ALTER COLUMN provider SET DEFAULT 'cashfree';

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_method varchar(50),
  ADD COLUMN IF NOT EXISTS gateway_status varchar(50),
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(100);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider_order
ON payments(provider, provider_order_id)
WHERE provider_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_payments_order_status
ON payments(order_id, status);

-- ============================================================
-- 10. INVENTORY
-- Existing quantity_reserved will be used for checkout
-- reservations. inventory_transactions records every movement.
-- ============================================================

CREATE INDEX IF NOT EXISTS ix_inventory_transactions_variant_created
ON inventory_transactions(variant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_inventory_transactions_reference
ON inventory_transactions(reference_type, reference_id);

-- ============================================================
-- 11. STORE / CHECKOUT SETTINGS
-- Centralizes shipping, tax and checkout configuration.
-- ============================================================

CREATE TABLE IF NOT EXISTS store_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key varchar(100) NOT NULL,
  setting_value jsonb NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_store_settings_key
ON store_settings(setting_key);

INSERT INTO store_settings(setting_key, setting_value, description)
VALUES
  (
    'shipping',
    '{"free_shipping_threshold":499,"flat_shipping_amount":149,"currency":"INR"}'::jsonb,
    'Free shipping at or above ₹499; ₹149 below ₹499.'
  ),
  (
    'tax',
    '{"default_rate":18,"prices_include_tax":true,"currency":"INR"}'::jsonb,
    'Current project configuration: website prices are GST-inclusive.'
  ),
  (
    'checkout',
    '{"allow_cod":true,"allow_online_payment":true,"allow_coupon_stacking":false}'::jsonb,
    'Customer checkout configuration.'
  )
ON CONFLICT(setting_key) DO NOTHING;

-- ============================================================
-- 12. ADMIN USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(255) NOT NULL,
  password_hash text NOT NULL,
  full_name varchar(200) NOT NULL,
  role varchar(30) NOT NULL DEFAULT 'ADMIN',
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_admin_users_email_lower
ON admin_users(lower(email));

CREATE INDEX IF NOT EXISTS ix_admin_users_active
ON admin_users(is_active);

-- ============================================================
-- 13. ADMIN AUDIT LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  action varchar(100) NOT NULL,
  entity_type varchar(100),
  entity_id varchar(100),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_admin_audit_logs_created
ON admin_audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS ix_admin_audit_logs_entity
ON admin_audit_logs(entity_type, entity_id);

-- ============================================================
-- 14. ORDER STATUS HISTORY
-- ============================================================

CREATE INDEX IF NOT EXISTS ix_order_status_history_order_created
ON order_status_history(order_id, created_at DESC);

COMMIT;
