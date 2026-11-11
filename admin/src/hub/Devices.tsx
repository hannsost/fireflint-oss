import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { Empty, ErrorNotice, PageTitle, Pager, RecordPicker, formatDate, useAction, useDraft, useHub, useHubQuery } from "./common";
import "./devices.css";

interface Details { manufacturer: string; model: string; serial_number: string; architecture: string; omarchy_version: string; kernel_version: string; notes: string }
interface Device {
  id: string; name: string; inventory_number: string; lifecycle: string;
  company_id: string | null; contact_id: string | null; location_id: string | null;
  details: Details; archived: boolean; revision: number; updated_at: string;
  platform: "omarchy"; inventory_source: "manual"; connection_status: "not_connected";
}
interface DevicePage { items: Device[]; total: number; offset: number; limit: number }
interface Version { revision: number; snapshot: Device; actor_id: string; created_at: string }
type Draft = Omit<Device, "updated_at" | "platform" | "inventory_source" | "connection_status">;
const lifecycleNames: Record<string, string> = { in_stock: "Auf Lager", in_use: "Im Einsatz", repair: "In Reparatur", retired: "Ausgemustert" };
const detailFields: { key: keyof Details; label: string }[] = [
  { key: "manufacturer", label: "Hersteller" }, { key: "model", label: "Modell" },
  { key: "serial_number", label: "Seriennummer" }, { key: "omarchy_version", label: "Omarchy-Version" },
  { key: "kernel_version", label: "Kernel-Version" },
];
function fresh(): Draft {
  return { id: crypto.randomUUID(), name: "", inventory_number: "", lifecycle: "in_stock", company_id: null, contact_id: null, location_id: null,
    details: { manufacturer: "", model: "", serial_number: "", architecture: "", omarchy_version: "", kernel_version: "", notes: "" }, archived: false, revision: 0 };
}
function payload(device: Draft) {
  return { name: device.name, inventory_number: device.inventory_number, lifecycle: device.lifecycle, company_id: device.company_id,
    contact_id: device.contact_id, location_id: device.location_id, details: device.details, archived: device.archived, expected_revision: device.revision };
}
export function DevicesPage() {
  const { id } = useParams();
  const { user, org, role, isOwner } = useHub();
  // A role change ends the old editor's async actions as well. Drafts remain
  // scoped to this user/org/device and can be resumed if ownership returns.
  const scope = `${user?.id}:${org}:${role}:${id ?? "list"}`;
  return <div className="devices-page" key={scope}>{id === "new" && !isOwner ? <>
    <PageTitle title="Omarchy-Gerät erfassen" description="Das Geräteinventar wird von den Inhabern dieses Arbeitsbereichs gepflegt." />
    <section className="panel"><p>Nur Inhaber können Geräte erfassen. Du kannst den vorhandenen Gerätebestand und seine Historie ansehen.</p><Link className="button" to="/hub/devices">Zum Gerätebestand</Link></section>
  </> : id ? <DeviceEditor id={id} /> : <DeviceList />}</div>;
}
function DeviceList() {
  const { isOwner } = useHub();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const devices = useHubQuery<DevicePage>("devices", `/devices?q=${encodeURIComponent(query)}&archived=${archived}&offset=${offset}`);
  return <>
    <PageTitle title="Omarchy-Geräte" description="Arbeitsrechner deinem Unternehmen zuordnen und ihren Inventarbestand gemeinsam überblicken.">
      {isOwner && <Link className="button primary" to="/hub/devices/new">Gerät erfassen</Link>}
    </PageTitle>
    <section className="panel"><h2>Dein Gerätebestand</h2><p className="hint">Manuell gepflegtes Inventar. Geräte sind noch nicht verbunden und senden keine automatischen Statusmeldungen.</p>
      {!isOwner && <p className="hub-reader">Du kannst das Inventar ansehen. Nur Inhaber können Geräte erfassen und bearbeiten.</p>}
      <form className="hub-actions devices-filters" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setOffset(0); }}>
        <label>Geräte suchen<input type="search" maxLength={160} value={search} placeholder="Name, Inventarnummer, Modell oder Seriennummer" onChange={event => setSearch(event.target.value)} /></label>
        <button type="submit" className="button secondary">Suchen</button>
        <label className="hub-check"><input type="checkbox" checked={archived} onChange={event => { setArchived(event.target.checked); setOffset(0); }} />Archiv anzeigen</label>
      </form>
      <ErrorNotice error={devices.error} onReload={() => void devices.refetch()} />
      {devices.isPending && <p role="status">Geräte werden geladen…</p>}
      {devices.data?.total === 0 && <Empty>{query ? "Keine Geräte zu dieser Suche gefunden." : archived ? "Keine archivierten Geräte." : "Noch keine Geräte erfasst."}</Empty>}
      {!!devices.data?.items.length && <div className="hub-table-wrap"><table><caption className="sr-only">Manuell erfasste Omarchy-Geräte</caption><thead><tr><th scope="col">Gerät</th><th scope="col">Inventarnummer</th><th scope="col">Lebenszyklus</th><th scope="col">Inventarstand</th></tr></thead><tbody>
        {devices.data.items.map(device => <tr key={device.id}><td data-label="Gerät"><Link to={`/hub/devices/${device.id}`}>{device.name}</Link><div className="hint">{[device.details.manufacturer, device.details.model].filter(Boolean).join(" ") || "Omarchy"}</div></td>
          <td data-label="Inventarnummer">{device.inventory_number}</td><td data-label="Lebenszyklus">{lifecycleNames[device.lifecycle]}</td>
          <td data-label="Inventarstand">{formatDate(device.updated_at)}<div className="hint">Manuell gepflegt</div></td></tr>)}
      </tbody></table></div>}
      {devices.data && <Pager offset={offset} count={devices.data.items.length} total={devices.data.total} onChange={setOffset} />}
    </section>
  </>;
}

