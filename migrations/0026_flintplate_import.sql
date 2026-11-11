-- Confirmed manual source mappings; no remote credentials or automatic publication.
CREATE UNIQUE INDEX content_objects_org_identity ON content_objects(org_id,id);

CREATE TABLE hub_flintplate_connections (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id UUID NOT NULL,
    name TEXT NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 240),
    source_instance TEXT NOT NULL CHECK (octet_length(source_instance) BETWEEN 1 AND 160),
    source_tenant TEXT NOT NULL CHECK (octet_length(source_tenant) BETWEEN 1 AND 160),
    venue_id UUID NOT NULL,
    content_id UUID NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    enabled BOOLEAN NOT NULL DEFAULT true,
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(org_id,id),
    UNIQUE(org_id,source_instance,source_tenant,venue_id),
    UNIQUE(org_id,content_id),
    -- Deferred NO ACTION permits complete org teardown, not isolated target deletion.
    FOREIGN KEY(org_id,content_id) REFERENCES content_objects(org_id,id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE hub_flintplate_receipts (
    org_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    request_id UUID NOT NULL,
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(org_id,connection_id,request_id),
    FOREIGN KEY(org_id,connection_id) REFERENCES hub_flintplate_connections(org_id,id)
        ON DELETE CASCADE
);

-- All content writers, including internal workflows, preserve the imported source.
-- The importer changes mapping.snapshot then content.data within one transaction.
CREATE FUNCTION guard_flintplate_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM hub_flintplate_connections c
               WHERE c.org_id=OLD.org_id AND c.content_id=OLD.id
                 AND (NEW.org_id IS DISTINCT FROM OLD.org_id
                   OR NEW.id IS DISTINCT FROM OLD.id
                   OR NEW.content_type_id IS DISTINCT FROM OLD.content_type_id
                   OR NEW.data IS DISTINCT FROM c.snapshot)) THEN
        RAISE EXCEPTION 'managed_menu_requires_import' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER content_flintplate_guard BEFORE UPDATE ON content_objects
    FOR EACH ROW EXECUTE FUNCTION guard_flintplate_content();

CREATE FUNCTION guard_flintplate_overrides() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.overrides IS NOT NULL AND NEW.overrides <> '{}'::jsonb
       AND EXISTS (SELECT 1 FROM hub_flintplate_connections WHERE content_id=NEW.content_object_id) THEN
        RAISE EXCEPTION 'managed_menu_disallows_overrides' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER channel_flintplate_guard BEFORE INSERT OR UPDATE ON content_channel_assignments
    FOR EACH ROW EXECUTE FUNCTION guard_flintplate_overrides();
