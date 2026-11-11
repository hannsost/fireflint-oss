-- Private read-only machine credentials, separate from website delivery tokens.
CREATE TABLE hub_service_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 106),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    UNIQUE (org_id, id)
);
CREATE INDEX hub_service_access_org ON hub_service_access(org_id, created_at, id);

-- A transactional counter, NOT a sequence/BIGSERIAL: its row lock is held until
-- commit. A later writer cannot publish a higher cursor before an earlier one.
CREATE TABLE hub_service_heads (
    org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL DEFAULT 0 CHECK (sequence >= 0)
);
CREATE TABLE hub_service_changes (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    record_id UUID NOT NULL,
    kind TEXT NOT NULL,
    snapshot JSONB NOT NULL,
    PRIMARY KEY (org_id, sequence)
);
CREATE INDEX hub_service_changes_record ON hub_service_changes(org_id, record_id, sequence DESC);
CREATE INDEX hub_service_changes_kind ON hub_service_changes(org_id, kind, sequence);

-- Existing records become the baseline. Do not depend on old history containing
-- links (older snapshots may predate relationship versioning).
INSERT INTO hub_service_changes(org_id,sequence,record_id,kind,snapshot)
SELECT r.org_id, row_number() OVER (PARTITION BY r.org_id ORDER BY r.id), r.id, r.kind,
       to_jsonb(r) || jsonb_build_object('links',COALESCE(
           (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM hub_links l
            WHERE l.org_id=r.org_id AND l.from_id=r.id),'[]'::jsonb))
FROM hub_records r;
INSERT INTO hub_service_heads(org_id,sequence)
SELECT org_id,max(sequence) FROM hub_service_changes GROUP BY org_id;

CREATE FUNCTION hub_capture_service_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_sequence BIGINT;
BEGIN
    -- Same lock order as every supported hub writer: org first, then head row.
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text,76102));
    INSERT INTO hub_service_heads(org_id,sequence) VALUES(NEW.org_id,1)
    ON CONFLICT(org_id) DO UPDATE SET sequence=hub_service_heads.sequence+1
    RETURNING sequence INTO next_sequence;
    INSERT INTO hub_service_changes(org_id,sequence,record_id,kind,snapshot)
    VALUES(NEW.org_id,next_sequence,NEW.record_id,NEW.snapshot->>'kind',NEW.snapshot);
    RETURN NEW;
END;
$$;
CREATE TRIGGER hub_versions_service_change AFTER INSERT ON hub_versions
FOR EACH ROW EXECUTE FUNCTION hub_capture_service_change();
