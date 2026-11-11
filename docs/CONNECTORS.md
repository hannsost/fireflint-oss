# Eingehende Unternehmensdaten-Adapter

Stand: 23.09.2026. Die Adapter lesen externe Daten in eine gespeicherte Vorschau.
Erst **Vorschau übernehmen** schreibt private Hub-Datensätze. Das aktiviert keine
öffentliche Website-Auslieferung und schreibt nichts beim Anbieter zurück.

## Unterstützte Protokolle

| Adapter | Unterstützter Stand | Objekte → Hub | Zugang / Berechtigungen |
| --- | --- | --- | --- |
| HubSpot | CRM Objects v3 | contacts → contact, companies → company | Bestehender privater App-Token; `crm.objects.contacts.read` bzw. `crm.objects.companies.read` |
| WooCommerce | WordPress REST `wc/v3` | products → product, customers → contact | Lesender Consumer Key + Consumer Secret; Basic Auth über HTTPS |
| Shopify | Admin GraphQL `2026-07` | products → product | Bestehender Admin-API-Token mit `read_products` |
| Odoo | 19 JSON-2 | `res.partner` → company/contact, `product.template` → product | API-Key eines Benutzers mit Leserechten, optional Datenbankname |
| Pipedrive | API v2 | persons → contact, organizations → company | Benutzer-/firmengebundener API-Token, Zugriff auf gewünschte Kontakte/Firmen |
| ERPNext | Frappe REST v1, ERPNext 15+ Standardschema | Customer/Supplier (Company) → company, Item → product | API-Key + API-Secret eines Benutzers mit passenden Leserechten |
| Brevo | Contacts API v3 | contacts → contact | API-Key für Kontaktzugriff |
| CSV | UTF-8, RFC-4180-Zitierung | Zuordnung zu company/contact/location/product | Lokaler Dateiinhalt; keine Zugangsdaten |
| JSON | Array von Objekten | Zuordnung zu company/contact/location/product | Lokaler Dateiinhalt; keine Zugangsdaten |

HubSpot liefert Namen, E-Mail, Telefon und Position bzw. Firmennamen, Website,
Telefon und Anschrift. WooCommerce liefert Produktname, SKU und Beschreibung bzw.
Kundenname, E-Mail und Telefon. Shopify liefert Produktname und Textbeschreibung;
SKU gehört zu Varianten und wird deshalb nicht durch einen Produkt-Handle ersetzt.
Odoo liefert Partnernamen, E-Mail, Telefon, Position bzw. Anschrift, Website,
Steuerkennung sowie Produktname, Artikelkennung und Verkaufsbeschreibung.

Pipedrive liest Kontakte mit Name, primärer E-Mail, primärer Telefonnummer und
optional vorhandener Position sowie Firmenname und Anschrift. Ohne als primär
markierten Eintrag wird der erste Kontaktwert verwendet. Benutzerdefinierte
Felder, Deals und Beziehungen werden nicht übertragen. Die Position hängt vom
Pipedrive-Kontaktsync ab. API-Tokens können weitergehende Rechte besitzen, auch
wenn FireFlint ausschließlich GET-Aufrufe verwendet.

ERPNext liest Firmenkunden und Firmenlieferanten (Typ `Company`) mit Name und
Steuerkennung sowie Artikel mit Name, Artikelnummer und Beschreibung. Private
Kunden/Lieferanten werden nicht zu Unternehmen umgedeutet. Verknüpfte Adressen,
Kontakte, Buchungsbelege und Variantenbeziehungen sind nicht enthalten. Die
öffentliche HTTPS-Origin auf Port 443 ist erforderlich; private Intranetadressen
bleiben durch die bestehende Outbound-Prüfung gesperrt.

Brevo liest Kontakt-ID, E-Mail, Name aus `FIRSTNAME`/`LASTNAME` oder
`FIRST_NAME`/`LAST_NAME` und Telefon aus `SMS`. Wenn kein Name vorliegt, dient die
E-Mail oder Telefonnummer als Bezeichnung. Listen, Kampagnen, beliebige Attribute
und Einwilligungen werden nicht importiert. **Ein Hub-Kontakt ist keine
Marketingfreigabe.** Sperrlisten und Versandentscheidungen bleiben in Brevo;
FireFlint versendet über diesen Adapter nichts und ändert keinen Brevo-Kontakt.

