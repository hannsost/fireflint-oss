import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ContentObject } from "../types";
import { Empty, ErrorNotice, PageTitle, formatDate, useDraft, useHub, useHubQuery } from "./common";
import "./flintplate.css";

interface Packaging { name: string; price_cents: number; deposit_cents: number; tax_rate_bps: number; deposit_tax_rate_bps: number; reusable: boolean }
interface MenuItem { id: string; sku: string; version: number; name: string; description: string; category: string; price_cents: number; tax_rate_bps: number; allergens: string[]; available: boolean; station: string; takeaway_packaging: Packaging | null }
interface Menu { schema_version: number; source_system: string; venue_id: string; menu_id: string; menu_revision: string; currency: string; timezone: string; published_at: string; items: MenuItem[] }
interface Connection { id: string; org_id: string; name: string; source_instance: string; source_tenant: string; venue_id: string; content_id: string; revision: number; enabled: boolean; created_at: string; updated_at: string; confirmation: "manual"; connection_status: "not_connected" | "read_access_configured"; live_source?: { base_url: string; auth_scheme: "X-FlintPlate-Key"; scope: "menu:read" } | null }
interface ConnectedMenu { connection: Connection; content: ContentObject }
interface Inspection { snapshot: Menu; item_count: number }
interface ImportPayload { snapshot_json: string; expected_revision: number; expected_content_revision: number; request_id: string }
interface ImportPreview extends Inspection, ConnectedMenu { payload: ImportPayload; transport?: "authenticated_fetch" }
interface FetchedMenu extends Inspection, ConnectedMenu { snapshot_json: string; transport: "authenticated_fetch" }
interface CreationDraft { id: string; name: string; source_instance: string; source_tenant: string; venue_id: string }
interface EditDraft extends ConnectedMenu { name: string; enabled: boolean }
type Operation = "file" | "inspect" | "create" | "save" | "apply" | "compare" | "save_source" | "fetch";
const ROOT = "/hub/integrations/flintplate";
const MAX_FILE_BYTES = 500 * 1024;
const size = (text: string) => new TextEncoder().encode(text).length;
function money(cents: number) {
  const exact = BigInt(cents);
  const euros = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(exact / 100n);
  return `${euros},${(exact % 100n).toString().padStart(2, "0")}\u00a0€`;
}
const tax = (bps: number) => `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(bps / 100)} %`;
const editDraft = (state: ConnectedMenu): EditDraft => ({ ...state, name: state.connection.name, enabled: state.connection.enabled });
// Data shown here has already passed the server's snapshot decoder. Raw imports
// are never parsed/re-serialized by the UI, preserving duplicate-key detection.
const menuData = (content: ContentObject) => content.data as unknown as Menu;

