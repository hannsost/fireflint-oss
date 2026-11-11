# Unternehmensdaten und modulare Erweiterungen

Auftrag vom 18.09.2026: FireFlint entwickelt sich zum plattformübergreifenden
Datenhub für Unternehmen. Bestehende Content-Publikation bleibt kompatibel.

Selbst ausprobieren (interne Dokumentation, nicht veröffentlicht) ·
Abnahme und Grenzen (interne Dokumentation, nicht veröffentlicht)

## Verbindliche Grenzen

- Ein Arbeitsbereich ist eine Sicherheitsgrenze. Unternehmens-/Kontakt-/Standortdaten
  innerhalb dieses Bereichs sind fachliche Objekte, keine neuen Auth-Mandanten.
- Interne Firmeninformationen werden niemals durch bloßes Speichern öffentlich.
- Login-Identitäten (OIDC issuer + subject), Benutzerkonten, Mitgliedschaften und
  reale Personen bleiben getrennt. Keine automatische Kontoverknüpfung per E-Mail.
- Die Modulregistrierung besitzt versionierte Definitionen, Abhängigkeiten und
  Rechte. Aktivierung wird im Backend geprüft, Deaktivierung bewahrt Daten.
- Änderungen verlangen die gelesene Revision; Importkonflikte werden angezeigt.
  Historie und Ereignis werden in derselben Transaktion wie die Änderung gespeichert.
- Beziehungen und externe Kennungen sind organisationsgebunden. Herkunft,
  Datenverantwortung und verknüpfte Systeme sind sichtbar.
- Synchronisation ist explizit gerichtet. Empfangene Fremddaten ersetzen keine
  lokalen Änderungen ohne Prüfung; Wiederholungen benötigen Idempotenz.
- Gemeinsame Tabellen für technische Metadaten ersetzen keine fachlichen Verträge.
  Module besitzen Validatoren und Operationen; vertrauliche Daten bleiben privat.
- Erweiterungen laufen zunächst im modularen Rust-Monolithen und PostgreSQL.
  Anbieter werden durch Adapter angebunden; keine dynamische Ausführung fremden Codes.

## Umsetzungsfolge und Abnahme

1. Modulverwaltung, versionierte Stammdaten und Beziehungen, Such-/Export-API.
2. OIDC mit PKCE, sicherer Verknüpfung, Sessionwiderruf und isoliertem Keycloak.
3. Aufgaben/Freigaben und In-App-Benachrichtigungen.
4. Versionierte Formulare und validierte Eingänge.
5. Integrationen: Importvorschau, atomare Übernahme, Herkunft und Ereignisse.
6. Übersetzungen mit Quellrevision, Medienmetadaten/Verwendung.
7. Ressourcen und atomare Terminreservierung.
8. Bedienoberfläche, echte Rollen-/Mandanten-/Konflikt-/Browserregressionen,
   Migration und Wiederanlauf; bestehende Veröffentlichungsregression bleibt grün.

Jeder Abschnitt wird erst nach tatsächlich bestandenen Nachweisen als fertig
bezeichnet. Technisch vorbereitete Adapter sind keine verifizierten Kundenanbindungen.

