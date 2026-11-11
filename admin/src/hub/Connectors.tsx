import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { Empty, ErrorNotice, PageTitle, RecordPicker, ValueView, formatDate, useAction, useDraft, useHub, useHubQuery } from "./common";

interface Provider {
  key: string; name: string; version: string; direction: string;
  objects: { key: string; kind: string; label: string }[];
  credential_fields: string[]; settings_fields: string[]; features?: string[]; limitations: string[];
  setup_hint?: string; base_url_placeholder?: string;
}
interface Mapping { kind: string; external_id: string; name: string; fields: Record<string, string>; delimiter: string }
interface Connector {
  id: string; org_id: string; name: string; provider: string; object_type: string; source_id: string;
  base_url: string | null; database: string | null; mapping: Mapping | null; enabled: boolean; revision: number;
  folder_path: string | null; share_metadata: boolean;
  has_credentials: boolean; retry_at: string | null; last_error: { code: string; message: string } | null;
}
interface Configuration {
  name: string; provider: string; object_type: string; source_id: string; base_url: string; database: string;
  mapping: Mapping | null; folder_path: string | null; share_metadata: boolean; enabled: boolean; revision: number;
}
interface PreviewRow {
  external_id: string; kind: string; name: string; data: Record<string, unknown>;
  expected_revision: number | null; action: "create" | "update"; current_revision: number; conflict: boolean;
}
interface ImportResult { applied: true; rows: { id: string; kind: string; name: string; revision: number }[]; request_key: string }
interface ConnectorPreview {
  id: string; connector_id: string; connector_revision: number; status: "preview" | "applied";
  expires_at: string; next_cursor: string | null; rows: PreviewRow[]; applied: boolean; result?: ImportResult;
}

const ROOT = "/hub/integrations/connectors";
const isFileProvider = (provider: string) => provider === "csv" || provider === "json";
const isNextcloudProvider = (provider: string) => provider === "nextcloud";
const defaultMapping = (kind = "contact"): Mapping => ({ kind, external_id: "id", name: "name", fields: kind === "company" ? { legal_name: "name" } : kind === "location" ? { name: "name", address: "address" } : { name: "name" }, delimiter: "," });
const credentialLabel = (key: string) => ({ token: "API-Zugriffstoken", api_key: "API-Key", api_secret: "API-Secret", consumer_key: "Consumer-Key", consumer_secret: "Consumer-Secret", username: "Benutzername", app_password: "App-Passwort" }[key] ?? key);

