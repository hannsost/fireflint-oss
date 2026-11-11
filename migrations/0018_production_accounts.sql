-- Additive: preserve all historical migration checksums and existing content.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0);

-- A durable installation marker prevents a restarted bootstrap job from
-- resetting passwords, recreating deleted accounts or restoring removed roles.
CREATE TABLE installation_bootstrap (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    admin_id UUID NOT NULL,
    org_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
