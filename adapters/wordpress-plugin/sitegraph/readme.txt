=== SiteGraph ===
Contributors: sitegraph
Tags: cms, content, headless, multisite
Requires at least: 6.0
Requires PHP: 7.4
Stable tag: 0.1.0
License: MIT

Bindet zentral in SiteGraph gepflegte Inhalte (Team, Standorte, Jobs …) in
WordPress ein — serverseitig gerendert, mit Cache und Ausfall-Fallback.

== Beschreibung ==

SiteGraph pflegt Inhalte einmal zentral und spielt sie auf mehreren Websites aus.
Dieses Plugin holt die für einen Channel veröffentlichten Inhalte über die
Delivery-API und zeigt sie an — per Shortcode oder Gutenberg-Block.

* Serverseitiges Rendering (SEO-freundlich, funktioniert ohne JavaScript)
* Kurzzeit-Cache (Transient) für Performance
* Begrenzter Fallback: Bei Netzwerkfehlern oder HTTP 5xx kann eine höchstens
  15 Minuten alte Version mit sichtbarem Hinweis angezeigt werden.

== Einrichtung ==

1. Plugin aktivieren.
2. Einstellungen → SiteGraph öffnen und API-URL + Delivery-Token eintragen.
3. Inhalte einbinden:
   * Shortcode: [sitegraph module="job" channel="karriere"]
   * Block: „SiteGraph Inhalt" einfügen, Modul + Channel wählen.

== Hinweise ==

* Der Token autorisiert nur Lesezugriff auf die Delivery-API. Ein
  channel-gebundener Token kann nur seinen Channel lesen.
* Cache-Dauer: 60 Sekunden (Transient). Fallback maximal 15 Minuten seit dem
  erfolgreichen Abruf; wiederholte Ausfälle verlängern diese Frist nicht.
* Versionierte Cache-Schlüssel trennen API-URL, Channel, Inhaltstyp und einen
  SHA-256-Hash des Tokens. Kein Klartexttoken im Schlüssel oder Cache-Inhalt.
  Alte ungebundene Cache-Einträge werden nicht gelesen oder migriert.
* HTTP 401/403/404, andere nicht erfolgreiche HTTP-Antworten außerhalb 5xx sowie
  ungültiges JSON verwerfen den Cache dieses Zugriffs. Leere erfolgreiche
  Veröffentlichungen ersetzen zuvor gespeicherte Inhalte.
* Tokens bleiben serverseitig in den WordPress-Einstellungen. Channel-gebundene
  Tokens mit kleinstem benötigten Zugriff bevorzugen. Private Tokens nicht an
  eine Browser-Komponente oder öffentliche JavaScript-Konfiguration weitergeben.
* Ein frischer Cache kann einen Widerruf bis zu 60 Sekunden später bemerken.
  Während eines Netzwerkausfalls ist ein Widerruf nicht prüfbar; innerhalb der
  15-Minuten-Frist kann die zuletzt gelieferte Version als Fallback erscheinen.
  Nach einem tatsächlich empfangenen Auth-/Not-found-Fehler gibt es keinen
  Rückgriff auf diesen Stand. Eine sofortige Zugriffssperre erfordert auch
  Kontrolle über vorgeschaltete WordPress-/CDN-/Seiten-Caches.
* Serverseitige Tokens machen gerendertes Website-HTML nicht automatisch privat.
  Private Inhalte benötigen eine eigene Zugriffskontrolle der Website.
* Backups werden bei Zugriff auf ihr Ablaufdatum geprüft und dann gelöscht;
  ungenutzte alte Einträge können bis zur Bereinigung/Deinstallation gespeichert
  bleiben. Sie werden bei einem anderen Token nicht verwendet.

== Adapterprüfung ==

Isolierte PHP-Stubtests ohne Datenbank und Netzwerk, ab Repository-Wurzel:
php adapters/wordpress-plugin/tests/client-test.php
