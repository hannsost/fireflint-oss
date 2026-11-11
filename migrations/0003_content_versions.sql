-- Content versioning (WP1.5 / Whitepaper §8).
-- An immutable snapshot of `data` is written on every create/update/revert.
-- created_by is nullable until auth lands (WP1.3).

CREATE TABLE content_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_object_id   UUID NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
    data                JSONB NOT NULL,
    created_by          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_versions_object ON content_versions (content_object_id, created_at DESC);
