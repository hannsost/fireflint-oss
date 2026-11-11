# FireFlint

**Gemeinsame Inhalte pflegen. Lokale Unterschiede behalten. Kontrolliert veröffentlichen.**

FireFlint ist der Content-Hub für Webagenturen und Unternehmen mit mehreren
Websites: etwa Standortdaten, Ansprechpartner und Stellenangebote zentral pflegen,
gezielte Website-Ausnahmen sichtbar lassen und die Auswirkungen einer gespeicherten
Revision vor der Veröffentlichung je Website vergleichen.

Der Start ist als **betreuter SaaS-Pilot** zugeschnitten: ein Kundenunternehmen
pro Arbeitsbereich, zunächst ein Inhaltstyp und zwei angebundene Websites.
Einrichtung, laufender Betrieb und Preis werden individuell vereinbart. Reale
Marktbeispiele belegen diesen Problemtyp; Zahlungsbereitschaft und Nutzen gerade
für FireFlint müssen in Pilotprojekten gemessen werden.
[Markt und Positionierung].

**Native App:** [Android/iPhone-Modul und Buildanleitung](../mobile/README.md) · [aktueller Umsetzungs- und Plattformnachweis].
Eigenständige FireFlint-App; iOS-Build-/Gerätenachweis separat beachten.

**SaaS-Installation:** [Betriebsanleitung](SAAS-DEPLOYMENT.md) ·
[Release und Prüfnachweise] ·
[Helm-/Containerpaket](../deploy/saas/).
Das Paket kann als Open-Source-Eigenbetrieb im Kundencluster oder als betreutes
SaaS eingesetzt werden. Es enthält keine feste Neurofunken-Domain, Registry oder
Anmeldestelle; der Betreiber konfiguriert die bestehenden Values.
Der Release verwendet einen PostgreSQL-Pool, eine API-Instanz und persistenten
Asset-Speicher; Wartungsfenster sind vorgesehen. Kein Self-Service-Billing,
keine HA-/Regionszusage und kein getrenntes Vier-Augen-Verfahren.

**Neuer Arbeitsablauf:** eigener Markenauftritt, responsive Navigation,
Dashboard mit echten Daten und Einrichtungsschritten, Kontosicherheit und ein
revisionsgebundener Website-Vergleich. Die Website-Anbindungen bleiben API-basiert;
ihre Caches und Builds können Inhalte zeitversetzt aktualisieren.

Technik: Rust/Axum/SQLx + PostgreSQL; React19, Router7 und Vite8. Bestehende
Schnittstellennamen `sitegraph` bleiben für die Adapter kompatibel.

**Stand (v1 + v2 + v3):**
- **v1 — Content-Basis:** Mandanten & Team (Org anlegen, Mitglieder/Rollen,
  Org-Switcher), Plattform-Admin-Claim, Security-Härtung (Prod-Guards, CORS-Allowlist),
  CI (fmt/clippy/test + Admin-Build), einheitliches Branding.
- **v2 — Content-Tiefe:** Content-Type-Builder (UI), Medien/Assets (Upload/Serve),
  Preview & Scheduling, Publish-Webhooks (signiert, mit Outbox/Retry/DLQ),
  Content-Suche & Status-Filter, Relation-Felder, Dashboard.
- **v3 — optionale, separat zu konfigurierende KI-Erweiterung (nicht Teil des
  unterstützten Content-Piloten):** Visueller Workflow-Builder (Drag-and-Drop-Board)
  mit Knoten *Start / Agent / Bedingung / Schleife / Parallel / Zusammenführen /
  Ausgabe*; Anthropic mit eigenem API-Schlüssel oder der keyfreie `mock`-Testmodus
  mit simulierten Antworten; Chat-Copilot, der aus einer Beschreibung ein
  Graph-Gerüst entwirft; Läufe mit Knoten-für-Knoten-Trace. Ergebnisse landen als
  **Entwurf**; Veröffentlichen bleibt ein eigener, ausdrücklicher Schritt. Der
  Content-Pilot richtet keinen Provider automatisch ein und benötigt keine KI.
  API-Keys werden gespeichert, aber nie wieder ausgegeben.
- **Optionale interne Plattform-/Operator-Erweiterungen (außerhalb des
  unterstützten Content-Piloten):** Storage-Operator und technische
  Data-Residency-Schnittstellen (O0–O4) unter `operator/`, `deploy/operator/` und
  `crates/platform/`; Cluster-Sicht via read-only BFF
  (`operator/sitegraph-cluster-bff/`); Foundation-Module unter `crates/foundation/`.
  Diese Erweiterungen sind keine Zusage zu regionaler Datenresidenz,
  Hochverfügbarkeit (HA) oder Multi-Region.

