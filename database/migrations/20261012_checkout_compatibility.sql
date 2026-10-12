-- The Crunchy Heart checkout compatibility migration
-- Safe to apply to existing Neon databases; no existing commerce data is dropped.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30),
    ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 18,
    ADD COLUMN IF NOT EXISTS price_includes_tax BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
    ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(50);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key_unique
    ON orders(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS taxable_value NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 18,
    ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS unit_price_includes_tax BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30),
    ADD COLUMN IF NOT EXISTS gateway_status VARCHAR(60);

CREATE TABLE IF NOT EXISTS store_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO store_settings (setting_key, setting_value)
VALUES (
    'shipping',
    '{"free_shipping_threshold":499,"flat_shipping_amount":149,"currency":"INR"}'::jsonb
)
ON CONFLICT (setting_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_payments_provider_order
    ON payments(provider_order_id);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_reference
    ON inventory_transactions(reference_type, reference_id);
