-- ============================================================
-- THE CRUNCHY HEART
-- Production Ecommerce Database Schema
-- PostgreSQL / Neon
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- CATALOG
-- ============================================================

CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(180) NOT NULL UNIQUE,
    description TEXT,
    image_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_active_sort
    ON categories(is_active, sort_order);

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(220) NOT NULL UNIQUE,
    description TEXT,
    short_description TEXT,
    product_type VARCHAR(50) NOT NULL DEFAULT 'food',
    brand VARCHAR(150) NOT NULL DEFAULT 'The Crunchy Heart',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_category
    ON products(category_id);

CREATE INDEX IF NOT EXISTS idx_products_active_sort
    ON products(is_active, sort_order);

CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku VARCHAR(100) NOT NULL UNIQUE,
    variant_name VARCHAR(150) NOT NULL,
    weight_grams INTEGER,
    flavor VARCHAR(100),
    mrp NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (mrp >= 0),
    selling_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
    cost_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
    badge VARCHAR(100),
    tone VARCHAR(50) DEFAULT 'sand',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_variant_price
        CHECK (selling_price <= mrp OR mrp = 0)
);

CREATE INDEX IF NOT EXISTS idx_variants_product
    ON product_variants(product_id);

CREATE INDEX IF NOT EXISTS idx_variants_active
    ON product_variants(is_active, sort_order);

CREATE TABLE IF NOT EXISTS product_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    alt_text VARCHAR(255),
    image_type VARCHAR(50) DEFAULT 'product',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_images_product
    ON product_images(product_id, sort_order);

-- ============================================================
-- INVENTORY
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID NOT NULL UNIQUE REFERENCES product_variants(id) ON DELETE CASCADE,
    quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    quantity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
    reorder_level INTEGER NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_inventory_reserved
        CHECK (quantity_reserved <= quantity_on_hand)
);

CREATE TABLE IF NOT EXISTS inventory_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    batch_number VARCHAR(100) NOT NULL,
    supplier_name VARCHAR(200),
    purchase_date DATE,
    packing_date DATE,
    best_before_date DATE,
    quantity_received INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
    quantity_remaining INTEGER NOT NULL DEFAULT 0 CHECK (quantity_remaining >= 0),
    unit_cost NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(variant_id, batch_number)
);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry
    ON inventory_batches(best_before_date);

CREATE TABLE IF NOT EXISTS inventory_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES inventory_batches(id) ON DELETE SET NULL,
    transaction_type VARCHAR(50) NOT NULL,
    quantity INTEGER NOT NULL,
    reference_type VARCHAR(50),
    reference_id VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_variant
    ON inventory_transactions(variant_id, created_at DESC);

-- ============================================================
-- CUSTOMERS
-- ============================================================

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(30),
    password_hash TEXT,
    is_guest BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_unique
    ON customers(LOWER(email))
    WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_phone
    ON customers(phone);

CREATE TABLE IF NOT EXISTS customer_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    address_type VARCHAR(30) NOT NULL DEFAULT 'shipping',
    recipient_name VARCHAR(200) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    address_line1 TEXT NOT NULL,
    address_line2 TEXT,
    landmark VARCHAR(255),
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    postal_code VARCHAR(20) NOT NULL,
    country VARCHAR(100) NOT NULL DEFAULT 'India',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
    ON customer_addresses(customer_id);

-- ============================================================
-- CART
-- ============================================================

CREATE TABLE IF NOT EXISTS carts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    session_id VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_cart_owner
        CHECK (customer_id IS NOT NULL OR session_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_carts_customer
    ON carts(customer_id);

CREATE INDEX IF NOT EXISTS idx_carts_session
    ON carts(session_id);

CREATE TABLE IF NOT EXISTS cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(cart_id, variant_id)
);

-- ============================================================
-- ORDERS
-- ============================================================

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number VARCHAR(50) NOT NULL UNIQUE,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    customer_name VARCHAR(200) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    email VARCHAR(255),
    shipping_address JSONB NOT NULL,
    billing_address JSONB,
    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    shipping_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0),
    tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    status VARCHAR(40) NOT NULL DEFAULT 'pending',
    payment_status VARCHAR(40) NOT NULL DEFAULT 'pending',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer
    ON orders(customer_id);