Bekannte Einschränkungen siehe Abschnitt unten. Details:
`modules/OPERATOR-DEVELOPMENT-PLAN.md`.

> **Auth (WP1.3):** Admin-Routen liegen unter `/api/orgs/:org_id/…` und erfordern
> ein Access-JWT. Die Delivery-API erfordert einen API-Token. Ein Demo-Mandant
> wird ausschließlich im Entwicklungsmodus beim Serverstart angelegt:
> Login `owner@demo.test` / `demo1234`, Delivery-Token `sg_demo_token`,
> Org-ID `00000000-0000-0000-0000-000000000001`.
> Produktion lehnt bekannte Demo-Zugänge/-Tokens ab. `sitegraph migrate` erzeugt
> keine Zugangsdaten; `sitegraph bootstrap-admin` richtet einmalig einen eigenen
> Administrator und privaten Arbeitsbereich über explizite Secret-Werte ein.
> Historische Seed-Migrationen bleiben unverändert; ihre unzugewiesenen Demodaten
> sind kein zugänglicher Kundenarbeitsbereich.

## Optionale KI-Funktionen lokal erproben

> Diese Funktionen sind separat zu konfigurieren und nicht Bestandteil des
> unterstützten Content-Piloten. Die Content-Abläufe funktionieren ohne KI;
> FireFlint richtet keinen externen Provider automatisch ein. Anthropic erfordert
> eine manuell angelegte Verbindung mit einem eigenen API-Schlüssel. `mock` ist
> ein keyfreier Testmodus mit simulierten Antworten. Der Chat benötigt eine
> eingerichtete Verbindung; Workflows können ohne ausgewählten Connector im
> Mock-Modus laufen.
>
> Prüfstand 10.09.2026: Native Engine-/Trace-Prüfungen, ein echter
> Browser-Mock-Workflow und Entschlüsselung nach Cluster-Restore sind dokumentiert.
> Der Mock-Test spricht keinen externen Provider an. Details: [Release].
> `UNTESTED-CHANGES.md` bleibt als historischer Arbeitszettel erhalten.

1. Core starten (legt beim Start die Migration `0012_ai_workflows.sql` an) und im
   Admin-UI als `owner@demo.test` einloggen.
2. **Agenten & KI** → *Verbindung & Modell*: Für Anthropic den eigenen
   API-Schlüssel eintragen; alternativ den `mock`-Testmodus ohne KI-Dienst wählen.
   Mit *Verbindung hinzufügen* speichern.
3. **KI-Workflows** → *Mit Copilot erstellen* (Beschreibung eintippen) **oder**
   *Leeren Workflow anlegen* und Knoten per Palette aufs Board ziehen.
4. Knoten verbinden; bei einer **Bedingung** Kante anklicken, um sie auf
   `true`/`false` zu schalten. Im Agent-Knoten die Verbindung, das Modell und den
   Prompt setzen. Im **Ausgabe**-Knoten den Ziel-Inhaltstyp wählen.
5. **Speichern**, dann unter *Ausführen* eine Eingabe setzen und starten — der
   Lauf zeigt einen Knoten-für-Knoten-Trace; erzeugte Inhalte erscheinen als
   Entwurf unter dem gewählten Inhaltstyp. Veröffentlichen bleibt ein eigener,
   ausdrücklicher Schritt im Content-Editor.

Per API (gleiche Endpunkte): `POST /api/orgs/:org/ai/connectors`,
`POST /api/orgs/:org/ai/workflows`, `POST …/ai/workflows/:id/run`,
`POST …/ai/copilot`. Vollständig in `/openapi.json` (Tag `ai`).