function useScopedRequest() {
  const generation = useRef(0);
  const mounted = useRef(true);
  const pending = useRef<number | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState<{ operation: Operation; cause: unknown } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; }; }, []);
  function invalidate() { generation.current += 1; pending.current = null; setBusy(null); setError(null); }
  async function run<T>(operation: Operation, work: () => Promise<T>, accept: (value: T) => void) {
    if (pending.current !== null) return;
    const ticket = ++generation.current;
    pending.current = ticket; setBusy(operation); setError(null);
    const current = () => mounted.current && generation.current === ticket;
    try { const value = await work(); if (current()) accept(value); }
    catch (cause) { if (current()) setError({ operation, cause }); }
    finally { if (current()) { pending.current = null; setBusy(null); } }
  }
  return { busy, error, invalidate, run, writing: busy === "create" || busy === "save" || busy === "apply" || busy === "save_source" };
}
async function readFile(file: File) {
  if (file.size > MAX_FILE_BYTES) throw new Error("Die Menüdatei ist größer als 500 KiB. Bitte einen kleineren Snapshot auswählen.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error("Die Datei konnte nicht als UTF-8 gelesen werden. Bitte einen UTF-8-JSON-Export auswählen."); }
}
function checkedRaw(raw: string) {
  if (!raw.trim()) throw new Error("Bitte eine Menüdatei auswählen oder einen JSON-Snapshot einfügen.");
  if (size(raw) > MAX_FILE_BYTES) throw new Error("Der Menü-Snapshot ist größer als 500 KiB.");
  return raw;
}
function checkedBody<T>(body: T): T {
  if (size(JSON.stringify(body)) > 1024 * 1024) throw new Error("Der Import überschreitet die Anfragegrenze. Bitte einen kleineren Snapshot verwenden.");
  return body;
}
function useRefreshMenu() {
  const { org, invalidate } = useHub();
  const client = useQueryClient();
  return (id: string) => {
    void invalidate();
    for (const key of [["content-types", org], ["content", org, "gastro_menu"], ["content-obj", org, "gastro_menu", id], ["versions", org, id]]) void client.invalidateQueries({ queryKey: key });
  };
}

export function FlintPlatePage() {
  const { id } = useParams();
  const { org, user, role, isOwner } = useHub();
  return <div className="flintplate-page" key={`${user?.id}:${org}:${role}:${id ?? "list"}`}>
    {!id ? <ConnectionList /> : id === "new" ? isOwner ? <NewConnection /> : <><PageTitle title="Menüverbindung anlegen" /><Empty>Nur Inhaber können eine Menüquelle bestätigen und verbinden. <Link to={ROOT}>Menüverbindungen ansehen</Link></Empty></> : <ConnectionLoader id={id} />}
  </div>;
}
function ManualNotice({ initial = false }: { initial?: boolean }) {
  return <p className="flintplate-manual">{initial ? "Die erste Quellenzuordnung erfolgt mit einem manuellen Snapshotimport. Danach kann ein Inhaber den Lesezugriff auf FlintPlate einrichten." : "Menüs auf ausdrücklichen Abruf oder aus einer Datei prüfen. Ein eingerichteter Lesezugriff allein bestätigt noch keine erreichbare Quelle."} Übernahme und Website-Veröffentlichung erfolgen jeweils ausdrücklich; es gibt keine automatische Synchronisation.</p>;
}
function ConnectionList() {
  const { isOwner } = useHub();
  const connections = useHubQuery<Connection[]>("flintplate-connections", "/flintplate");
  return <>
    <PageTitle title="FlintPlate-Menüs" description="Geprüfte Menü-Snapshots als private Entwürfe für deine Websites übernehmen.">{isOwner && <Link className="button primary" to={`${ROOT}/new`}>Menüverbindung anlegen</Link>}</PageTitle>
    <ManualNotice />
    <section className="panel" aria-label="Menüverbindungen"><h2>Deine Menüverbindungen</h2><ErrorNotice error={connections.error} onReload={() => void connections.refetch()} />
      {connections.isPending && <p role="status">Menüverbindungen werden geladen…</p>}
      {connections.data?.length === 0 && <Empty>Noch keine Menüverbindung vorhanden. Ein Inhaber kann die erste Quelle bestätigen.</Empty>}
      {!!connections.data?.length && <div className="hub-table-wrap"><table><caption className="flintplate-sr-only">Manuell bestätigte FlintPlate-Menüquellen</caption><thead><tr><th scope="col">Verbindung</th><th scope="col">Betrieb</th><th scope="col">Importfreigabe</th><th scope="col">Stand</th></tr></thead><tbody>{connections.data.map(connection => <tr key={connection.id}>
        <td data-label="Verbindung"><Link to={`${ROOT}/${connection.id}`}>{connection.name}</Link><p className="hint">{connection.live_source ? "Lesezugriff eingerichtet" : "Dateiimport · kein Lesezugriff eingerichtet"}</p></td><td data-label="Betrieb">{connection.venue_id}</td><td data-label="Importfreigabe">{connection.enabled ? "Aktiviert" : "Deaktiviert"}</td><td data-label="Stand">{formatDate(connection.updated_at)} · Revision {connection.revision}</td>
      </tr>)}</tbody></table></div>}
      {!isOwner && <p className="hint">Nur Inhaber richten Verbindungen ein. Redaktion und Inhaber können neue Snapshots für aktivierte Verbindungen prüfen und übernehmen.</p>}
    </section>
  </>;
}
function SnapshotInput({ raw, filename, disabled, reading, onText, onFile }: { raw: string; filename: string; disabled: boolean; reading: boolean; onText: (value: string) => void; onFile: (file: File) => void }) {
  const id = useId();
  return <div className="flintplate-input">
    <div className="hub-field"><label htmlFor={`${id}-file`}>Menüdatei (JSON)</label><input id={`${id}-file`} type="file" accept=".json,application/json" disabled={disabled} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) onFile(file); }} /></div>
    {filename && <p>Ausgewählt: <strong>{filename}</strong></p>}{reading && <p role="status">Menüdatei wird gelesen…</p>}
    <details><summary>JSON direkt einfügen</summary><label htmlFor={`${id}-json`}>Menü-Snapshot (JSON)</label><textarea id={`${id}-json`} rows={12} className="hub-code-input" spellCheck={false} disabled={disabled} value={raw} onChange={event => onText(event.target.value)} /></details>
    <p className="hint">UTF-8-JSON · maximal 500 KiB und 500 Menüeinträge. Der Dateiinhalt bleibt nur in dieser geöffneten Ansicht. Beim Verlassen, Neuladen oder Kontowechsel musst du ihn erneut auswählen.</p>
  </div>;
}

