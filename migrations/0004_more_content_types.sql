-- ESP content types: Team + Jobs (dev plan WP1.2 scope: Team, Standorte, Jobs).
-- These are pure data thanks to the schema-driven model — no Rust changes.

INSERT INTO content_types (id, org_id, key, name, schema) VALUES
    ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'team', 'Teammitglied',
     '{"fields":[
        {"key":"name","label":"Name","type":"text","required":true},
        {"key":"rolle","label":"Rolle","type":"text","required":true},
        {"key":"email","label":"E-Mail","type":"text","required":false},
        {"key":"foto","label":"Foto","type":"media","required":false},
        {"key":"standort_ref","label":"Standort","type":"relation-ref","required":false}
     ]}'::jsonb),
    ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'job', 'Stellenanzeige',
     '{"fields":[
        {"key":"titel","label":"Titel","type":"text","required":true},
        {"key":"standort","label":"Standort","type":"text","required":true},
        {"key":"abteilung","label":"Abteilung","type":"text","required":false},
        {"key":"arbeitsmodell","label":"Arbeitsmodell","type":"select","required":false},
        {"key":"beschreibung","label":"Beschreibung","type":"richtext","required":false}
     ]}'::jsonb)
ON CONFLICT (id) DO NOTHING;
