-- AI creator (v3) extensions: connector-level preprompt + default model, and a
-- persistent per-workflow memory store (the `memory` node's store/recall/forget).

ALTER TABLE ai_connectors ADD COLUMN IF NOT EXISTS preprompt TEXT;
ALTER TABLE ai_connectors ADD COLUMN IF NOT EXISTS default_model TEXT;

CREATE TABLE IF NOT EXISTS ai_memory (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES ai_workflows(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, workflow_id, key)
);
CREATE INDEX IF NOT EXISTS idx_ai_memory_wf ON ai_memory (workflow_id);
