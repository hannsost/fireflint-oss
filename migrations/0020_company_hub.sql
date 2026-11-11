-- Private company data. No table participates in public content delivery.
CREATE TABLE hub_modules (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    module_key TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, module_key)
);
CREATE TABLE hub_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
    data JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    archived BOOLEAN NOT NULL DEFAULT false,
    source_id UUID,
    external_id TEXT,
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    UNIQUE (org_id, source_id, external_id),
    CHECK ((source_id IS NULL) = (external_id IS NULL)),
    FOREIGN KEY (org_id, source_id) REFERENCES hub_records(org_id, id)
);
CREATE INDEX hub_records_search ON hub_records (org_id, kind, updated_at DESC, id);
CREATE TABLE hub_versions (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    record_id UUID NOT NULL,
    revision BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, record_id, revision),
    FOREIGN KEY (org_id, record_id) REFERENCES hub_records(org_id, id) ON DELETE CASCADE
);
CREATE TABLE hub_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    from_id UUID NOT NULL,
    to_id UUID NOT NULL,
    relation TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (from_id <> to_id),
    UNIQUE (org_id, from_id, to_id, relation),
    FOREIGN KEY (org_id, from_id) REFERENCES hub_records(org_id, id),
    FOREIGN KEY (org_id, to_id) REFERENCES hub_records(org_id, id)
);
CREATE TABLE hub_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id),
    event_type TEXT NOT NULL,
    subject TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hub_events_org ON hub_events (org_id, created_at DESC, id);
CREATE TABLE hub_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    assignee_id UUID NOT NULL REFERENCES users(id),
    created_by UUID NOT NULL REFERENCES users(id),
    record_id UUID,
    subject_revision BIGINT,
    requires_approval BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','approved','rejected')),
    due_at TIMESTAMPTZ,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, record_id) REFERENCES hub_records(org_id, id),
    CHECK (NOT requires_approval OR (record_id IS NOT NULL AND subject_revision > 0 AND assignee_id <> created_by))
);
CREATE INDEX hub_tasks_org ON hub_tasks(org_id, status, due_at);
CREATE TABLE hub_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES hub_tasks(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE hub_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    task_id UUID REFERENCES hub_tasks(id) ON DELETE CASCADE,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hub_notifications_user ON hub_notifications(org_id, user_id, created_at DESC);
CREATE TABLE hub_forms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    fields JSONB NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    published BOOLEAN NOT NULL DEFAULT false,
    public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    created_by UUID NOT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, id)
);
CREATE TABLE hub_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    form_id UUID NOT NULL,
    form_revision BIGINT NOT NULL,
    form_snapshot JSONB NOT NULL,
    data JSONB NOT NULL,
    submission_key UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','processing','closed')),
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (form_id, submission_key),
    FOREIGN KEY (org_id, form_id) REFERENCES hub_forms(org_id, id)
);
CREATE TABLE hub_translations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    record_id UUID NOT NULL,
    locale TEXT NOT NULL,
    source_revision BIGINT NOT NULL,
    data JSONB NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    updated_by UUID NOT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, record_id, locale),
    FOREIGN KEY (org_id, record_id) REFERENCES hub_records(org_id, id)
);
CREATE TABLE hub_media (
    asset_id UUID PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    alt_text TEXT NOT NULL DEFAULT '',
    credit TEXT NOT NULL DEFAULT '',
    license TEXT NOT NULL DEFAULT '',
    collection TEXT NOT NULL DEFAULT '',
    revision BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE hub_media_usage (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    record_id UUID NOT NULL,
    PRIMARY KEY (org_id, asset_id, record_id),
    FOREIGN KEY (org_id, record_id) REFERENCES hub_records(org_id, id)
);
CREATE TABLE hub_bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    resource_id UUID NOT NULL,
    title TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
    revision BIGINT NOT NULL DEFAULT 1,
    created_by UUID NOT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    FOREIGN KEY (org_id, resource_id) REFERENCES hub_records(org_id, id)
);
CREATE INDEX hub_bookings_resource ON hub_bookings(org_id, resource_id, starts_at, ends_at) WHERE status = 'confirmed';
CREATE TABLE hub_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_id UUID NOT NULL,
    request_key UUID NOT NULL,
    request_hash TEXT NOT NULL,
    result JSONB NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, request_key),
    FOREIGN KEY (org_id, source_id) REFERENCES hub_records(org_id, id)
);

CREATE TABLE hub_form_versions (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    form_id UUID NOT NULL,
    revision BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(org_id,form_id,revision),
    FOREIGN KEY(org_id,form_id) REFERENCES hub_forms(org_id,id) ON DELETE CASCADE
);
CREATE TABLE hub_media_versions (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(org_id,asset_id,revision)
);

CREATE TABLE hub_kinds (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind_key TEXT NOT NULL,
    name TEXT NOT NULL,
    fields JSONB NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(org_id,kind_key)
);