Ein fertiger **Beispiel-Workflow** („Beispiel: Standort-Entwurf aus Stadtname")
wird automatisch in den Demo-Mandanten geseedet — er nutzt jeden Knotentyp und
läuft auch ohne Key gegen `mock`. Die feste Graph-Syntax (Bausteine, die auch der
Copilot nutzt) steht in [`docs/ai-workflow-syntax.md`](ai-workflow-syntax.md).

## Lokaler Steward-Stack (Stand 10.09.2026)

Die aktuelle Vorschau läuft bereits über drei eigene systemd-User-Dienste und
ist unter <http://localhost:5174> erreichbar. Automatischer API-Neustart und
Persistenz nach Ende des Installationsauftrags sind
[geprüft].

```bash
systemctl --user status fireflint-db.service fireflint-core.service fireflint-admin.service
systemctl --user restart fireflint-core.service  # nach erfolgreichem API-Build
```

Start/Stop des gesamten Stacks und Buildvoraussetzungen:
[deploy/systemd/README.md](../deploy/systemd/README.md). Während die Units laufen,
keine parallelen Bare-Stack-Skripte verwenden; beim normalen Taskabschluss die
Vorschau weiterlaufen lassen.

### Alternativer Bare-Stack bei gestoppten User-Diensten

In diesem Checkout den bestehenden Podman-Container `fireflint-db` verwenden:

```bash
./run-local.sh             # Postgres 5433, API 8090, Admin 5174
./stop-local.sh            # ausschließlich PID-geprüfte Projektprozesse
./stop-local.sh --db       # zusätzlich den eigenen DB-Container stoppen
```

Alle Listener binden an `0.0.0.0`. Der Start ist wiederholbar; ein belegter Port
mit unbekanntem Prozess wird nicht übernommen. Das Skript lädt keine Secret-
oder dotenv-Dateien; öffentliche Demo-Defaults bzw. bereits exportierte Variablen
werden verwendet. Abweichende lokale Zugangsdaten über die Prozessumgebung
bereitstellen. `SITEGRAPH_LOAD_DOTENV=0` deaktiviert auch das automatische Laden
im Core und in Vite. Nach Codeänderungen Stop/Start zum Neubauen der API verwenden.

Voraussetzungen: vorhandener Podman-Container samt Volume, Rust stable mit
rustfmt/clippy, Node/npm, Python 3, curl, ss, flock und setsid (Linux mit `/proc`). Admin-Abhängigkeiten bei Bedarf mit
`npm --prefix admin ci` installieren. Fehlt der bestehende DB-Container, meldet
sich das Skript mit einer konkreten Fehlermeldung und erzeugt keinen Ersatzstack.

Die Readiness-Prüfung wartet bis zu 30 Sekunden auf den eigenen Prozess und
seinen Listener; ein letzter HTTP-Versuch kann bis zu einer Sekunde dauern.
Nach einem Timeout bleiben die PID-Dateien zur sicheren Wiederaufnahme erhalten.
Prozess-Regression ohne Datenbank/Portbelegung: `python3 tools/test_local_stack.py`.
Ursache, Abnahme und Grenzen: [Startprüfung].

Aktueller Nachweis und priorisierte Arbeit: [BOARDBOOK].
Produktentscheidung: [Marktvergleich vom 10.09.2026].
Die folgenden allgemeinen Docker-Anweisungen sind ein alternativer Aufbau;
sie werden nicht zusätzlich zum vorhandenen Podman-Stack ausgeführt.

## Voraussetzungen
- Rust (stable) + Cargo
- Docker (für PostgreSQL)

## Starten

```bash
# 1. Datenbank starten
docker compose -f deploy/docker-compose.yml up -d

# 2. Env setzen: deploy/.env.example nach ./.env kopieren und anpassen
cp deploy/.env.example .env

# 3. Core starten (lädt ./.env automatisch, führt Migrationen + Demo-Seed aus)
cargo run

# 4. Demo öffnen: adapters/web-component/demo.html im Browser
#    (zwei Websites, dieselbe Datenquelle, ein lokaler Override)
```

## Die Demo-Story (90 Sekunden)

1. `demo.html` zeigt zwei „Websites". Beide lesen denselben Standort (mit
   Delivery-Token `sg_demo_token`). Karriere zeigt Darmstadt mit lokalem
   Override (anderes Telefon/Zeiten).
2. Einen neuen Standort anlegen und auf beiden Channels veröffentlichen:

```bash
ORG=00000000-0000-0000-0000-000000000001

# einloggen -> Access-Token holen
TOKEN=$(curl -s -X POST localhost:8090/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@demo.test","password":"demo1234"}' | jq -r .access_token)

# anlegen (Status: draft)
curl -s -X POST localhost:8090/api/orgs/$ORG/content/standort \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"data":{"name":"Berlin","adresse":"Unter den Linden 1, 10117 Berlin","telefon":"030-300"}}'
# -> liefert die neue id zurück, z.B. <ID>

# beiden Websites zuweisen
curl -s -X PUT localhost:8090/api/orgs/$ORG/content/standort/<ID>/channels \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"expected_revision":1,"assignments":[
        {"website_id":"00000000-0000-0000-0000-000000000100"},
        {"website_id":"00000000-0000-0000-0000-000000000101"}]}'

# veröffentlichen: revision aus dem zuvor geprüften Objekt mitsenden
# Neu angelegt: 1; die Channel-Zuweisung liefert content.revision = 2.
# Bei weiteren Änderungen immer den tatsächlich geprüften aktuellen Stand verwenden.
curl -s -X POST localhost:8090/api/orgs/$ORG/content/standort/<ID>/publish \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"expected_revision":2}'
```

