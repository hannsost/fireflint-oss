# FireFlint AI-Workflow-Syntax (feste Bausteine)

Diese Datei ist die **menschenlesbare Spiegelung** der festen Graph-Syntax. Die
maßgebliche Quelle ist die Konstante `COPILOT_SYSTEM` in
[`crates/sitegraph-api/src/ai.rs`](../crates/sitegraph-api/src/ai.rs) — sie wird
dem Chat-Copilot als System-Prompt übergeben. Die Engine im selben Modul
(`run_workflow`) konsumiert exakt diese Felder; jede hier beschriebene
Möglichkeit ist damit 1:1 in Code übersetzbar.

## Grundform

```json
{
  "nodes": [ { "id": "<eindeutig>", "type": "<kind>", "data": { } } ],
  "edges": [ { "source": "<id>", "target": "<id>", "branch": null } ]
}
```

## Knoten-Bausteine

| `type` | `data`-Felder | Verhalten / Ausgabe |
|---|---|---|
| `trigger` | — | Einziger Einstiegspunkt. Ausgabe = der Eingabetext des Laufs. |
| `agent` | `connector_id?` (UUID\|null), `model`, `system?`, `prompt` | Ein LLM-Aufruf. `connector_id` null ⇒ `mock`. Ausgabe = Modelltext. |
| `loop` | `connector_id?`, `model`, `prompt`, `iterations` (1–20) | Wiederholt den Prompt N-mal. Ausgabe = Iterationen mit `\n---\n` verbunden. |
| `condition` | `input` (Knoten-ID oder `"input"`), `contains` | Enthält die geprüfte Ausgabe `contains` ⇒ Kante `true`, sonst `false`. Durchreich-Ausgabe. |
| `parallel` | — | Fan-out: mehrere ausgehende Kanten laufen unabhängig. |
| `join` | — | Fan-in: Ausgabe = alle eingehenden Knoten-Ausgaben, mit `\n\n` verbunden. |
| `output` | `content_type` (Typ-**Key**), `mode?` (`draft`\|`publish`), `input?` (Knoten-ID) | Schreibt einen Entwurf. JSON-Objekt ⇒ Felder; sonst Text ins erste Feld. `publish` veröffentlicht sofort. |

**Modelle:** `claude-opus-4-8` (stärkstes), `claude-sonnet-4-6` (ausgewogen),
`claude-haiku-4-5-20251001` (schnell).

**Platzhalter in Prompts:** `{{input}}` = Lauf-Eingabe · `{{<knotenId>}}` =
Ausgabe dieses Knotens · `{{index}}` = Schleifenzähler (0-basiert).

**Kanten:** `branch` ist `null`, **außer** bei den beiden Kanten, die einen
`condition`-Knoten verlassen — die müssen `"true"` und `"false"` sein.

**Regeln:** genau ein `trigger`; mindestens ein `output`; eindeutige IDs
(snake_case); gerichteter azyklischer Graph (keine Zyklen — für Wiederholung den
`loop`-Knoten nutzen); für sauberen Content lässt man den letzten `agent` vor
einem `output` ein JSON-Objekt erzeugen, dessen Schlüssel zu den Feldern des
Ziel-Inhaltstyps passen.

## Beispiel-Prompt (für den Copilot)

> „Erzeuge aus einem **Stadtnamen** einen Entwurf vom Typ `standort`. Hole
> parallel eine plausible Adresse, über eine kurze Schleife zwei
> Telefonnummern-Vorschläge und typische Öffnungszeiten. Führe alles zusammen,
> lass Opus daraus ein JSON mit `name`, `adresse`, `telefon`, `oeffnungszeiten`
> bauen, und speichere das Ergebnis als Entwurf — wenn eine Adresse enthalten
> ist regulär, sonst zur Nachkontrolle."

## Beispiel-Flow (genau dieser Prompt, alle Bausteine)

Dieser Graph wird als Demo-Workflow **„Beispiel: Standort-Entwurf aus
Stadtname"** geseedet (Migration `0013_seed_ai_demo.sql`) und läuft auch gegen
den key-freien `mock`-Anbieter durch. Er nutzt jeden Knotentyp.

```json
{
  "nodes": [
    {"id":"start","type":"trigger","data":{}},
    {"id":"split","type":"parallel","data":{}},
    {"id":"address","type":"agent","data":{"model":"claude-sonnet-4-6","prompt":"Nenne eine plausible Beispieladresse (Strasse, PLZ Ort) fuer einen Unternehmensstandort in {{input}}. Antworte nur mit der Adresse."}},
    {"id":"phones","type":"loop","data":{"model":"claude-sonnet-4-6","iterations":2,"prompt":"Schlage eine plausible deutsche Festnetznummer fuer einen Standort in {{input}} vor (Variante #{{index}}). Nur die Nummer."}},
    {"id":"hours","type":"agent","data":{"model":"claude-sonnet-4-6","prompt":"Nenne typische Buero-Oeffnungszeiten in {{input}} im Format Mo-Fr 9-17 Uhr. Nur die Zeiten."}},
    {"id":"gather","type":"join","data":{}},
    {"id":"assemble","type":"agent","data":{"connector_id":null,"model":"claude-opus-4-8","system":"Du gibst ausschliesslich gueltiges JSON zurueck, ohne Erklaertext.","prompt":"Baue ein JSON-Objekt mit den Schluesseln \"name\", \"adresse\", \"telefon\", \"oeffnungszeiten\" fuer den Standort \"{{input}}\". Nutze diese Bausteine:\n{{gather}}"}},
    {"id":"valid","type":"condition","data":{"input":"assemble","contains":"adresse"}},
    {"id":"draft_ok","type":"output","data":{"content_type":"standort","mode":"draft","input":"assemble"}},
    {"id":"draft_review","type":"output","data":{"content_type":"standort","mode":"draft","input":"assemble"}}
  ],
  "edges": [
    {"source":"start","target":"split","branch":null},
    {"source":"split","target":"address","branch":null},
    {"source":"split","target":"phones","branch":null},
    {"source":"split","target":"hours","branch":null},
    {"source":"address","target":"gather","branch":null},
    {"source":"phones","target":"gather","branch":null},
    {"source":"hours","target":"gather","branch":null},
    {"source":"gather","target":"assemble","branch":null},
    {"source":"assemble","target":"valid","branch":null},
    {"source":"valid","target":"draft_ok","branch":"true"},
    {"source":"valid","target":"draft_review","branch":"false"}
  ]
}
```

> Hinweis: Im Board werden Knotenpositionen zusätzlich in `data.__pos`
> gespeichert; die Engine ignoriert dieses Feld.
