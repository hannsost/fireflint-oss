# Datei-Integrationsassistent

Der erste Assistent hilft Inhabern eines Arbeitsbereichs, einen CSV- oder
JSON-Export zu verstehen und einem Hub-Datentyp zuzuordnen. Er verwendet feste
Regeln für deutsche und englische Feldnamen. Die Vorschläge sind prüfbar und
bearbeitbar; sie behaupten keine fachliche Gewissheit.

Die Abnahme vom 22.09.2026 (interne Dokumentation, nicht veröffentlicht)
beschreibt die bestandenen Prüfungen und die tatsächlich behobenen Fehler.

## Ausprobieren

1. Das Modul **Datenaustausch** aktivieren und dort oder unter **Konnektoren** den
   **Datei-Integrationsassistenten** öffnen (`/hub/integrations/assistant`).
2. Eine UTF-8-Datei auswählen, bei CSV das passende Trennzeichen einstellen und
   **Datei untersuchen** wählen. Als Einstieg eignen sich die
   [drei fiktiven Kontakte](examples/hub-contacts.csv) mit Komma als Trennzeichen.
3. Zeilenzahl und Feldbeobachtungen prüfen. Als Ziel kommen Unternehmen, Kontakte,
   Standorte und Produkte infrage. Der Assistent zeigt Gründe und unklare
   Zuordnungen. Die externe Kennung und alle Pflichtfelder bewusst zuordnen.
   Eindeutigkeit im aktuellen Export belegt keine dauerhaft stabile Kennung.
4. Eine Datenquelle auswählen und einen Verbindungsnamen angeben. Eine fehlende
   Quelle lässt sich über den Link in einem neuen Tab anlegen. Anschließend
   **Datenquellen neu laden** wählen; der Upload bleibt in der geöffneten Ansicht.
5. **Verbindung speichern** legt die Konfiguration an. Noch werden keine
   Unternehmensdatensätze importiert. Änderungen an der Zuordnung speichern
   dieselbe Verbindung mit ihrer zuvor bestätigten Revision.
6. **Gespeicherte Vorschau erstellen** öffnet den vorhandenen Connector-Dialog
   mit den geplanten Änderungen. Erst **Geprüfte Vorschau übernehmen** importiert
   die Daten atomar. Zwischenzeitliche Änderungen führen zu einem Konflikt;
   die Anwendung überschreibt sie nicht durch automatische Revisionsanpassung.

Eine fehlerhafte Vorschau erhält die Verbindung, Datei und Zuordnung. Der nächste
Versuch erzeugt keine weitere Verbindung. Ist nach einem Verbindungsabbruch
unklar, ob das erstmalige Speichern gelungen ist, fordert die Oberfläche zur
Prüfung der vorhandenen Verbindungen auf und verhindert blindes erneutes Anlegen.
Bei einem Revisionskonflikt bleibt der ursprüngliche Stand erhalten. Die
gespeicherte Verbindung lässt sich zum Vergleich in einem zweiten Tab öffnen.

## Daten und Grenzen

Die Untersuchung sendet den ausdrücklich ausgewählten Dateiinhalt an die
FireFlint-API. Sie speichert weder Datei noch Verbindung und ruft keinen
Modellanbieter auf. Zurück kommen Feldpfade, vorkommende skalare Typen, Anzahl
vorhandener/nichtleerer Werte, Eindeutigkeit im Upload und Zuordnungsvorschläge.
Beispielwerte sind kein Bestandteil dieser Antwort.

Der Browser hält Datei und Entwurf nur im Speicher der geöffneten Ansicht. Beim
Verlassen, Neuladen sowie Organisations- oder Kontowechsel werden sie verworfen.
Dateiinhalte werden nicht in Browser-Storage, URL oder Navigationszustand übergeben.
Eine später ausdrücklich erstellte Importvorschau speichert dagegen die
zugeordneten Zeilen gemäß dem bestehenden [Connector-Vertrag](CONNECTORS.md).
Das ist kein Upload in die öffentlich adressierbare Medienablage.

- 1–100 Datensätze, höchstens 500 KiB Dateiinhalt und 512 KiB gesamte JSON-Anfrage.
  Wegen JSON-Escaping kann eine Datei bereits unter 500 KiB die Anfragegrenze erreichen.
- Höchstens 64 skalare Feldpfade und 8 JSON-Pfadsegmente; JSON muss ein Array von
  Objekten sein. CSV unterstützt Komma, Semikolon und Tabulator mit Anführungszeichen.
- Mehrdeutige oder fehlende Zuordnungen bleiben offen. Namen, E-Mail-Adressen
  und Zeilennummern werden nicht automatisch zu dauerhaften Kennungen erklärt.
- JSON-Schlüssel mit Punkten, doppelte Objektschlüssel und widersprüchliche
  Objekt-/Array-/Skalarstrukturen werden bei der Untersuchung abgelehnt.
  CSV-Spalten mit Punkten werden als exakte Spaltennamen behandelt.
- Die Zuordnung ersetzt keine fachliche Werteprüfung. Beispielsweise kann ein
  erkanntes E-Mail-Feld in der anschließenden Vorschau an ungültigen Werten scheitern.
- Die neue Untersuchung und Konfiguration erfordern die Rolle Inhaber. Redaktion
  und Lesende erhalten eine Erklärung; bestehende Connector-Rechte bleiben gültig.

Diese Ausbaustufe durchsucht keine verbundenen Cloudspeicher oder Firmenlaufwerke.
Ein LLM, Chat, Ressourcenkatalog und automatische Synchronisation sind weiterhin
eigene Aufgaben im [Discovery-Entwurf](INTEGRATION-ASSISTANT-DESIGN.md).
Die Laravel-Bewertung (interne Dokumentation, nicht veröffentlicht) hält die Architekturgrenzen
für spätere Erweiterungen fest.
