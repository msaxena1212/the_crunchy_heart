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

BEGIN;

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

COMMIT;
