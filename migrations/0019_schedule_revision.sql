-- Scheduling has its own revision: changing a deadline must not manufacture
-- unpublished content changes or alter the immutable publication snapshot.
ALTER TABLE content_objects
    ADD COLUMN schedule_revision BIGINT NOT NULL DEFAULT 1
    CHECK (schedule_revision > 0);

CREATE FUNCTION bump_content_schedule_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.schedule_revision := OLD.schedule_revision + 1;
    RETURN NEW;
END;
$$;

-- Includes manual publish/unpublish, scheduler cleanup and same-value writes.
-- An old planning form can never resurrect a cleared or replaced deadline.
CREATE TRIGGER content_schedule_revision_on_write
    BEFORE UPDATE OF publish_at, unpublish_at, publish_revision ON content_objects
    FOR EACH ROW EXECUTE FUNCTION bump_content_schedule_revision();
