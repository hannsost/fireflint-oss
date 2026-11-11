# Interner FlintPlate-v1-Vertrag für FireFlint

Originalschema und Semantik vom FlintPlate-Owner liegen unverändert in `schema/`.
`schema/source.json` dokumentiert Ursprung und SHA-256 beider Dateien. Der Export
vom 11.09.2026 ersetzt die vorherige Annahme eines noch ausstehenden Schemaexports.

`src/index.ts` enthält interne TypeScript-Typen für den normalisierten Snapshot
und die strukturelle Wire-Form mit optionalen Defaults. Diese Typen können im
bestehenden FireFlint-Web-/Mobile-Projekt verwendet werden. Das Verzeichnis ist
privat; es gibt keine veröffentlichte gemeinsame SDK-Version.

## Verwendung und Grenzen

```ts
import type { MenuSnapshotV1 } from "../../adapters/flintplate-contract/src/index";
```

Typen ersetzen keine Laufzeitvalidierung. Der serverseitige
[Rustdecoder](../../crates/sitegraph-domain/src/flintplate.rs) prüft inzwischen
Originalvertrag, Normalisierung, Quellhash und dokumentierte Empfängergrenzen im
[manuellen Menüimport](../../docs/FLINTPLATE-MENU-IMPORT.md). Dieser verbindet eine
ownerbestätigte Quelle mit einem privaten Entwurf; Channelzuordnung und explizite
Veröffentlichung erfolgen anschließend über die bestehende Inhaltsverwaltung.
Authentifizierter Live-Abruf und Editor-Rückkanal bleiben offen. Dieses private
TypeScript-Vertragsmodul enthält weiterhin keine eigenen HTTP-Funktionen,
Credentials, Instanzwrites oder native Builds und ist kein veröffentlichtes SDK.

- `menu_revision` ist ein opaker Quellhash. FireFlint `expected_revision` bleibt
  eine separate Ganzzahl. Der Hash deckt ausschließlich normalisierte `items` ab,
  weder Mandant, Betriebsstätte, Währung, Zeitzone noch Freigabe/Übertragungszeit.
  Er ist kein Authentizitätsnachweis und ersetzt keinen Mandanten-/Responseabgleich.
- Zeitstempel unverändert als String erhalten. Der Python-Produzent kann sechs
  Nachkommastellen ausgeben; `Date`/`toISOString()` würde Mikrosekunden verlieren.
  `published_at` ist die Erstellung des Übertragungssnapshots, keine FireFlint-
  Veröffentlichung. v1 hat eine Karte pro Betriebsstätte und ausschließlich EUR.
- Nur deklarierte Defaults ergänzen. Root: `schema_version=1`,
  `source_system="flintplate"`, `currency="EUR"`;
  Artikel: `takeaway_packaging=null`; Verpackung: `deposit_cents=0`, `reusable=false`.
  JSON-Schema-Defaults verändern eine Payload nicht automatisch.
- Root verbietet zusätzliche Keys. Verschachtelte Objekte erlauben sie im Schema;
  Pydantic ignoriert sie bei der Normalisierung. Diese Unterschiede erhalten und
  strengere eigene Regeln ausdrücklich als Empfängerregeln dokumentieren.
- JavaScript-Empfänger müssen Geld-/Versionswerte mit `Number.isSafeInteger`
  prüfen. Das Schema hat bei Artikel-Ganzzahlen keine entsprechenden Obergrenzen.
  Keine Präzisionsverluste still akzeptieren. Schema allein prüft nicht alle
  fachlichen Regeln wie gültige IANA-Zeitzone, gleiche Menü-/Betriebsstätten-ID,
  eindeutige ASCII-SKUs oder die Eingaberegeln für Preise/Steuern.
- Unverfügbare veröffentlichte Artikel bleiben Bestandteil der Karte. Allergene
  nicht umsortieren, Verpackungs- und Pfandpreise/-steuern getrennt erhalten.

## Reproduzierbare Prüfung

Nach Installation der bestehenden Admin-Entwicklungswerkzeuge:

```sh
npm --prefix adapters/flintplate-contract run check
```

Keine neuen Laufzeit-/Build-Abhängigkeiten. TypeScript kommt aus `admin/`; Node und
Python3 sind lokale Voraussetzungen. Der synthetische Python-Vektor benutzt keine
App-Imports, Konfiguration, Datenbank oder Kundendaten. Er enthält Umlaute, Emoji,
DEL, JSON-Escapes, ASCII-Sortierfälle, Null-/Defaultwerte und getrennte Pfandsteuern.
Ein unabhängiger JS-Test rekonstruiert die exakten Python-Bytes und den Hash.
Die JS-Referenzfunktion ist nur ein Testorakel, kein produktiver Hash-/Schema-Parser.
Die Checks prüfen Typen und Vertragsbeispiele; sie sind keine vollständige
JSON-Schema-Validierung oder Abnahme einer echten FireFlint-/FlintPlate-Verbindung.

Der FlintPlate-Owner meldete bei der Schemaübernahme vier bestandene HTTP-
Vertragstests und zwanzig gezielte Backendtests. Diese fremden Prüfnachweise werden
nicht als eigene erneut ausgeführte Tests gezählt. Eigene aktuelle FireFlint-
Prüfungen liegen in `admin/tests/flintplate-contract-api.spec.ts` und
`admin/tests/flintplate-import-api.spec.ts`; sie beweisen noch keine echte
FlintPlate-Verbindung oder einen Editor-Rückkanal.
