-- Preserve existing Instagram Login grants; Unified grants have their own
-- provider, permission family, client business and token-lifecycle semantics.
ALTER TABLE instagram_flows
    ADD COLUMN login_mode TEXT NOT NULL DEFAULT 'instagram_login' CHECK(login_mode IN ('instagram_login','unified')),
    ADD COLUMN config_id TEXT;
ALTER TABLE instagram_connections
    ALTER COLUMN expires_at DROP NOT NULL,
    ADD COLUMN login_mode TEXT NOT NULL DEFAULT 'instagram_login' CHECK(login_mode IN ('instagram_login','unified')),
    ADD COLUMN config_id TEXT,
    ADD COLUMN client_business_id TEXT,
    ADD COLUMN provider_subject TEXT,
    ADD COLUMN token_kind TEXT NOT NULL DEFAULT 'instagram_user' CHECK(token_kind IN ('instagram_user','business_integration_system_user')),
    ADD COLUMN last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN needs_revalidation BOOLEAN NOT NULL DEFAULT false;
UPDATE instagram_connections SET provider_subject=instagram_id WHERE provider_subject IS NULL;
ALTER TABLE instagram_connections ALTER COLUMN provider_subject SET NOT NULL;
ALTER TABLE instagram_connections ADD CONSTRAINT instagram_provider_binding CHECK(
    (login_mode='instagram_login' AND config_id IS NULL AND client_business_id IS NULL AND token_kind='instagram_user' AND expires_at IS NOT NULL)
    OR (login_mode='unified' AND config_id IS NOT NULL AND client_business_id IS NOT NULL AND token_kind='business_integration_system_user')
);
ALTER TABLE instagram_flows ADD CONSTRAINT instagram_flow_provider_binding CHECK(
    (login_mode='instagram_login' AND config_id IS NULL) OR (login_mode='unified' AND config_id IS NOT NULL)
);

ALTER TABLE instagram_revocations ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'instagram_account'
    CHECK(subject_kind IN ('instagram_account','system_user','business'));
ALTER TABLE instagram_revocations DROP CONSTRAINT instagram_revocations_pkey;
ALTER TABLE instagram_revocations ADD PRIMARY KEY(app_id,subject_kind,instagram_id);

-- An ambiguous multi-account grant is encrypted and stays unconnected until
-- the same initiating owner explicitly chooses an account, within ten minutes.
CREATE TABLE instagram_pending_grants (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_version INTEGER NOT NULL,
    expected_revision BIGINT NOT NULL,
    app_id TEXT NOT NULL,
    config_id TEXT NOT NULL,
    client_business_id TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    token_ciphertext TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    expires_at TIMESTAMPTZ,
    authorized_at TIMESTAMPTZ NOT NULL,
    accounts JSONB NOT NULL CHECK(jsonb_typeof(accounts)='array'),
    pending_until TIMESTAMPTZ NOT NULL
);
CREATE INDEX instagram_pending_expiry ON instagram_pending_grants(pending_until);

CREATE TABLE instagram_business_changes (app_id TEXT NOT NULL,business_id TEXT NOT NULL,changed_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(app_id,business_id));
