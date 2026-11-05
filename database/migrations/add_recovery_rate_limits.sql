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

BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_events (
    id          BIGSERIAL    PRIMARY KEY,
    scope       VARCHAR(60)  NOT NULL,
    key_hash    VARCHAR(64)  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_scope_key_created
    ON rate_limit_events (scope, key_hash, created_at DESC);

COMMIT;
