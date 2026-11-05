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

BEGIN;

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

COMMIT;

