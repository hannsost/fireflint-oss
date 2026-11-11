-- Media assets (v2 content depth). Binary bytes live in a blob store; this
-- table holds only metadata + an opaque storage key. Org-scoped like everything
-- else (Whitepaper §19/§20).
CREATE TABLE assets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size    BIGINT NOT NULL,
    storage_key  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assets_org ON assets (org_id);
