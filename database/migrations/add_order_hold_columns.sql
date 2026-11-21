-- Online orders hold stock for 15 minutes; the sweep releases unpaid ones.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS hold_released_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_hold_expiry
    ON orders(status, payment_status, hold_expires_at)
    WHERE hold_expires_at IS NOT NULL AND hold_released_at IS NULL;