function NewConnection() {
  const { base } = useHub();
  const navigate = useNavigate();
  const refresh = useRefreshMenu();
  const [initial] = useState<CreationDraft>(() => ({ id: crypto.randomUUID(), name: "", source_instance: "", source_tenant: "", venue_id: "" }));
  const draft = useDraft("flintplate-new", initial);
  const [raw, setRaw] = useState("");
  const [filename, setFilename] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<(Inspection & { raw: string; metadata: CreationDraft }) | null>(null);
  const [recovered, setRecovered] = useState<ConnectedMenu | null>(null);
  const request = useScopedRequest();
  function changed() { request.invalidate(); setPreview(null); setConfirmed(false); setRecovered(null); }
  function setMetadata(patch: Partial<CreationDraft>) { if (request.writing) return; changed(); draft.set(old => ({ ...old, ...patch })); }
  function setText(value: string) { if (request.writing) return; changed(); setRaw(value); setFilename(""); }
  function choose(file: File) {
    if (request.writing) return;
    changed(); void request.run("file", () => readFile(file), value => { setRaw(value); setFilename(file.name); });
  }
  function inspect() {
    const metadata = { ...draft.value };
    void request.run("inspect", async () => {
      if (![metadata.name, metadata.source_instance, metadata.source_tenant, metadata.venue_id].every(value => value.trim())) throw new Error("Bitte Verbindungsname, Quellinstallation, Quellmandant und erwartete Betriebs-ID unabhängig vom Snapshot angeben.");
      return api.post<Inspection>(`${base}/flintplate/inspect`, checkedBody({ snapshot_json: checkedRaw(raw), venue_id: metadata.venue_id.trim() }));
    }, result => { setPreview({ ...result, raw, metadata }); setConfirmed(false); });
  }
  function create() {
    if (!preview || !confirmed) return;
    const metadata = preview.metadata;
    void request.run("create", () => api.put<ConnectedMenu>(`${base}/flintplate/${metadata.id}`, checkedBody({ expected_revision: 0, name: metadata.name.trim(), source_instance: metadata.source_instance.trim(), source_tenant: metadata.source_tenant.trim(), venue_id: metadata.venue_id.trim(), snapshot_json: preview.raw, confirmed: true })), result => {
      draft.clear(); refresh(result.content.id); navigate(`${ROOT}/${result.connection.id}`, { replace: true });
    });
  }
  function checkSaved() { void request.run("compare", () => api.get<ConnectedMenu>(`${base}/flintplate/${draft.value.id}`), setRecovered); }
  return <>
    <PageTitle title="Menüverbindung anlegen" description="Die Quelle bewusst bestätigen und den ersten Menüentwurf prüfen."><Link className="button" to={ROOT}>Alle Menüverbindungen</Link></PageTitle><ManualNotice initial />
    <section className="panel" aria-label="Menüquelle bestätigen"><h2>1. Quelle zuordnen</h2>
      <p>Trage die Kennungen der vorgesehenen FlintPlate-Installation, ihres Mandanten und des Betriebs unabhängig vom Dateiinhalt ein. Diese Zuordnung ist nach der Anlage fest.</p>
      <div className="hub-fields">{([
        ["name", "Verbindungsname", 240], ["source_instance", "Quellinstallation", 160], ["source_tenant", "Quellmandant", 160], ["venue_id", "Erwartete Betriebs-ID (UUID)", 36],
      ] as const).map(([key, label, max]) => <div className="hub-field" key={key}><label htmlFor={`flintplate-new-${key}`}>{label}</label><input id={`flintplate-new-${key}`} required maxLength={max} value={draft.value[key]} disabled={request.writing} onChange={event => setMetadata({ [key]: event.target.value })} /></div>)}</div>
      <p className="hint">Die Quellenangaben sind deine Bestätigung. Sie stellen keine technisch geprüfte Verbindung oder Anmeldung an einem fremden System her.</p>
    </section>
    <section className="panel" aria-label="Ersten Menü-Snapshot prüfen"><h2>2. Snapshot prüfen</h2><SnapshotInput raw={raw} filename={filename} disabled={request.writing} reading={request.busy === "file"} onText={setText} onFile={choose} />
      <button type="button" disabled={!!request.busy || !raw.trim()} onClick={inspect}>Snapshot prüfen</button>
      {request.busy === "inspect" && <p role="status">Menü-Snapshot wird geprüft…</p>}
    </section>
    <ErrorNotice error={request.error?.cause} />
    {request.error?.operation === "create" && <section className="panel"><h2>Speicherergebnis prüfen</h2><p>Deine Eingaben und die Kennung dieses Anlagevorgangs bleiben erhalten. Bei unklarer Antwort wird keine neue Verbindung mit einer neuen Kennung angelegt. Prüfe zuerst, ob diese Verbindung bereits gespeichert wurde.</p><button type="button" disabled={!!request.busy} onClick={checkSaved}>Speicherergebnis prüfen</button></section>}
    {recovered && <section className="panel" aria-label="Bereits gespeicherte Menüverbindung"><h2>Verbindung bereits vorhanden</h2><SourceDetails connection={recovered.connection} /><MenuView menu={menuData(recovered.content)} /><Link className="button" to={`${ROOT}/${recovered.connection.id}`} onClick={() => draft.clear()}>Gespeicherte Verbindung öffnen</Link></section>}
    {preview && <section className="panel" aria-label="Geprüfter erster Menü-Snapshot"><h2>3. Geprüften Menüentwurf anlegen</h2><p role="status">{preview.item_count} Menüeinträge geprüft.</p><MenuView menu={preview.snapshot} />
      <label className="hub-check"><input type="checkbox" checked={confirmed} disabled={request.writing} onChange={event => setConfirmed(event.target.checked)} />Ich bestätige die Zuordnung dieser Quelle zu diesem Betrieb.</label>
      <p className="hint">Erstellt die Verbindung und einen privaten Menüentwurf. Websites werden dabei weder zugeordnet noch veröffentlicht.</p><button type="button" disabled={!confirmed || !!request.busy} onClick={create}>{request.busy === "create" ? "Menüentwurf wird angelegt…" : "Verbindung und Menüentwurf anlegen"}</button>
    </section>}
  </>;
}

