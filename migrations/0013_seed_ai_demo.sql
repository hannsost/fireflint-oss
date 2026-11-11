-- Demo seed for the AI creator (v3): one mock connector + one example workflow
-- that exercises every node kind (trigger, parallel, agent, loop, join,
-- condition, output) and targets the demo 'standort' content type, so it runs
-- end-to-end even against the key-free `mock` provider. Idempotent.

INSERT INTO ai_connectors (id, org_id, name, provider, api_key, base_url) VALUES
    ('00000000-0000-0000-0000-0000000000a0', '00000000-0000-0000-0000-000000000001',
     'Mock (Test)', 'mock', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ai_workflows (id, org_id, name, graph) VALUES
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001',
     'Beispiel: Standort-Entwurf aus Stadtname',
     '{
       "nodes": [
         {"id":"start","type":"trigger","data":{"__pos":{"x":320,"y":0}}},
         {"id":"split","type":"parallel","data":{"__pos":{"x":320,"y":90}}},
         {"id":"address","type":"agent","data":{"model":"claude-sonnet-4-6","prompt":"Nenne eine plausible Beispieladresse (Strasse, PLZ Ort) fuer einen Unternehmensstandort in {{input}}. Antworte nur mit der Adresse.","__pos":{"x":80,"y":200}}},
         {"id":"phones","type":"loop","data":{"model":"claude-sonnet-4-6","iterations":2,"prompt":"Schlage eine plausible deutsche Festnetznummer fuer einen Standort in {{input}} vor (Variante #{{index}}). Nur die Nummer.","__pos":{"x":320,"y":200}}},
         {"id":"hours","type":"agent","data":{"model":"claude-sonnet-4-6","prompt":"Nenne typische Buero-Oeffnungszeiten in {{input}} im Format Mo-Fr 9-17 Uhr. Nur die Zeiten.","__pos":{"x":560,"y":200}}},
         {"id":"gather","type":"join","data":{"__pos":{"x":320,"y":320}}},
         {"id":"assemble","type":"agent","data":{"connector_id":null,"model":"claude-opus-4-8","system":"Du gibst ausschliesslich gueltiges JSON zurueck, ohne Erklaertext.","prompt":"Baue ein JSON-Objekt mit den Schluesseln \"name\", \"adresse\", \"telefon\", \"oeffnungszeiten\" fuer den Standort \"{{input}}\". Nutze diese Bausteine:\n{{gather}}","__pos":{"x":320,"y":430}}},
         {"id":"valid","type":"condition","data":{"input":"assemble","contains":"adresse","__pos":{"x":320,"y":540}}},
         {"id":"draft_ok","type":"output","data":{"content_type":"standort","mode":"draft","input":"assemble","__pos":{"x":160,"y":650}}},
         {"id":"draft_review","type":"output","data":{"content_type":"standort","mode":"draft","input":"assemble","__pos":{"x":480,"y":650}}}
       ],
       "edges": [
         {"source":"start","target":"split","branch":null},
         {"source":"split","target":"address","branch":null},
         {"source":"split","target":"phones","branch":null},
         {"source":"split","target":"hours","branch":null},
         {"source":"address","target":"gather","branch":null},
         {"source":"phones","target":"gather","branch":null},
         {"source":"hours","target":"gather","branch":null},
         {"source":"gather","target":"assemble","branch":null},
         {"source":"assemble","target":"valid","branch":null},
         {"source":"valid","target":"draft_ok","branch":"true"},
         {"source":"valid","target":"draft_review","branch":"false"}
       ]
     }'::jsonb)
ON CONFLICT (id) DO NOTHING;