function DeviceEditor({ id }: { id: string }) {
  const { base, isOwner, invalidate } = useHub();
  const navigate = useNavigate();
  const isNew = id === "new";
  const [initial] = useState(() => isNew ? fresh() : null);
  const draft = useDraft<Draft | null>(`device:${id}`, initial);
  const loaded = useHubQuery<Device>(`device:${id}`, `/devices/${id}`, !isNew);
  const [historyOffset, setHistoryOffset] = useState(0);
  const history = useHubQuery<Version[]>(`device-history:${id}`, `/devices/${id}/history?offset=${historyOffset}`, !isNew);
  const members = useHubQuery<{ user_id: string; name: string; email: string }[]>("device-history-members", "/members", !isNew);
  const [comparison, setComparison] = useState<Device | null>(null);
  const comparisonRequest = useRef(0);
  const [notice, setNotice] = useState("");
  const action = useAction();
  const compareAction = useAction();
  useEffect(() => { if (loaded.data && !draft.value) draft.reset(loaded.data); }, [loaded.data, draft]);
  const value = draft.value;
  const locked = !isOwner || action.busy;
  function change(patch: Partial<Draft>) {
    if (locked) return;
    draft.set(old => old ? { ...old, ...patch } : old); setNotice("");
  }
  async function save() {
    if (!value || !isOwner) return;
    const submitted = value;
    await action.run(async () => {
      // A comparison started before this write must not restore a stale panel.
      comparisonRequest.current += 1;
      setComparison(null); compareAction.clear();
      const saved = await api.put<Device>(`${base}/devices/${submitted.id}`, payload(submitted));
      if (!action.isActive()) return;
      draft.reset(saved); setComparison(null); setNotice("Inventarangaben gespeichert.");
      await invalidate();
      if (isNew && action.isActive()) { draft.clear(); navigate(`/hub/devices/${saved.id}`, { replace: true }); }
    });
  }
  async function compare() {
    if (!value || action.busy || compareAction.busy) return;
    const request = ++comparisonRequest.current;
    setComparison(null);
    const current = await compareAction.run(async () => {
      try {
        const server = await api.get<Device>(`${base}/devices/${value.id}`);
        return request === comparisonRequest.current ? server : null;
      } catch (error) {
        if (request === comparisonRequest.current) throw error;
        return null;
      }
    });
    if (current && request === comparisonRequest.current) setComparison(current);
  }
  function adoptComparison() {
    if (!comparison || !isOwner || action.busy || compareAction.busy) return;
    comparisonRequest.current += 1;
    draft.reset(comparison); setComparison(null); action.clear(); compareAction.clear(); setNotice("Serverstand übernommen.");
    if (isNew) { draft.clear(); navigate(`/hub/devices/${comparison.id}`, { replace: true }); }
  }
  return <>
    <PageTitle title={isNew ? "Omarchy-Gerät erfassen" : value?.name || "Omarchy-Gerät"} description="Inventarangaben und Zuständigkeiten nachvollziehbar pflegen."><Link className="button secondary" to="/hub/devices">Zum Gerätebestand</Link></PageTitle>
    <ErrorNotice error={loaded.error} onReload={() => void loaded.refetch()} />
    {!isNew && loaded.isPending && !value && <p role="status">Gerät wird geladen…</p>}
    {value && <>
      {draft.dirty && <p className="hub-draft-note" role="status">Ungespeicherter Entwurf · bleibt beim Wechsel der Ansicht in diesem Konto und Arbeitsbereich erhalten. Neuladen oder Abmelden verwirft ungespeicherte Eingaben.</p>}
      {loaded.data && loaded.data.revision > value.revision && <p className="hub-warning">Ein neuerer Serverstand ist verfügbar. Deine Eingaben und die bearbeitete Revision bleiben erhalten, bis du den Serverstand vergleichst und ausdrücklich übernimmst.</p>}
      <section className="panel"><div className="hub-inline"><h2>Inventarangaben</h2><span className="badge draft">Nicht verbunden</span></div>
        <p className="hint">Diese Angaben werden manuell gepflegt. Versionen und Lebenszyklus wurden nicht automatisch am Rechner überprüft.</p>
        {!isOwner && <p className="hub-reader">Nur Inhaber können Geräte bearbeiten.</p>}
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="hub-fields">
              <div className="hub-field"><label htmlFor="device-name">Gerätename *</label><input id="device-name" required maxLength={240} value={value.name} onChange={event => change({ name: event.target.value })} /></div>
              <div className="hub-field"><label htmlFor="device-inventory">Inventarnummer *</label><input id="device-inventory" required maxLength={64} value={value.inventory_number} onChange={event => change({ inventory_number: event.target.value })} /><small>Eindeutig im Arbeitsbereich, auch für archivierte Geräte. Kleinbuchstaben werden als Großbuchstaben gespeichert.</small></div>
              <div className="hub-field"><label htmlFor="device-lifecycle">Lebenszyklus</label><select id="device-lifecycle" value={value.lifecycle} onChange={event => change({ lifecycle: event.target.value })}>{Object.entries(lifecycleNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></div>
              <div className="hub-field"><label htmlFor="device-architecture">Architektur</label><select id="device-architecture" value={value.details.architecture} onChange={event => change({ details: { ...value.details, architecture: event.target.value } })}><option value="">Noch nicht erfasst</option><option value="x86_64">x86_64</option><option value="aarch64">aarch64</option></select></div>
              {detailFields.map(field => <div className="hub-field" key={field.key}><label htmlFor={`device-${field.key}`}>{field.label}</label><input id={`device-${field.key}`} maxLength={160} value={value.details[field.key]} onChange={event => change({ details: { ...value.details, [field.key]: event.target.value } })} /></div>)}
              <div className="hub-field hub-wide"><label htmlFor="device-notes">Notizen</label><textarea id="device-notes" maxLength={4096} value={value.details.notes} onChange={event => change({ details: { ...value.details, notes: event.target.value } })} /></div>
            </div>
            <h3>Zuordnung im Arbeitsbereich</h3><div className="hub-fields">
              <RecordPicker kind="company" label="Unternehmen" value={value.company_id ?? ""} onChange={id => change({ company_id: id || null })} disabled={locked} />
              <RecordPicker kind="contact" label="Zugeordnete Person" value={value.contact_id ?? ""} onChange={id => change({ contact_id: id || null })} disabled={locked} />
              <RecordPicker kind="location" label="Standort" value={value.location_id ?? ""} onChange={id => change({ location_id: id || null })} disabled={locked} />
            </div>
            <p className="hint">Neue Zuordnungen verwenden aktive Datensätze dieses Arbeitsbereichs. Eine bereits gespeicherte, inzwischen archivierte Zuordnung darf unverändert erhalten bleiben.</p>
            <label className="hub-check"><input type="checkbox" checked={value.archived} onChange={event => change({ archived: event.target.checked })} />Im Archiv führen</label>
            <p className="hint">Archivieren bewahrt Angaben und Historie. Es führt keine Aktion auf dem Rechner aus.</p>
            {isOwner && <button type="submit" disabled={locked}>{action.busy ? "Wird gespeichert…" : isNew ? "Gerät speichern" : "Änderungen speichern"}</button>}
          </fieldset>
        </form>
        {value.revision > 0 && <p className="hint">Bearbeiteter Stand: Revision {value.revision}{draft.dirty ? " · Ungespeicherte Änderungen" : ""}</p>}
        {notice && <p role="status">{notice}</p>}
        <ErrorNotice error={action.error} />
        {(action.error || !isNew) && <button type="button" className="button secondary" disabled={action.busy || compareAction.busy} onClick={() => void compare()}>Serverstand vergleichen</button>}
        {compareAction.busy && <p role="status">Serverstand wird zum Vergleich geladen…</p>}
        <ErrorNotice error={compareAction.error} />
      </section>
      {comparison && <section className="panel" aria-label="Serverstand zum Vergleich"><h2>Serverstand · Revision {comparison.revision}</h2><p>Deine Eingaben oben bleiben erhalten. Die Übernahme ersetzt sie ausdrücklich durch diesen Serverstand.</p><DeviceSnapshot device={comparison} />
        <div className="hub-actions">{isOwner && <button type="button" disabled={action.busy || compareAction.busy} onClick={adoptComparison}>Serverstand übernehmen</button>}<button type="button" className="button secondary" onClick={() => setComparison(null)}>Vergleich schließen</button></div>
      </section>}
      {!isNew && <section className="panel" aria-label="Änderungshistorie"><h2>Änderungshistorie</h2><p className="hint">Gespeicherte Inventarstände. Die Historie löst keine Aktion auf dem Gerät aus.</p><ErrorNotice error={history.error} onReload={() => void history.refetch()} />
        {history.isPending && <p role="status">Historie wird geladen…</p>}
        {history.data?.length === 0 && <Empty>Für dieses Gerät sind noch keine Historieneinträge vorhanden.</Empty>}
        {history.data?.map(version => {
          const member = members.data?.find(person => person.user_id === version.actor_id);
          return <details className="hub-history" key={version.revision}><summary>Revision {version.revision} · {formatDate(version.created_at)}</summary><p className="hint">Gespeichert von: {member?.name || member?.email || version.actor_id || "früheres Teammitglied"}</p><DeviceSnapshot device={version.snapshot} /></details>;
        })}
        {history.data && <Pager offset={historyOffset} count={history.data.length} onChange={setHistoryOffset} />}
      </section>}
    </>}
  </>;
}
function DeviceSnapshot({ device }: { device: Device }) {
  return <dl className="hub-values">
    {[ ["Gerätename", device.name], ["Inventarnummer", device.inventory_number], ["Lebenszyklus", lifecycleNames[device.lifecycle]],
      ["Archiv", device.archived ? "Ja" : "Nein"], ["Architektur", device.details.architecture],
      ...detailFields.map(field => [field.label, device.details[field.key]]), ["Notizen", device.details.notes],
      ["Unternehmen (Kennung)", device.company_id], ["Person (Kennung)", device.contact_id], ["Standort (Kennung)", device.location_id],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value || "—"}</dd></div>)}
  </dl>;
}
