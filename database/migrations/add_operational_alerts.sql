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

BEGIN;

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

COMMIT;