Bewusste Grenzen: keine Varianten, Preise, Bestände, Bestellungen, Beziehungen,
Löschungsübernahme, automatische Zeitpläne oder Rückschreibungen. OAuth-App-Installation
und Token-Erneuerung sind nicht Bestandteil dieses Adapters. Abgelaufene Tokens
werden vom Owner ersetzt. Odoo benötigt den freigeschalteten externen API-Zugang;
verfügbare Felder und Leserechte hängen von der jeweiligen Installation ab.

Die Protokollimplementierungen wurden anhand aktueller offizieller Dokumentation
entwickelt: [HubSpot Objects v3](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/objects/get-objects),
[HubSpot Kontakte](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide),
[WooCommerce REST v3](https://developer.woocommerce.com/docs/apis/rest-api/v3/),
[Produkte](https://developer.woocommerce.com/docs/apis/rest-api/v3/products/),
[Kunden](https://developer.woocommerce.com/docs/apis/rest-api/v3/customers/),
[Shopify products](https://shopify.dev/docs/api/admin-graphql/latest/queries/products),
[Odoo JSON-2](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html),
[Pipedrive Personen](https://developers.pipedrive.com/docs/api/v1/Persons),
[Pipedrive Organisationen](https://developers.pipedrive.com/docs/api/v1/Organizations),
[Pipedrive v2-Datenformat](https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide),
[Pipedrive Authentifizierung](https://pipedrive.readme.io/docs/core-api-concepts-authentication),
[Frappe REST](https://docs.frappe.io/framework/user/en/api/rest),
[ERPNext Customer-Schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/selling/doctype/customer/customer.json),
[ERPNext Supplier-Schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/buying/doctype/supplier/supplier.json),
[ERPNext Item-Schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/stock/doctype/item/item.json),
[Brevo Contacts](https://developers.brevo.com/reference/get-contacts).
Implementiert sind explizite Protokollstände; die Referenzseiten können spätere
Versionen beschreiben. Keine Kundenzugangsdaten lagen vor. Isolierte HTTP-Fixtures
sind keine Abnahme einer realen Kundenanbindung.

## Bedienung und API

1. Owner aktiviert das Modul `integrations` und legt einen Hub-Datensatz `source`
   mit Name, System und Zuständigkeit an.
2. Owner konfiguriert die Verbindung und wählt Quelle, Objekttyp und Zugangsdaten.
   Provider, Objekttyp, Quelle, Basisadresse und Datenbank sind danach unveränderlich.
   Zum Wechsel des verbundenen Systems eine eigene Verbindung/Quelle anlegen.
3. Owner oder Editor ruft eine Vorschau ab. Dateien benötigen eine explizite
   Feldzuordnung. Viewer kann Konfiguration und gespeicherte Vorschauen lesen.
4. Die Vorschau enthält vollständige Übernahmedaten, Aktion und exakt erfasste
   Hub-Revision je Zeile. Bei größeren Provider-Beständen kann nach Übernahme eine
   weitere Charge mit dem zurückgegebenen `next_cursor` abgerufen werden.
5. Eine ausdrückliche Übernahme überträgt die gespeicherte Charge atomar. Eine
   inzwischen geänderte Hub- oder Connector-Revision führt zu HTTP 409. Alte
   Vorschauen bleiben unverändert; neu abrufen und prüfen ist eine separate Aktion.

Alle folgenden Pfade stehen unter `/api` und verlangen eine Access-Session:

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/hub/connectors/catalog` | Unterstützte Richtungen, Versionen und Objekte |
| GET / POST | `/orgs/:org/hub/connectors` | Verbindungen lesen / anlegen |
| PUT | `/orgs/:org/hub/connectors/:id` | Revisionsgeprüfte Konfiguration |
| POST | `/orgs/:org/hub/connectors/:id/preview` | Anbieter/Datei lesen und Plan speichern |
| GET | `/orgs/:org/hub/connectors/:id/previews/:preview` | Unveränderten Plan lesen |
| POST | `/orgs/:org/hub/connectors/:id/previews/:preview/apply` | Genau diesen Plan übernehmen |

Konfigurationsbody (`expected_revision:0` bei Anlage; gelesene Revision bei Änderung):

```json
{
  "name":"Kontaktimport", "provider":"json", "object_type":"rows",
  "source_id":"<UUID der aktiven Datenquelle>",
  "base_url":null, "database":null, "credentials":null,
  "mapping":{
    "kind":"contact", "external_id":"id", "name":"profile.name",
    "fields":{"name":"profile.name","email":"profile.email"}, "delimiter":","
  },
  "enabled":true, "expected_revision":0
}
```

Provider-Konfigurationen verwenden `mapping:null`. HubSpot verwendet automatisch
`https://api.hubapi.com` und verlangt `base_url:null`. WooCommerce akzeptiert die
HTTPS-Basis des Shops einschließlich eines WordPress-Unterverzeichnisses. Shopify
verlangt die ursprüngliche `https://<shop>.myshopify.com`-Adresse. Odoo verwendet
seine HTTPS-Origin und optional `database`. Pipedrive verlangt die direkte
`https://<firma>.pipedrive.com`-Origin; Brevo verwendet fest `https://api.brevo.com`
und verlangt `base_url:null`. ERPNext verwendet die öffentliche HTTPS-Origin
seiner Installation. WooCommerce-Zugangsdaten sind `{consumer_key,consumer_secret}`,
ERPNext verwendet `{api_key,api_secret}`, die übrigen Online-Adapter `{token}`.
ERPNext sendet `Authorization: token <key>:<secret>`, Pipedrive `x-api-token`,
Brevo `api-key`; keine Zugangsdaten stehen in URL-Parametern.
Bei Änderungen erhält `credentials:null` bzw. ein ausgelassenes Feld den
vorhandenen Schlüssel; ein neues Objekt ersetzt ihn. Listen und Einzelantworten
liefern ausschließlich `has_credentials`, niemals verschlüsselte oder offene Werte.

Vorschau: `{expected_revision:1,content:"<CSV/JSON-Text>"}` bei Dateien,
`{expected_revision:1,cursor:null}` beim ersten Provider-Abruf. Sie liefert
`id,connector_id,connector_revision,status,applied,expires_at,next_cursor,rows`.
Jede Zeile enthält `external_id,kind,name,data,expected_revision,current_revision,
action,conflict`. Online-Kennungen werden mit dem Objekttyp präfixiert, beispielsweise
`contacts:123` oder `products:gid://shopify/Product/123`; Datei-Kennungen werden
unverändert verwendet. Das verhindert Kollisionen verschiedener Objektfamilien.

Übernahmebody: `{expected_revision:<connector_revision aus Vorschau>}`. Der Server
liest die Datensätze aus dem gespeicherten Plan, nicht aus neu angelieferten Zeilen.
Das Resultat ist `{applied:true,request_key,rows:[Hub-Datensätze]}`. Parallele oder
wiederholte Übernahme desselben Plans liefert dieselbe Bestätigung. Neue Änderungen
werden niemals auf Basis einer automatisch neu gelesenen Revision überschrieben.

Dateien: exakte CSV-Spaltennamen, für JSON Punktpfade einschließlich numerischer
Array-Indizes; nur skalare Werte/null. CSV unterstützt Komma, Semikolon und Tab,
BOM, CRLF, eingebettete Zeilenumbrüche und doppelte Anführungszeichen. Doppelte
Spalten, widersprüchliche Zeilenlängen, doppelte Kennungen, fehlende Pfade, unbekannte
Zielfelder und fehlende Pflichtzuordnungen werden abgelehnt. Pflichtfelder:
`legal_name` für Unternehmen, `name` für andere Typen, zusätzlich `address` für
Standorte. Es gibt keine Skripte, Formelauswertung oder URL-Downloads aus Dateien.

Felder, die ein Adapter nicht liefert, werden aus dem aktuellen Hub-Datensatz in
den Plan übernommen. Das erhält lokale Ergänzungen wie Notizen. Zugeordnete
Dateifelder mit leerem Wert können ausdrücklich geleert werden. Bei Online-Adaptern
werden leere optionale Anbieterfelder ausgelassen und erhalten bestehende Werte;
automatische Löschungen werden nicht abgeleitet. Das bestehende Hub-Modell validiert
jede Zeile. Beschreibungen werden als Daten behandelt; HTML aus WooCommerce darf
von Oberflächen ausschließlich als Text ausgegeben werden.

## Persistenz und Schutzmaßnahmen

Migration `0022_connectors.sql` speichert organisationsgebundene Konfiguration,
Cooldown/Lease und Vorschaupläne. Die additive Migration
`0028_business_connectors.sql` erweitert nur die Provider-Constraint um die drei
neuen Adapter; bestehende Daten und historische Migrationen bleiben unverändert.
AES-256-GCM verwendet den vorhandenen
`AI_CONNECTOR_ENCRYPTION_KEY`; zusätzliche authentifizierte Daten binden den
Ciphertext an Organisation, Verbindung und Anbieter. Eine Kopie in einen anderen
Datensatz lässt sich nicht entschlüsseln. Der historische Schlüssel muss bei Restore
wie bereits für AI-Connectoren erhalten bleiben. Es gibt keine neue Secret-Ausgabe,
keinen Klartext-Audit und kein Logging roher Providerfehler/Response-Bodies.

Server prüft Owner für Konfiguration, Editor für Abruf/Übernahme und Viewer für
Lesen. Schreiboperationen prüfen Mitgliedschaft und aktiviertes Modul erneut unter
dem Hub-Organisationslock. Konfiguration, Revisionskontrolle, Unternehmensdatensätze,
Versionen, Importbestätigung und Hub-Ereignisse werden in Transaktionen geschrieben.
Das Apply verwendet denselben `import_in_tx`-Pfad wie der generische Hub-Import.
Webhooks werden von diesem Paket nicht zusätzlich ausgelöst; die generische,
transaktionale Ereignis-/Outbox-Anbindung bleibt beim Haupttask.

Remote-Requests verwenden `outbound.rs`: jedes Ziel wird erneut aufgelöst, gegen
öffentliche Unicast-Adressen geprüft und für die Verbindung gepinnt. Nur HTTPS/443,
keine System-Proxys, keine Redirects und keine Provider-Links als Folgeziel. Der
Entwicklungs-Bypass für private Webhooks gilt hier **nicht**. HTTP-Mock-Ziele sind
nur in `#[cfg(test)]` kompiliert und ausschließlich Loopback.

Im unterstützten Helm-Paket ist öffentlicher HTTPS-Egress standardmäßig gesperrt.
Der Betreiber muss den benötigten Anbieter-Egress auf seiner Infrastruktur
freigeben, etwa über die vorhandene Option `networkPolicy.allowPublicHTTPS` oder
eine gesonderte, gezielte Egress-Policy. Die URL-/DNS-Prüfungen der API bleiben auch
bei freigegebenem Netzwerkverkehr aktiv. Dateiimporte benötigen keinen Egress.

Grenzen je Abruf: vier Seiten à 25 Objekte, 100 Objekte pro Vorschau, 2 MiB pro
HTTP-Antwort, zwölf Sekunden pro HTTP-Request einschließlich Body, 50 Sekunden
für den kompletten Providerabruf. Es laufen höchstens vier Vorschauen gleichzeitig
pro API-Prozess; die unterstützte Bereitstellung nutzt eine API-Instanz. Ein
75-Sekunden-Lease verhindert parallele Abrufe derselben Verbindung und läuft nach
Abbruch automatisch aus. Höchstens 100 Verbindungen je Organisation und 100
Vorschauen pro Verbindung innerhalb 24 Stunden. Vorschauen verfallen nach 24 Stunden;
beim nächsten erfolgreichen Capture werden abgelaufene Vorschauen derselben
Verbindung bereinigt. Bereits importierte Idempotenzbestätigungen bleiben im
Hub-Importjournal. Kein automatischer dauerhafter Datenabgleich ist versprochen.

`Retry-After` wird als Sekunden oder HTTP-Datum ausgewertet. HTTP 429 und Shopify
`THROTTLED` führen zu gespeichertem `retry_at`; vor dessen Ablauf wird kein weiterer
Request gesendet. HTTP-Serverfehler und Timeouts erhalten ebenfalls eine Wartezeit.
Retry-Zeitangaben sind auf ein Jahr begrenzt; ungültige Werte verwenden 60 Sekunden.
Der Benutzer startet den nächsten Versuch ausdrücklich. Keine automatischen
Retries führen zu einem Rebase einer bereits gespeicherten Vorschau.

Fehler sind unterscheidbar: `provider_authentication`, `provider_rate_limited`,
`provider_timeout`, `provider_unavailable`, `provider_target_rejected`,
`provider_redirect`, `provider_request_rejected`, `provider_response`,
`provider_graphql`, `provider_version`, `invalid_input`. 429 enthält den HTTP-Header
`Retry-After` und `retry_after_seconds`. GraphQL-Teilantworten mit Fehlern werden
vollständig verworfen. Rekursive/identische Cursor, doppelte IDs oder ungültige
Objekte brechen die Vorschau ab. Ein Abruf bildet keine transaktionale Momentaufnahme
des Fremdsystems über mehrere Seiten; Änderungen beim Anbieter können einen
neuen Abruf nötig machen.

## Prüfnachweise

Ausführbare Tests:

- `crates/sitegraph-api/src/connectors/tests.rs`: lokale HTTP-Server für sämtliche
  Online-Adapter, echte Requests/Auth-Header, Paging, Grenzen, fehlerhafte Antworten,
  Shopify-200-Fehler, Retry-After, Redirect-/SSRF-Abwehr und Datei-Fixtures.
- `crates/sitegraph-db/src/hub/connectors.rs`: AES-GCM-Roundtrip, Nichtdeterminismus,
  falscher Schlüssel, falsche Organisation/Verbindung/Provider und defekter Ciphertext.
- `admin/tests/connectors-api.spec.ts`: neun echte API-/Postgres-Regressionsfälle in
  `E2E_DATABASE=hub` (API 28090, DB 25433); trockene persistierte Vorschau, atomare
  Übernahme, Idempotenz, Konflikte, lokale Ergänzungen, Ablauf, Modul-/Rollen-/Mandanten-
  Grenzen, Verschlüsselungsprojektion und AAD, private Ziele und persistierter Cooldown.

Die Tests verwenden synthetische Konten und Daten, niemals reale Anbieterzugänge.
Rust-Builds und Testausführung werden vom Haupttask koordiniert; konkrete Ergebnisse
stehen im Arbeitspaket-Handoff `connectors-ready.md` und im zentralen Prüfnachweis.


Ausgeführt am 19.09.2026: **9/9 API-/Postgres-Regressionsfälle bestanden** in
1,3 Minuten, ein Worker, keine Wiederholungen; persistenter Testdienst
`fireflint-hub-connectors-tests.service`, Exitcode0. Nachweis:
(lokaler Nachweis, nicht veröffentlicht). Workspace-fmt und Clippy mit `-D warnings` sind erfolgreich. Der koordinierte
Rust-Workspace-Lauf ist abgeschlossen: **195 bestanden, 0 fehlgeschlagen, 5 explizit
ausgelassen**. Alle **15 neuen Connector-Tests** (14 Protokoll-/Parser-/Sicherheitsfälle
und ein AES-GCM/AAD-Fall) sind bestanden; keiner dieser Tests wurde ausgelassen.
Nachweis: (lokaler Nachweis, nicht veröffentlicht). Die fünf anderen
ausgelassenen DB-/HTTP-Fälle werden vom Haupttask getrennt koordiniert.


## Erweiterung vom 23.09.2026

Pipedrive, ERPNext und Brevo verwenden denselben gespeicherten Vorschau-/Apply-Pfad
wie die bisherigen Anbieter. Die Oberflächeneinrichtung stammt vollständig aus
dem Serverkatalog, einschließlich Provider-Hinweisen und Credential-Feldern.
ERPNext und Brevo paginieren in begrenzten, stabil sortierten Offset-Chargen;
Pipedrive verwendet opaque Cursor. Eine volle ERPNext-Schlussseite kann einen
zusätzlichen leeren Folgeabruf benötigen. Gleichzeitige Änderungen im Fremdsystem
können bei Offset-Pagination Datensätze verschieben; der Abruf ist kein konsistenter
Snapshot und kein verlustfreies Änderungsjournal.

Die neuen Tests sind in `crates/sitegraph-api/src/connectors/tests.rs`,
`admin/tests/connectors-api.spec.ts` und
`admin/tests/business-connectors-ui.spec.ts` enthalten. Synthetische HTTP-Antworten
prüfen Anbieterprotokolle; eine isolierte PostgreSQL-Instanz prüft Konfiguration,
Secret-Rotation und den gemeinsamen Importpfad. Konkrete Prüfergebnisse:
CONNECTORS-VALIDATION-2026-09-23.md (interne Dokumentation, nicht veröffentlicht).

KoiForges Erweiterungsmechanismus ist separat analysiert:
Gemeinsame Erweiterungsfähigkeit (interne Dokumentation, nicht veröffentlicht).
Das ist ein Architekturentwurf; FireFlint führt hier noch keine selbst erzeugten
Connectoren aus. Für einen Cluster-Rollout sind API-/Admin-Images aus dem neuen
Quellstand zu bauen; die bisherigen RC3-Images enthalten diese Erweiterung nicht.
