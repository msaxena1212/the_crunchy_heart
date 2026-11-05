-- ============================================================
-- MIGRATION: reconciliation claim token (lease ownership)
-- Apply only to an approved, isolated database. Never to production
-- without an explicit deployment decision.
-- ============================================================
--
-- claim_token identifies the worker that currently owns a 'processing'
-- item. Settlement and failure writes must present the token they were
-- issued, so a worker whose lease expired cannot settle or overwrite
-- the state recorded by the worker that took over.
-- ============================================================

BEGIN;

ALTER TABLE payment_reconciliation_queue
    ADD COLUMN IF NOT EXISTS claim_token UUID;

COMMIT;
