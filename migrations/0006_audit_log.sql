-- Audit log (WP1.4 / Whitepaper §19): an append-only record of writing actions.
-- user_id is nullable and ON DELETE SET NULL so the trail survives user removal.

CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id   UUID,
    meta        JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_org_created ON audit_log (org_id, created_at DESC);
