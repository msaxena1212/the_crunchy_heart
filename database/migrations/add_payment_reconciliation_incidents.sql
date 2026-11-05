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

BEGIN;

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

COMMIT;
