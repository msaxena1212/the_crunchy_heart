-- Migration: Add inventory holds and expiration
-- Allows reserving checkout cart inventory for 15 minutes with auto-expiry

CREATE TABLE IF NOT EXISTS inventory_holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(255) NOT NULL,
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, EXPIRED, RELEASED, CONVERTED
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_holds_active_expiry
    ON inventory_holds(status, expires_at)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_inventory_holds_order
    ON inventory_holds(order_id);

CREATE TABLE IF NOT EXISTS inventory_hold_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hold_id UUID NOT NULL REFERENCES inventory_holds(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(hold_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_hold_items_hold
    ON inventory_hold_items(hold_id);
