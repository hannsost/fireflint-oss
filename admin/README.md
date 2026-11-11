# FireFlint Admin (WP1.7)

React + TypeScript + Vite + TanStack Query. Spricht ausschließlich die FireFlint-API
(`/openapi.json`) — der Core bleibt von der UI getrennt (Whitepaper §22).

## Entwicklung

```bash
npm install
npm run dev        # 0.0.0.0:5174 (erwartet die API auf :8090)
npm run typecheck  # tsc -b --noEmit
npm run build      # tsc + vite build -> dist/
```

Browser-E2E für Redaktion, Delivery, Medien, Rollen/Mandanten und KI-Canvas.
Standard ist die isolierte Release-Fixture: Postgres `fireflint-release-db`
auf 15433, API auf 18090 und Testoberfläche auf 15174. Die Tests erstellen eigene
Mandanten und bereinigen deren Daten; sie benötigen Podman/psql im Testcontainer.
Ein fehlendes `E2E_DATABASE` wählt bewusst `release`, niemals die Entwicklungsdatenbank.
Die Fixture muss vor dem Test separat gestartet sein; die Tests starten nur Vite.
Hub-/E1-Spezialfälle benötigen ihre jeweils dokumentierte separate Fixture.

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/../data/playwright" npx playwright install chromium
E2E_DATABASE=release SITEGRAPH_LOAD_DOTENV=0 PLAYWRIGHT_BROWSERS_PATH="$PWD/../data/playwright" npm run e2e -- account-security.spec.ts content-publication-ui.spec.ts
```

Der Demo-Login lässt sich über `E2E_EMAIL` und `E2E_PASSWORD` überschreiben.
`API_URL` und `ADMIN_PORT` müssen zur vollständig festgelegten Testumgebung passen;
abweichende oder gemischte Koordinaten werden vor jedem Zugriff abgelehnt.
`E2E_DATABASE=local` ist eine ausdrückliche Auswahl für einen entbehrlichen lokalen
Entwicklungsstack auf 8090/5433; Release-Abnahmen verwenden ausschließlich `release`.
Die datenbankfreien Unit-Tests laufen mit `npm run test:unit`.
Fixtures verwenden eigene Organisationen ohne KI-Connectoren (Mock, keine Kosten).
HTTP-Traces sind deaktiviert, damit keine Zugangstoken in Testartefakten landen.
`SITEGRAPH_LOAD_DOTENV=0` verhindert das Lesen von dotenv-Dateien durch Vite/Core.

API-Basis-URL überschreibbar via `VITE_API_URL` (Default `http://localhost:8090`).
Optionale Cluster-Sicht: `VITE_BFF_URL` (Default `http://localhost:8091`).
Demo-Login: `owner@demo.test` / `demo1234`.

## Funktionsumfang
- Login mit JWT (Access + Refresh, automatischer Refresh bei 401), Logout
- Layout mit Navigation (Content-Typen dynamisch, Websites, Tokens)
- Content-Liste je Typ mit Status-Badge
- **Schema-getriebenes** Editor-Formular (aus `content_type.schema` generiert)
- Versionsgeprüftes Speichern, Publish / Unpublish und Wiederherstellen
- Konfliktvergleich mit erhaltenen lokalen Eingaben und expliziter Auflösung
- Getrennter freigegebener Stand mit Daten/Channels; ausstehende Entwurfsänderungen sichtbar
- Geplante Freigabe eines geprüften Stands; spätere Änderungen blockieren die Planung
- Löschen
- Channel-Zuweisung mit optionalen lokalen Overrides pro Channel (§6)
- Versionsverlauf + Wiederherstellen (WP1.5)
- API-Token-Verwaltung (erstellen, einmalig anzeigen, widerrufen)
- Websites anlegen (Owner)

## Visuelle Selbstprüfung
Gehört zur Definition-of-Done jeder UI-Änderung: `cd ../tools/visual && node shoot.mjs
http://localhost:5174 admin`, dann die Screenshots prüfen (mind. ein Phone + Desktop).
Die E2E-Suite erzeugt zusätzlich `editor-mobile.png` und `cluster-desktop.png`
unter `test-results/`.

Revisionsschutz und Abnahme: CONTENT-CONCURRENCY-2026-09-10 (interne Dokumentation, nicht veröffentlicht).
Die E2E-Suite prüft zwei Tabs, verspätete Antworten, Hintergrund-Refetch und
Mandantenwechsel; sie erzeugt authentifizierte Konflikt-Screenshots für Desktop
und 375 px (`revision-conflict-desktop.png`, `revision-conflict-mobile.png`).

Freigabesnapshots und Planung: CONTENT-PUBLICATION-2026-09-10 (interne Dokumentation, nicht veröffentlicht).
Die zusätzlichen API-/Browserfälle prüfen die echte Migration, Delivery/Preview,
Channel-Wechsel und Overrides, konkurrierende Freigaben sowie den echten Scheduler.
Abnahmescreenshots: `publication-draft-desktop.png`, `publication-draft-mobile.png`
und `publication-schedule-mobile.png` unter `test-results/`.
