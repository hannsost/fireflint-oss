-- Demo seed (WP1.1 / WP1.11). Fixed UUIDs so the skeleton is reproducible and
-- the API can resolve the demo tenant without auth (DEMO_ORG_ID).
-- Idempotent via ON CONFLICT so re-running migrations is safe.

INSERT INTO organizations (id, name, slug) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Demo GmbH', 'demo')
ON CONFLICT (id) DO NOTHING;

INSERT INTO websites (id, org_id, name, slug, domain) VALUES
    ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000001', 'Hauptwebsite', 'hauptseite', 'hauptfirma.de'),
    ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Karriere',     'karriere',  'karriere.hauptfirma.de')
ON CONFLICT (id) DO NOTHING;

-- One content type for the skeleton: Standort (location).
INSERT INTO content_types (id, org_id, key, name, schema) VALUES
    ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'standort', 'Standort',
     '{"fields":[
        {"key":"name","label":"Name","type":"text","required":true},
        {"key":"adresse","label":"Adresse","type":"text","required":true},
        {"key":"telefon","label":"Telefon","type":"text","required":false},
        {"key":"oeffnungszeiten","label":"Öffnungszeiten","type":"text","required":false}
     ]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Two published locations.
INSERT INTO content_objects (id, org_id, content_type_id, status, data) VALUES
    ('00000000-0000-0000-0000-000000001000', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'published',
     '{"name":"Darmstadt","adresse":"Rheinstraße 1, 64283 Darmstadt","telefon":"06151-100","oeffnungszeiten":"Mo-Fr 9-17 Uhr"}'::jsonb),
    ('00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'published',
     '{"name":"Frankfurt","adresse":"Zeil 10, 60313 Frankfurt","telefon":"069-200","oeffnungszeiten":"Mo-Fr 9-18 Uhr"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Darmstadt appears on both sites; on Karriere with a local override (§6 demo).
INSERT INTO content_channel_assignments (content_object_id, website_id, overrides) VALUES
    ('00000000-0000-0000-0000-000000001000', '00000000-0000-0000-0000-000000000100', NULL),
    ('00000000-0000-0000-0000-000000001000', '00000000-0000-0000-0000-000000000101',
     '{"telefon":"06151-100-JOBS","oeffnungszeiten":"Bewerbung: Mo-Fr 8-20 Uhr"}'::jsonb),
    -- Frankfurt only on the main site.
    ('00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000000100', NULL)
ON CONFLICT (content_object_id, website_id) DO NOTHING;
