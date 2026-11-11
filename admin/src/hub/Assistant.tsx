import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { ErrorNotice, PageTitle, RecordPicker, useHub } from "./common";
import "./assistant.css";

type FileProvider = "csv" | "json";
type Delimiter = "," | ";" | "\t";
type Mapping = { kind: string; external_id: string; name: string; fields: Record<string, string>; delimiter: string };
type ObservedField = { path: string; types: string[]; present: number; non_empty: number; unique: boolean };
type Suggestion = { kind: string; label: string; mapping: Mapping; reasons: string[]; missing: string[] };
type Inspection = {
  version: 1; mode: "rules"; provider: FileProvider; delimiter: string; row_count: number;
  fields: ObservedField[]; suggestions: Suggestion[]; warnings: string[];
};
type SavedConnection = { id: string; name: string; revision: number; fingerprint: string };
type Operation = "file" | "inspect" | "save" | "preview";
type Ticket = { operation: Operation; generation: number };
const CONNECTORS = "/hub/integrations/connectors";
const MAX_CONTENT = 500 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const types: Record<string, string> = { string: "Text", number: "Zahl", boolean: "Wahrheitswert", null: "Nullwert" };

export function AssistantPage() {
  const { isOwner, user, org } = useHub();
  if (!isOwner) return <>
    <PageTitle title="Datei-Integrationsassistent" description="CSV- und JSON-Dateien Schritt für Schritt einem Datenbestand zuordnen." />
    <section className="panel"><h2>Regelbasierter Dateiassistent</h2>
      <p>Der Assistent untersucht eine ausdrücklich ausgewählte Datei, zeigt deren Struktur und schlägt nachvollziehbare Feldzuordnungen vor. Verbindungen einrichten können nur Inhaber dieses Arbeitsbereichs.</p>
      <p>Die Zuordnung wird geprüft, die Verbindung ausdrücklich gespeichert und erst danach eine Importvorschau erstellt. Eine Übernahme erfolgt in einem eigenen Schritt.</p>
      <Link className="button" to={CONNECTORS}>Vorhandene Konnektoren ansehen</Link>
    </section>
  </>;
  return <AssistantEditor key={`${user?.id}:${org}`} />;
}

