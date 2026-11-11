-- AI content workflows (v3): pluggable AI connectors, visual workflow graphs,
-- and run traces. Generated content lands as drafts (optional approval = publish).

CREATE TABLE ai_connectors (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    provider    TEXT NOT NULL,            -- 'anthropic' | 'openai' | 'mock'
    api_key     TEXT,                     -- secret; never serialized back
    base_url    TEXT,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_connectors_org ON ai_connectors (org_id);

CREATE TABLE ai_workflows (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    graph       JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_workflows_org ON ai_workflows (org_id);

CREATE TABLE ai_runs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workflow_id  UUID NOT NULL REFERENCES ai_workflows(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'running',  -- running | succeeded | failed
    trace        JSONB NOT NULL DEFAULT '[]'::jsonb,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ
);
CREATE INDEX idx_ai_runs_workflow ON ai_runs (workflow_id, created_at DESC);
