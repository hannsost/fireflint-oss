import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { ErrorNotice, PageTitle, RecordPicker, useAction, useDraft, useHub } from "./common";

type ImportRow = {
  external_id: string;
  name: string;
  kind: string;
  data: Record<string, unknown>;
  expected_revision?: number | null;
};
type ImportPayload = { source_id: string; request_key: string; rows: ImportRow[] };
type PreviewRow = { external_id: string; name: string; action: "create" | "update"; current_revision: number; conflict: boolean };
type ImportResult = { applied: true; rows: { id: string; kind: string; name: string; revision: number }[]; request_key: string };
type ImportPreview = { applied: false; rows: PreviewRow[] };
type ImportDraft = { sourceId: string; content: string; requestKey: string };

const example = JSON.stringify([{
  external_id: "kontakt-001", name: "Erika Beispiel", kind: "contact",
  data: { name: "Erika Beispiel", email: "erika@example.org" }, expected_revision: 0,
}], null, 2);

function readPayload(draft: ImportDraft): ImportPayload {
  if (!draft.sourceId) throw new Error("Bitte zuerst eine Datenquelle auswählen.");
  let rows: unknown;
  try { rows = JSON.parse(draft.content); }
  catch { throw new Error("Der Import enthält kein gültiges JSON. Erwartet wird eine Liste von Datensätzen."); }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw new Error("Bitte eine JSON-Liste mit 1 bis 100 Datensätzen eingeben.");
  }
  rows.forEach((row: unknown, index: number) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Zeile ${index + 1}: Ein Datensatz muss ein JSON-Objekt sein.`);
    const item = row as Record<string, unknown>;
    if (["external_id", "name", "kind"].some(key => typeof item[key] !== "string" || !(item[key] as string).trim())) {
      throw new Error(`Zeile ${index + 1}: external_id, name und kind müssen ausgefüllt sein.`);
    }
    if (!item.data || typeof item.data !== "object" || Array.isArray(item.data)) throw new Error(`Zeile ${index + 1}: data muss ein JSON-Objekt sein.`);
    if (item.expected_revision != null && (!Number.isSafeInteger(item.expected_revision) || (item.expected_revision as number) < 0)) {
      throw new Error(`Zeile ${index + 1}: expected_revision muss eine ganze Zahl ab 0 sein.`);
    }
  });
  return { source_id: draft.sourceId, request_key: draft.requestKey, rows: rows as ImportRow[] };
}

export function IntegrationsPage() {
  const { base, canWrite, invalidate } = useHub();
  const [initial] = useState<ImportDraft>(() => ({ sourceId: "", content: "", requestKey: crypto.randomUUID() }));
  const draft = useDraft<ImportDraft>("manual-import", initial);
  const action = useAction();
  const latest = useRef(draft.value);
  latest.current = draft.value;
  const [preview, setPreview] = useState<{ payload: ImportPayload; fingerprint: string; rows: PreviewRow[] } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function change(patch: Partial<Pick<ImportDraft, "sourceId" | "content">>) {
    draft.set(old => ({ ...old, ...patch, requestKey: crypto.randomUUID() }));
    setPreview(null);
    setResult(null);
  }
  async function inspect() {
    await action.run(async () => {
      const payload = readPayload(draft.value);
      const fingerprint = JSON.stringify(payload);
      const response = await api.post<ImportPreview | ImportResult>(`${base}/import/preview`, payload);
      if (latest.current.requestKey !== payload.request_key) return;
      if (response.applied) {
        setResult(response);
        setPreview(null);
        await invalidate();
      } else {
        setResult(null);
        setPreview({ payload, fingerprint, rows: response.rows });
      }
    });
  }
  async function apply() {
    await action.run(async () => {
      if (!preview || preview.rows.some(row => row.conflict) || preview.fingerprint !== JSON.stringify(readPayload(draft.value))) {
        throw new Error("Bitte diese Eingaben erneut prüfen, bevor der Import übernommen wird.");
      }
      const response = await api.post<ImportResult>(`${base}/import/apply`, preview.payload);
      if (latest.current.requestKey !== preview.payload.request_key) return;
      setResult(response);
      setPreview(null);
      await invalidate();
    });
  }

  const conflicts = preview?.rows.filter(row => row.conflict).length ?? 0;
  return <>
    <PageTitle title="Daten importieren" description="Externe Daten zunächst prüfen und anschließend gemeinsam übernehmen.">
      <Link className="button primary" to="/hub/integrations/assistant">Datei-Integrationsassistent</Link>
      <Link className="button" to="/hub/integrations/flintplate">FlintPlate-Menüs</Link>
      <Link className="button" to="/hub/integrations/connectors">Konnektoren</Link>
      <Link className="button" to="/hub/records/source">Datenquellen</Link>
    </PageTitle>
    {!canWrite && <p className="hint">Mit Leserechten können Sie Datenquellen und Konnektoren ansehen. Importieren erfordert Bearbeitungsrechte.</p>}
    <section className="panel" aria-labelledby="import-input-title">
      <h2 id="import-input-title">1. Quelle und Datensätze</h2>
      <p className="hint">Die externe Kennung ordnet jeden Datensatz dauerhaft seiner Quelle zu. Ein Import umfasst höchstens 100 Datensätze und veröffentlicht keine Inhalte.</p>
      <RecordPicker label="Datenquelle" kind="source" value={draft.value.sourceId} onChange={sourceId => change({ sourceId })} disabled={!canWrite || action.busy} />
      {canWrite && <p><Link to="/hub/records/source/new">Neue Datenquelle anlegen</Link></p>}
      <div className="field">
        <label htmlFor="import-json">Datensätze als JSON</label>
        <textarea id="import-json" className="hub-code-input" rows={15} value={draft.value.content} onChange={event => change({ content: event.target.value })} disabled={!canWrite || action.busy} spellCheck={false} aria-describedby="import-json-help" placeholder={example} />
        <p id="import-json-help" className="hint">Jeder Eintrag enthält external_id, name, kind, data und expected_revision. Für neue Datensätze ist die Revision 0 erforderlich; für Änderungen die bewusst geprüfte Revision. Fehlende oder abweichende Revisionen werden als Konflikt angezeigt.</p>
      </div>
      <details>
        <summary>Beispiel und Datenformat</summary>
        <pre className="hub-code">{example}</pre>
        <p className="hint">Die erlaubten Felder hängen vom Datentyp ab. Lokale Änderungen werden niemals automatisch durch eine neu geladene Revision ersetzt. Prüfen Sie bei einem Konflikt den bestehenden Datensatz und passen Sie den Import ausdrücklich an.</p>
        <Link to="/hub/records/contact">Kontakte prüfen</Link>
      </details>
      <div className="hub-actions">
        <button type="button" onClick={inspect} disabled={!canWrite || action.busy || !draft.value.sourceId || !draft.value.content.trim()}>{action.busy ? "Wird verarbeitet …" : "Import prüfen"}</button>
      </div>
      <ErrorNotice error={action.error} />
    </section>
    {preview && <section className="panel" aria-labelledby="import-preview-title">
      <h2 id="import-preview-title">2. Vorschau prüfen</h2>
      <p role="status">{preview.rows.length} Datensätze: {preview.rows.filter(row => row.action === "create").length} neu, {preview.rows.filter(row => row.action === "update").length} Änderungen, {conflicts} Konflikte.</p>
      <div className="hub-table-wrap"><table>
        <caption className="sr-only">Geplante Änderungen und Revisionsprüfung je Datensatz</caption>
        <thead><tr><th scope="col">Datensatz</th><th scope="col">Externe Kennung</th><th scope="col">Aktion</th><th scope="col">Erwartete Revision</th><th scope="col">Aktuelle Revision</th><th scope="col">Prüfung</th></tr></thead>
        <tbody>{preview.rows.map((row, index) => <tr key={row.external_id}>
          <th scope="row">{row.name}</th><td>{row.external_id}</td><td>{row.action === "create" ? "Neu anlegen" : "Aktualisieren"}</td>
          <td>{preview.payload.rows[index]?.expected_revision ?? "Nicht angegeben"}</td><td>{row.current_revision}</td>
          <td><span className={`badge ${row.conflict ? "hub-status-warning" : "hub-status-success"}`}>{row.conflict ? "Konflikt" : "Bereit"}</span></td>
        </tr>)}</tbody>
      </table></div>
      {conflicts > 0 ? <p className="hint">Der gesamte Import bleibt unverändert. Prüfen Sie die betroffenen Datensätze, bearbeiten Sie die Eingaben und erstellen Sie eine neue Vorschau.</p> : <p className="hint">Die Übernahme prüft alle Revisionen erneut. Bei einem Konflikt wird kein Datensatz dieses Imports geändert.</p>}
      <button type="button" onClick={apply} disabled={!canWrite || action.busy || conflicts > 0 || preview.rows.length === 0}>Geprüften Import übernehmen</button>
    </section>}
    {result && <section className="panel" aria-labelledby="import-result-title">
      <h2 id="import-result-title">Import übernommen</h2>
      <p role="status">{result.rows.length} Datensätze wurden übernommen. Ihre Eingaben bleiben erhalten.</p>
      <ul>{result.rows.map(row => <li key={row.id}><Link to={`/hub/records/${row.kind}/${row.id}`}>{row.name}</Link> · Revision {row.revision}</li>)}</ul>
    </section>}
  </>;
}
