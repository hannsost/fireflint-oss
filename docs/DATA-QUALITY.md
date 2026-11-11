# Datenqualität und fachliche Dublettenprüfung

Optionales Modul `quality`, Version1, abhängig von `directory`. Ein Inhaber aktiviert
es in der Modulverwaltung. Die Seite `/hub/quality` bietet je Arbeitsbereich und
Datentyp konfigurierbare Regeln und nachvollziehbare, private Prüfnachweise. Sie
verwendet den organisationsgebundenen Katalog einschließlich eigener `hub_kinds`.
Ein deaktiviertes Fachmodul kann auch über Quality nicht ausgelesen/geprüft werden.

## Fachlicher Ablauf

1. Datentyp wählen und Regeln speichern. Pro Pflichtfeldgruppe muss mindestens ein
   Feld vorliegen; alle Gruppen gelten gemeinsam. Beispiel Kontakt: E-Mail ODER
   Telefon. Fehlend bedeutet null, nicht vorhanden oder leerer/Whitespace-Text;
   `false` und `0` gelten ausdrücklich als vorhanden.
2. Optional maximales Alter seit `updated_at` in Tagen wählen. Alter bedeutet
   Prüfanlass, keinen Beweis falscher Daten. Verglichen wird gegen den Startzeitpunkt
   des jeweiligen Laufs, strikt älter als N×24 Stunden. Eine spätere Betrachtung
   berechnet den historischen Befund nicht um; für einen neuen Zeitpunkt neu prüfen.
3. Namenshinweise oder Vergleichsschlüssel aus einem/mehreren Feldern konfigurieren.
   Jeder Komponententeil muss vorhanden sein und normalisiert übereinstimmen.
   Straßen-/PLZ-Felder können als zusammengesetzter Schlüssel verwendet werden;
   vorhandene einteilige Anschriften ebenfalls. Keine automatische Adresskorrektur.
4. Neue Prüfung starten und weitere Seiten ausdrücklich prüfen. Die Seite zeigt
   Startzeit, Regelrevision, Datensätze geprüft/erfasst/gesamt, Befundanzahl, vollständigen
   oder begrenzten Umfang und veraltete Stände. Ungespeicherte Regelentwürfe werden
   nicht ausgeführt; der Lauf verwendet ausschließlich die gespeicherte Regelrevision.
5. Befund öffnen, Quellreferenzen, gelesene Datensatzrevisionen, Originalwerte und
   Erklärung vergleichen. Einer oder mehrere Treffer bilden einen Gruppenhinweis.
   Kein automatisches Zusammenführen, Überschreiben, Archivieren oder Löschen von
   Unternehmensdaten. Quality schreibt niemals `hub_records`, `hub_versions` oder
   `hub_links`.
6. Bearbeitungsberechtigte dokumentieren Zuständigkeit, Status und einen Kommentar.
   Status `open`, `in_review`, `resolved`, `dismissed`. Außer `open` muss eine aktuelle
   Owner-/Editor-Person des Arbeitsbereichs zugewiesen sein. Jeder Schreibvorgang
   verlangt die tatsächlich gelesene Befundrevision und einen nichtleeren Kommentar.
   „Prüfung abgeschlossen“ bedeutet eine fachliche Beurteilung, keine Datenkorrektur.
   Es gibt keine erzwungene Zweitperson und kein Vier-Augen-Versprechen.

## Deterministische Vergleiche

Eigene, bewusst einfache Regeln ohne KI, unscharfe Suche oder neue Abhängigkeiten:

| Auswahl | Normalisierung | Grenzen |
| --- | --- | --- |
| Name / Text | Unicode-Kleinschreibung, Whitespace zusammenfassen, Ränder entfernen | Keine Transliteration, Akzententfernung, Unicode-Normalform oder Namensähnlichkeit; „Müller“ und „Muller“ bleiben verschieden |
| Kennung | Kleinschreibung, Whitespace und ASCII-Bindestrich entfernen | Sonstige Zeichen bleiben erhalten; `A/1` ist nicht `A1`; unterschiedliche Kennungssysteme benötigen getrennte Felder oder Namespace-Komponenten |
| E-Mail | Ränder entfernen, Kleinschreibung | Gemeinsames Postfach und theoretisch case-sensitive lokale Adressteile können Fehlhinweise erzeugen; keine Alias-/Provider-Erkennung |
| Telefon | Whitespace, ASCII-Bindestrich und runde Klammern entfernen | Keine Länderkennungsannahme, `00`-/`+`-Umsetzung oder Durchwahlbereinigung |