3. `demo.html` neu laden → Berlin erscheint auf **beiden** Websites.
4. API stoppen, neu laden → die Web Component zeigt dank Cache+Fallback die
   letzte bekannte Version statt eines Fehlers (Whitepaper §13/§23).

## API-Überblick

Auth: `Authorization: Bearer <access_token>` für alle `/api/*`-Routen.

| Methode | Pfad | Zweck |
|---|---|---|
| GET  | `/healthz` | Liveness-Check |
| GET  | `/readyz` | Readiness-Check (prüft DB-Verbindung; 503 wenn nicht bereit) |
| GET  | `/version` | Dienstname + Version |
| GET  | `/openapi.json` | OpenAPI 3.1 Dokument (alle Endpunkte) |
| POST | `/auth/login` \| `/auth/refresh` | Login / Token erneuern |
| GET  | `/api/me` | Eigener User + Memberships |
| GET/POST | `/api/orgs/:org/websites` | Channels listen / anlegen |
| GET/POST | `/api/orgs/:org/content/:type` | Inhalte listen / anlegen |
| PUT/DELETE | `/api/orgs/:org/content/:type/:id` | Inhalt ändern / löschen |
| PUT | `/api/orgs/:org/content/:type/:id/channels` | Channel-Zuweisung + Overrides |
| POST | `/api/orgs/:org/content/:type/:id/publish` \| `/unpublish` | Status setzen |
| GET | `/api/orgs/:org/content/:type/:id/versions` | Versionsverlauf |
| POST | `/api/orgs/:org/content/:type/:id/revert/:version_id` | Version wiederherstellen |
| GET/POST | `/api/orgs/:org/tokens` | API-Tokens listen / erstellen |
| GET | `/api/orgs/:org/audit` | Audit-Log (Owner) |
| POST | `/api/orgs` · `/api/orgs/:org/members` … | Org anlegen, Team/Mitglieder (Owner) |
| GET/POST/PUT/DELETE | `/api/orgs/:org/content-types[/:key]` | Content-Type-Builder (Owner) |
| GET/POST/DELETE | `/api/orgs/:org/assets[/:id]` | Medien (Upload/List/Delete) |
| GET/PUT | `/api/orgs/:org/content/:type/:id/schedule` | Geplantes Publizieren |
| POST | `/api/orgs/:org/preview-tokens` | Vorschau-Token (Drafts) |
| GET/POST/DELETE | `/api/orgs/:org/webhooks[/:id]` · `/webhook-deliveries` | Webhooks + Zustell-Historie (Owner) |
| GET | `/api/orgs/:org/overview` | Dashboard-Kennzahlen |
| GET | `/v1/:channel/content/:type` | **Delivery** (public, Token nötig, nur published) |
| GET | `/preview/:channel/content/:type?token=` | **Preview-Delivery** (inkl. Drafts) |
| GET | `/assets/:org/:id` | **Asset-Auslieferung** (public, org-geroutet) |

Schreibende Aktionen (anlegen/ändern/löschen/publish/revert/channels/website/token)
werden im Audit-Log protokolliert (WP1.4). Die vollständige API-Beschreibung
liegt maschinenlesbar unter `/openapi.json`.

**Parallele Bearbeitung (Migration 0016):** Content-Objekte enthalten `revision`.
Update (`PUT` mit `data`), Channel-/Override-Ersetzung (`PUT …/channels`),
Löschen (`DELETE`), Publish, Unpublish, Revert und Planung benötigen im JSON-Body
`expected_revision` aus dem geladenen/geprüften Objekt. Fehlend → 428, veraltet
→ 409 (`code: revision_conflict`). Erfolgreiche Daten-/Status-/Channel-Änderungen erhöhen
die Revision. Bei einem Konflikt Eingaben bewahren und den Serverstand vergleichen;
keine automatische Wiederholung mit einer ungeprüften neueren Revision.
Der Admin bietet explizite Übernahme des Serverstands oder Beibehaltung eigener
Eingaben für einen erneuten, weiterhin geprüften Speichervorgang.
[Vertrag, Grenzen und Regression].

**Getrennte Freigabe (Migration 0017):** `data` und Channel-Zuweisungen sind der
bearbeitbare Entwurf. `publication` enthält den letzten freigegebenen Datenstand
mit Channels/Overrides, Revision und Zeitpunkt. Delivery liefert ausschließlich
diesen Snapshot; Preview liefert den gespeicherten Entwurf. Speichern/Revert oder
Channel-Änderungen verändern den öffentlichen Stand erst nach erneutem Publish.
`has_unpublished_changes` kennzeichnet ausstehende Freigaben. Eine Channel-Speicherung
liefert `{assignments, content}` mit der neuen Objekt-Revision; der Channel-GET
liefert `{assignments, revision}` aus einem gemeinsamen Datenbank-Snapshot.