export function ConnectorsPage() {
  const { isOwner } = useHub();
  const catalog = useHubQuery<Provider[]>("connector-catalog", "/api/hub/connectors/catalog");
  const connectors = useHubQuery<Connector[]>("connectors", "/connectors");
  return <>
    <PageTitle title="Konnektoren" description="Daten aus anderen Systemen abrufen, prüfen und ausdrücklich in den Unternehmenshub übernehmen.">
      <Link className="button primary" to="/hub/integrations/assistant">Datei-Integrationsassistent</Link>
      <Link className="button" to="/hub/integrations/flintplate">FlintPlate-Menüs</Link>
      <Link className="button" to="/hub/import">JSON-Direktimport</Link>
      <Link className="button" to="/hub/records/source">Datenquellen</Link>
    </PageTitle>
    <p className="hint">Die Anbindungen lesen Daten ein. Abruf und Übernahme werden jeweils von Ihnen gestartet. Es gibt keine geplante Synchronisation, Rückschreibung oder automatische Übernahme externer Löschungen.</p>
    <ErrorNotice error={connectors.error} onReload={() => void connectors.refetch()} />
    <section className="panel" aria-labelledby="connector-list-title">
      <h2 id="connector-list-title">Ihre Verbindungen</h2>
      {connectors.isPending ? <p role="status">Verbindungen werden geladen …</p> : connectors.data?.length ? <div className="hub-table-wrap"><table>
        <thead><tr><th scope="col">Verbindung</th><th scope="col">Anbieter</th><th scope="col">Zustand</th><th scope="col">Revision</th></tr></thead>
        <tbody>{connectors.data.map(connector => <tr key={connector.id}>
          <th scope="row"><Link to={`${ROOT}/${connector.id}`}>{connector.name}</Link></th>
          <td>{catalog.data?.find(provider => provider.key === connector.provider)?.name ?? connector.provider}</td>
          <td>{connector.enabled ? "Aktiviert" : "Deaktiviert"}{connector.retry_at && <> · Erneuter Abruf ab {formatDate(connector.retry_at)}</>}{connector.last_error && <p className="hint">{connector.last_error.message}</p>}</td>
          <td>{connector.revision}</td>
        </tr>)}</tbody>
      </table></div> : !connectors.error && <Empty>Noch keine Verbindungen. Wählen Sie unten einen Anbieter und ordnen Sie eine Datenquelle zu.</Empty>}
    </section>
    <section aria-labelledby="connector-catalog-title">
      <h2 id="connector-catalog-title">Verfügbare Anbieter</h2>
      <p className="hint">Die Adapter sind technisch vorbereitet. Eine Verbindung gilt erst nach einem erfolgreichen Abruf mit Ihrem Konto als geprüft.</p>
      {!isOwner && <p className="hint">Verbindungen konfigurieren können nur Inhaber. Bearbeitende können gespeicherte Verbindungen abrufen und Importe übernehmen.</p>}
      <ErrorNotice error={catalog.error} onReload={() => void catalog.refetch()} />
      {catalog.isPending && <p role="status">Anbieter werden geladen …</p>}
      <div className="hub-grid">{catalog.data?.map(provider => <article className="panel" key={provider.key}>
        <h3>{provider.name}</h3><p>{provider.objects.map(object => object.label).join(", ")}</p>
        <p className="hint">Eingehende Daten · Adapterversion {provider.version}</p>
        {!!provider.features?.length && <p className="hint">Funktionen · {provider.features.join(", ")}</p>}
        {!!provider.limitations.length && <ul>{provider.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>}
        {isOwner && <Link className="button" to={`${ROOT}/new?provider=${encodeURIComponent(provider.key)}`}>{provider.name} einrichten</Link>}
      </article>)}</div>
    </section>
  </>;
}

export function ConnectorPage() {
  const { id = "new" } = useParams();
  const [search] = useSearchParams();
  const { org } = useHub();
  const catalog = useHubQuery<Provider[]>("connector-catalog", "/api/hub/connectors/catalog");
  const connectors = useHubQuery<Connector[]>("connectors", "/connectors", id !== "new");
  if (catalog.isPending || (id !== "new" && connectors.isPending)) return <p role="status">Verbindung wird geladen …</p>;
  if (catalog.error || connectors.error) return <ErrorNotice error={catalog.error || connectors.error} onReload={() => { void catalog.refetch(); if (id !== "new") void connectors.refetch(); }} />;
  const connector = id === "new" ? null : connectors.data?.find(item => item.id === id);
  if (id !== "new" && !connector) return <Empty>Diese Verbindung wurde nicht gefunden. <Link to={ROOT}>Zur Übersicht</Link></Empty>;
  if (!catalog.data?.length) return <Empty>Es sind keine Anbieter verfügbar. <Link to={ROOT}>Zur Übersicht</Link></Empty>;
  return <ConnectorEditor key={`${org}:${id}`} connector={connector ?? null} catalog={catalog.data} requestedProvider={search.get("provider")} />;
}

function ConnectorEditor({ connector, catalog, requestedProvider }: { connector: Connector | null; catalog: Provider[]; requestedProvider: string | null }) {
  const { base, isOwner, canWrite, contracts, invalidate } = useHub();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const first = catalog.find(provider => provider.key === requestedProvider) ?? catalog[0];
  const initial: Configuration = connector ? {
    name: connector.name, provider: connector.provider, object_type: connector.object_type, source_id: connector.source_id,
    base_url: connector.base_url ?? "", database: connector.database ?? "", mapping: connector.mapping, folder_path: connector.folder_path ?? null, share_metadata: connector.share_metadata ?? false, enabled: connector.enabled, revision: connector.revision,
  } : { name: "", provider: first.key, object_type: first.objects[0]?.key ?? "rows", source_id: "", base_url: "", database: "", mapping: isFileProvider(first.key) ? defaultMapping() : null, folder_path: null, share_metadata: false, enabled: true, revision: 0 };
  const draft = useDraft<Configuration>(`connector:${connector?.id ?? `new:${first.key}`}`, initial);
  const content = useDraft<string>(`connector-content:${connector?.id ?? "new"}`, "");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ previewId: string; value: ImportResult } | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const provider = catalog.find(item => item.key === draft.value.provider);
  const file = isFileProvider(draft.value.provider);
  const nextcloud = isNextcloudProvider(draft.value.provider);
  const hasFolderPathSetting = nextcloud || !!provider?.settings_fields.includes("folder_path");
  const hasShareMetadataSetting = nextcloud || !!provider?.settings_fields.includes("share_metadata");
  const mapping = draft.value.mapping ?? defaultMapping();
  const kind = contracts.data?.kinds.find(item => item.key === mapping.kind);
  const previewId = search.get("preview") ?? "";
  const previewQuery = useHubQuery<ConnectorPreview>("connector-preview", `/connectors/${connector?.id ?? "new"}/previews/${encodeURIComponent(previewId)}`, !!connector && !!previewId);
  const preview = previewId ? previewQuery.data : undefined;
  const secretChanged = Object.values(credentials).some(Boolean);
  const hasChanges = draft.dirty || secretChanged;
  const busy = action.busy;
  const configDisabled = !isOwner || busy;

  function clearPreview() {
    setResult(null);
    if (previewId) { const next = new URLSearchParams(search); next.delete("preview"); setSearch(next, { replace: true }); }
  }
  function change(patch: Partial<Configuration>) {
    draft.set(old => ({ ...old, ...patch }));
    setSaved(false);
    clearPreview();
  }
  function selectProvider(key: string) {
    const next = catalog.find(item => item.key === key);
    if (!next) return;
    change({ provider: key, object_type: next.objects[0]?.key ?? "rows", base_url: "", database: "", mapping: isFileProvider(key) ? defaultMapping() : null, folder_path: null, share_metadata: false });
    setCredentials({});
  }
  async function save() {
    await action.run(async () => {
      if (!isOwner) throw new Error("Nur Inhaber können Verbindungen konfigurieren.");
      if (!draft.value.name.trim() || !draft.value.source_id) throw new Error("Bitte eine Bezeichnung und Datenquelle angeben.");
      const folderPath = draft.value.folder_path?.trim() ?? "";
      if (nextcloud && (!folderPath || folderPath.replace(/^\/+|\/+$/g, "") === "")) throw new Error("Bitte einen nicht-rootigen Nextcloud-Ordner wie /Team/Kunden angeben.");
      if (nextcloud && !draft.value.share_metadata) throw new Error("Bestätige die Freigabe der Dokumentmetadaten für den gesamten FireFlint-Arbeitsbereich.");
      const requiredCredentials = provider?.credential_fields ?? [];
      if (requiredCredentials.length && (secretChanged || !connector?.has_credentials) && requiredCredentials.some(key => !credentials[key]?.trim())) {
        throw new Error("Bitte alle Zugangsdaten für diese Verbindung ausfüllen. Leere Felder behalten bereits gespeicherte Zugangsdaten bei.");
      }
      const body = {
        name: draft.value.name, provider: draft.value.provider, object_type: draft.value.object_type, source_id: draft.value.source_id,
        base_url: draft.value.base_url.trim() || null, database: draft.value.database.trim() || null,
        folder_path: nextcloud ? folderPath || null : null, share_metadata: nextcloud ? draft.value.share_metadata : false,
        mapping: file ? { ...mapping, fields: Object.fromEntries(Object.entries(mapping.fields).filter(([, value]) => value.trim())) } : null,
        enabled: draft.value.enabled, expected_revision: draft.value.revision,
        credentials: secretChanged ? Object.fromEntries(requiredCredentials.map(key => [key, credentials[key]])) : null,
      };
      const response = connector ? await api.put<Connector>(`${base}/connectors/${connector.id}`, body) : await api.post<Connector>(`${base}/connectors`, body);
      if (!action.isActive()) return;
      setCredentials({});
      draft.reset({ name: response.name, provider: response.provider, object_type: response.object_type, source_id: response.source_id, base_url: response.base_url ?? "", database: response.database ?? "", mapping: response.mapping, folder_path: response.folder_path ?? null, share_metadata: response.share_metadata ?? false, enabled: response.enabled, revision: response.revision });
      setSaved(true);
      clearPreview();
      await invalidate();
      if (!connector && action.isActive()) { draft.clear(); navigate(`${ROOT}/${response.id}`); }
    });
  }
  async function reload() {
    if (!connector) return;
    await action.run(async () => {
      const rows = await api.get<Connector[]>(`${base}/connectors`);
      const current = rows.find(row => row.id === connector.id);
      if (!current) throw new Error("Die Verbindung wurde nicht gefunden.");
      draft.reset({ name: current.name, provider: current.provider, object_type: current.object_type, source_id: current.source_id, base_url: current.base_url ?? "", database: current.database ?? "", mapping: current.mapping, folder_path: current.folder_path ?? null, share_metadata: current.share_metadata ?? false, enabled: current.enabled, revision: current.revision });
      setCredentials({});
      setSaved(false);
      clearPreview();
      await invalidate();
    });
  }
  async function inspect(cursor?: string) {
    if (!connector) return;
    await action.run(async () => {
      if (hasChanges) throw new Error("Bitte zuerst die Konfiguration speichern, bevor Sie Daten abrufen.");
      if (file && !content.value.trim()) throw new Error("Bitte die zu importierenden Datei-Inhalte eingeben oder eine Datei auswählen.");
      if (file && new TextEncoder().encode(content.value).length > 500000) throw new Error("Die Importdatei ist zu groß. Bitte in Abschnitte unter 500 kB aufteilen.");
      const body = { expected_revision: draft.value.revision, ...(file ? { content: content.value } : {}), ...(cursor ? { cursor } : {}) };
      if (new TextEncoder().encode(JSON.stringify(body)).length > 512 * 1024) throw new Error("Der Importabschnitt ist zu groß. Bitte die Datei in kleinere Abschnitte aufteilen.");
      let response: ConnectorPreview;
      try {
        response = await api.post<ConnectorPreview>(`${base}/connectors/${connector.id}/preview`, body);
      } finally {
        // Refresh cooldown/error metadata, never the captured configuration draft.
        await invalidate();
      }
      setResult(null);
      const next = new URLSearchParams(search); next.set("preview", response.id); setSearch(next);
    });
  }
  async function apply() {
    if (!connector || !preview) return;
    await action.run(async () => {
      if (hasChanges || preview.connector_revision !== draft.value.revision || preview.rows.some(row => row.conflict)) throw new Error("Bitte die geänderte Konfiguration und alle Konflikte prüfen und eine neue Vorschau erstellen.");
      const response = await api.post<ImportResult>(`${base}/connectors/${connector.id}/previews/${preview.id}/apply`, { expected_revision: preview.connector_revision });
      setResult({ previewId: preview.id, value: response });
      await invalidate();
    });
  }
  async function chooseFile(input: HTMLInputElement) {
    const selected = input.files?.[0];
    if (!selected) return;
    await action.run(async () => {
      if (selected.size > 500000) throw new Error("Die Importdatei ist zu groß. Bitte in Abschnitte unter 500 kB aufteilen.");
      const text = await selected.text();
      content.set(text);
      clearPreview();
    });
    input.value = "";
  }

  const conflicts = preview?.rows.filter(row => row.conflict).length ?? 0;
  const expired = !!preview && new Date(preview.expires_at).getTime() <= Date.now();
  const currentResult = result?.previewId === previewId ? result.value : null;
  const applied = currentResult ?? preview?.result;
  return <>
    <PageTitle title={connector ? connector.name : "Verbindung einrichten"} description="Eine Quelle, ein Datenfluss und eine ausdrücklich geprüfte Übernahme."><Link className="button" to={ROOT}>Alle Konnektoren</Link></PageTitle>
    {!isOwner && <p className="hint">Die Konfiguration ist nur für Inhaber bearbeitbar.{canWrite ? " Sie können Daten abrufen und geprüfte Vorschauen übernehmen." : " Mit Leserechten können Sie gespeicherte Vorschauen über deren Link ansehen."}</p>}
    <section className="panel" aria-labelledby="connector-config-title">
      <h2 id="connector-config-title">1. Verbindung konfigurieren</h2>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="hub-fields">
          <div className="hub-field"><label htmlFor="connector-name">Bezeichnung</label><input id="connector-name" value={draft.value.name} maxLength={240} required disabled={configDisabled} onChange={event => change({ name: event.target.value })} /></div>
          <div className="hub-field"><label htmlFor="connector-provider">Anbieter</label><select id="connector-provider" value={draft.value.provider} disabled={configDisabled || !!connector} onChange={event => selectProvider(event.target.value)}>{catalog.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></div>
          <div className="hub-field"><label htmlFor="connector-object">Datenbereich</label><select id="connector-object" value={draft.value.object_type} disabled={configDisabled || !!connector} onChange={event => change({ object_type: event.target.value })}>{provider?.objects.map(object => <option key={object.key} value={object.key}>{object.label}</option>)}</select></div>
          <RecordPicker kind="source" label="Datenquelle" value={draft.value.source_id} disabled={configDisabled || !!connector} onChange={source_id => change({ source_id })} />
          {provider?.settings_fields.includes("base_url") && <div className="hub-field"><label htmlFor="connector-url">Basis-URL</label><input id="connector-url" type="url" required value={draft.value.base_url} placeholder={provider.base_url_placeholder ?? "https://shop.example.org"} disabled={configDisabled || !!connector} onChange={event => change({ base_url: event.target.value })} /></div>}
          {provider?.settings_fields.includes("database") && <div className="hub-field"><label htmlFor="connector-database">Datenbank (optional)</label><input id="connector-database" value={draft.value.database} disabled={configDisabled || !!connector} onChange={event => change({ database: event.target.value })} /></div>}
          {hasFolderPathSetting && <div className="hub-field"><label htmlFor="connector-folder-path">Nextcloud-Ordner</label><input id="connector-folder-path" value={draft.value.folder_path ?? ""} placeholder="/Team/Kunden" required={nextcloud} disabled={configDisabled || !!connector} onChange={event => change({ folder_path: event.target.value })} /><p className="hint">{nextcloud ? "Pflichtfeld: ein konkreter Unterordner wie /Team/Kunden. Nach der Erstellung ist der Ordnerpfad unveränderlich." : "Der Ordnerpfad ist fest zugeordnet."}</p></div>}
          {hasShareMetadataSetting && <div className="hub-field"><label className="hub-check" htmlFor="connector-share-metadata"><input id="connector-share-metadata" type="checkbox" required={nextcloud} aria-describedby="connector-share-metadata-hint" checked={draft.value.share_metadata} disabled={configDisabled || !!connector} onChange={event => change({ share_metadata: event.target.checked })} />Dokumentmetadaten im FireFlint-Arbeitsbereich teilen</label><p id="connector-share-metadata-hint" className="hint">Erforderliche ausdrückliche Freigabe: Wenn aktiviert, sind Dokumentmetadaten (Namen, Links, Größe und Datumsangaben) für alle Mitglieder dieses FireFlint-Arbeitsbereichs sichtbar, einschließlich API und Export. Die Dateiinhalte bleiben in Nextcloud; den tatsächlichen Dateizugriff erzwingt Nextcloud.{connector ? " Diese Einstellung ist nach der Erstellung unveränderlich." : ""}</p></div>}
          <div className="hub-field"><label htmlFor="connector-enabled">Zustand</label><select id="connector-enabled" value={draft.value.enabled ? "true" : "false"} disabled={configDisabled} onChange={event => change({ enabled: event.target.value === "true" })}><option value="true">Aktiviert</option><option value="false">Deaktiviert</option></select></div>
        </div>
        {provider?.setup_hint && <p className="hint">{provider.setup_hint}</p>}
        {connector ? <p className="hint">Konfigurationsrevision {draft.value.revision}. Anbieter, Datenbereich, Quelle, Zieladresse{nextcloud ? " und Ordnerpfad" : ""} sind fest zugeordnet. Für eine andere Zuordnung eine separate Verbindung und Quelle anlegen. Deaktivieren bewahrt bereits importierte Datensätze.</p> : <p><Link to="/hub/records/source/new">Datenquelle anlegen</Link></p>}
        {file && <fieldset disabled={configDisabled}>
          <legend>Feldzuordnung</legend>
          <p className="hint">Geben Sie exakte {draft.value.provider === "csv" ? "Spaltenüberschriften" : "JSON-Pfade (zum Beispiel person.name)"} an. Die externe Kennung muss je Quelle eindeutig sein.</p>
          <div className="hub-fields">
            <div className="hub-field"><label htmlFor="mapping-kind">Ziel-Datentyp</label><select id="mapping-kind" value={mapping.kind} onChange={event => change({ mapping: defaultMapping(event.target.value) })}>{["company", "contact", "location", "product"].map(key => <option key={key} value={key}>{contracts.data?.kinds.find(item => item.key === key)?.name ?? key}</option>)}</select></div>
            <div className="hub-field"><label htmlFor="mapping-id">Externe Kennung: Quellfeld</label><input id="mapping-id" required value={mapping.external_id} onChange={event => change({ mapping: { ...mapping, external_id: event.target.value } })} /></div>
            <div className="hub-field"><label htmlFor="mapping-name">Bezeichnung: Quellfeld</label><input id="mapping-name" required value={mapping.name} onChange={event => change({ mapping: { ...mapping, name: event.target.value } })} /></div>
            {draft.value.provider === "csv" && <div className="hub-field"><label htmlFor="mapping-delimiter">CSV-Trennzeichen</label><select id="mapping-delimiter" value={mapping.delimiter} onChange={event => change({ mapping: { ...mapping, delimiter: event.target.value } })}><option value=",">Komma</option><option value=";">Semikolon</option><option value={"\t"}>Tabulator</option></select></div>}
            {kind?.fields.map(field => <div className="hub-field" key={field.key}><label htmlFor={`mapping-field-${field.key}`}>{field.label}: Quellfeld{field.required ? " *" : " (optional)"}</label><input id={`mapping-field-${field.key}`} required={field.required} value={mapping.fields[field.key] ?? ""} onChange={event => change({ mapping: { ...mapping, fields: { ...mapping.fields, [field.key]: event.target.value } } })} /></div>)}
          </div>
          <ErrorNotice error={contracts.error} />
        </fieldset>}
        {!!provider?.credential_fields.length && <fieldset disabled={configDisabled}>
          <legend>Zugangsdaten</legend>
          <p className="hint">{connector?.has_credentials ? "Zugangsdaten sind hinterlegt. Lassen Sie alle Felder leer, um sie beizubehalten. Zum Ersetzen alle Felder neu ausfüllen." : "Für den Abruf sind die Zugangsdaten dieses Kontos erforderlich."} Geheimnisse werden verschlüsselt gespeichert und nicht wieder angezeigt. Ungespeicherte Zugangsdaten werden beim Verlassen dieses Formulars verworfen.</p>
          <div className="hub-fields">{provider.credential_fields.map(key => <div className="hub-field" key={key}><label htmlFor={`credential-${key}`}>{credentialLabel(key)}</label><input id={`credential-${key}`} type="password" autoComplete="new-password" value={credentials[key] ?? ""} onChange={event => { setCredentials(old => ({ ...old, [key]: event.target.value })); setSaved(false); clearPreview(); action.clear(); }} /></div>)}</div>
        </fieldset>}
        {provider && !!provider.limitations.length && <details><summary>Grenzen dieses Adapters</summary><ul>{provider.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details>}
        <div className="hub-actions"><button type="submit" disabled={configDisabled || (file && !kind)}>{busy ? "Wird verarbeitet …" : "Verbindung speichern"}</button>{connector && <button type="button" disabled={busy} onClick={reload}>Gespeicherten Stand laden · Eingaben verwerfen</button>}</div>
        {saved && <p role="status">Die Verbindung wurde gespeichert.</p>}
      </form>
    </section>
    <ErrorNotice error={action.error} />
    {connector && <section className="panel" aria-labelledby="connector-fetch-title">
      <h2 id="connector-fetch-title">2. {file ? "Datei prüfen" : "Verbindung testen und Daten abrufen"}</h2>
      <p className="hint">{file ? "UTF-8, höchstens 100 Datensätze je Abschnitt. Die Datei wird erst beim Prüfen an FireFlint gesendet." : nextcloud ? "Die Vorschau liest aus dem gewählten Nextcloud-Ordner nur direkte Dateien, höchstens 100 Stück. Unterordner werden nicht rekursiv gelesen. Ein zu großer Ordner wird abgelehnt; wähle dann einen kleineren Ordner. Die Dateiinhalte bleiben in Nextcloud." : "Der Test ruft einen begrenzten Abschnitt mit höchstens 100 Datensätzen ab und speichert eine Vorschau. Unternehmensdatensätze werden dabei noch nicht geändert."}</p>
      {file && <>
        <div className="hub-field"><label htmlFor="connector-file">{draft.value.provider.toUpperCase()}-Datei auswählen</label><input id="connector-file" type="file" accept={draft.value.provider === "csv" ? ".csv,text/csv,text/plain" : ".json,application/json"} disabled={!canWrite || busy} onChange={event => void chooseFile(event.currentTarget)} /></div>
        <div className="hub-field"><label htmlFor="connector-content">Datei-Inhalt ({draft.value.provider.toUpperCase()})</label><textarea id="connector-content" rows={10} className="hub-code-input" spellCheck={false} value={content.value} disabled={!canWrite || busy} onChange={event => { content.set(event.target.value); clearPreview(); action.clear(); }} /></div>
      </>}
      {hasChanges && <p className="hint">Die Konfiguration enthält ungespeicherte Änderungen. Speichern Sie sie vor dem Abruf.</p>}
      {!draft.value.enabled && <p className="hint">Diese Verbindung ist deaktiviert. Ein Inhaber kann sie wieder aktivieren.</p>}
      {connector.retry_at && <p className="hint">Anbieter-Pause: Ein erneuter Abruf ist frühestens ab {formatDate(connector.retry_at)} möglich.</p>}
      {connector.last_error && <p className="hint">Letzter Abruf: {connector.last_error.message}</p>}
      <button type="button" disabled={!canWrite || busy || hasChanges || !draft.value.enabled || (file && !content.value.trim())} onClick={() => void inspect()}>{file ? "Datei-Vorschau erstellen" : "Verbindung testen und Vorschau erstellen"}</button>
    </section>}
    {previewId && <section className="panel" aria-labelledby="connector-preview-title">
      <h2 id="connector-preview-title">3. Gespeicherte Vorschau</h2>
      <ErrorNotice error={previewQuery.error} onReload={() => void previewQuery.refetch()} />
      {previewQuery.isPending && <p role="status">Vorschau wird geladen …</p>}
      {preview && <>
        <p className="hint">Konfigurationsrevision {preview.connector_revision} · gültig bis {formatDate(preview.expires_at)}. Dieser Seitenlink öffnet dieselbe Vorschau erneut.</p>
        <p role="status">{preview.rows.length} Datensätze · {conflicts} Konflikte · {preview.applied || currentResult ? "übernommen" : "noch nicht übernommen"}</p>
        {preview.rows.length === 0 ? <Empty>Dieser Abschnitt enthält keine Datensätze. Es gibt nichts zu übernehmen.</Empty> : <div className="hub-table-wrap"><table>
          <caption className="sr-only">Gespeicherte Importvorschau und Revisionsprüfung</caption>
          <thead><tr><th scope="col">Datensatz</th><th scope="col">Externe Kennung</th><th scope="col">Aktion</th><th scope="col">Erwartet / aktuell</th><th scope="col">Prüfung</th></tr></thead>
          <tbody>{preview.rows.map(row => <tr key={row.external_id}>
            <th scope="row">{row.name}<details><summary>Importierte Felder ansehen</summary><ValueView fields={contracts.data?.kinds.find(item => item.key === row.kind)?.fields ?? Object.keys(row.data).map(key => ({ key, label: key, kind: "text", required: false, options: [] }))} data={row.data} /></details></th>
            <td>{row.external_id}</td><td>{row.action === "create" ? "Neu anlegen" : "Aktualisieren"}</td><td>{row.expected_revision ?? "Fehlt"} / {row.current_revision}</td><td>{row.conflict ? "Konflikt" : "Bereit"}</td>
          </tr>)}</tbody>
        </table></div>}
        {conflicts > 0 && <p className="hint">Die Vorschau enthält Konflikte. Prüfen Sie die lokalen und externen Daten ausdrücklich. Ein neuer Abruf erzeugt eine separate Vorschau; die Revisionen dieser Vorschau bleiben unverändert.</p>}
        {expired && !preview.applied && !currentResult && <p className="hint">Die Vorschau ist abgelaufen. Erstellen Sie für eine Übernahme eine neue Vorschau.</p>}
        {preview.connector_revision !== draft.value.revision && <p className="hint">Diese Vorschau gehört zu einer anderen Konfigurationsrevision. Prüfen Sie die Verbindung und erstellen Sie eine neue Vorschau.</p>}
        {!preview.applied && !currentResult && <p className="hint">Die Übernahme verwendet ausschließlich diese gespeicherten Zeilen und Revisionen. Bei zwischenzeitlichen Änderungen wird der gesamte Import abgelehnt.</p>}
        <div className="hub-actions">
          <button type="button" disabled={!canWrite || busy || hasChanges || !draft.value.enabled || conflicts > 0 || expired || preview.rows.length === 0 || preview.applied || !!currentResult || preview.connector_revision !== draft.value.revision} onClick={apply}>Geprüfte Vorschau übernehmen</button>
          {preview.next_cursor && !nextcloud && <button type="button" disabled={!canWrite || busy || hasChanges || !draft.value.enabled} onClick={() => void inspect(preview.next_cursor!)}>Nächsten Abschnitt abrufen</button>}
        </div>
        {preview.next_cursor && !nextcloud && <p className="hint">Der nächste Abschnitt ersetzt die angezeigte Vorschau. Übernehmen Sie diesen Abschnitt vorher, wenn er importiert werden soll.</p>}
      </>}
    </section>}
    {applied && <section className="panel"><h2>Import übernommen</h2><p role="status">{applied.rows.length} Datensätze wurden übernommen.</p><ul>{applied.rows.map(row => <li key={row.id}><Link to={`/hub/records/${row.kind}/${row.id}`}>{row.name}</Link> · Revision {row.revision}</li>)}</ul></section>}
  </>;
}