function ConnectionLoader({ id }: { id: string }) {
  const state = useHubQuery<ConnectedMenu>(`flintplate:${id}`, `/flintplate/${id}`);
  if (!state.data) return state.error ? <><PageTitle title="Menüverbindung" /><ErrorNotice error={state.error} onReload={() => void state.refetch()} /><Link to={ROOT}>Alle Menüverbindungen</Link></> : <p role="status">Menüverbindung wird geladen…</p>;
  return <ConnectionEditor initial={state.data} />;
}
function ConnectionEditor({ initial }: { initial: ConnectedMenu }) {
  const { base, isOwner, canWrite } = useHub();
  const refresh = useRefreshMenu();
  const draft = useDraft<EditDraft>(`flintplate:${initial.connection.id}`, editDraft(initial));
  const { connection, content } = draft.value;
  const path = `${base}/flintplate/${connection.id}`;
  const [raw, setRaw] = useState("");
  const [filename, setFilename] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [comparison, setComparison] = useState<ConnectedMenu | null>(null);
  const [applied, setApplied] = useState<ConnectedMenu | null>(null);
  const [notice, setNotice] = useState("");
  // Credentials must not enter useDraft, the query cache or browser storage.
  const [sourceUrl, setSourceUrl] = useState(connection.live_source?.base_url ?? "");
  const [sourceKey, setSourceKey] = useState("");
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const request = useScopedRequest();
  const configChanged = draft.value.name !== connection.name || draft.value.enabled !== connection.enabled;
  const sourceChanged = !!sourceKey || sourceConfirmed || sourceUrl !== (connection.live_source?.base_url ?? "");
  const newer = initial.connection.revision > connection.revision || initial.content.revision > content.revision;
  function changed() { request.invalidate(); setPreview(null); setComparison(null); setApplied(null); setNotice(""); setRequestId(crypto.randomUUID()); }
  function setText(value: string) { if (request.writing) return; changed(); setRaw(value); setFilename(""); }
  function setConfig(patch: Partial<Pick<EditDraft, "name" | "enabled">>) { if (!isOwner || request.writing) return; changed(); draft.set(old => ({ ...old, ...patch })); }
  function choose(file: File) {
    if (!canWrite || !connection.enabled || request.writing) return;
    changed(); void request.run("file", () => readFile(file), value => { setRaw(value); setFilename(file.name); });
  }
  function saveConfig() {
    if (!isOwner || !configChanged) return;
    void request.run("save", () => api.put<ConnectedMenu>(path, { expected_revision: connection.revision, name: draft.value.name.trim(), enabled: draft.value.enabled }), result => {
      // Saving a name/toggle is not consent to a newer menu/content revision.
      draft.reset({ ...editDraft(result), content }); setPreview(null); setComparison(null); setNotice("Verbindung gespeichert."); refresh(content.id);
    });
  }
  function changeSource(update: () => void) {
    if (!isOwner || request.writing) return;
    changed(); update();
  }
  function saveSource() {
    if (!isOwner || !connection.enabled || configChanged || !sourceConfirmed || !sourceKey || !sourceUrl.trim()) return;
    void request.run("save_source", () => api.put<ConnectedMenu>(`${path}/source`, {
      expected_revision: connection.revision, base_url: sourceUrl.trim(), api_key: sourceKey, confirmed: true,
    }), result => {
      // Configuring credentials is not consent to replace the captured content.
      draft.reset({ ...editDraft(result), content }); setSourceUrl(result.connection.live_source?.base_url ?? "");
      setSourceKey(""); setSourceConfirmed(false); setPreview(null); setComparison(null); setApplied(null);
      setNotice("Lesezugriff gespeichert. Die Erreichbarkeit wird erst beim ausdrücklichen Abruf geprüft."); refresh(content.id);
    });
  }
  function fetchSource() {
    if (!canWrite || !connection.enabled || !connection.live_source || configChanged || sourceChanged || request.busy) return;
    changed();
    const fetchRequestId = crypto.randomUUID();
    void request.run("fetch", () => api.post<FetchedMenu>(`${path}/fetch`, {
      expected_revision: connection.revision, expected_content_revision: content.revision,
    }), result => {
      setRaw(result.snapshot_json); setFilename("Abruf von FlintPlate"); setRequestId(fetchRequestId);
      setPreview({ ...result, payload: { snapshot_json: result.snapshot_json, expected_revision: connection.revision,
        expected_content_revision: content.revision, request_id: fetchRequestId } });
      setNotice("Authentifiziert von FlintPlate abgerufen. Noch nicht übernommen.");
    });
  }
  function inspect() {
    if (!canWrite || !connection.enabled || configChanged || sourceChanged) return;
    void request.run("inspect", () => api.post<Inspection & ConnectedMenu>(`${path}/inspect`, checkedBody({ snapshot_json: checkedRaw(raw), expected_revision: connection.revision, expected_content_revision: content.revision })), result => {
      setPreview({ ...result, payload: { snapshot_json: raw, expected_revision: connection.revision, expected_content_revision: content.revision, request_id: requestId } }); setApplied(null);
    });
  }
  function apply() {
    if (!canWrite || !connection.enabled || configChanged || sourceChanged || !preview || applied) return;
    void request.run("apply", () => api.post<ConnectedMenu & { applied: true; request_id: string }>(`${path}/apply`, checkedBody(preview.payload)), result => {
      draft.reset(editDraft(result)); setApplied(result); setComparison(null); setNotice("Menüentwurf übernommen. Der veröffentlichte Stand bleibt unverändert."); refresh(result.content.id);
    });
  }
  function compare() { void request.run("compare", () => api.get<ConnectedMenu>(path), setComparison); }
  function adopt() {
    if (!comparison || request.busy) return;
    changed(); draft.reset(editDraft(comparison)); setSourceUrl(comparison.connection.live_source?.base_url ?? "");
    setSourceKey(""); setSourceConfirmed(false); setNotice("Serverstand ausdrücklich übernommen. Prüfe deinen weiterhin vorhandenen Snapshot erneut. Ein noch nicht gespeicherter API-Schlüssel wurde verworfen.");
  }
  return <>
    <PageTitle title={connection.name} description="Menüimporte nachvollziehbar prüfen und als Entwurf übernehmen."><Link className="button" to={ROOT}>Alle Menüverbindungen</Link><Link className="button" to={`/content/gastro_menu/${content.id}`}>Websites und Veröffentlichung</Link></PageTitle><ManualNotice />
    {notice && <p className="hub-success" role="status">{notice}</p>}
    {newer && <p className="hub-warning">Ein neuerer Serverstand ist verfügbar. Deine Eingaben und die gelesenen Revisionen bleiben erhalten. Vergleiche den Serverstand vor einer erneuten Prüfung.</p>}
    <section className="panel" aria-label="Menüverbindung"><h2>Quelle und Importfreigabe</h2><SourceDetails connection={connection} />
      {isOwner ? <form onSubmit={event => { event.preventDefault(); saveConfig(); }}><div className="hub-fields"><div className="hub-field"><label htmlFor="flintplate-name">Verbindungsname</label><input id="flintplate-name" required maxLength={240} value={draft.value.name} disabled={request.writing} onChange={event => setConfig({ name: event.target.value })} /></div><label className="hub-check"><input type="checkbox" checked={draft.value.enabled} disabled={request.writing} onChange={event => setConfig({ enabled: event.target.checked })} />Importe für diese Verbindung aktivieren</label></div><p className="hint">Deaktivieren erhält alle Menüstände. Quelle und Zielinhalt sind fest zugeordnet und können nicht umgebogen werden.</p><button type="submit" disabled={!configChanged || !!request.busy}>Verbindung speichern</button></form> : <p className="hint">Nur Inhaber können Name und Importfreigabe ändern.</p>}
      <p className="hint">Gelesene Verbindungsrevision {connection.revision} · Menürevision {content.revision}.</p>
      <button type="button" className="button secondary" disabled={!!request.busy} onClick={compare}>Serverstand vergleichen</button>
    </section>
    <section className="panel" aria-label="Lesezugriff konfigurieren"><h2>Lesezugriff auf FlintPlate</h2>
      {connection.live_source ? <p>Lesezugriff eingerichtet · Die Verbindung wird bei jedem Abruf geprüft. <span className="hint">{connection.live_source.base_url}</span></p> : <p>Für diese Verbindung ist noch kein Lesezugriff eingerichtet. Dateiimporte bleiben möglich.</p>}
      {isOwner ? <form onSubmit={event => { event.preventDefault(); saveSource(); }} autoComplete="off">
        <p>Nutze einen betriebsgebundenen FlintPlate-Schlüssel mit ausschließlich <code>menu:read</code>. Die Betriebs-ID im abgerufenen Menü muss mit der bestätigten Quelle übereinstimmen.</p>
        <div className="hub-fields"><div className="hub-field"><label htmlFor="flintplate-source-url">FlintPlate-Basis-URL</label><input id="flintplate-source-url" type="url" required maxLength={1800} placeholder="https://menue.example.de" value={sourceUrl} readOnly={!!connection.live_source} disabled={request.writing || !connection.enabled} onChange={event => changeSource(() => { setSourceUrl(event.target.value); setSourceConfirmed(false); })} /></div>
          <div className="hub-field"><label htmlFor="flintplate-source-key">FlintPlate-API-Schlüssel</label><input id="flintplate-source-key" type="password" autoComplete="new-password" spellCheck={false} required maxLength={4096} value={sourceKey} disabled={request.writing || !connection.enabled} onChange={event => changeSource(() => { setSourceKey(event.target.value); setSourceConfirmed(false); })} /></div></div>
        <p className="hint">Direkte öffentliche HTTPS-Adresse ohne Pfad. Die einmal bestätigte Adresse bleibt fest; den Schlüssel kannst du erneuern. Der gespeicherte Schlüssel wird nicht angezeigt.</p>
        <label className="hub-check"><input type="checkbox" checked={sourceConfirmed} disabled={request.writing || !connection.enabled} onChange={event => changeSource(() => setSourceConfirmed(event.target.checked))} />Ich bestätige die Quelle und den Lesezugriff</label>
        <button type="submit" disabled={!!request.busy || !connection.enabled || configChanged || !sourceConfirmed || !sourceKey || !sourceUrl.trim()}>Lesezugriff speichern</button>
        {sourceChanged && <button type="button" className="button secondary" disabled={request.writing} onClick={() => changeSource(() => { setSourceUrl(connection.live_source?.base_url ?? ""); setSourceKey(""); setSourceConfirmed(false); })}>Zugangseingabe verwerfen</button>}
      </form> : <p className="hint">Nur Inhaber können den Lesezugriff einrichten oder den Schlüssel erneuern.</p>}
      {canWrite && connection.enabled && connection.live_source && <button type="button" disabled={!!request.busy || configChanged || sourceChanged} onClick={fetchSource}>Menü von FlintPlate abrufen</button>}
      {(configChanged || sourceChanged) && <p className="hint">Speichere oder verwerfe geänderte Verbindungs- und Zugangseingaben vor der Menüprüfung.</p>}
      {request.busy === "save_source" && <p role="status">Lesezugriff wird gespeichert…</p>}{request.busy === "fetch" && <p role="status">Menü wird von FlintPlate abgerufen und geprüft…</p>}
      <p className="hint">Ein Abruf verändert weder den Menüentwurf noch deine Websites. Prüfe zuerst den Vergleich und übernimm den Snapshot anschließend ausdrücklich.</p>
    </section>
    <ErrorNotice error={request.error?.cause} />
    {request.error?.operation === "save_source" && <p className="hint">Zugangseingaben und ursprüngliche Revision bleiben erhalten. Bei einer unklaren Antwort zuerst den Serverstand vergleichen. Beim ausdrücklichen Übernehmen des Serverstandes wird ein eingegebener Schlüssel verworfen.</p>}
    {request.error?.operation === "apply" && <p className="hint">Der geprüfte Snapshot, seine ursprünglichen Revisionen und seine Vorgangskennung bleiben erhalten. Bei einer unklaren Antwort kannst du denselben geprüften Snapshot erneut übernehmen. Bei einem Revisionskonflikt zuerst den Serverstand vergleichen; es wird keine neu geladene Revision automatisch verwendet.</p>}
    {request.busy === "compare" && <p role="status">Serverstand wird zum Vergleich geladen…</p>}
    {comparison && <section className="panel" aria-label="Serverstand zum Vergleich"><h2>Serverstand zum Vergleich</h2><p>Verbindungsrevision {comparison.connection.revision} · Menürevision {comparison.content.revision}. Deine Eingaben wurden nicht ersetzt.</p><SourceDetails connection={comparison.connection} /><p>Verbindungsname: {comparison.connection.name}</p><MenuView menu={menuData(comparison.content)} /><p className="hint">Die Übernahme ersetzt lokale Verbindungsänderungen und die gelesenen Revisionen. Dein eingegebener Snapshot bleibt erhalten; seine bisherige Importvorschau wird verworfen.</p><button type="button" disabled={!!request.busy} onClick={adopt}>Serverstand übernehmen</button></section>}
    <section className="panel" aria-label="Gelesener Menüentwurf"><h2>{applied ? "Bestätigter Menüentwurf dieses Imports" : "Gelesener Menüentwurf"}</h2><PublicationNotice content={content} /><MenuView menu={menuData(content)} /></section>
    {!connection.enabled && <section className="panel"><h2>Import deaktiviert</h2><p>Diese Verbindung bleibt lesbar. Ein Inhaber kann sie für weitere Importe aktivieren.</p></section>}
    {!canWrite && <p className="hub-reader">Du kannst Quelle und Menü ansehen. Neue Snapshots prüfen und übernehmen dürfen Redaktion und Inhaber.</p>}
    {canWrite && connection.enabled && <section className="panel" aria-label="Neuen Menü-Snapshot prüfen"><h2>Neuen Snapshot prüfen</h2><SnapshotInput raw={raw} filename={filename} disabled={request.writing} reading={request.busy === "file"} onText={setText} onFile={choose} />{configChanged && <p className="hint">Speichere oder verwerfe die geänderten Verbindungsangaben vor der Snapshotprüfung.</p>}<button type="button" disabled={!!request.busy || configChanged || sourceChanged || !raw.trim()} onClick={inspect}>Snapshot prüfen</button>{request.busy === "inspect" && <p role="status">Menü-Snapshot wird geprüft…</p>}</section>}
    {preview && <section className="panel" aria-label="Geprüfter Menüvergleich"><h2>Geprüfter Menüvergleich</h2><ChangeSummary before={menuData(preview.content)} after={preview.snapshot} /><p className="hint">Geprüft gegen Verbindungsrevision {preview.payload.expected_revision} und Menürevision {preview.payload.expected_content_revision}. Die Übernahme verwendet genau den geprüften Snapshot und diese Revisionen.</p>
      <div className="flintplate-comparison"><section aria-label="Bisheriger Menüentwurf"><h3>Bisheriger Entwurf</h3><MenuView menu={menuData(preview.content)} /></section><section aria-label="Geprüfter neuer Snapshot"><h3>Geprüfter Snapshot</h3><MenuView menu={preview.snapshot} /></section></div>
      <p>Eine Übernahme aktualisiert den privaten Menüentwurf. Websites und Veröffentlichung werden weiterhin ausdrücklich in der Inhaltsverwaltung festgelegt.</p>
      {preview.transport === "authenticated_fetch" && <p className="hint">Dieser Vergleich stammt aus dem ausdrücklichen Abruf von der eingerichteten Quelle. Die Betriebs-ID und der Quellhash wurden geprüft.</p>}
      {canWrite && <button type="button" disabled={!!request.busy || !!applied || configChanged || sourceChanged || !connection.enabled} onClick={apply}>{request.busy === "apply" ? "Snapshot wird übernommen…" : "Geprüften Snapshot übernehmen"}</button>}
      {applied && <p role="status">Snapshot übernommen · bestätigte Menürevision {applied.content.revision}. Bei einer Wiederholung wird das ursprüngliche Importergebnis angezeigt. Spätere Änderungen kannst du über „Serverstand vergleichen“ prüfen. <Link to={`/content/gastro_menu/${applied.content.id}`}>Websites und Veröffentlichung öffnen</Link></p>}
    </section>}
  </>;
}

