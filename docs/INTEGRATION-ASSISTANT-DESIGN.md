# Integrationsassistent – Entwurf vom 19.09.2026

Stand 22.09.2026: Die erste Ausbaustufe ist als regelbasierter Dateiassistent
implementiert: ausdrücklich gewählte CSV-/JSON-Datei untersuchen, Feldzuordnung
vorschlagen und bearbeiten, Verbindung speichern und den vorhandenen geprüften
Importweg verwenden. Anleitung und Grenzen stehen unter
[Dateiassistent](INTEGRATION-ASSISTANT.md). Die folgenden Abschnitte beschreiben
weiterhin den umfassenderen Entwurf für Remote-Discovery und Modellwerkzeuge;
Firmenlaufwerksuche, Ressourcenkatalog und ein ausführender Modellagent fehlen noch.

## Nutzerablauf

Die Nutzerin wählt eine Quelle und den freigegebenen Suchbereich. FireFlint zeigt
gefundene Bestände mit Fundort, Aktualität, erkennbarer Struktur und einer Begründung
für die vorgeschlagene Anbindung. Ein Beispiel: eine Kundenliste im freigegebenen
Firmenlaufwerk passt zu Kontakten; eine Produktdatei passt zum Produktkatalog.
Das System erstellt eine Feldzuordnung und Vorschau. Eine bestätigte Übernahme
verwendet die vorhandene atomare, revisionsgeprüfte Importoperation.

Ein Chat kann diese Schritte begleiten, Systeme erfragen und Ergebnisse erklären.
Alle Schritte bleiben als gewöhnliche Bedienoberfläche zugänglich. Ein nicht
konfiguriertes Modell führt zu einem sichtbaren Einrichtungszustand. Es darf keinen
als echten Agentenerfolg ausgegebenen Mock-Fallback geben.

## Vorhandene Bausteine

- `crates/sitegraph-api/src/ai.rs`: Provider-Transport, Tokenbudgets, vorhandene
  Content-Workflows und Protokollierung. Der Content-Graph ist kein allgemeiner
  Werkzeugautoritätsvertrag und wird nicht unverändert zum Discovery-Agenten.
- `hub/connectors.rs` und `connectors/*`: verschlüsselte Verbindungsdaten,
  Anbieteradapter, begrenzte Abrufe, Vorschau und atomare Übernahme.
- Unternehmensdatentypen, Quellen/Herkunft, Revisionshistorie, Aufgaben,
  Datenqualitätsprüfung und Module als wiederverwendbare fachliche Funktionen.

## Benötigte Verträge

Ein Discovery-Adapter bietet explizit `list_resources`, `describe_resource` und
`preview_resource` an. Jede Operation trägt Organisation, Verbindung, Benutzer,
freigegebenen Bereich und ein Seiten-/Zeit-/Größenbudget. Fortsetzungscursor werden
serverseitig auf dieselbe Verbindung und Berechtigung gebunden. Nicht durchsuchte
Bereiche und unterbrochene Läufe bleiben sichtbar.

Der Ressourcenkatalog speichert Quellenreferenz, Ressourcentyp, überprüfbare
Beobachtungen, Zeitpunkt, Herkunft, Vorschlagsgrund und Bearbeitungsstatus. Er
unterscheidet bestätigte Beobachtungen von einer Modellinterpretation. Gleiche
Dateinamen beweisen keine identischen Bestände. Entfernte oder nicht mehr lesbare
Ressourcen machen zugehörige Vorschläge ungültig.

Der Agent erhält eine kleine Werkzeugliste: Verbindungen auflisten, erlaubte
Ressourcen suchen, Metadaten beschreiben, Zuordnung vorschlagen, Importvorschau
vorbereiten. Zugangsdaten werden über den bestehenden Verbindungsdialog eingegeben
und sind nur dem serverseitigen Adapter zugänglich. Das Modell erhält keine
allgemeine Shell, beliebige HTTP-Aufrufe oder Datenbank-Schreibrechte.

Extern gefundene Dateiinhalte, Webseiten und Beschreibungen sind Eingabedaten.
Sie können weder neue Werkzeuge freischalten noch die gewählte Organisation oder
die Freigabegrenzen ändern. Der Server prüft jede Werkzeugoperation unabhängig
von Modelltext. Schreibende Schritte benötigen eine konkrete, geprüfte Operation
mit der ursprünglichen erwarteten Revision. Ein Konflikt verlangt eine neue
fachliche Prüfung; der Agent darf keine frische Revision zum Überschreiben nutzen.

Vor Nutzung eines externen Modells wird für die Organisation festgelegt, welche
Metadaten oder Inhalte an diesen Provider gehen dürfen. Standardmäßig reichen
Ressourcentyp, freigegebene Feldnamen und Datentypen für einen Zuordnungsvorschlag;
vollständige Firmenarchive werden dafür nicht vorausgesetzt.

## Quellenadapter und Reihenfolge

Zuerst die priorisierte reale Firmenquelle und deren Berechtigungsmodell klären.
Ein Dateiupload oder ein ausdrücklich freigegebener Bereich ist ein begrenzbarer
Start. Öffentliches Erkennen anhand einer Firmendomain ist ein eigener Adapter;
es beweist keinen Zugang zu internen Daten.

Microsoft Graph unterstützt gezielt freigegebene Sites, Listen, Ordner und Dateien.
Eine entsprechende Berechtigung benötigt sowohl die Zustimmung zum Scope als auch
die tatsächliche Ressourcenzuweisung; ein Keycloak-Login allein liefert diese
Freigabe nicht. [Microsoft Selected Permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview).

Google Drive bietet Datei-/Ordner-Metadaten und Suchfunktionen über seine API und
OAuth. Die konkrete Auswahl der Freigaben und gemeinsamer Laufwerke gehört in den
jeweiligen Adaptervertrag. [Google Drive API](https://developers.google.com/workspace/drive/api/guides/about-sdk).

Die derzeit implementierten CRM-/Shop-/ERP-Adapter liefern Unternehmensdatensätze.
Microsoft365-, Drive-, Nextcloud- oder lokale Suchadapter werden erst nach eigener
Implementierung und realer Abnahme als verfügbar angezeigt.

## Erforderliche Abnahme

Reale Discovery-Fixture mit mehreren Seiten und Abbruch/Fortsetzung; eingeschränkte
Freigaben; widerrufener Zugang; gleiche Ressource über mehrere Fundwege; keine
anderen Organisationen im Suchergebnis; adversarielle Anweisungen in Dateiinhalten;
kein Geheimnis in Modellinput, Antwort oder Protokoll; reproduzierbare Zuordnung;
veraltete Vorschau und konkurrierende Änderung; Browserablauf von der Fundliste bis
zum geprüften Import. Ohne echten Providerzugang werden Modell- und Adaptertests
als Fixture-Tests ausgewiesen.
