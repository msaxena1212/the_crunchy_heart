-- ============================================================
-- MIGRATION: social media post drafts (admin)
-- Drafts only. Nothing here publishes to any platform.
-- Idempotent: safe to apply twice.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS social_post_drafts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform    VARCHAR(20) NOT NULL,
    title       VARCHAR(200) NOT NULL,
    body        TEXT NOT NULL,
    media_url   TEXT,
    status      VARCHAR(20) NOT NULL DEFAULT 'draft',
    created_by  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_social_post_platform
        CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'pinterest')),
    CONSTRAINT chk_social_post_status
        CHECK (status IN ('draft', 'scheduled', 'published', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_social_post_drafts_platform_updated
    ON social_post_drafts (platform, updated_at DESC);

COMMIT;