function SourceDetails({ connection }: { connection: Connection }) {
  return <dl className="hub-values"><div><dt>Quellinstallation</dt><dd>{connection.source_instance}</dd></div><div><dt>Quellmandant</dt><dd>{connection.source_tenant}</dd></div><div><dt>Bestätigter Betrieb</dt><dd>{connection.venue_id}</dd></div><div><dt>Importfreigabe</dt><dd>{connection.enabled ? "Aktiviert" : "Deaktiviert"} · Quelle manuell bestätigt</dd></div><div><dt>Lesezugriff</dt><dd>{connection.live_source ? `${connection.live_source.base_url} · eingerichtet, kein laufender Verbindungsnachweis` : "Nicht eingerichtet · manueller Dateiimport"}</dd></div></dl>;
}
function PublicationNotice({ content }: { content: ContentObject }) {
  return <p className="hint">{content.publication ? `Veröffentlicht ist Stand ${content.publication.revision}. Dieser Stand bleibt bei einem Import unverändert.` : "Dieses Menü wurde noch nicht veröffentlicht."} Änderungen für Websites werden erst nach ausdrücklicher Veröffentlichung wirksam.</p>;
}
function ChangeSummary({ before, after }: { before: Menu; after: Menu }) {
  const oldItems = new Map(before.items.map(item => [item.id, item]));
  const newIds = new Set(after.items.map(item => item.id));
  const added = after.items.filter(item => !oldItems.has(item.id));
  const removed = before.items.filter(item => !newIds.has(item.id));
  const changed = after.items.filter(item => oldItems.has(item.id) && comparableItem(oldItems.get(item.id)!) !== comparableItem(item));
  const metadataChanged = before.published_at !== after.published_at || before.timezone !== after.timezone || before.currency !== after.currency || before.menu_revision !== after.menu_revision;
  return <div className="flintplate-review"><p role="status">{added.length} neu · {changed.length} geändert · {removed.length} entfernt · {after.items.length} Menüeinträge danach.</p><p className="hint">Entfernte Einträge entfallen aus dem neuen Entwurf. Die bisherige Veröffentlichung bleibt erhalten. {metadataChanged ? "Auch die Snapshotangaben unterscheiden sich." : "Die Snapshotangaben sind unverändert."}</p></div>;
}
function comparableItem(item: MenuItem) {
  const packaging = item.takeaway_packaging;
  // JSON object key order may differ between a DB read and the inspect result.
  // Compare declared values, including ordered allergens, without changing data.
  return JSON.stringify([item.id, item.sku, item.version, item.name, item.description, item.category, item.price_cents, item.tax_rate_bps, item.allergens, item.available, item.station,
    packaging ? [packaging.name, packaging.price_cents, packaging.deposit_cents, packaging.tax_rate_bps, packaging.deposit_tax_rate_bps, packaging.reusable] : null]);
}
function MenuView({ menu }: { menu: Menu }) {
  const [count, setCount] = useState(30);
  return <div className="flintplate-menu">
    <p className="hint">{menu.items.length} Menüeinträge · {menu.currency} · {menu.timezone}<br />Snapshot erstellt: <time dateTime={menu.published_at} title={menu.published_at}>{formatDate(menu.published_at)}</time>. Dieser Zeitpunkt ist keine FireFlint-Veröffentlichung.</p>
    {menu.items.length === 0 && <Empty>Der Snapshot enthält keine Menüeinträge.</Empty>}
    <ul className="flintplate-items">{menu.items.slice(0, count).map(item => <li key={item.id}>
      <div className="flintplate-item-title"><div><span className="hint">{item.category} · {item.sku}</span><h4>{item.name}</h4></div><strong>{money(item.price_cents)}</strong></div>
      {item.description && <p className="flintplate-description">{item.description}</p>}<p className="hint">{item.available ? "Verfügbar" : "Derzeit nicht verfügbar"} · Steuer {tax(item.tax_rate_bps)}</p>
      <details><summary>Weitere Menüangaben</summary><dl className="hub-values"><div><dt>Allergene</dt><dd>{item.allergens.length ? item.allergens.join(", ") : "Keine angegeben"}</dd></div><div><dt>Station</dt><dd>{item.station === "kitchen" ? "Küche" : item.station === "bar" ? "Bar" : item.station}</dd></div></dl>
        {item.takeaway_packaging ? <div><h5>Mitnahmeverpackung: {item.takeaway_packaging.name}</h5><p>Preis {money(item.takeaway_packaging.price_cents)} · Steuer {tax(item.takeaway_packaging.tax_rate_bps)}</p><p>Pfand {money(item.takeaway_packaging.deposit_cents)} · Pfandsteuer {tax(item.takeaway_packaging.deposit_tax_rate_bps)} · {item.takeaway_packaging.reusable ? "Mehrweg" : "Kein Mehrweg"}</p></div> : <p>Keine Mitnahmeverpackung angegeben.</p>}
      </details>
    </li>)}</ul>
    {menu.items.length > count && <button type="button" className="button secondary" onClick={() => setCount(old => old + 30)}>Weitere Menüeinträge anzeigen</button>}
    <details className="flintplate-json"><summary>Geprüfte JSON-Details ansehen</summary><pre>{JSON.stringify(menu, null, 2)}</pre></details>
  </div>;
}