Planung prüft `expected_revision` und die eigene `expected_schedule_revision`
(aus dem geprüften Schedule-GET `schedule_revision`, Migration0019). So können
ältere Formulare weder neuere Termine überschreiben noch gelöschte Termine
wiederherstellen. Die Freigabe bindet weiter `publish_revision`. Spätere Änderungen
blockieren die geplante Freigabe sichtbar (`publish_conflict`), bis sie erneut
geprüft und geplant wird. Geplante Rücknahme gilt auch bei neueren Entwürfen.
Manuelles Publish/Unpublish löscht beide geplanten Termine.
[Vertrag, Migration und Prüfnachweis].

**Delivery und Sitzungen:** Delivery/Preview antworten mit `private, no-store`
und tokenabhängiger Prüfung auch bei ETag/304. Zwischen Mandanten wird kein
öffentlicher Shared-Cache verwendet. API-Anmeldung ist kontobasiert begrenzt
(10/min), zusätzlich besteht ein globales Eingangslimit; weitergeleitete
IP-Header werden nicht als Identität vertraut. Delivery bleibt 120/min je Token.
Die Limiter und Hintergrund-Jobs erfordern genau eine API-Instanz.

Passwortänderung unter **Konto & Sicherheit** und der Betreiberbefehl
`sitegraph reset-password` widerrufen vorherige Access-/Refresh-Sitzungen.
`/api/account/password` erwartet `current_password` und `new_password`.
Aktuelle Sitzungsrevision und Plattformrolle werden bei geschützten Anfragen aus
der Datenbank gelesen. JWT- und Connector-Verschlüsselungsschlüssel sind in
Produktion unabhängig und ausreichend stark; explizite HTTPS-CORS-Origens sind
Pflicht. `/readyz` prüft die Datenbank; Ctrl-C und SIGTERM fahren geordnet herunter.

Assets sind öffentlich abrufbare Medien; aktive Dateiformate erhalten eine
Sandbox-/Download-Antwort statt ausführbaren HTML-Zugriff auf die Admin-Origin.
Webhook- und KI-Ziele werden auch beim Versand auf öffentliche, fest aufgelöste
Adressen geprüft; Weiterleitungen sind deaktiviert. Die optionalen KI-Workflows
bleiben außerhalb des zugesagten Pilot-Kernablaufs.

**Rollen:** Owner (alles inkl. Websites/Tokens), Editor (Content CRUD + Publish),
Viewer (nur lesen). **Delivery-Token:** org-weit oder channel-gebunden — ein
channel-gebundener Token kann andere Channels nicht lesen.

Content-Typen im Seed: `standort`, `team`, `job` (ESP-Scope). Beim Anlegen/Ändern
wird `data` gegen das Typ-Schema validiert (Pflichtfelder + Basistypen, WP1.2).

**Admin-UI-Komfort:** Toast-Rückmeldungen, globaler Ladebalken, Empty-States,
Trefferzahlen, Suche mit Debounce/Clear, Auto-Slug, Pflichtfeld-Marker,
Ctrl+S-Speichern + Unsaved-Guard, Sticky-Action-Bar, Medien-Drag&Drop,
Relativzeiten und Org-Name im Tab-Titel.

> **Hinweis:** Zuletzt ergänzte Komfort-/Betriebs-Erweiterungen sind teils nur
> build-/render-geprüft, nicht voll funktional verifiziert — Liste +
> Prüf-Checkliste in [`UNTESTED-CHANGES.md`].

## Bekannte Einschränkungen

- **Residency & Hintergrund-Jobs:** Der Scheduler (geplantes Publizieren) und der
  Webhook-Outbox-Worker laufen auf dem Control-Plane-Pool (org-übergreifend).
  Korrekt im Single-Pool-Default; echtes Multi-Target (per-Tenant-DB) braucht eine
  Org-Pool-Enumeration — Folgeaufgabe **vor** Aktivierung von Multi-Target.
- **Asset-Bytes:** DB-Zuordnung und Auslieferung (`/assets/:org/:id`) sind
  org-geroutet; die Blob-*Bytes* liegen aktuell in einem lokalen Verzeichnis
  (`ASSET_DIR`), noch nicht regions-/org-partitioniert. S3-/residency-fähiger
  Blob-Store ist Folgeaufgabe.
