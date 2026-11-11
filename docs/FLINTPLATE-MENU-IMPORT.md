# FlintPlate-Menüs in FireFlint übernehmen

Der Menüimport übernimmt ausdrücklich ausgewählte Snapshot-v1-Dateien oder einen
ausdrücklich abgerufenen FlintPlate-Snapshot in einen privaten Website-Entwurf.
FireFlint prüft Format, Quellhash und Betriebsstätte auf dem Server. Ein Inhaber
bestätigt zuerst die Quellzuordnung und richtet bei Bedarf einen begrenzten
Lesezugriff ein. Die Einrichtung allein belegt keine erreichbare Quelle. Abruf,
Übernahme und Website-Veröffentlichung bleiben getrennte Schritte; es gibt keine
automatische Synchronisation und keine Rückschreibung.

Die neue Abrufstrecke und ihre Abnahmegrenzen stehen in
E1 · authentifizierte Menüvorschau (interne Dokumentation, nicht veröffentlicht).

Lokale Hauptoberfläche: <http://localhost:5174/hub/integrations/flintplate>.
Implementierung und Grenzen sind im Abnahmebericht vom 22.09.2026 (interne Dokumentation, nicht veröffentlicht)
dokumentiert. Zum gefahrlosen Ausprobieren steht die isolierte Testoberfläche
<http://localhost:28091/hub/integrations/flintplate> mit synthetischen Daten bereit.
Die [synthetische Beispieldatei](../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json)
gehört ausschließlich in eine Testorganisation; ihre Betriebs-ID lautet
`10000000-0000-4000-8000-000000000001`.

Die ergänzende Zwei-Channel-/Neustartprüfung (interne Dokumentation, nicht veröffentlicht)
belegt außerdem die erhaltene Veröffentlichung und sichere Wiederholung nach
einem echten Neustart der Test-API.

Aktueller E1-Stand und sequenzielle Folgeaufgaben:
Live-Abgleich vom 22.09.2026 (interne Dokumentation, nicht veröffentlicht).

## Bedienung

1. Als Inhaber im Unternehmenshub das Modul **Integrationen** aktivieren.
2. **Daten importieren → FlintPlate-Menüs → Menüverbindung anlegen** öffnen.
3. Name, stabile Quellinstallations- und Quellmandantenkennung sowie die unabhängig
   geprüfte Betriebsstätten-UUID eingeben. Eine Quellzuordnung gilt nur innerhalb
   der gewählten FireFlint-Organisation.
4. JSON-Datei auswählen, **Snapshot prüfen**, Artikel und Angaben ansehen und die
   Zuordnung ausdrücklich bestätigen. **Verbindung und Menüentwurf anlegen**
   erstellt beides zusammen; bei Bedarf entsteht auch der Inhaltstyp `gastro_menu`.
   Ein vorhandenes inkompatibles Typschema wird nicht verändert.
5. **Websites und Veröffentlichung** führt zum bestehenden Inhaltseditor. Dort
   Channels zuordnen, Auswirkungen prüfen und die konkrete Revision ausdrücklich
   veröffentlichen. Importierte Quellfelder und lokale Overrides sind gesperrt.
6. Spätere Dateien auf der Menüverbindung prüfen. Der Vergleich zeigt alten und
   neuen Entwurf. **Geprüften Snapshot übernehmen** ersetzt nur den privaten
   Arbeitsstand; die bisherige Website-Publikation bleibt erhalten.

Viewer können Verbindungen und Menüstände lesen. Editor und Owner dürfen Dateien
prüfen und importieren; nur Owner richtet Quellen ein oder deaktiviert sie.
Deaktivieren stoppt neue Importe und erhält Daten sowie bestehende Publikationen.
Eine öffentliche Speisekarte wird über **Zurückziehen** im Inhaltseditor entfernt.
Quelle, Betriebsstätte und Zielobjekt einer Verbindung sind unveränderlich.

Bei 409 bleiben Eingaben und gelesene Revisionen erhalten. **Serverstand vergleichen**
zeigt den aktuellen Stand; erst **Serverstand übernehmen** ersetzt die eigene
Arbeitsbasis. Danach den weiterhin vorhandenen Dateiinhalt erneut prüfen.
Bei verlorener Importantwort darf exakt derselbe geprüfte Auftrag erneut gesendet
werden. Die Antwort kann den früher quittierten Importstand zeigen; sie setzt einen
inzwischen neueren Entwurf nicht zurück. Bei unklarer Erstanlage prüft die Oberfläche
die ursprüngliche Verbindungs-ID, statt eine neue Verbindung anzulegen.

