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

BEGIN;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint VARCHAR(64);

COMMIT;
