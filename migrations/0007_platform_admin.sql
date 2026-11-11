-- Platform administration (cross-organization control plane).
--
-- Storage targets, bindings and the cluster view span organizations, so they
-- are gated by a dedicated platform-admin flag rather than an org-scoped role.
-- The flag is carried in the access JWT (claim `pa`), so both the core and the
-- read-only cluster BFF can authorize without a database lookup.
ALTER TABLE users
    ADD COLUMN is_platform_admin BOOLEAN NOT NULL DEFAULT false;