Referenzen: [OIDC](https://www.keycloak.org/securing-apps/oidc-layers),
[PKCE](https://www.keycloak.org/securing-apps/javascript-adapter),
[CloudEvents](https://cloudevents.io/), bestehende `modules/CAPABILITY-MAP.md`.

## Erweiterung und Betrieb

Eigene Datentypen werden organisationsgebunden im Katalog angelegt. Bestehende
Felder können kompatibel ergänzt werden; Feldentfernung, Typwechsel und nachträglich
verpflichtende Felder benötigen eine gesonderte Datenmigration. Das verhindert,
dass eine Katalogänderung gespeicherte Datensätze unbrauchbar macht. Der aktuelle
Vertrag begrenzt eigene Typen auf 100 je Organisation, Felder auf 40 je Typ und
Datensatzdaten auf 64 KiB. Die Modulregistrierung ist Teil des Rust-Builds; neue
fachliche Module ergänzen Definition, Repository, Routen und Oberfläche.

Die Service-Zugänge (interne Dokumentation, nicht veröffentlicht) liefern einen vollständigen Export mit
festem Ausgangsstand und anschließendem Änderungsabruf. Maschinenzugänge besitzen
explizite Datentyp-Berechtigungen und bleiben von Benutzer- und Website-Tokens
getrennt. Der einfache Download in der Oberfläche liest alle Ergebnisseiten,
ist bei parallelen Änderungen aber kein konsistentes Datenbankabbild.

Die [Datenqualitätsprüfung](DATA-QUALITY.md) liefert überprüfbare Hinweise statt
automatischer Zusammenführungen. Prüfumfang und veraltete Befunde werden angezeigt.
Die [Connector-Dokumentation](CONNECTORS.md) beschreibt verfügbare Importadapter,
Anbieterberechtigungen, Seitengrenzen und Fortsetzung. Fremde Zugangsdaten werden
verschlüsselt gespeichert; ein bereits geprüfter Import wird nur mit unveränderten
Datensatzrevisionen übernommen. Reale Kundenkonten sind separat abzunehmen.

Das optionale [Omarchy-Geräteinventar](DEVICE-INVENTORY.md) ergänzt manuelle
Inventarangaben, Zuordnungen zu Unternehmen/Person/Standort, Archiv und Historie.
Nur Inhaber bearbeiten Geräte; Mitglieder können sie lesen. Diese eigene
Modulgrenze gewährt keine Fernzugriffe und wird nicht über den vorhandenen
Stammdaten-Serviceexport ausgeliefert. Geräteagent und Installationsaufträge
bleiben spätere Ausbaustufen.

Schreiboperationen serialisieren zunächst je Organisation über einen PostgreSQL-
Transaktionslock. Dadurch bleiben Modulwechsel, Revisionsprüfungen und Buchungen
zusammenhängend. Dies ist eine bewusste Konsistenzentscheidung für die unterstützte
Einzelinstanz, keine Zusage für unbegrenzten Durchsatz. Große Lasten benötigen
Messungen und gegebenenfalls feinere Sperren; Volltext-/Feldindizes können später
anhand tatsächlicher Suchmuster ergänzt werden. Unveränderliche Revisionen,
Ereignisse und Service-Änderungen benötigen eine geplante Aufbewahrungsstrategie.

Vor Migration0024 müssen bestehende API-/Schreibprozesse beendet sein: der initiale
Service-Exportbestand wird einmalig aufgebaut. Das unterstützte StatefulSet arbeitet
mit genau einer API-Instanz und Migration vor deren Start. Historische Migrationen
werden nach Anwendung nicht verändert. Sicherungen enthalten Unternehmensdaten,
Schema-/Modulkonfiguration, Revisions- und Importzustände. Der vorhandene
Connector-Verschlüsselungsschlüssel wird zur Wiederherstellung benötigt.

## Klare fachliche Grenzen

- Aufgabenfreigaben beziehen sich auf eine konkrete Unternehmensdatensatzrevision.
  Sie erzwingen keine zusätzliche Freigabe der bestehenden Website-Publikation.
- Benachrichtigungen erscheinen innerhalb von FireFlint; E-Mail-Zustellung ist
  kein Bestandteil dieses Moduls.
- Übersetzungen dokumentieren ihren Quellstand. Automatische Website-Auslieferung
  oder Sprach-Fallback werden dadurch nicht eingeschaltet.
- Medienmetadaten dokumentieren Verwendung, Herkunft und Lizenz. Die vorhandenen
  Datei-URLs bleiben öffentlich adressierbar; dieses Modul ist kein privater
  Dokumentenspeicher und erzeugt keine Bildvarianten.
- Konfigurierte Termine reservieren Ressourcen in FireFlint. Kalenderanbieter,
  Zahlungsabwicklung oder automatische Buchungsbestätigungen sind eigene Adapter.

Der [Entwurf eines Integrationsassistenten](INTEGRATION-ASSISTANT-DESIGN.md) beschreibt
die nächste Ausbaustufe für das Auffinden und vorgeschlagene Anbinden von Ressourcen.
Diese Discovery-Funktion ist im vorliegenden Hub-Stand noch nicht implementiert.
