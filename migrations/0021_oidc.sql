-- Optional OIDC is additive. An issuer/subject is never resolved by email.
CREATE TABLE oidc_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (issuer, subject),
    UNIQUE (user_id, issuer)
);

CREATE TABLE oidc_flows (
    state_hash TEXT PRIMARY KEY,
    browser_hash TEXT NOT NULL,
    issuer TEXT NOT NULL,
    nonce_hash TEXT NOT NULL,
    verifier_ciphertext TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    session_version INTEGER,
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK ((user_id IS NULL) = (session_version IS NULL))
);
CREATE INDEX oidc_flows_expiry ON oidc_flows(expires_at);

CREATE TABLE oidc_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    provider_sid TEXT,
    session_version INTEGER NOT NULL,
    access_ciphertext TEXT NOT NULL,
    refresh_ciphertext TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oidc_sessions_user ON oidc_sessions(user_id);
CREATE INDEX oidc_sessions_provider ON oidc_sessions(issuer, provider_sid);
CREATE INDEX oidc_sessions_subject ON oidc_sessions(issuer, subject);

-- Durable replay protection plus logout/login race protection. Kept for 24h;
-- accepted logout tokens are at most two minutes old and local sessions <=15m.
CREATE TABLE oidc_logout_events (
    issuer TEXT NOT NULL,
    jti TEXT NOT NULL,
    subject TEXT,
    provider_sid TEXT,
    issued_at BIGINT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (issuer, jti),
    CHECK (subject IS NOT NULL OR provider_sid IS NOT NULL)
);