- **Webhook-Outbox:** persistent mit Retry/Backoff und Dead-Letter, aber
  Single-Worker (kein `SKIP LOCKED`/horizontale Skalierung). DNS-/IP-Pinning blockiert
  private Ziele und Weiterleitungen; Ausnahme nur bei explizitem
  `APP_ENV=development` und `WEBHOOK_ALLOW_PRIVATE=true`.
- **Tests:** Rust-, echte HTTP-/DB-, Produktions-Lifecycle- und Browserprüfungen
  sind vorhanden. Der konkrete Stand und die Grenzen stehen im
  [Release-Nachweis].

## Lokale Umgebung (neu) aufsetzen

Nach einem `docker system prune` o. ä. lässt sich alles neu hochziehen:

```bash
# 1. PostgreSQL
docker compose -f deploy/docker-compose.yml up -d

# 2. Env (Dev) — ./.env wird von sitegraph-bin automatisch geladen,
#    echte Umgebungsvariablen haben weiterhin Vorrang vor .env-Werten
cat > .env <<'ENV'
DATABASE_URL=postgres://sitegraph:sitegraph@localhost:5432/sitegraph
ASSET_DIR=./data/assets                 # lokale Medien-Blobs
WEBHOOK_ALLOW_PRIVATE=true              # nur Dev: erlaubt 127.0.0.1-Webhook-Ziele
ENV

# 3. Core (Migrationen + Demo-Seed laufen automatisch)
cargo run -p sitegraph-bin              # http://localhost:8090

# 4. Admin-UI
cd admin && npm install && npm run dev  # http://localhost:5173
```

Produktion: `APP_ENV=production` erzwingt unabhängige starke Secrets, explizite
HTTPS-CORS-Origens und eigene Accounts. Für den Betrieb ausschließlich das
[SaaS-Paket](SAAS-DEPLOYMENT.md) verwenden.

**Ports (lokal):** Core-API `:8090` (`BIND`), optionaler Cluster-View-BFF
`:8091` (`BFF_BIND`). Die `/cluster`-Route der Admin-UI ist **optional** und
zeigt ohne laufenden BFF einen ruhigen „nicht konfiguriert"-Hinweis. Sie
benötigt einen kind-Cluster + Storage-Operator + den read-only BFF: siehe
`deploy/operator/` und `operator/sitegraph-cluster-bff/README.md`.

### Taskfeste Vorschau per systemd --user

Die lokale Vorschau kann über die vorbereiteten [User-Units](../deploy/systemd/README.md)
unabhängig vom Cockpit-Owner-Task betrieben werden. `setsid` in `run-local.sh`
trennt keine Cgroups; solche Hintergrundprozesse können mit ihrem Owner-Task enden.

Für den Wechsel zuerst den bisherigen Stack mit `./stop-local.sh --db` kontrolliert
stoppen, erfolgreiche API-Builds und installierte Admin-Abhängigkeiten bereitstellen
und die dokumentierten User-Units als eigener Benutzer aktivieren. Die Units verwenden den
bestehenden Container `fireflint-db`, die Ports 5433/8090/5174 und kanonische Assets.
Sie lesen keine dotenv-Dateien, erzeugen keinen Ersatzcontainer und bauen beim
Start nicht automatisch.

Nach dem Wechsel ausschließlich `systemctl --user` für Start/Stop/Neustart nutzen.
Die Sperre verhindert parallelen Bare-Stack-Betrieb. Nach API-Änderungen erst
bauen, dann gezielt `fireflint-core.service` neu starten. Der normale Taskabschluss
soll die Vorschau weiterlaufen lassen. Details, Abnahme und die getrennten Grenzen
für Benutzer-Logout/Boot stehen in der [Betriebsanleitung](../deploy/systemd/README.md).

## Struktur

```
crates/sitegraph-domain  # Entitäten, Rollen, Override-Merge, Validierung (kein IO)
crates/sitegraph-db      # sqlx-Pool, Migrationen, Repositories (org_id-scoped)
crates/sitegraph-api     # axum-Router, Admin- + Delivery-API; auth.rs (argon2/JWT/Token)
crates/sitegraph-bin     # Config, Migrate, Demo-Bootstrap, Server-Start
crates/foundation/*      # Foundation-Module als Rust-Crates (Party, Identity&Access,
                         #   Event&Audit, Work, Time&Resource, Asset) — isoliert,
                         #   noch nicht in den Core verdrahtet (Ports + Reference + Tests)
crates/platform/data-residency # Data-Residency-Verträge; via Seam in sitegraph-db (O4.1)
migrations/              # 0001–0006 (Schema/Seed/Versionen/Typen/Auth/Audit),
                         #   0007 platform-admin, 0008 assets, 0009 scheduling,
                         #   0010 webhooks, 0011 webhook-outbox
admin/                   # Admin-UI (React/TS/Vite) — spricht die API
adapters/web-component/  # no-build Web Component + demo.html
adapters/wordpress-plugin/ # WordPress-Plugin (Shortcode + Block, Cache + Fallback)
adapters/next-sdk/       # @sitegraph/next (typisiertes SDK) + Next.js-Beispiel-App
operator/                # FireFlint Storage Operator (CRDs, Controller, Bin) — O0–O3
deploy/operator/         # Kustomize + Helm + CRDs + Beispiele für den Operator
docs/                    # ADR, Gefahrenmodell, Operator-Support-Matrix
modules/                 # optionale Domänenmodule (TS-Sandboxes) + Planungs-/Handoff-Docs
tools/visual/            # Multi-Viewport-Screenshots zur UI-Selbstprüfung
```

