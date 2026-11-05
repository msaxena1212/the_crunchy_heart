-- ============================================================
-- MIGRATION: reconciliation retry support
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- Adds the resolution actions used by the settlement retry workflow and
-- permits system (worker) resolutions, which have no admin actor.
-- Existing values and rows are unchanged; only the allowed sets widen.
-- ============================================================

BEGIN;

ALTER TABLE payment_reconciliation_queue
    DROP CONSTRAINT IF EXISTS chk_recon_queue_resolution_action;

ALTER TABLE payment_reconciliation_queue
    ADD CONSTRAINT chk_recon_queue_resolution_action
        CHECK (resolution_action IS NULL OR resolution_action IN (
            'no_action_required',
            'refund_initiated',
            'order_manually_fulfilled',
            'duplicate_payment_noted',
            'investigation_required',
            'voided',
            'auto_retry_settled',      -- worker settled after verified retry
            'admin_retry_settled'      -- admin-triggered settlement retry
        ));

ALTER TABLE payment_reconciliation_queue
    DROP CONSTRAINT IF EXISTS chk_recon_queue_resolver;

ALTER TABLE payment_reconciliation_queue
    ADD CONSTRAINT chk_recon_queue_resolver
        CHECK (
            resolution_action IS NULL
            OR resolved_by_admin_id IS NOT NULL
            OR resolution_action IN ('no_action_required', 'auto_retry_settled')
        );

-- Worker lookup: due pending items only.
CREATE INDEX IF NOT EXISTS idx_recon_queue_due_pending
    ON payment_reconciliation_queue (next_retry_after)
    WHERE status = 'pending';

COMMIT;
