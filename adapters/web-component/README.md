# FireFlint / SiteGraph Web Component

Kleine Einbindung veröffentlichter Standortinhalte ohne Build-Schritt. Der Beispielrenderer zeigt `name`, `adresse`, `telefon` und `oeffnungszeiten`; für andere Inhaltsmodelle muss das Rendering angepasst werden. Die API liefert dabei bereits die für den Channel wirksamen lokalen Ausnahmen.

```html
<sitegraph-content
  api="https://delivery.example.com"
  channel="hauptseite"
  module="standort"
  token="PUBLIC_CHANNEL_DELIVERY_TOKEN"
></sitegraph-content>
<script src="./sitegraph-content.js"></script>
```

## Token und öffentliche Inhalte

**Nur einen channel-gebundenen Delivery-Token verwenden, dessen erreichbare Inhalte öffentlich sein dürfen.** Attribute, JavaScript und Browseranfragen sind für jeden Websitebesucher lesbar. Der Token ist hier kein Geheimnis; ein Hash im Cache-Schlüssel ändert daran nichts. Auch weitere über diesen Channel abrufbare Inhaltstypen müssen für die Öffentlichkeit geeignet sein. Ein Channel-Token begrenzt den Channel, nicht automatisch den Inhaltstyp.

Org-weite oder private Tokens gehören auf einen Server: [WordPress-Plugin](../wordpress-plugin/sitegraph/readme.txt) oder [Next.js-SDK in einer Server Component](../next-sdk/README.md). Private Tokens niemals in `NEXT_PUBLIC_*`, HTML-Attribute oder Client Components schreiben. Ein Token allein macht ausgeliefertes Website-HTML nicht privat; dafür benötigt auch die Website eine eigene Zugriffskontrolle.

HTTPS verwenden (lokal auch `http://localhost` bzw. Loopback). Der Browser muss die Delivery-API gemäß deren CORS-Konfiguration erreichen können. `api` ist die API-Basis ohne Query, Fragment oder URL-Zugangsdaten; ohne Attribut wird die aktuelle Origin verwendet.

## Cache und Fehler

- Jeder Aufruf lädt zuerst live, mit acht Sekunden Timeout und ohne Browser-HTTP-Cache. Attributwechsel brechen den alten Request ab und entfernen dessen sichtbaren Inhalt sofort. Überholte Antworten und Antworten nach Entfernen des Elements werden verworfen.
- `localStorage` speichert ausschließlich erfolgreich validierte Antworten. Der versionierte Schlüssel berücksichtigt API-Basis, Channel, Inhaltstyp und einen SHA-256-Hash des Tokens; der fertige Schlüssel enthält keinen Klartexttoken. Frühere ungebundene Cache-Schlüssel werden nicht gelesen oder migriert.
- Nur Netzwerkfehler, Timeout und HTTP 5xx dürfen einen gespeicherten Stand verwenden. Er muss **jünger als 15 Minuten seit erfolgreichem Abruf** sein. Ein sichtbarer Hinweis kennzeichnet ihn. Wiederholte Ausfälle verlängern diese Frist nicht.
- HTTP 401/403/404, andere HTTP-Fehler und ungültige erfolgreiche JSON-Antworten verwerfen den Cache dieses Zugriffs. Eine erfolgreiche leere Veröffentlichung ersetzt alte Inhalte ebenfalls.
- Ohne Web Crypto wird kein persistenter Cache verwendet. Nicht verfügbares bzw. volles `localStorage` verhindert die Liveanzeige nicht. Ungültige oder abgelaufene Cache-Einträge werden verworfen.

Eine serverseitige Sperrung lässt sich während eines Netzwerkausfalls nicht feststellen: Bereits öffentlich gelieferte Inhalte können innerhalb des genannten Fensters noch als Fallback erscheinen. Die Komponente ersetzt keine Zugriffskontrolle für private Inhalte. Alte Cache-Einträge anderer Zugriffe können bis zum Leeren der Website-Daten im Browser verbleiben; sie werden unter dem neuen Zugriff nicht verwendet.

## Gezielte Prüfungen

Keine Backend-/Kundendaten erforderlich:

```sh
node adapters/web-component/tests/cache.test.mjs
# Benötigt die installierten Playwright-Dependencies aus admin/ und Chromium:
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node adapters/web-component/tests/cache.browser.test.mjs
```