## Optionale Modulgerüste

- `modules/commerce` — modularer B2C/B2B/B2G-Commerce
- `modules/forms-workflow` — Formulare, Einreichungen und Workflows
- `modules/edi` — EDI-Gateway 
- `modules/privacy-dsgvo` — Datenschutz-Governance über Content, Commerce, Forms und EDI

Beide Bereiche sind vom Rust-Core isoliert. Ihre Szenariotests dienen als
fachliche Akzeptanzkriterien für eine spätere Integration.

## Nächste Schritte (Phase 1)
Erledigt: WP1.2 (Validierung), WP1.3 (Auth/Rollen/Tokens), WP1.4 (Audit-Log +
OpenAPI), WP1.5 (Versionierung), WP1.6 (Delivery-Caching + Rate-Limiting),
WP1.7 (Admin-UI — siehe `admin/`), WP1.9 (WordPress-Plugin — siehe
`adapters/wordpress-plugin/`), WP1.10 (Next.js-SDK — siehe `adapters/next-sdk/`).
HTTP-/DB-Integration und Produktions-Lifecycle sind inzwischen geprüft; aktuelle
Prüfnachweise und weitere Produktarbeit stehen im BOARDBOOK.
Siehe `../entwicklungsplan-phase-1-2.md`.

## Optionale direkte Instagram-Anbindung

`/instagram` zeigt den echten Konfigurations- und Verbindungsstand des aktuellen
Arbeitsbereichs. Ohne Meta-App bleibt Verbinden deaktiviert. Die aktuelle Unified-
Einrichtung verlangt `instagram_basic` und `instagram_manage_messages`; für die
Veröffentlichung kommt `instagram_content_publish` hinzu. Metas Editor markiert
die ersten beiden Rechte als erforderlich. Über Konfigurationsvorschau →
„Edit permissions“ lassen sich Werbe- und Kommentarrechte entfernen; die geprüfte
Drei-Rechte-Konfiguration bleibt „Instagram Login Compatible“. Der Owner muss
die zusätzliche Nachrichtenberechtigung ausdrücklich freigeben. Die implementierten
Funktionen rufen keine Nachrichten ab und registrieren keine Message-Webhooks.
Bestehende Instagram-Login-Apps verwenden `instagram_business_basic` und
`instagram_business_content_publish`. Profilbild, Benutzername und Biografie
werden nicht über diese API geändert.
App-Review, Zugriffslevel und gegebenenfalls Unternehmensverifizierung müssen im
tatsächlichen Meta-Entwicklerkonto geprüft werden. Ein Pilotzugriff beweist keine
Freigabe für beliebige weitere Kunden. Der Betreiber wird unverändert als
natürliche Person ausgewiesen; diese Funktion behauptet keine Gewerbeanmeldung.

Für die API `INSTAGRAM_LOGIN_MODE` ausdrücklich auf `unified` oder `instagram_login`
setzen. Beide Modi benötigen `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`,
`INSTAGRAM_PUBLIC_ORIGIN` (HTTPS-Origin ohne Pfad) und `INSTAGRAM_API_VERSION`
(die tatsächlich unterstützte Version aus dem Meta-Dashboard). Unified verwendet
die Meta-App-Kennung und deren Secret, zusätzlich die numerische
`INSTAGRAM_CONFIG_ID` einer Facebook-Login-for-Business-Konfiguration sowie
`INSTAGRAM_WEBHOOK_VERIFY_TOKEN` (16–256 Zeichen). Instagram Login verwendet das
eigene Instagram-App-Paar; `INSTAGRAM_CONFIG_ID` muss dabei leer bleiben.

