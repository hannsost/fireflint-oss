# Omarchy-Geräteinventar

Abnahme und Grenzen (interne Dokumentation, nicht veröffentlicht)

Das optionale Modul `devices` erfasst Omarchy-Arbeitsrechner als privaten
Inventarbestand des Unternehmens. Diese erste Ausbaustufe wird manuell gepflegt.
Geräte sind noch nicht technisch verbunden: Es gibt keine automatische
Inventarsammlung, Softwareinstallation, Fernsteuerung oder Live-Erreichbarkeit.

## Ausprobieren

1. Als Inhaber unter **Unternehmenshub → Module** das Modul **Omarchy-Geräte**
   aktivieren und öffnen. Direkter Pfad: `/hub/devices`.
2. **Gerät erfassen** wählen. Gerätenamen und Inventarnummer eingeben, etwa
   „Vertrieb Notebook“ und `PC-001`.
3. Hersteller, Modell, Seriennummer und bekannte Omarchy-/Kernel-Version ergänzen.
   Leere Felder bedeuten „noch nicht erfasst“, keine automatisch erkannte Version.
4. Optional Unternehmen, Person und Standort aus den vorhandenen Stammdaten
   auswählen. Diese Zuordnungen vergeben weder Login- noch Gerätezugriffsrechte.
5. Speichern, den Datensatz erneut öffnen und die Änderungshistorie prüfen.
   **Im Archiv führen** bewahrt Daten und Historie. Das Gerät bleibt über
   **Archiv anzeigen** erreichbar und kann wieder in den aktiven Bestand wechseln.

Mitglieder können das Inventar lesen. Nur Inhaber können Geräte anlegen und
bearbeiten. Die bestehende Redaktionsrolle berechtigt nicht zur Geräteverwaltung.
Diese vorläufige Rollenregel ersetzt keine spätere gesonderte Geräteadministratorrolle.

## Änderungen und Konflikte

Jeder gespeicherte Stand erhält eine Revision, einen unveränderlichen historischen
Snapshot und ein Ereignis im Arbeitsbereich. Parallele Änderungen werden auf
der ursprünglich gelesenen Revision geprüft. Ein Konflikt lässt lokale Eingaben
erhalten. **Serverstand vergleichen** zeigt den anderen Stand separat;
**Serverstand übernehmen** ersetzt die Eingaben erst nach ausdrücklicher Auswahl.

Die Oberfläche behält die Gerätekennung auch nach einer fehlgeschlagenen
Speicherantwort. Eine erneute Anlage mit derselben Kennung erzeugt keinen zweiten
Datensatz. Wenn der erste Aufruf bereits gespeichert wurde, meldet die Wiederholung
einen Revisionskonflikt; der Vergleich erlaubt die Prüfung des vorhandenen Geräts.
Dies ist keine automatische Erfolgsbestätigung nach einem Netzwerkabbruch.

## Datenvertrag

Alle Routen liegen unter `/api/orgs/{org}/hub/devices` und benötigen eine gültige
Benutzersitzung, Organisationsmitgliedschaft und das aktivierte Modul.

| Operation | Vertrag |
| --- | --- |
| `GET /` | `q` als wörtliche Suche in Name, Inventarnummer, Modell und Seriennummer; `archived=false`; `offset=0`. Antwort: `items`, `total`, `offset`, `limit=100`. |
| `GET /{id}` | Aktueller organisationsgebundener Datensatz. |
| `PUT /{id}` | Inhaber; neue clientseitige UUID plus `expected_revision=0` für Anlage, gelesene Revision für jede Änderung. |
| `GET /{id}/history` | Bis zu 100 historische Stände, neueste zuerst; weitere über `offset`. |

Inventarnummern werden getrimmt und in ASCII-Großbuchstaben gespeichert. Sie
enthalten 1–64 Zeichen aus `A–Z`, `0–9`, `.`, `_`, `-`, beginnen mit Buchstabe/Zahl
und bleiben auch für archivierte Geräte je Organisation eindeutig. Seriennummern
werden nicht als eindeutige Geräteidentität behandelt.

Der Lebenszyklus unterscheidet `in_stock`, `in_use`, `repair` und `retired`.
Archivierung ist davon getrennt. Die Antwort weist die Herkunft ausdrücklich mit
`inventory_source=manual`, das Zielsystem mit `platform=omarchy` und die fehlende
technische Anbindung mit `connection_status=not_connected` aus. Diese Angaben und
erfundene Rückmeldezeitpunkte können nicht über Eingabefelder überschrieben werden.

Zuordnungen akzeptieren nur aktive Stammdatensätze des passenden Typs aus derselben
Organisation. Wird ein bereits zugeordneter Stammdatensatz später archiviert, darf
die vorhandene Zuordnung erhalten bleiben oder entfernt werden. Die Kennung des
archivierten Datensatzes bleibt in der Auswahl sichtbar.

Die erste Version begrenzt den Bestand auf 5000 Geräte einschließlich Archiv je
Organisation, die Suche auf 160 Bytes, Namen auf 240 Bytes, einzelne technische
Angaben auf 160 Bytes und Notizen auf 4096 Bytes. Der JSON-Body ist auf 16 KiB
begrenzt. Paginierte Listen sind kein konsistenter Gesamtexport bei parallelen
Änderungen. Das bestehende `/hub/v1` exportiert dieses separate Inventarmodul nicht.

## Betrieb und Erweiterung

Migration `0025_device_inventory.sql` ergänzt eigene Geräte- und Historientabellen.
Deaktivieren des Moduls sperrt dessen Zugriffe und bewahrt den Bestand. Das Modul
hat keine Verbindung zur öffentlichen Website-Auslieferung oder zum Medienupload.

Technische Registrierung, widerrufbare Maschinenidentitäten und echte Rückmeldungen
folgen als eigene Ausbaustufe. Die anschließende Software-/Konfigurationsverwaltung
benötigt den im [Modulentwurf](DEVICE-MANAGEMENT-DESIGN.md) beschriebenen
Auftragsvertrag. Ein manueller Inventareintrag autorisiert keine Ferninstallation.