`$external_id` ist ausschließlich als Vergleichsfeld zulässig und wird immer um
`source_id` erweitert. Derselbe externe Text aus verschiedenen Systemquellen
belegt keine Dublette. Quellenübergreifende fachliche Kennungen benötigen ein
passendes gemeinsames Datenfeld (z.B. Steuerkennung), gegebenenfalls mit Namespace.
Die Seite zeigt tatsächliche Quell-IDs und externe Kennungen. Sie behauptet keine
überprüfte Kundenanbindung oder verifizierte Identität. `identity_confirmed` ist
bei allen Vergleichshinweisen false; identische Namen allein sind `name_hint`.

Eine Gruppe wird am ersten Datensatz der stabil nach UUID sortierten Momentaufnahme
verankert. Alle erfassten Datensätze werden in den Vergleichsindex einbezogen,
auch spätere Verarbeitungsseiten. Damit existiert jede Gruppe genau einmal; es
entsteht keine quadratische Liste aus allen möglichen Datensatzpaaren.

## Revisionen, Isolation und Aufbewahrung

- HTTP prüft authentifizierte Organisationsmitgliedschaft und Rolle. Viewer liest,
  Editor/Owner prüft und dokumentiert. Regeln/Scans/Befunde sind org-gebunden; jede
  Abfrage filtert org_id. Sowohl Quality als auch das Fachmodul des Datentyps müssen
  aktiviert sein. Unbekannte bzw. organisationsfremde Ressourcen ergeben404.
- Alle Mutationen verwenden `hub_begin` und denselben Organisations-Advisory-Lock
  wie die übrigen Hub-Schreibvorgänge. Rollen-/Modulprüfung, Revisionstest, Änderung,
  Historie und Ereignis erfolgen in einer Transaktion. Keine automatische Wiederholung
  mit frisch gelesener Revision bei Konflikten.
- Ein Scan bewahrt seine Regeln, Regel- und Typrevision und die erfassten Datenstände.
  Regel-/Typänderungen sowie Änderungen/Archivierungen/Entfernung erfasster Datensätze
  oder eine geänderte Anzahl aktiver Datensätze machen den Lauf und seine Befunde
  veraltet. Das gilt konservativ für den gesamten Lauf, auch wenn ein anderer
  Datensatz betroffen war. Veraltete Stände lassen sich lesen, aber weder fortsetzen
  noch als aktuelle Prüfung dokumentieren. Ein neuer Lauf übernimmt keine früheren
  Entscheidungen oder Kommentare. Historische Prüfung bleibt unverändert erhalten.
- Revisionskonflikte liefern409, fehlende Revision428. UI hält Entwurf und erfasste
  Revision fest. Ein neuer Serverstand wird zur Ansicht geladen; erst die ausdrückliche
  Auswahl übernimmt seine Revision oder verwirft den Entwurf. Private Entwürfe bleiben
  im bestehenden, nach Konto/Org getrennten Sitzungsspeicher der UI.
- Inhaber dürfen einen abgeschlossenen oder veralteten Lauf ausdrücklich entfernen.
  Veraltete Teilläufe sind eingeschlossen, weil sie nicht mehr fortgesetzt werden
  können. Unveränderte laufende Prüfungen sind geschützt. Die UI verlangt eine
  zweite ausdrückliche Bestätigung mit Laufzeitpunkt, Befundanzahl und Hinweis auf
  die endgültige Entfernung sämtlicher Befunde/Prüfhistorien dieses Laufs.
- `DELETE /scans/:id` verlangt Owner und die gelesene Scanrevision. Jede neue
  fachliche Prüfung erhöht auch diese Scanrevision: eine zwischenzeitliche Notiz
  verhindert die Löschung auf Grundlage einer alten Ansicht. Kaskadiert werden
  ausschließlich die Scan-Momentaufnahme, seine Befunde und Befundversionen.
  Unternehmensdaten, Regeln/Regelhistorie und `hub_events` bleiben erhalten. Das
  Ereignis `de.fireflint.quality.scan.deleted` nennt Revision, Anzahl entfernter
  Befunde/Prüfungen und `source_records_changed:0`. Keine automatische Bereinigung.

## Bewusste Grenzen

- Maximal1000 aktive Datensätze je org/kind/Lauf; darüber nur die ersten1000 nach
  UUID, ausdrücklich als unvollständig markiert. Kein Sampling-Vollständigkeitsversprechen.
  Mögliche Dubletten mit nicht erfassten Datensätzen werden nicht erkannt. Eine
  bloße Änderung außerhalb des gekappten Umfangs kann unbemerkt bleiben, wenn die
  Gesamtanzahl gleich bleibt; der Lauf ist weiterhin ausdrücklich unvollständig.
