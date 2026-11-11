-- Optimistic concurrency token shared by user edits and internal transitions.
-- Existing objects start at 1; IDs in content_versions remain history IDs,
-- not concurrency tokens (status changes do not create data snapshots).
ALTER TABLE content_objects
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE FUNCTION advance_content_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.revision := OLD.revision + 1;
    RETURN NEW;
END;
$$;

-- Increment even for a same-value write: a successful command consumes its
-- expected revision. Channel/schedule metadata edits do not change this token;
-- an actual scheduled status transition does, as do internal AI transitions.
CREATE TRIGGER content_revision_on_write
    BEFORE UPDATE OF data, status ON content_objects
    FOR EACH ROW EXECUTE FUNCTION advance_content_revision();
