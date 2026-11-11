-- Explicit inbound connectors. Credentials never appear in public projections.
CREATE TABLE hub_connectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
    provider TEXT NOT NULL CHECK (provider IN ('hubspot','woocommerce','shopify','odoo','csv','json')),
    object_type TEXT NOT NULL,
    base_url TEXT,
    database TEXT,
    mapping JSONB,
    enabled BOOLEAN NOT NULL DEFAULT true,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    credentials_ciphertext TEXT,
    retry_at TIMESTAMPTZ,
    last_error JSONB,
    lease_id UUID,
    lease_until TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, source_id) REFERENCES hub_records(org_id, id)
);
CREATE INDEX hub_connectors_org ON hub_connectors(org_id, created_at DESC, id);
CREATE TABLE hub_connector_previews (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    connector_id UUID NOT NULL,
    connector_revision BIGINT NOT NULL,
    import_input JSONB NOT NULL,
    report JSONB NOT NULL,
    result JSONB,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
    applied_at TIMESTAMPTZ,
    FOREIGN KEY (org_id, connector_id) REFERENCES hub_connectors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX hub_connector_previews_org ON hub_connector_previews(org_id, connector_id, created_at DESC);
