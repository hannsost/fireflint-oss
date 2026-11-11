-- Authentication & authorization (WP1.3).
-- Users authenticate; memberships bind a user to an org with a role
-- (Owner/Editor/Viewer). API tokens authorize the public Delivery API and are
-- stored only as hashes (Whitepaper §19: Secret-Management).

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL DEFAULT '',
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, user_id)
);

-- A token is org-wide when website_id IS NULL, otherwise scoped to one channel
-- (so token A cannot read channel B — WP1.6 acceptance criterion).
CREATE TABLE api_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    website_id      UUID REFERENCES websites(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX idx_memberships_user ON memberships (user_id);