Helm verwendet `instagram.enabled`, `instagram.loginMode`,
`instagram.configurationId`, `instagram.apiVersion` und `instagram.existingSecret`
mit Schlüsseln `app-id`, `app-secret` und bei Unified `webhook-verify-token`.
Der letzte Schlüssel ist über `instagram.webhookVerifyTokenSecretKey` anpassbar.
Private Werte gehören nicht in Helm-Values oder Git. Bei aktivierter NetworkPolicy
ist öffentlicher HTTPS-Ausgang erforderlich. Anmelde-Rücksprung und Meta-Callbacks:

- `https://<fireflint-host>/auth/instagram/callback`
- Instagram Login: `https://<fireflint-host>/auth/instagram/deauthorize`
- Instagram Login: `https://<fireflint-host>/auth/instagram/data-deletion`
- Unified-Geschäftsintegration: `https://<fireflint-host>/auth/instagram/business-webhooks`
  mit dem geheimen Verifizierungstoken und den vorgesehenen Integrationsereignissen.
- Datenschutz: `https://<fireflint-host>/legal#instagram-privacy`
  beziehungsweise `/en/legal#instagram-privacy`.

Bei Unified wird im Meta-Dashboard die Datenschutzseite als Löschanleitung
hinterlegt. Ein klassischer `signed_request.user_id` wird nicht ohne belegte
Zuordnung als System-User- oder Portfolio-Kennung behandelt; dafür wird keine
abgeschlossene Löschung quittiert. Der signierte Geschäftsportfolio-Uninstall-
Webhook entfernt die zugehörige Unified-Verbindung und gespeicherte
Veröffentlichungsdaten. Weitere Löschanfragen laufen über den auf der
Datenschutzseite genannten Kontakt.

`POST /api/orgs/:org/instagram/connect|refresh|verify|disconnect` erfordert den Owner
und `expected_revision` (bei erstmaliger Verbindung `0`). Anmeldung und Token-
Austausch erfolgen bei Meta bzw. serverseitig. Grants werden verschlüsselt mit
org- und appgebundener Identität gespeichert. Der kurzlebige HttpOnly/Secure-
First-Party-Cookie bindet den einmaligen OAuth-State an den Browser. Die
Oberfläche zeigt Loginmodus, Ablauf und nötiges Neuverbinden. Unified verwendet
System-User-Tokens und eine ausdrückliche Kontowahl bei mehreren freigegebenen
Instagram-Konten; ein Wechsel von Modus oder Konfiguration erfordert eine neue
Freigabe. Der Instagram-Login-Refresh wird niemals auf Unified-Tokens angewendet.
Ein automatischer Token-Refresh ist nicht aktiv.

Der Setup-Weg muss zur tatsächlichen App passen. Maßgeblich sind Metas
[Unified-Login-Einrichtung](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started)
und [Authentifizierung](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication).
Eine erstellte App oder ein Geschäftsportfolio beweist weder einen erteilten
Kontozugriff noch App-Review oder Unternehmensverifizierung.

`POST /api/orgs/:org/instagram/publications` benötigt `Idempotency-Key` und
`{content_type,content_id,website_id,expected_revision}`. Unterstützt werden
`website_page` (expliziter `instagram_text`, `instagram_image` oder `hero_image`)
und `social_plan_post` (`instagram`, `image`). Nur unverändert freigegebene,
der Website zugewiesene CMS-Snapshots und eigene öffentliche JPEG-Assets sind
zulässig. Der Aufruf reserviert dauerhaft genau einen Bild-Container; er postet
noch nicht. `POST .../publications/:id/advance` mit `expected_revision` prüft den
Containerstatus und veröffentlicht den geprüften Auftrag ausdrücklich.
`POST .../:id/reconcile` liest ausschließlich einen bekannten Container. Bei
ungeklärtem Ausgang oder einem Prozessabbruch wird kein Inhalt erneut gesendet.
Die Historie ist unter `GET .../publications` abrufbar. Zusätzliche Zeitplanung,
weitere Medienformate, Insights und automatische Übernahme bestehender Buffer-
Aufträge sind hierdurch noch nicht aktiviert. Bestehende Buffer-Pläne bleiben
unverändert; eine spätere Umstellung muss Dubletten gezielt ausschließen.

Relevante Regressionen: `cargo test -p sitegraph-api -p sitegraph-db instagram`;
die ignorierten HTTP-/DB-Prüfungen benötigen ausdrücklich die isolierte Release-
Datenbank und synthetische Meta-App-Umgebung. Die vollständig gemockte Browser-
Regression `admin/playwright.instagram.config.ts` benutzt keine echten Konten
und keine Datenbank. Reale OAuth-/Provider-Veröffentlichung ist erst nach der
App-Einrichtung und einer tatsächlich bestätigten Konto-Freigabe nachgewiesen.