- Maximal8MiB Rohsnapshot; größere Stände werden ohne persistierten Teillauf abgewiesen.
  Die begrenzte SQL-Lesung kann davor bis zu1000 gültige Hub-Datensätze lesen.
- Maximal100 dauerhaft gespeicherte Läufe je Datentyp. Bei Erreichen können Inhaber
  bewusst abgeschlossene/veraltete Nachweise entfernen und danach neu prüfen.
- Je Verarbeitungsschritt höchstens100 Datensätze, maximal16 Pflichtfeldgruppen,
  1 Altersregel, 8 Vergleichsschlüssel plus Namenshinweise; Gruppe/Schlüssel maximal8
  Felder. Gruppierung verhindert paarweise Explosion. Ein Lauf kann bis zu21500
  Befunde erzeugen (17000 Einzelregeln + höchstens4500 Zweiergruppen).
- API-Seiten enthalten höchstens100 Einträge, Offset0..100000. Quellen einer
  Vergleichsgruppe enthalten höchstens1000 Referenzen; die UI zeigt diese in
  Seiten zu20. Läufe, Befunde und beide Historien sind paginiert. Scans liefern
  ihre Roh-Momentaufnahme nicht über HTTP aus.
- „Vollständig“ bedeutet nur: alle aktiven Datensätze des ausgewählten Datentyps
  zum aufgeführten Zeitpunkt innerhalb der Grenzen mit den konfigurierten Regeln
  geprüft, ohne erkannte spätere Änderung. Kein organisationsweiter Qualitätsscore,
  kein Anspruch auf inhaltliche Wahrheit. Deaktivieren bewahrt alle Nachweise.

## API und Registrierung

Migration `0023_hub_quality.sql`, SHA256
`fbb5a55868c514ce33aab33387f5ca13d401167719e7d666d837939d2b6b392e`.
Sie bleibt nach erster Anwendung unverändert. Tabellen `hub_quality_rules`,
`hub_quality_rule_versions`, `hub_quality_scans`, `hub_quality_findings`,
`hub_quality_finding_versions`. Keine Änderungen historischer Migrationen.

DB-Modul `hub/quality.rs`, HTTP `hub_quality.rs`; OpenAPI-Tag `data-quality` wird
über `hub_quality::api_doc()` eingebunden. Präfix `/api/orgs/:org/hub/quality`:

| Methode / Pfad | Aufgabe |
| --- | --- |
| GET/PUT rules/:kind | Regelstand bzw. Änderung mit expected_revision |
| GET rules/:kind/history | Versionierte Regelhistorie |
| GET/POST scans | Läufe für kind / Start mit kind und expected_rule_revision |
| GET/DELETE scans/:id | Umfang/Status / explizite Owner-Bereinigung mit expected_revision |
| POST scans/:id/step | Nächste100 Datensätze mit expected_revision |
| GET findings | Befunde für scan_id, optional status und offset |
| GET/PUT findings/:id | Befund / Beurteilung mit expected_revision,status,assignee_id,comment |
| GET findings/:id/history | Versionierte Prüfhistorie |

## Prüfnachweise

Eigene Suite: `admin/tests/hub-quality-api.spec.ts`, ausschließlich
`E2E_DATABASE=hub`: API28090, Admin25174, PostgreSQL25433, Container
`fireflint-hub-db`. Setup/Cleanup betrifft nur eigens erstellte Fixture-Organisationen
und synthetische Datensätze. Der Haupttask koordiniert Builds und Browserfenster.
Die Suite enthält echte HTTP-/DB-Sicherheits-, Revisions-, Paging- und Datenintegritätsfälle
sowie zwei echte Browserabläufe. Unitprüfungen testen konservative Normalisierung,
Namens-Fehlhinweise über Seiten hinweg und externe Namespace-Grenzen.

Bestanden auf API-Build6 in der isolierten Hub-Fixture: **10/10 echte API-/DB-Fälle**
in 1,7 Minuten, ohne Retries. Nachweis: (lokaler Nachweis, nicht veröffentlicht),
persistenter Dienst `fireflint-hub-quality-api-1`, `ExecMainStatus=0`.
Erneut am 22.09.2026 anhand von Log und Dienststatus bestätigt. Geprüft wurden:

