-- Scheduled publishing (v2). Optional timestamps; a background tick flips
-- status when they fall due. NULL means "no schedule".
ALTER TABLE content_objects
    ADD COLUMN publish_at   TIMESTAMPTZ,
    ADD COLUMN unpublish_at TIMESTAMPTZ;

CREATE INDEX idx_content_publish_at ON content_objects (publish_at)
    WHERE publish_at IS NOT NULL;
CREATE INDEX idx_content_unpublish_at ON content_objects (unpublish_at)
    WHERE unpublish_at IS NOT NULL;