function AssistantEditor() {
  const { base, contracts, invalidate } = useHub();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<FileProvider>("csv");
  const [delimiter, setDelimiter] = useState<Delimiter>(",");
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<SavedConnection | null>(null);
  const savedReceipt = useRef<SavedConnection | null>(null);
  const [creationUncertain, setCreationUncertain] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Operation | null>(null);
  const generation = useRef(0);
  const active = useRef(true);
  const inFlight = useRef<Ticket | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { active.current = true; return () => { active.current = false; generation.current += 1; }; }, []);
  useEffect(() => {
    if (!file) return;
    const leaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [file]);

  const writing = pending === "save" || pending === "preview";
  const kind = contracts.data?.kinds.find(item => item.key === mapping?.kind);
  const suggestion = inspection?.suggestions.find(item => item.kind === mapping?.kind);
  const cleanMapping = mapping ? { ...mapping, delimiter, fields: Object.fromEntries(Object.entries(mapping.fields).filter(([, path]) => path)) } : null;
  const fingerprint = JSON.stringify({ name: name.trim(), provider, source_id: sourceId, mapping: cleanMapping });
  const savedCurrent = !!saved && saved.fingerprint === fingerprint;
  const missing = mapping && kind ? [
    ...(!mapping.external_id ? ["Externe Kennung"] : []), ...(!mapping.name ? ["Bezeichnung"] : []),
    ...kind.fields.filter(field => field.required && !mapping.fields[field.key]).map(field => field.label),
  ] : [];
  const identity = inspection?.fields.find(field => field.path === mapping?.external_id);
  const identityReady = !!inspection && !!identity && identity.unique && identity.present === inspection.row_count && identity.non_empty === inspection.row_count;
  const ready = !!inspection && !!mapping && !!kind && !missing.length && identityReady && !!sourceId && !!name.trim();

  function changed() {
    generation.current += 1;
    inFlight.current = null;
    setPending(null);
    setError(null);
  }
  function clearInspection() {
    changed(); setInspection(null); setMapping(null);
  }
  function editMapping(next: Mapping) { changed(); setMapping(next); }
  async function run(operation: Operation, work: (current: () => boolean) => Promise<void>) {
    if (inFlight.current) return;
    const ticket = { operation, generation: generation.current };
    inFlight.current = ticket; setPending(operation); setError(null);
    const current = () => active.current && generation.current === ticket.generation && inFlight.current === ticket;
    try { await work(current); }
    catch (cause) { if (current()) setError(cause); }
    finally { if (current()) { inFlight.current = null; setPending(null); } }
  }
  function changeProvider(value: FileProvider) {
    if (writing || saved) return;
    clearInspection(); setProvider(value); setFile(null);
    if (fileInput.current) fileInput.current.value = "";
  }
  async function chooseFile(input: HTMLInputElement) {
    const selected = input.files?.[0];
    input.value = "";
    if (!selected || writing) return;
    clearInspection(); setFile(null);
    await run("file", async current => {
      if (selected.size > MAX_CONTENT) throw new Error("Die Datei ist größer als 500 KiB. Bitte eine kleinere Datei mit höchstens 100 Datensätzen auswählen.");
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(await selected.arrayBuffer()); }
      catch { throw new Error("Die Datei konnte nicht als UTF-8 gelesen werden. Bitte den Export als UTF-8 speichern."); }
      if (!current()) return;
      if (!content.trim()) throw new Error("Die Datei ist leer. Bitte eine CSV- oder JSON-Datei mit Datensätzen auswählen.");
      setFile({ name: selected.name, content });
    });
  }
  async function inspect() {
    if (!file) return;
    await run("inspect", async current => {
      const body = { provider, content: file.content, ...(provider === "csv" ? { delimiter } : {}) };
      if (bytes(JSON.stringify(body)) > 512 * 1024) throw new Error("Diese Datei überschreitet die Anfragegrenze von 512 KiB. Bitte einen kleineren Abschnitt auswählen.");
      const result = await api.post<Inspection>(`${base}/connectors/inspect-file`, body);
      if (!current()) return;
      if (result.version !== 1 || result.mode !== "rules" || result.provider !== provider || !result.suggestions.length) throw new Error("Die Dateiprüfung hat keine passende Struktur geliefert. Bitte erneut prüfen.");
      setInspection(result);
      setMapping({ ...result.suggestions[0].mapping, fields: { ...result.suggestions[0].mapping.fields }, delimiter });
    });
  }
  async function save() {
    if (!ready || !cleanMapping || savedCurrent || creationUncertain || savedReceipt.current?.fingerprint === fingerprint) return;
    await run("save", async current => {
      const acknowledged = savedReceipt.current;
      const body = { name: name.trim(), provider, object_type: "rows", source_id: sourceId, base_url: null, database: null, credentials: null, mapping: cleanMapping, enabled: true, expected_revision: acknowledged?.revision ?? 0 };
      let result: { id: string; name: string; revision: number };
      try {
        result = acknowledged ? await api.put(`${base}/connectors/${acknowledged.id}`, body) : await api.post(`${base}/connectors`, body);
      } catch (cause) {
        // An unconfirmed create must not turn into a duplicate on the next click.
        if (!acknowledged && current() && (!(cause instanceof ApiError) || cause.status >= 500)) setCreationUncertain(true);
        throw cause;
      }
      if (!current()) return;
      savedReceipt.current = { id: result.id, name: result.name, revision: result.revision, fingerprint };
      setSaved(savedReceipt.current);
      void invalidate();
    });
  }
  async function createPreview() {
    if (!saved || !savedCurrent || !file || !ready) return;
    await run("preview", async current => {
      const body = { expected_revision: saved.revision, content: file.content };
      if (bytes(JSON.stringify(body)) > 512 * 1024) throw new Error("Diese Datei überschreitet die Anfragegrenze von 512 KiB. Bitte einen kleineren Abschnitt auswählen.");
      const preview = await api.post<{ id: string }>(`${base}/connectors/${saved.id}/preview`, body);
      if (!current()) return;
      // Only server identifiers enter the URL. The file dies with this component.
      navigate(`${CONNECTORS}/${saved.id}?preview=${encodeURIComponent(preview.id)}`);
    });
  }
  function pathSelect(id: string, label: string, value: string, onChange: (path: string) => void, required = false) {
    return <div className="hub-field"><label htmlFor={id}>{label}</label><select id={id} value={value} onChange={event => onChange(event.target.value)} required={required} disabled={writing}>
      <option value="">{required ? "Bitte Quellfeld auswählen" : "Nicht zuordnen"}</option>
      {inspection?.fields.map(field => <option value={field.path} key={field.path}>{field.path}</option>)}
    </select></div>;
  }

  return <div className="file-assistant">
    <PageTitle title="Datei-Integrationsassistent" description="Dateistruktur verstehen, Felder bewusst zuordnen und einen Import vorbereiten."><Link className="button" to={CONNECTORS}>Konnektoren</Link></PageTitle>
    <section className="panel assistant-intro"><span className="eyebrow">REGELBASIERTER DATEIASSISTENT</span>
      <h2>Deine Datei. Eine nachvollziehbare Zuordnung.</h2>
      <p>Wähle einen CSV- oder JSON-Export. FireFlint untersucht Feldnamen und Datentypen und erklärt passende Zuordnungsvorschläge. Du prüfst die Zuordnung und entscheidest über jeden Speicherschritt.</p>
      <p className="hint">Es werden ausschließlich feste Regeln verwendet. Ein Sprachmodell oder eine Suche in verbundenen Systemen ist nicht eingerichtet.</p>
      <ol className="assistant-steps" aria-label="Ablauf"><li>Datei untersuchen</li><li>Zuordnung und Verbindung speichern</li><li>Vorschau prüfen und ausdrücklich übernehmen</li></ol>
    </section>
    <section className="panel" aria-labelledby="assistant-file-heading">
      <h2 id="assistant-file-heading">1. Datei untersuchen</h2>
      <p className="hint">UTF-8 · 1 bis 100 Datensätze · maximal 500 KiB und 64 Feldpfade. Beim Untersuchen wird die Datei zur Auswertung an FireFlint gesendet; diese Prüfung speichert keine Datei oder Verbindung.</p>
      <div className="hub-fields">
        <div className="hub-field"><label htmlFor="assistant-provider">Dateiformat</label><select id="assistant-provider" value={provider} disabled={writing || !!saved} onChange={event => changeProvider(event.target.value as FileProvider)}><option value="csv">CSV</option><option value="json">JSON</option></select></div>
        {provider === "csv" && <div className="hub-field"><label htmlFor="assistant-delimiter">CSV-Trennzeichen</label><select id="assistant-delimiter" value={delimiter} disabled={writing} onChange={event => { if (writing) return; clearInspection(); setDelimiter(event.target.value as Delimiter); }}><option value=",">Komma</option><option value=";">Semikolon</option><option value={"\t"}>Tabulator</option></select></div>}
        <div className="hub-field hub-wide"><label htmlFor="assistant-file">Importdatei</label><input ref={fileInput} id="assistant-file" type="file" accept={provider === "csv" ? ".csv,text/csv,text/plain" : ".json,application/json"} disabled={writing} onChange={event => void chooseFile(event.currentTarget)} /></div>
      </div>
      {file && <p className="assistant-filename"><strong>Ausgewählt:</strong> {file.name}</p>}
      <p className="hint">Datei und Entwurf bleiben nur in dieser geöffneten Ansicht. Beim Verlassen, Neuladen oder Wechsel des Arbeitsbereichs musst du die Datei erneut auswählen. Eine gespeicherte Verbindung bleibt erhalten.</p>
      <button type="button" disabled={!file || !!pending || !!inspection} onClick={() => void inspect()}>{pending === "inspect" ? "Datei wird untersucht …" : "Datei untersuchen"}</button>
      {pending === "file" && <p role="status">Datei wird gelesen …</p>}
    </section>
    <ErrorNotice error={error} />
    {creationUncertain && <section className="panel" role="alert"><h2>Speicherergebnis nicht bestätigt</h2><p>Die Verbindung könnte bereits gespeichert sein. Prüfe zuerst die vorhandenen Konnektoren, bevor du eine weitere Verbindung anlegst. Deine Datei und Zuordnung bleiben hier erhalten.</p><Link to={CONNECTORS} target="_blank" rel="noopener noreferrer">Vorhandene Verbindungen prüfen (neuer Tab)</Link></section>}
    {saved && error instanceof ApiError && error.status === 409 && <section className="panel"><h2>Gespeicherte Verbindung vergleichen</h2><p>Diese Ansicht verwendet weiterhin die bewusst gespeicherte Revision {saved.revision}. Öffne die Verbindung zum Vergleich in einem neuen Tab. Deine Datei und Zuordnung bleiben hier erhalten; eine neuere Revision wird nicht automatisch übernommen.</p><Link to={`${CONNECTORS}/${saved.id}`} target="_blank" rel="noopener noreferrer">Gespeicherte Verbindung prüfen (neuer Tab)</Link><p className="hint">Nach dem Vergleich kannst du den Import in der Konnektoransicht mit dem dort ausdrücklich geprüften Stand fortsetzen und die Datei erneut auswählen.</p></section>}
    {inspection && mapping && <>
      <section className="panel" aria-labelledby="assistant-observations-heading">
        <h2 id="assistant-observations-heading">Erkannte Dateistruktur</h2><p role="status">{inspection.row_count} Datensätze · {inspection.fields.length} Feldpfade</p>
        <p className="hint">Die Beobachtungen beschreiben diese Datei. Beispielwerte und Dateiinhalte werden hier nicht angezeigt.</p>
        <div className="hub-table-wrap"><table><caption className="sr-only">Beobachtete Felder der ausgewählten Datei</caption><thead><tr><th scope="col">Quellfeld</th><th scope="col">Datentypen</th><th scope="col">Vorhanden</th><th scope="col">Nicht leer</th><th scope="col">Eindeutig in dieser Datei</th></tr></thead><tbody>{inspection.fields.map(field => <tr key={field.path}><th scope="row">{field.path}</th><td data-label="Datentypen">{field.types.map(type => types[type] ?? type).join(", ")}</td><td data-label="Vorhanden">{field.present} / {inspection.row_count}</td><td data-label="Nicht leer">{field.non_empty} / {inspection.row_count}</td><td data-label="Eindeutig in dieser Datei">{field.unique ? "Ja" : "Nein"}</td></tr>)}</tbody></table></div>
        {!!inspection.warnings.length && <div className="assistant-notes"><h3>Hinweise zur Datei</h3><ul>{inspection.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      </section>
      <section className="panel" aria-labelledby="assistant-mapping-heading">
        <h2 id="assistant-mapping-heading">2. Zuordnung prüfen und Verbindung speichern</h2>
        <p>Die Vorschläge sind nach den erkannten Feldnamen geordnet. Mehrdeutige Zuordnungen bleiben zur bewussten Auswahl offen. Die spätere Vorschau prüft die tatsächlichen Werte.</p>
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <div className="hub-field"><label htmlFor="assistant-kind">Ziel-Datentyp</label><select id="assistant-kind" value={mapping.kind} disabled={writing} onChange={event => { const next = inspection.suggestions.find(item => item.kind === event.target.value); if (next) editMapping({ ...next.mapping, fields: { ...next.mapping.fields }, delimiter }); }}>{inspection.suggestions.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></div>
          {suggestion && <div className="assistant-notes"><h3>Warum dieser Vorschlag?</h3><ul>{suggestion.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>{!!suggestion.missing.length && <p className="hint">Im ursprünglichen Vorschlag ungeklärt: {suggestion.missing.join(", ")}. Ergänze die passende Zuordnung unten.</p>}</div>}
          <fieldset disabled={writing}><legend>Feldzuordnung</legend><div className="hub-fields">
            {pathSelect("assistant-external-id", "Externe Kennung: Quellfeld", mapping.external_id, value => editMapping({ ...mapping, external_id: value }), true)}
            {pathSelect("assistant-name-field", "Bezeichnung: Quellfeld", mapping.name, value => editMapping({ ...mapping, name: value }), true)}
            {kind?.fields.map(field => <div className="assistant-mapping-field" key={field.key}>{pathSelect(`assistant-field-${field.key}`, `${field.label}: Quellfeld`, mapping.fields[field.key] ?? "", value => editMapping({ ...mapping, fields: { ...mapping.fields, [field.key]: value } }), field.required)}{field.required && <small className="hint">Pflichtfeld</small>}</div>)}
          </div></fieldset>
          <p className="hint">Die externe Kennung muss vollständig und eindeutig sein. Eindeutigkeit in diesem Upload garantiert keine dauerhafte Stabilität: Prüfe, ob dieselbe Kennung bei späteren Exporten denselben Datensatz bezeichnet.</p>
          {mapping.external_id && !identityReady && <p className="assistant-warning">Das ausgewählte Kennungsfeld ist in dieser Datei nicht vollständig, nicht durchgehend ausgefüllt oder nicht eindeutig.</p>}
          {!!missing.length && <p className="assistant-warning">Noch zuzuordnen: {missing.join(", ")}.</p>}
          <ErrorNotice error={contracts.error} onReload={() => void contracts.refetch()} />
          <div className="hub-fields">
            <RecordPicker kind="source" label="Datenquelle" value={sourceId} disabled={writing || !!saved} onChange={value => { changed(); setSourceId(value); }} />
            <div className="hub-field"><label htmlFor="assistant-connection-name">Verbindungsname</label><input id="assistant-connection-name" required maxLength={240} value={name} disabled={writing} onChange={event => { changed(); setName(event.target.value); }} /></div>
          </div>
          {!saved && <div className="hub-actions"><Link to="/hub/records/source/new" target="_blank" rel="noopener noreferrer">Datenquelle anlegen (neuer Tab)</Link><button type="button" disabled={writing} onClick={() => void invalidate()}>Datenquellen neu laden</button></div>}
          {!saved && <p className="hint">Lege eine fehlende Quelle im neuen Tab an und lade anschließend die Datenquellen hier neu. Deine ausgewählte Datei bleibt in dieser Ansicht erhalten.</p>}
          <p className="hint">Beim Speichern werden ausschließlich Verbindung und Feldzuordnung angelegt oder geändert. Unternehmensdatensätze bleiben bis zur ausdrücklichen Übernahme unverändert.</p>
          <button type="submit" disabled={!ready || !!pending || savedCurrent || creationUncertain}>{pending === "save" ? "Verbindung wird gespeichert …" : "Verbindung speichern"}</button>
        </form>
      </section>
    </>}
    {saved && <section className="panel" aria-labelledby="assistant-preview-heading"><h2 id="assistant-preview-heading">3. Gespeicherte Vorschau vorbereiten</h2>
      <p role="status">Verbindung „{saved.name}“ gespeichert · Revision {saved.revision}.</p>
      <p className="hint">Dateiformat und Datenquelle sind jetzt fest mit dieser Verbindung verbunden. Änderungen an Name oder Zuordnung speichern dieselbe Verbindung mit ihrer gelesenen Revision.</p>
      {!savedCurrent && <p className="assistant-warning">Die Zuordnung oder Verbindung wurde geändert. Prüfe die Dateistruktur und speichere die Änderungen vor der Vorschau.</p>}
      <p>Mit dem nächsten Schritt werden die zugeordneten Zeilen als Vorschau gespeichert. Du siehst anschließend die geplanten Änderungen und entscheidest dort über die Übernahme.</p>
      <div className="hub-actions"><button type="button" disabled={!savedCurrent || !ready || !!pending} onClick={() => void createPreview()}>{pending === "preview" ? "Vorschau wird erstellt …" : "Gespeicherte Vorschau erstellen"}</button><Link to={`${CONNECTORS}/${saved.id}`}>Gespeicherte Verbindung öffnen</Link></div>
      <p className="hint">Falls die Vorschau fehlschlägt, bleibt die Verbindung gespeichert. Erneutes Prüfen verwendet dieselbe Verbindung; es wird keine weitere angelegt.</p>
    </section>}
  </div>;
}