CREATE INDEX IF NOT EXISTS idx_orders_status_created
    ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL,
    product_name VARCHAR(200) NOT NULL,
    variant_name VARCHAR(150),
    sku VARCHAR(100),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
    total_price NUMERIC(12,2) NOT NULL CHECK (total_price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order
    ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status VARCHAR(40) NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order
    ON order_status_history(order_id, created_at DESC);

-- ============================================================
-- PAYMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL DEFAULT 'razorpay',
    provider_order_id VARCHAR(255),
    provider_payment_id VARCHAR(255),
    provider_signature TEXT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    status VARCHAR(40) NOT NULL DEFAULT 'created',
    raw_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order
    ON payments(order_id);

CREATE INDEX IF NOT EXISTS idx_payments_provider_order
    ON payments(provider_order_id);

CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider_refund_id VARCHAR(255),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    reason TEXT,
    status VARCHAR(40) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- COUPONS
-- ============================================================

CREATE TABLE IF NOT EXISTS coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    discount_type VARCHAR(20) NOT NULL,
    discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value >= 0),
    minimum_order_value NUMERIC(10,2) NOT NULL DEFAULT 0,
    maximum_discount NUMERIC(10,2),
    usage_limit INTEGER,
    usage_count INTEGER NOT NULL DEFAULT 0,
    per_customer_limit INTEGER,
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_coupon_type
        CHECK (discount_type IN ('percentage', 'fixed'))
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon
    ON coupon_redemptions(coupon_id);

-- ============================================================
-- REVIEWS
-- ============================================================

CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title VARCHAR(200),
    review_text TEXT,
    is_verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_product
    ON reviews(product_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS review_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- MARKETING
-- ============================================================

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unsubscribed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS social_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform VARCHAR(50) NOT NULL,
    external_post_id VARCHAR(255),
    permalink TEXT,
    media_url TEXT,
    thumbnail_url TEXT,
    caption TEXT,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- HELPER FUNCTION: updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================

DROP TRIGGER IF EXISTS trg_categories_updated_at ON categories;
CREATE TRIGGER trg_categories_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_variants_updated_at ON product_variants;
CREATE TRIGGER trg_variants_updated_at
BEFORE UPDATE ON product_variants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_inventory_updated_at ON inventory;
CREATE TRIGGER trg_inventory_updated_at
BEFORE UPDATE ON inventory
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_customers_updated_at ON customers;
CREATE TRIGGER trg_customers_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_customer_addresses_updated_at ON customer_addresses;
CREATE TRIGGER trg_customer_addresses_updated_at
BEFORE UPDATE ON customer_addresses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_carts_updated_at ON carts;
CREATE TRIGGER trg_carts_updated_at
BEFORE UPDATE ON carts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_cart_items_updated_at ON cart_items;
CREATE TRIGGER trg_cart_items_updated_at
BEFORE UPDATE ON cart_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_refunds_updated_at ON refunds;
CREATE TRIGGER trg_refunds_updated_at
BEFORE UPDATE ON refunds
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_reviews_updated_at ON reviews;
CREATE TRIGGER trg_reviews_updated_at
BEFORE UPDATE ON reviews
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- END
-- ============================================================

-- ============================================================
-- Payment reconciliation queue (mirrors database/migrations/add_payment_reconciliation_queue.sql)
-- ============================================================
-- ============================================================
-- MIGRATION: payment_reconciliation_queue
-- Isolated to crunchy_heart_test ONLY.
-- ============================================================
--
-- Safety note: This table is the durable record of a VERIFIED
-- payment exception. Presence of a queue entry must NEVER by
-- itself mark an order as fulfilled, issue a refund, or trigger
-- a second charge. All downstream actions require an independent
-- verified admin workflow.
--
-- Deletion policy (per project convention):
--   order_id   → RESTRICT    (retain financial records even if order row changes)
--   payment_id → SET NULL    (matches refunds table; payment rows can be cleaned)
--   resolved_by_admin_id → SET NULL (matches admin_audit_logs pattern)
--
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

-- ============================================================
-- TABLE: payment_reconciliation_queue
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_reconciliation_queue (
    -- ---- Identity ----
    id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Idempotency key: the canonical deduplification handle.
    -- Composed from provider + provider_order_id + event_type so that
    -- replayed webhooks or duplicate reconciliation runs are silently
    -- ignored at the DB level.
    idempotency_key             VARCHAR(255) NOT NULL,

    -- ---- Order / payment linkage ----
    -- RESTRICT: financial exception records must survive order mutations.
    order_id                    UUID        NOT NULL
        REFERENCES orders(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,

    -- SET NULL: follows refunds table pattern; payment rows can be cleaned.
    payment_id                  UUID
        REFERENCES payments(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    -- ---- Verified provider event identifiers ----
    -- These are written ONLY after the provider response has been verified
    -- cryptographically or by a second lookup; never from unverified input.
    provider                    VARCHAR(50)  NOT NULL DEFAULT 'cashfree',
    provider_order_id           VARCHAR(255),          -- e.g. TCH-xxxx, TCH-xxxx-R2
    provider_payment_id         VARCHAR(255),          -- provider's payment/transaction ID
    provider_event_id           VARCHAR(255),          -- webhook event ID / CF order ID

    -- Snapshot of amount and currency from the VERIFIED provider response.
    verified_amount             NUMERIC(12,2),
    verified_currency           VARCHAR(10)  NOT NULL DEFAULT 'INR',

    -- ---- Exception classification ----
    -- Type of exception that triggered this queue entry.
    event_type                  VARCHAR(80)  NOT NULL,

    -- Current processing status of this queue entry.
    -- Allowed values enforced by CHECK constraint below.
    status                      VARCHAR(40)  NOT NULL DEFAULT 'pending',

    -- Intended action to be taken by an admin after review.
    -- NULL = not yet determined.
    resolution_action           VARCHAR(80),

    -- ---- Audit / actor ----
    -- SET NULL: mirrors admin_audit_logs; admin rows can be deleted.
    resolved_by_admin_id        UUID
        REFERENCES admin_users(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    resolution_note             TEXT,

    -- ---- Raw verified payload (non-PII snapshot for audit) ----
    -- Stores the sanitised provider response that triggered this entry.
    -- Must NOT contain payment credentials or full card data.
    raw_provider_payload        JSONB        NOT NULL DEFAULT '{}'::jsonb,

    -- ---- Retry metadata ----
    attempt_count               INTEGER      NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts                INTEGER      NOT NULL DEFAULT 5  CHECK (max_attempts  >= 1),
    last_attempted_at           TIMESTAMPTZ,
    next_retry_after            TIMESTAMPTZ,
    last_error                  TEXT,

    -- ---- Timestamps ----
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at                 TIMESTAMPTZ,

    -- ---- Constraints ----

    -- Idempotency: one entry per unique (provider, provider_order_id, event_type) tuple.
    CONSTRAINT uq_recon_queue_idempotency_key
        UNIQUE (idempotency_key),

    -- Status must be one of the defined lifecycle values.
    CONSTRAINT chk_recon_queue_status
        CHECK (status IN (
            'pending',          -- awaiting first processing attempt
            'processing',       -- currently being processed (short-lived)
            'pending_admin',    -- waiting for admin review/action
            'resolved',         -- successfully resolved
            'failed',           -- exhausted retries without resolution
            'skipped'           -- intentionally skipped (e.g. duplicate already resolved)
        )),

    -- Resolution action must be one of the safe, explicit values.
    CONSTRAINT chk_recon_queue_resolution_action
        CHECK (resolution_action IS NULL OR resolution_action IN (
            'no_action_required',       -- verified no intervention needed
            'refund_initiated',         -- refund workflow initiated via verified provider API
            'order_manually_fulfilled', -- order fulfilled after independent admin verification
            'duplicate_payment_noted',  -- duplicate charge logged; provider-side refund to follow
            'investigation_required',   -- escalated for manual investigation
            'voided'                    -- payment voided at provider; no further action
        )),

    -- A resolved/failed entry must have a resolution timestamp.
    CONSTRAINT chk_recon_queue_resolved_at
        CHECK (
            (status NOT IN ('resolved', 'failed', 'skipped')) OR (resolved_at IS NOT NULL)
        ),

    -- resolved_by is required when a resolution_action has been set.
    -- (Allows NULL during pending/processing stages.)
    CONSTRAINT chk_recon_queue_resolver
        CHECK (
            resolution_action IS NULL
            OR resolved_by_admin_id IS NOT NULL
            OR resolution_action = 'no_action_required'
        ),

    -- Retry guard: attempt_count must not exceed max_attempts.
    CONSTRAINT chk_recon_queue_attempt_limit
        CHECK (attempt_count <= max_attempts),

    -- verified_amount must be positive when present.
    CONSTRAINT chk_recon_queue_amount
        CHECK (verified_amount IS NULL OR verified_amount > 0)
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Primary lookup for deduplication (already covered by the unique constraint
-- but an explicit index name makes query plans readable).
CREATE INDEX IF NOT EXISTS idx_recon_queue_idempotency
    ON payment_reconciliation_queue (idempotency_key);

-- Operational: find pending / retryable entries efficiently.
CREATE INDEX IF NOT EXISTS idx_recon_queue_status_retry
    ON payment_reconciliation_queue (status, next_retry_after)
    WHERE status IN ('pending', 'processing', 'pending_admin');

-- Order-scoped lookups (admin order detail view, recovery path).
CREATE INDEX IF NOT EXISTS idx_recon_queue_order
    ON payment_reconciliation_queue (order_id, created_at DESC);

-- Payment-scoped lookups (reconcile against a payment row).
CREATE INDEX IF NOT EXISTS idx_recon_queue_payment
    ON payment_reconciliation_queue (payment_id)
    WHERE payment_id IS NOT NULL;

-- Provider-order lookup (webhook recovery, reconciliation service).
CREATE INDEX IF NOT EXISTS idx_recon_queue_provider_order
    ON payment_reconciliation_queue (provider, provider_order_id)
    WHERE provider_order_id IS NOT NULL;

-- Audit / admin view: unresolved entries sorted newest-first.
CREATE INDEX IF NOT EXISTS idx_recon_queue_pending_admin_created
    ON payment_reconciliation_queue (created_at DESC)
    WHERE status = 'pending_admin';

-- ============================================================
-- TRIGGER: keep updated_at current
-- ============================================================

DROP TRIGGER IF EXISTS trg_recon_queue_updated_at ON payment_reconciliation_queue;
CREATE TRIGGER trg_recon_queue_updated_at
    BEFORE UPDATE ON payment_reconciliation_queue
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Payment reconciliation incidents (mirrors database/migrations/add_payment_reconciliation_incidents.sql)
-- ============================================================
-- ============================================================
-- MIGRATION: payment_reconciliation_incidents
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- Durable record of payment-event integrity problems that must not be
-- silently acknowledged or silently discarded:
--   * IDEMPOTENCY_CONFLICT          same queue key, materially different data
--   * UNIDENTIFIED_PROVIDER_PAYMENT verified SUCCESS with no provider payment ID
--
-- An incident is NOT a refund request and does not change order or payment
-- state. Rows are retained for audit; deletion is never part of normal flow.
--
-- Deletion policy:
--   order_id    -> RESTRICT  (financial history survives)
--   queue_id    -> SET NULL  (incident outlives a queue row removed by hand)
-- ============================================================


CREATE TABLE IF NOT EXISTS payment_reconciliation_incidents (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    -- SHA-256 of the canonical incoming event. Exact redeliveries of the same
    -- conflicting event map to one incident instead of many.
    fingerprint         VARCHAR(64)  NOT NULL,

    incident_type       VARCHAR(60)  NOT NULL,
    severity            VARCHAR(20)  NOT NULL DEFAULT 'high',

    order_id            UUID         NOT NULL
        REFERENCES orders(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,

    queue_id            UUID
        REFERENCES payment_reconciliation_queue(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    provider            VARCHAR(50)  NOT NULL DEFAULT 'cashfree',
    provider_order_id   VARCHAR(255) NOT NULL,
    provider_payment_id VARCHAR(255),

    -- Sanitised incoming event fields only. Never a raw webhook body.
    incoming_details    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- Sanitised snapshot of the stored record the event conflicted with.
    existing_details    JSONB        NOT NULL DEFAULT '{}'::jsonb,

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ,

    CONSTRAINT uq_recon_incident_fingerprint
        UNIQUE (fingerprint),

    CONSTRAINT chk_recon_incident_type
        CHECK (incident_type IN (
            'IDEMPOTENCY_CONFLICT',
            'UNIDENTIFIED_PROVIDER_PAYMENT'
        )),

    CONSTRAINT chk_recon_incident_severity
        CHECK (severity IN ('high', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_recon_incident_open
    ON payment_reconciliation_incidents (created_at)
    WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_recon_incident_order
    ON payment_reconciliation_incidents (order_id);

DROP TRIGGER IF EXISTS trg_recon_incident_updated_at ON payment_reconciliation_incidents;
CREATE TRIGGER trg_recon_incident_updated_at
    BEFORE UPDATE ON payment_reconciliation_incidents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Reconciliation retry support (mirrors database/migrations/add_reconciliation_retry_support.sql)
-- ============================================================
-- ============================================================
-- MIGRATION: reconciliation retry support
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- Adds the resolution actions used by the settlement retry workflow and
-- permits system (worker) resolutions, which have no admin actor.
-- Existing values and rows are unchanged; only the allowed sets widen.
-- ============================================================


ALTER TABLE payment_reconciliation_queue
    DROP CONSTRAINT IF EXISTS chk_recon_queue_resolution_action;

ALTER TABLE payment_reconciliation_queue
    ADD CONSTRAINT chk_recon_queue_resolution_action
        CHECK (resolution_action IS NULL OR resolution_action IN (
            'no_action_required',
            'refund_initiated',
            'order_manually_fulfilled',
            'duplicate_payment_noted',
            'investigation_required',
            'voided',
            'auto_retry_settled',      -- worker settled after verified retry
            'admin_retry_settled'      -- admin-triggered settlement retry
        ));

ALTER TABLE payment_reconciliation_queue
    DROP CONSTRAINT IF EXISTS chk_recon_queue_resolver;

ALTER TABLE payment_reconciliation_queue
    ADD CONSTRAINT chk_recon_queue_resolver
        CHECK (
            resolution_action IS NULL
            OR resolved_by_admin_id IS NOT NULL
            OR resolution_action IN ('no_action_required', 'auto_retry_settled')
        );

-- Worker lookup: due pending items only.
CREATE INDEX IF NOT EXISTS idx_recon_queue_due_pending
    ON payment_reconciliation_queue (next_retry_after)
    WHERE status = 'pending';

-- ============================================================
-- Reconciliation claim token (mirrors database/migrations/add_reconciliation_claim_token.sql)
-- ============================================================
-- ============================================================
-- MIGRATION: reconciliation claim token (lease ownership)
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- claim_token identifies the worker that currently owns a 'processing'
-- item. Settlement and failure writes must present the token they were
-- issued, so a worker whose lease expired cannot settle or overwrite
-- the state recorded by the worker that took over.
-- ============================================================


ALTER TABLE payment_reconciliation_queue
    ADD COLUMN IF NOT EXISTS claim_token UUID;

-- ============================================================
-- Refund orchestration (mirrors database/migrations/add_refund_orchestration.sql)
-- ============================================================
-- ============================================================
-- MIGRATION: refund orchestration (intent, idempotency, claims)
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- Extends the existing refunds table. No parallel refund table.
--
-- Status meanings (see server/src/services/refund.service.js):
--   pending                 intent recorded; awaiting operator approval
--   approved                authorised; eligible for provider submission
--   processing              claimed; provider call in flight (lease held)
--   reconciliation_required outcome unknown, or provider accepted but not final
--   refunded                provider confirmed the refund (existing completed status, reused)
--   failed                  reserved for compatibility; automation does not set it
--   manual_review           permanent rejection, conflict, or exhausted retries
--
-- PRE-CHECK before applying to any database that has real rows:
--   SELECT DISTINCT status FROM refunds;
-- Every value must be in the allowed set below, or the constraint fails
-- (fail-closed by design). Existing rows are never rewritten by status.
-- ============================================================


ALTER TABLE refunds
    ADD COLUMN IF NOT EXISTS idempotency_key      VARCHAR(255),
    ADD COLUMN IF NOT EXISTS currency             VARCHAR(10)  NOT NULL DEFAULT 'INR',
    ADD COLUMN IF NOT EXISTS origin               VARCHAR(40)  NOT NULL DEFAULT 'legacy',
    ADD COLUMN IF NOT EXISTS claim_token          UUID,
    ADD COLUMN IF NOT EXISTS claimed_at           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempt_count        INTEGER      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_attempts         INTEGER      NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS next_attempt_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error           TEXT,
    ADD COLUMN IF NOT EXISTS approved_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS approved_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolved_at          TIMESTAMPTZ;

-- Legacy rows get a deterministic key so the NOT NULL + UNIQUE constraints hold.
UPDATE refunds
SET idempotency_key = 'legacy:' || id::text
WHERE idempotency_key IS NULL;

ALTER TABLE refunds
    ALTER COLUMN idempotency_key SET NOT NULL;

-- Legacy direct inserts that omit a key get a unique random key, so they can never
-- collide. Application code always supplies a deterministic key.
ALTER TABLE refunds
    ALTER COLUMN idempotency_key SET DEFAULT ('legacy:' || gen_random_uuid()::text);

ALTER TABLE refunds
    DROP CONSTRAINT IF EXISTS uq_refunds_idempotency_key;

ALTER TABLE refunds
    ADD CONSTRAINT uq_refunds_idempotency_key UNIQUE (idempotency_key);

ALTER TABLE refunds
    DROP CONSTRAINT IF EXISTS chk_refunds_status;

ALTER TABLE refunds
    ADD CONSTRAINT chk_refunds_status CHECK (status IN (
        'pending', 'approved', 'processing', 'reconciliation_required',
        'refunded', 'failed', 'manual_review'
    ));

ALTER TABLE refunds
    DROP CONSTRAINT IF EXISTS chk_refunds_attempts;

ALTER TABLE refunds
    ADD CONSTRAINT chk_refunds_attempts CHECK (attempt_count >= 0 AND max_attempts >= 1);

ALTER TABLE refunds
    DROP CONSTRAINT IF EXISTS chk_refunds_amount_currency;

ALTER TABLE refunds
    ADD CONSTRAINT chk_refunds_amount_currency CHECK (currency = UPPER(currency));

-- A provider refund ID identifies at most one local refund.
CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_provider_refund_id
    ON refunds (provider_refund_id)
    WHERE provider_refund_id IS NOT NULL;

-- Worker lookup: due work only.
CREATE INDEX IF NOT EXISTS idx_refunds_due
    ON refunds (next_attempt_at)
    WHERE status IN ('approved', 'reconciliation_required');

-- Cumulative in-flight totals per payment.
CREATE INDEX IF NOT EXISTS idx_refunds_payment_status
    ON refunds (payment_id, status);

DROP TRIGGER IF EXISTS trg_refunds_updated_at ON refunds;
CREATE TRIGGER trg_refunds_updated_at
    BEFORE UPDATE ON refunds
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Operational alerts (mirrors database/migrations/add_operational_alerts.sql)
-- ============================================================
-- ============================================================
-- MIGRATION: operational alerts (durable, deduplicated)
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- Alerts describe operational conditions (overdue pending refunds, refunds in
-- manual review). They never change refund or payment state. Delivery failures
-- are recorded and retried. The alert_key is unique so one condition produces
-- one alert.
-- ============================================================


CREATE TABLE IF NOT EXISTS operational_alerts (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_key       VARCHAR(255) NOT NULL,
    alert_type      VARCHAR(60)  NOT NULL,
    severity        VARCHAR(20)  NOT NULL,
    entity_type     VARCHAR(60)  NOT NULL,
    entity_id       VARCHAR(100) NOT NULL,
    -- Allowlisted, redacted fields only. See ops-alert.service.js.
    payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    delivery_status VARCHAR(20)  NOT NULL DEFAULT 'pending',
    attempt_count   INTEGER      NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,

    CONSTRAINT uq_operational_alerts_key
        UNIQUE (alert_key),

    CONSTRAINT chk_operational_alerts_severity
        CHECK (severity IN ('high', 'critical')),

    CONSTRAINT chk_operational_alerts_delivery
        CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'undeliverable')),

    CONSTRAINT chk_operational_alerts_attempts
        CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_operational_alerts_undelivered
    ON operational_alerts (next_attempt_at)
    WHERE delivery_status IN ('pending', 'failed');

-- ============================================================
-- Order request fingerprint (mirrors database/migrations/add_order_idempotency_fingerprint.sql)
-- ============================================================
-- ============================================================
-- MIGRATION: order request fingerprint for idempotent checkout
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- Stores a SHA-256 of the logical order request. A replayed idempotency key with a
-- different fingerprint is rejected (409 IDEMPOTENCY_KEY_REUSED) instead of silently
-- returning the earlier order.
--
-- Existing rows keep NULL. NULL means "created before fingerprints existed" and is
-- allowed to replay as before. The column is nullable, so this migration does not
-- rewrite or lock order data in a way that matters at this scale.
-- ============================================================


ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint VARCHAR(64);

-- ============================================================
-- Commerce extensions (sections 2 to 11 and 14 of the foundation upgrade; data backfills excluded)
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
-- 14. ORDER STATUS HISTORY
-- ============================================================

CREATE INDEX IF NOT EXISTS ix_order_status_history_order_created
ON order_status_history(order_id, created_at DESC);

-- ============================================================
-- Guest order recovery challenges (mirrors database/migrations/add_order_recovery_challenges.sql)
-- ============================================================
-- ============================================================
-- MIGRATION: guest order recovery challenges
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- A one-time recovery challenge lets a guest who lost the checkout response obtain
-- the guest access token for their own recent order. Only a hash of the code is
-- stored. Challenges expire, are single-use, and count failed attempts.
--
-- contact_hash is a SHA-256 of the normalised contact (email or phone). The
-- contact itself is not stored here.
-- ============================================================


CREATE TABLE IF NOT EXISTS order_recovery_challenges (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID         NOT NULL
        REFERENCES orders(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    contact_hash    VARCHAR(64)  NOT NULL,
    code_hash       VARCHAR(64)  NOT NULL,
    attempts        INTEGER      NOT NULL DEFAULT 0,
    max_attempts    INTEGER      NOT NULL DEFAULT 5,
    expires_at      TIMESTAMPTZ  NOT NULL,
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_order_recovery_attempts
        CHECK (attempts >= 0 AND max_attempts >= 1 AND attempts <= max_attempts + 1)
);

CREATE INDEX IF NOT EXISTS idx_order_recovery_contact_created
    ON order_recovery_challenges (contact_hash, created_at DESC);

-- ============================================================
-- Recovery rate limits (mirrors database/migrations/add_recovery_rate_limits.sql)
-- ============================================================
-- ============================================================
-- MIGRATION: database-backed rate limits for order recovery
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- One row per counted request. key_hash is a SHA-256 of a contact or an IP address,
-- never the raw value. Rows older than a day can be pruned safely; no financial or
-- order data is stored here.
-- ============================================================


CREATE TABLE IF NOT EXISTS rate_limit_events (
    id          BIGSERIAL    PRIMARY KEY,
    scope       VARCHAR(60)  NOT NULL,
    key_hash    VARCHAR(64)  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_scope_key_created
    ON rate_limit_events (scope, key_hash, created_at DESC);

-- ============================================================
-- social_post_drafts (admin drafts; migration add_social_post_drafts.sql)
-- ============================================================

CREATE TABLE IF NOT EXISTS social_post_drafts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform    VARCHAR(20) NOT NULL,
    title       VARCHAR(200) NOT NULL,
    body        TEXT NOT NULL,
    media_url   TEXT,
    status      VARCHAR(20) NOT NULL DEFAULT 'draft',
    created_by  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_social_post_platform
        CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'pinterest')),
    CONSTRAINT chk_social_post_status
        CHECK (status IN ('draft', 'scheduled', 'published', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_social_post_drafts_platform_updated
    ON social_post_drafts (platform, updated_at DESC);
