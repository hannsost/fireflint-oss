-- Campaign dates are editorial intentions, never publication deadlines.
CREATE UNIQUE INDEX content_objects_org_id_id ON content_objects(org_id,id);

CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL CHECK (end_date >= start_date),
    time_zone TEXT NOT NULL,
    platforms TEXT[] NOT NULL,
    rules JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(rules)='object'),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','archived')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id,id)
);
CREATE INDEX campaigns_org_dates ON campaigns(org_id,start_date,end_date);

CREATE TABLE campaign_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    campaign_id UUID NOT NULL,
    content_id UUID NOT NULL,
    desired_date DATE NOT NULL,
    desired_time TEXT CHECK (desired_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    reviewed_content_revision BIGINT NOT NULL CHECK (reviewed_content_revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id,id),
    UNIQUE(org_id,content_id,platform),
    FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON DELETE CASCADE,
    FOREIGN KEY(org_id,content_id) REFERENCES content_objects(org_id,id) ON DELETE CASCADE
);
CREATE INDEX campaign_entries_calendar ON campaign_entries(org_id,desired_date,campaign_id);

CREATE TABLE campaign_generation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    campaign_id UUID NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key TEXT NOT NULL,
    request JSONB NOT NULL,
    snapshot JSONB NOT NULL,
    campaign_revision BIGINT NOT NULL CHECK (campaign_revision > 0),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','blocked','cancelled')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    claim_owner UUID,
    claim_key TEXT,
    claim_nonce UUID,
    lease_version BIGINT NOT NULL DEFAULT 0,
    lease_expires_at TIMESTAMPTZ,
    heartbeat_key TEXT,
    result_hash TEXT,
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id,id),
    UNIQUE(org_id,campaign_id,idempotency_key),
    FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON DELETE CASCADE
);
CREATE INDEX campaign_generation_queue ON campaign_generation_runs(created_at,id) WHERE status='queued';
