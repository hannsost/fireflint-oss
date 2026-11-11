-- SiteGraph core schema (WP1.1).
-- Multi-tenancy is present from day one: everything is scoped by org_id
-- (Whitepaper §19/§20), even though the skeleton seeds a single org.

CREATE TABLE organizations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE websites (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    domain      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, slug)
);

-- Schema-driven content types: new types are data, not code (dev plan §A).
CREATE TABLE content_types (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    name        TEXT NOT NULL,
    schema      JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (org_id, key)
);

CREATE TABLE content_objects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    content_type_id UUID NOT NULL REFERENCES content_types(id) ON DELETE RESTRICT,
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    data            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_objects_org_type ON content_objects (org_id, content_type_id);

-- Assignment of a content object to a website + optional local overrides (§6).
CREATE TABLE content_channel_assignments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_object_id   UUID NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
    website_id          UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
    overrides           JSONB,
    UNIQUE (content_object_id, website_id)
);

CREATE INDEX idx_cca_website ON content_channel_assignments (website_id);
