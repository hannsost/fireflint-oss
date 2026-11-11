-- Optional, private, manually maintained Omarchy inventory. No device credentials
-- or command channel are introduced by this migration.
CREATE TABLE hub_devices (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id UUID NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
    inventory_number TEXT NOT NULL CHECK (inventory_number ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('in_stock','in_use','repair','retired')),
    company_id UUID,
    contact_id UUID,
    location_id UUID,
    details JSONB NOT NULL CHECK (jsonb_typeof(details) = 'object'),
    archived BOOLEAN NOT NULL DEFAULT false,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, inventory_number),
    FOREIGN KEY (org_id, company_id) REFERENCES hub_records(org_id, id),
    FOREIGN KEY (org_id, contact_id) REFERENCES hub_records(org_id, id),
    FOREIGN KEY (org_id, location_id) REFERENCES hub_records(org_id, id)
);
CREATE INDEX hub_devices_page ON hub_devices(org_id, archived, inventory_number, id);
CREATE TABLE hub_device_versions (
    org_id UUID NOT NULL,
    device_id UUID NOT NULL,
    revision BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, device_id, revision),
    FOREIGN KEY (org_id, device_id) REFERENCES hub_devices(org_id, id) ON DELETE CASCADE
);
