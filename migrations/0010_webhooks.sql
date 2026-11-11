-- Outbound publish webhooks (v2). On publish/unpublish the core POSTs a signed
-- payload to each active endpoint so downstream sites can purge caches / rebuild.
CREATE TABLE webhooks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    secret      TEXT NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhooks_org ON webhooks (org_id);