- aktiviertes/deaktiviertes Modul, Fachmodulgrenzen, Viewer, private Cache-Header;
- Regelvalidierung, verpflichtende Revisionen, echte parallele CAS-Konflikte;
- Namens-Fehlhinweise, normalisierte Kennungen/Adressen, externe Quellen-Namespaces;
- unveränderliche Historie und veraltete Daten-, Regel- und eigene Typrevisionen;
- eigene Datentypen, AND-von-OR-Pflichtgruppen, false/0, Altersregeln, zusammengesetzte Schlüssel;
- 350 Datensätze und 351 Befunde ohne doppelte Gruppen über Prüfseiten hinweg;
- 1005 Datensätze mit sichtbarer 1000er-Grenze, 8 MiB-Abweisung ohne Teillauf;
- fremde Mandanten-IDs/Zuständigkeiten, Prüfhistorie, Kommentar-/Löschkonflikt;
- Owner-Bereinigung mit Audit, wiedergewonnene Kapazität am 100-Läufe-Limit;
- unveränderte Quellzeilen, Datensatzversionen, Beziehungen und Quellereignisse.

Am 22.09.2026 außerdem **2/2 echte Browsertests in 33,4 Sekunden** bestanden,
ohne automatische Retries: (lokaler Nachweis, nicht veröffentlicht),
Dienst `fireflint-hub-quality-browser-3`, `ExecMainStatus=0`. Verwendet wurde
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium` auf dem koordinierten Vite-Server.
Der erste Fall prüft Regeln speichern → Scan → Quellreferenz → fachlichen Kommentar
und Historie, 390-Pixel-Ansicht ohne horizontalen Überlauf sowie die ausdrückliche
Owner-Löschbestätigung und Abbrechen. Der zweite prüft einen echten serverseitigen
Regelkonflikt, erhaltene Eingaben, bewusste Revisionsübernahme und gesperrte
Viewer-Schreibaktionen in einem getrennten Browserkontext.

Drei Quality-Unitfälle stehen im gemeinsamen `evidence/rust-tests.log` als bestanden.
Der Haupttask bestätigte Backendbuild6 einschließlich Owner-Bereinigung und die
Workspace fmt/clippy-Prüfung. Der UI-Owner bestätigte den gemeinsamen Typecheck4
nach Ergänzung expliziter Arraytypen im Quality-Test. Der Haupttask besitzt den
abschließenden gemeinsamen Rust-/Admin-Gatestand. Produktdateien blieben während
der Browserläufe unverändert; nach Browserergebnis eingefroren.

### Vorläufe und Sitzungsvorfall

Der erste Browserstart scheiterte vor Ausführung am fehlenden Playwright-Cache-Binary.
Es wurde nichts heruntergeladen; der vorhandene System-Chromium löste das Problem.
Im folgenden Lauf bestand der erste Fachablauf. Der zweite Fall hatte die
Konfliktprüfung bereits bestanden, verwendete für den anschließenden Rollenwechsel
aber fälschlich „Abmelden“ beim gemeinsamen Test-Inhaberkonto. Dadurch wurde dessen
API-Sitzung widerrufen. Das Loginformular war beim nächsten Zugriff noch nicht
angezeigt, und der folgende Fixture-Cleanup erhielt401. Eine offene Demo-Sitzung
dieses Testkontos benötigt gegebenenfalls eine erneute Anmeldung. Die Sitzung wurde
nicht durch Datenbankänderung wiederhergestellt; keine weiteren Logout-, Passwort-
oder Revocation-Aktionen wurden durchgeführt. Der korrigierte Test verwendet
stattdessen einen separaten Viewer-Browserkontext und wartet explizit auf Speichern.

Die fehlgeschlagene eigene Fixture wurde nach Prüfung ihrer Identität und0 Assets
gezielt entfernt: Organisation `5cb4b2d4-ebb1-46c7-9e0a-b034018362ad`, Name
`Steward E2E 618d25f4-3bd8-4fa0-80ba-1d680f285bbb`, synthetischer Viewer
`04cec92b-cad7-4765-aefe-7c46cb3ec192`. Beide verbleibenden Zeilenzahlen wurden mit0
bestätigt. Keine andere Organisation und kein gemeinsames Testkonto wurden gelöscht.
Nachweise: `evidence/quality-browser.log`, `evidence/quality-browser-final.log`,
`evidence/quality-failed-fixture-cleanup.json`. Der abschließende Lauf bestand beide
Fälle einschließlich regulärem Fixture-Cleanup.
