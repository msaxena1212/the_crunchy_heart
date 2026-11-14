-- Migration: Add customer OTP and session tables for Neon Auth & Mobile OTP
-- Supports both Neon Auth Managed Better Auth identity and Mobile SMS/WhatsApp OTP login

CREATE TABLE IF NOT EXISTS customer_otps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(30) NOT NULL,
    otp_hash VARCHAR(128) NOT NULL,
    purpose VARCHAR(30) NOT NULL DEFAULT 'LOGIN', -- LOGIN, CHECKOUT, RECOVERY
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    channel VARCHAR(20) NOT NULL DEFAULT 'sms', -- sms, whatsapp
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_otps_active
    ON customer_otps(phone, expires_at)
    WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    session_token VARCHAR(255) NOT NULL UNIQUE,
    neon_auth_user_id VARCHAR(255),
    auth_provider VARCHAR(50) NOT NULL DEFAULT 'phone_otp', -- phone_otp, neon_auth, whatsapp_otp
    ip_address VARCHAR(50),
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_token
    ON customer_sessions(session_token, expires_at);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer
    ON customer_sessions(customer_id);
