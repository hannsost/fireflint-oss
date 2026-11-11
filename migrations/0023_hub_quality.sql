-- Optional private data-quality evidence. Scans never mutate source records.
CREATE TABLE hub_quality_rules (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_by UUID NOT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, kind)
);
CREATE TABLE hub_quality_rule_versions (
    org_id UUID NOT NULL,
    kind TEXT NOT NULL,
    revision BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, kind, revision),
    FOREIGN KEY (org_id, kind) REFERENCES hub_quality_rules(org_id, kind) ON DELETE CASCADE
);
CREATE TABLE hub_quality_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    rule_revision BIGINT NOT NULL,
    kind_revision BIGINT NOT NULL,
    definition JSONB NOT NULL,
    records JSONB NOT NULL CHECK (jsonb_typeof(records) = 'array'),
    total_records BIGINT NOT NULL CHECK (total_records >= 0),
    captured_records INTEGER NOT NULL CHECK (captured_records BETWEEN 0 AND 1000),
    processed_records INTEGER NOT NULL DEFAULT 0 CHECK (processed_records >= 0 AND processed_records <= captured_records),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, kind) REFERENCES hub_quality_rules(org_id, kind)
);
CREATE INDEX hub_quality_scans_org ON hub_quality_scans(org_id, kind, created_at DESC, id DESC);
CREATE TABLE hub_quality_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scan_id UUID NOT NULL,
    rule_key TEXT NOT NULL,
    anchor_id UUID NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('completeness','freshness','name_hint','duplicate_hint')),
    explanation TEXT NOT NULL,
    evidence JSONB NOT NULL,
    refs JSONB NOT NULL CHECK (jsonb_typeof(refs) = 'array'),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','resolved','dismissed')),
    assignee_id UUID REFERENCES users(id),
    comment TEXT NOT NULL DEFAULT '',
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    UNIQUE (org_id, scan_id, rule_key, anchor_id),
    FOREIGN KEY (org_id, scan_id) REFERENCES hub_quality_scans(org_id, id) ON DELETE CASCADE
);
CREATE INDEX hub_quality_findings_scan ON hub_quality_findings(org_id, scan_id, created_at, id);
CREATE TABLE hub_quality_finding_versions (
    org_id UUID NOT NULL,
    finding_id UUID NOT NULL,
    revision BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, finding_id, revision),
    FOREIGN KEY (org_id, finding_id) REFERENCES hub_quality_findings(org_id, id) ON DELETE CASCADE
);