Die Rohdatei bleibt in der geöffneten Ansicht im Arbeitsspeicher. Beim Verlassen,
Neuladen oder Konto-/Organisationswechsel ist eine neue Dateiauswahl nötig. Auf dem
Server werden ausschließlich erfolgreich übernommene normalisierte Snapshots,
Inhaltshistorie, Quellzuordnung und Importbelege gespeichert; die Prüfung allein
legt keinen Snapshot ab. Dateiname und Rohdatei werden nicht in einer Medienablage
veröffentlicht.

## Prüfung des Snapshot-v1-Vertrags

Originale bleiben unverändert im [Vertragsmodul](../adapters/flintplate-contract/README.md).
Der produktive [Rustdecoder](../crates/sitegraph-domain/src/flintplate.rs) prüft vor
jeder Erstanlage und Übernahme erneut, unabhängig von einer früheren Vorschau.

- `schema_version=1`, `source_system=flintplate`, `currency=EUR`; nur deklarierte
  Defaults ergänzen. Explizites `null` ersetzt keine Pflichtwerte.
- Root-Zusatzfelder ablehnen; verschachtelte Zusatzfelder entsprechend dem
  Quellmodell entfernen. Doppelte JSON-Schlüssel auch in später verworfenen
  Unterobjekten ablehnen. Keine Typumwandlung aus Strings oder Wahrheitswerten.
- `venue_id` und `menu_id` müssen dieselbe UUID und die bestätigte Betriebsstätte
  bezeichnen. Artikel-UUIDs und ASCII-SKUs sind eindeutig.
- IANA-Zeitzone und gültiger UTC-Zeitstempel; Originalstring einschließlich
  Mikrosekunden erhalten. Snapshot-Erstellungszeit ist keine FireFlint-Freigabe.
- Artikel für die Hashberechnung nach ASCII-SKU sortieren, Modell-Defaults
  ergänzen, Schlüssel sortieren und Python-kompatibel ASCII-JSON serialisieren.
  SHA-256 muss zu `menu_revision` passen. Die gespeicherte Artikelreihenfolge,
  Allergenenreihenfolge und unverfügbare Artikel bleiben erhalten.
- Der Quellhash bindet nur normalisierte Artikel. Er ist weder Echtheitsnachweis
  noch Änderungsreihenfolge. Metadaten bleiben deshalb separat geprüft; gleicher
  Artikelhash bedeutet nicht automatisch gleicher vollständiger Snapshot.

Zusätzliche dokumentierte Empfängergrenzen:

| Grenze | Wert |
| --- | --- |
| Rohsnapshot / HTTP-Anfrage | 500 KiB UTF-8 / 1 MiB einschließlich JSON-Hülle |
| Artikel / JSON-Tiefe | höchstens 500 / 64; leere Karte erlaubt |
| Einzelne Zeichenfolge oder Schlüssel | höchstens 16.384 UTF-8-Bytes; NUL wegen PostgreSQL-JSONB ausgeschlossen |
| SKU | 1–128 ASCII-Bytes, `[A-Za-z0-9][A-Za-z0-9._-]*` |
| Artikelversion / Preis in Cent | positive Ganzzahl / nichtnegative Ganzzahl, jeweils höchstens 9.007.199.254.740.991 |
| Steuersatz in Basispunkten | 0–10.000; Verpackungs- und Pfandsteuern getrennt |
| Verpackungs-/Pfandpreis | 0–10.000 Cent, wie im Originalschema |
| Verpackungsname | 1–80 Unicode-Zeichen, wie im Originalschema |
| Snapshot-Zeit | RFC3339 mit Offset 0, höchstens 9 Nachkommastellen, keine Schaltsekunde |
| Verbindungen / Importbelege | höchstens 100 / 5.000 je Organisation; keine automatische Belegverwerfung |

Leere Artikeltexte bleiben erlaubt, soweit das Quellschema sie erlaubt. Es wird
kein erfundenes Stationsverzeichnis vorausgesetzt. Fehler enthalten Feldpfade und
feste Beschreibungen, keine zurückgespiegelten privaten Eingabewerte.

## HTTP-Vertrag

Basispfad: `/api/orgs/{org}/hub/flintplate`. Benutzer-Access-JWT und passende
Organisationsmitgliedschaft sind erforderlich. Delivery- und `/hub/v1`-Lesetokens
sind keine Importberechtigung. Alle Schreibwege verlangen das aktive Modul
`integrations`; Deaktivierung und Rollenänderungen werden unter derselben
Org-Sperre beziehungsweise Mitgliedschaftssperre wie der Import geprüft.

