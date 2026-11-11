-- Public delivery must never read the mutable working copy. Backfill the
-- existing release without consuming a revision or changing public content.
ALTER TABLE content_objects
    ADD COLUMN published_data JSONB,
    ADD COLUMN published_channels JSONB,
    ADD COLUMN published_revision BIGINT,
    ADD COLUMN published_at TIMESTAMPTZ,
    ADD COLUMN publish_revision BIGINT;

UPDATE content_objects co
SET published_data = co.data,
    published_channels = COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'website_id', cca.website_id, 'overrides', cca.overrides
        ) ORDER BY cca.website_id)
        FROM content_channel_assignments cca
        JOIN websites w ON w.id = cca.website_id AND w.org_id = co.org_id
        WHERE cca.content_object_id = co.id
    ), '[]'::jsonb),
    published_revision = co.revision,
    published_at = co.updated_at
WHERE co.status = 'published';

-- Existing planned releases approve exactly the migrated working revision.
UPDATE content_objects SET publish_revision = revision WHERE publish_at IS NOT NULL;

ALTER TABLE content_objects
    ADD CONSTRAINT content_publication_complete CHECK (
        (status = 'published' AND published_data IS NOT NULL
         AND published_channels IS NOT NULL AND jsonb_typeof(published_channels) = 'array'
         AND published_revision IS NOT NULL AND published_revision > 0
         AND published_revision <= revision AND published_at IS NOT NULL)
        OR
        (status = 'draft' AND published_data IS NULL AND published_channels IS NULL
         AND published_revision IS NULL AND published_at IS NULL)
    ),
    ADD CONSTRAINT content_publish_revision_positive CHECK (
        publish_revision IS NULL OR publish_revision > 0
    );

-- PostgreSQL runs same-kind triggers alphabetically. This trigger follows
-- content_revision_on_write, so the release stores the resulting revision.
-- UPDATE OF status intentionally includes a same-status re-publication.
-- A data-only write never fires this trigger and cannot change public data.
CREATE FUNCTION snapshot_content_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'published' THEN
        NEW.published_data := NEW.data;
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'website_id', cca.website_id, 'overrides', cca.overrides
        ) ORDER BY cca.website_id), '[]'::jsonb)
        INTO NEW.published_channels
        FROM content_channel_assignments cca
        JOIN websites w ON w.id = cca.website_id AND w.org_id = NEW.org_id
        WHERE cca.content_object_id = NEW.id;
        NEW.published_revision := NEW.revision;
        NEW.published_at := now();
    ELSE
        NEW.published_data := NULL;
        NEW.published_channels := NULL;
        NEW.published_revision := NULL;
        NEW.published_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER content_snapshot_on_status
    BEFORE INSERT OR UPDATE OF status ON content_objects
    FOR EACH ROW EXECUTE FUNCTION snapshot_content_publication();
