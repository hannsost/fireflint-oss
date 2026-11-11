-- A provider refresh token is single-use when Keycloak rotation/MaxReuse=0 is
-- enabled. Claiming it in the database prevents concurrent browser requests
-- from spending the same token twice. The short claim lease only recovers from
-- a crashed worker; an ambiguous provider exchange revokes the local session.
ALTER TABLE oidc_sessions
    ADD COLUMN refresh_version INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refresh_nonce UUID,
    ADD COLUMN refresh_started_at TIMESTAMPTZ,
    ADD CONSTRAINT oidc_sessions_refresh_claim_complete
        CHECK ((refresh_nonce IS NULL) = (refresh_started_at IS NULL));

CREATE INDEX oidc_sessions_refresh_claim
    ON oidc_sessions(refresh_started_at)
    WHERE refresh_nonce IS NOT NULL AND revoked_at IS NULL;