| Methode / Pfad | Vertrag |
| --- | --- |
| `GET /` | Liste manuell bestätigter Verbindungen, einschließlich deaktivierter; `confirmation=manual`. Ohne Lesezugriff `connection_status=not_connected`, mit eingerichteten Zugangsdaten `read_access_configured` und öffentliche `live_source`-Metadaten. |
| `GET /{id}` | `{connection,content}` konsistent unter Verbindung→Content-Sperre lesen. |
| `POST /inspect` | `{venue_id,snapshot_json}` → `{snapshot,item_count}`; reine Prüfung ohne Speicherung. |
| `PUT /{client_uuid}` mit Revision 0 | `{expected_revision:0,name,source_instance,source_tenant,venue_id,snapshot_json,confirmed:true}`; Owner legt Verbindung und validen privaten Inhalt atomar an. Gleiche UUID nach unklarer Antwort nicht ersetzen; über GET abgleichen. |
| `PUT /{id}` mit bestehender Revision | `{expected_revision,name,enabled}`; Owner ändert nur Name/Importfreigabe. Fremde Zusatzfelder und Umleitungen ablehnen. |
| `POST /{id}/inspect` | `{snapshot_json,expected_revision,expected_content_revision}` → normalisierter Snapshot, Artikelzahl, Verbindung und bisheriger Inhalt. Beide ursprünglichen Revisionen prüfen. |
| `POST /{id}/apply` | Gleiche Felder plus stabile `request_id`-UUID → `{connection,content,applied:true,request_id}`; atomare Übernahme und Beleg. |

`snapshot_json` ist eine **Zeichenfolge mit den ursprünglichen JSON-Bytes nach
UTF-8-Decodierung**, kein bereits aufgelöstes Objekt. Nur so bleiben doppelte
Schlüssel beim Empfänger erkennbar. `expected_revision` bezeichnet die
Verbindungskonfiguration; `expected_content_revision` den FireFlint-Inhalt.
Importe ändern die Contentrevision, aber nicht die Konfigurationsrevision.

Replays sind an Organisation, Verbindung und Request-ID gebunden. Der Fingerprint
umfasst beide ursprünglichen Revisionen und den unveränderten Rohsnapshot; schon
abweichender Whitespace unter derselben ID ergibt 409. Aktuelle Rechte, Modul,
Verbindungsrevision und Aktivierung werden auch vor einem gespeicherten Ergebnis
geprüft. Beleg, Inhaltshistorie, neues Snapshot-JSON und internes Hub-Ereignis
entstehen mit der Änderung in einer Datenbanktransaktion.

Fehler: 400 ungültige Daten/inaktive Verbindung oder Modul; 401 fehlender Zugang;
403 Rolle/Mandant; 404 unbekanntes Objekt im eigenen Scope; 409 Revisions-, Quell-
oder Request-Konflikt; 413 zu große Anfrage; 428 fehlende gelesene Revision.
Nach Deaktivierung kann ein alter Auftrag bereits wegen seiner alten
Verbindungsrevision 409 liefern. Kein automatisches Nachladen und Wiederholen.

## Grenzen und Anschlussarbeit

Migration0026 ergänzt organisationsgebundene Tabellen/Fremdschlüssel und Guards.
Der Menüinhalt kann nicht über generische Edit-/Revert-/Delete-Wege umgangen werden;
abweichende interne Datenspeicherungen und nichtleere Channel-Overrides werden
zusätzlich in PostgreSQL abgewiesen. Gewöhnliche Inhalte bleiben unverändert.
Der generische Inhaltstypname allein macht einen früher separat angelegten Inhalt
noch nicht zu einem verwalteten Menü. Der Import legt neue gebundene Zielobjekte an.

Ein produktiver Pilot benötigt weiterhin eine konkrete FlintPlate-Instanz mit dem
begrenzten Snapshot-Leseendpunkt, einen dort eingerichteten Zugang und die
gemeinsame Abnahme der Quellzuordnung. Die neue ausdrückliche Abrufstrecke ist
kein automatisch laufender Adapter. Der
Editor-Rückkanal braucht zusätzlich einen atomar prüfbaren Quellversionsvertrag.
Diese Implementierung richtet weder einen Ereignisbus noch eine globale Personen-
oder Personalverwaltung ein. Der Architekturbacklog (interne Dokumentation, nicht veröffentlicht)
bleibt maßgeblich; die bestehende Content-Webhook-Lücke wird hier nicht verdeckt.

## Vollständiger lokaler Quellnachweis

Der zusammengesetzte Browser-/Quellablauf (interne Dokumentation, nicht veröffentlicht)
ist mit zehn Fällen bestanden: tatsächlicher authentifizierter Abruf, zwei
Websites, ausdrücklicher Import und Publish, Zugriffssperren, Originalrevisionen
nach I/O, späte Antworten und Wiederanlauf mit dauerhaftem Importbeleg.
`published_at` ist die pro GET neue Exportzeit. Bei unverändertem Menü können
daher Rohbytes differieren; ein Retry verwendet exakt den bereits geprüften
Snapshot und dieselbe Auftragskennung, keinen neuen Abruf.
