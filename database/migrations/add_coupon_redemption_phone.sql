-- Per-customer coupon limits are counted by phone number, because guest orders have no customer id.
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
CREATE INDEX IF NOT EXISTS ix_coupon_redemptions_coupon_phone ON coupon_redemptions(coupon_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS ux_coupon_redemptions_order ON coupon_redemptions(order_id) WHERE order_id IS NOT NULL;
