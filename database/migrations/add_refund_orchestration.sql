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

BEGIN;

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

COMMIT;
