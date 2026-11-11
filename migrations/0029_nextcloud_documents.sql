-- Never silently shadow a customer-defined schema with a new builtin.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM hub_kinds WHERE kind_key='external_document') THEN
        RAISE EXCEPTION 'external_document is already a custom kind; resolve the naming conflict with a reviewed data migration before upgrading';
    END IF;
END $$;
ALTER TABLE hub_connectors DROP CONSTRAINT hub_connectors_provider_check;
ALTER TABLE hub_connectors ADD CONSTRAINT hub_connectors_provider_check
    CHECK (provider IN ('hubspot','woocommerce','shopify','odoo','csv','json','pipedrive','erpnext','brevo','nextcloud'));
ALTER TABLE hub_connectors ADD COLUMN folder_path text;
ALTER TABLE hub_connectors ADD COLUMN share_metadata boolean NOT NULL DEFAULT false;
ALTER TABLE hub_connectors ADD CONSTRAINT hub_connectors_metadata_scope_check CHECK (
    (provider='nextcloud' AND folder_path IS NOT NULL AND length(folder_path)>1 AND share_metadata)
    OR (provider<>'nextcloud' AND folder_path IS NULL AND NOT share_metadata)
);
