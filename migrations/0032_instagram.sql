-- Optional direct Instagram integration. All credentials remain server-side.
CREATE TABLE instagram_flows (
    state_hash TEXT PRIMARY KEY,
    browser_hash TEXT NOT NULL,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_version INTEGER NOT NULL,
    app_id TEXT NOT NULL,
    expected_revision BIGINT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX instagram_flow_expiry ON instagram_flows(expires_at);

CREATE TABLE instagram_connections (
    org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    id UUID NOT NULL UNIQUE,
    instagram_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    authorized_at TIMESTAMPTZ NOT NULL,
    username TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    token_ciphertext TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK(revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX instagram_active_account ON instagram_connections(instagram_id) WHERE active;

CREATE TABLE instagram_publications (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,
    instagram_id TEXT NOT NULL,
    content_id UUID NOT NULL,
    content_revision BIGINT NOT NULL,
    website_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    payload JSONB NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('creating','prepared','publishing','published','outcome_unknown','rejected')),
    revision BIGINT NOT NULL DEFAULT 1,
    container_id TEXT,
    media_id TEXT,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id,idempotency_key),
    UNIQUE(org_id,instagram_id,content_id,content_revision,website_id)
);
CREATE INDEX instagram_publication_history ON instagram_publications(org_id,created_at DESC);

-- Anonymous confirmation receipt; no account, organization or token data.
CREATE TABLE instagram_deletion_receipts (
    confirmation_hash TEXT PRIMARY KEY,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE instagram_revocations (app_id TEXT NOT NULL,instagram_id TEXT NOT NULL,revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(app_id,instagram_id));
