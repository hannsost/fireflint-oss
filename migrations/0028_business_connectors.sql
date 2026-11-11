-- Extend the catalog without changing any historical migration or connector rows.
ALTER TABLE hub_connectors DROP CONSTRAINT hub_connectors_provider_check;
ALTER TABLE hub_connectors ADD CONSTRAINT hub_connectors_provider_check
    CHECK (provider IN ('hubspot','woocommerce','shopify','odoo','csv','json','pipedrive','erpnext','brevo'));
