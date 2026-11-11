import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, request } from "../api/client";
import { useToast } from "../components/Toast";
import { UiIcon } from "../components/Brand";
import { ErrorNotice, Fields, Empty, PageTitle, Pager, RecordPicker, ValueView, ModuleGate, formatDate, useAction, useDraft, useHub, useHubQuery, type HubRecord, type HubLink, type Kind, type RecordPage } from "./common";

export function RecordsPage() {
  const { kind = "company", id } = useParams();
  const { contracts } = useHub();
  const definition = contracts.data?.kinds.find(k => k.key === kind);
  if (contracts.isPending) return <p role="status">Datentypen werden geladen…</p>;
  if (contracts.error) return <ErrorNotice error={contracts.error} onReload={() => void contracts.refetch()} />;
  if (!definition && kind !== "open") return <Empty>Dieser Datentyp ist nicht bekannt. <Link to="/hub">Zum Unternehmenshub</Link></Empty>;
  return id && id !== "new" ? <RecordLoader id={id} /> : definition ? <ModuleGate module={definition.module}>{id === "new" ? <RecordEditor definition={definition} initial={emptyRecord(kind)} /> : <RecordList definition={definition} />}</ModuleGate> : <Empty>Bitte einen Datensatz wählen.</Empty>;
}
function emptyRecord(kind: string): HubRecord {
  return { id: "", org_id: "", name: "", kind, data: kind === "resource" ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}, revision: 0, archived: false, source_id: null, external_id: null, updated_by: "", created_by: "", created_at: "", updated_at: "", links: [] };
}
function RecordLoader({ id }: { id: string }) {
  const { contracts } = useHub();
  const record = useHubQuery<HubRecord>("record", `/records/${id}`);
  const definition = contracts.data?.kinds.find(k => k.key === record.data?.kind);
  if (record.isPending) return <p role="status">Datensatz wird geladen…</p>;
  if (record.error && !record.data) return <ErrorNotice error={record.error} onReload={() => void record.refetch()} />;
  return record.data && definition ? <ModuleGate module={definition.module}><RecordEditor key={record.data.id} initial={record.data} definition={definition} /></ModuleGate> : <Empty>Datensatz nicht gefunden.</Empty>;
}
function RecordList({ definition }: { definition: Kind }) {
  const { canWrite } = useHub();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const archived = params.get("archived") === "true";
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const list = useHubQuery<RecordPage>("records", `/records?kind=${definition.key}&q=${encodeURIComponent(q)}&archived=${archived}&offset=${offset}`);
  const update = (next: Record<string, string>) => setParams({ q, archived: String(archived), offset: "0", ...next }, { replace: true });
  return <><PageTitle title={definition.name} description="Ein gemeinsamer, versionierter Datenbestand für deinen Arbeitsbereich.">{canWrite && <Link className="button primary" to={`/hub/records/${definition.key}/new`}>Datensatz anlegen</Link>}</PageTitle>
    <section className="panel"><div className="hub-filter-row"><label>Datensätze suchen<input type="search" maxLength={240} value={q} placeholder="Name oder Feldinhalt" onChange={e => update({ q: e.target.value })} /></label><label>Status<select value={String(archived)} onChange={e => update({ archived: e.target.value })}><option value="false">Aktive Datensätze</option><option value="true">Archivierte Datensätze</option></select></label></div>
      <ErrorNotice error={list.error} onReload={() => void list.refetch()} />{list.isPending && <p role="status">Datensätze werden geladen…</p>}
      {list.data && <>{list.data.items.length === 0 ? <Empty><h2>{q ? "Keine Treffer" : archived ? "Das Archiv ist leer" : "Hier beginnt dein Datenbestand"}</h2><p>{q ? "Versuche einen anderen Suchbegriff." : `Lege den ersten Datensatz für ${definition.name} an.`}</p></Empty> : <ul className="hub-record-list">{list.data.items.map(row => <li key={row.id}><Link to={`/hub/records/${row.kind}/${row.id}`}><span className="hub-record-avatar" aria-hidden="true">{row.name.slice(0, 1).toUpperCase()}</span><span><strong>{row.name}</strong><small>{row.source_id ? "Mit externer Datenquelle" : "Zentral gepflegt"} · {formatDate(row.updated_at)}</small></span><span className="hub-revision">Stand {row.revision}<UiIcon name="arrow" /></span></Link></li>)}</ul>}<Pager offset={offset} count={list.data.items.length} total={list.data.total} onChange={value => update({ offset: String(value) })} /></>}
    </section></>;
}
interface Version { revision: number; snapshot: HubRecord; actor_id: string; created_at: string }
function RecordEditor({ initial, definition }: { initial: HubRecord; definition: Kind }) {
  const { base, canWrite, modules, invalidate } = useHub();
  const navigate = useNavigate();
  const toast = useToast();
  const draft = useDraft(`record:${initial.id || `new:${definition.key}`}`, initial);
  const row = draft.value;
  const action = useAction();
  const [latest, setLatest] = useState<HubRecord | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [linkOffset, setLinkOffset] = useState(0);
  const linkPage = useHubQuery<HubLink[]>("links", `/records/${row.id}/links?offset=${linkOffset}`, !!row.id);
  const visibleLinks = linkPage.data ?? (linkOffset === 0 ? row.links : []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const members = useHubQuery<{user_id:string;name:string;email:string}[]>("history-members", "/members", historyOpen);
  const history = useHubQuery<Version[]>("history", `/records/${row.id}/history?offset=${historyOffset}`, !!row.id && historyOpen);
  const relationship = useDraft(`record-links:${initial.id}`, { to: "", relation: "related_to" });
  const integrations = modules.data?.some(m => m.key === "integrations" && m.enabled);
  const set = (changes: Partial<HubRecord>) => draft.set(old => ({ ...old, ...changes }));
  async function save() {
    await action.run(async () => {
      const input = { kind: row.kind, name: row.name, data: row.data, archived: row.archived, source_id: row.source_id || null, external_id: row.source_id ? row.external_id : null, expected_revision: row.revision };
      const result = row.id ? await api.put<HubRecord>(`${base}/records/${row.id}`, input) : await api.post<HubRecord>(`${base}/records`, input);
      if (!action.isActive()) return;
      draft.reset({ ...result, links: row.links?.map(link => link.from_id === result.id ? { ...link, from_revision: result.revision } : link) ?? [] }); setLatest(null); toast("Datensatz gespeichert.");
      if (!row.id) { draft.clear(); navigate(`/hub/records/${result.kind}/${result.id}`, { replace: true }); }
      await invalidate();
    });
  }
  async function loadLatest() {
    await action.run(async () => { setLatest(await api.get<HubRecord>(`${base}/records/${row.id}`)); });
  }
  async function addLink() {
    await action.run(async () => {
      const result = await api.post<HubRecord>(`${base}/records/${row.id}/links`, { to_id: relationship.value.to, relation: relationship.value.relation, expected_revision: row.revision });
      draft.reset(result); relationship.reset({ to: "", relation: "related_to" }); toast("Beziehung hinzugefügt."); await invalidate();
    });
  }
  async function removeLink(id: string) {
    await action.run(async () => {
      await request(`${base}/links/${id}`, { method: "DELETE", body: JSON.stringify({ expected_revision: row.revision }) });
      draft.reset({ ...row, revision: row.revision + 1, links: row.links?.filter(link => link.id !== id) });
      toast("Beziehung entfernt."); await invalidate();
    });
  }
  return <><Link className="hub-back" to={`/hub/records/${definition.key}`}><UiIcon name="back" />{definition.name}</Link><PageTitle title={row.id ? row.name || "Datensatz" : "Datensatz anlegen"} description={row.id ? `Stand ${row.revision} · ${row.archived ? "Archiviert" : "Aktiv"}` : `${definition.name} · Zentral gepflegt`}>
      {row.id && row.kind === "company" && <Link className="button" to={`/hub/companies/${row.id}`}>Unternehmensakte öffnen</Link>}
      {row.id && modules.data?.some(m => m.key === "translations" && m.enabled) && <Link className="button" to={`/hub/translations?record=${row.id}`}>Übersetzen</Link>}
      {row.id && modules.data?.some(m => m.key === "work" && m.enabled) && <Link className="button" to={`/hub/work/new?record=${row.id}`}>Aufgabe erstellen</Link>}
    </PageTitle>
    {initial.revision > row.revision && <p className="hub-warning">Ein neuerer Serverstand ist verfügbar. Dein geladener Stand und deine Eingaben bleiben bis zur bewussten Übernahme erhalten.</p>}
    {draft.dirty && <p className="hub-draft-note" role="status">Ungespeicherter Entwurf · bleibt beim Wechsel der Ansicht erhalten.</p>}
    <ErrorNotice error={action.error} onReload={row.id ? () => void loadLatest() : undefined} />
    {latest && <section className="panel hub-review"><h2>Aktueller Serverstand: {latest.name} · Stand {latest.revision}</h2><ValueView fields={definition.fields} data={latest.data} /><p>Deine Eingaben stehen weiterhin im Editor. Beim Übernehmen werden sie durch diesen Serverstand ersetzt.</p><div className="hub-actions"><button type="button" onClick={() => { draft.reset(latest); setLatest(null); action.clear(); }}>Serverstand übernehmen und Entwurf verwerfen</button><button type="button" onClick={() => setLatest(null)}>Entwurf weiter ansehen</button></div></section>}
    <form className="panel hub-form" onSubmit={e => { e.preventDefault(); void save(); }} aria-busy={action.busy}>
      <fieldset disabled={!canWrite || action.busy}><legend>Stammdaten</legend><label>Anzeigename<input value={row.name} required maxLength={240} onChange={e => set({ name: e.target.value })} /></label><p className="hint">Der Anzeigename erscheint in Listen und Verknüpfungen. Pflichtfelder sind mit * markiert.</p><Fields fields={definition.fields} data={row.data} onChange={data => set({ data })} />
        {(integrations || row.source_id) && <details className="hub-details"><summary>Herkunft und Datenquelle</summary><RecordPicker kind="source" value={row.source_id ?? ""} onChange={source_id => set({ source_id: source_id || null, external_id: source_id ? row.external_id ?? "" : null })} label="Datenquelle" disabled={!integrations} exclude={row.id} /><label>Externe Kennung<input disabled={!integrations || !row.source_id} required={!!row.source_id} maxLength={240} value={row.external_id ?? ""} onChange={e => set({ external_id: e.target.value })} /></label><p className="hint">Quelle und Kennung ordnen den Datensatz eindeutig einem anderen System zu. Daten werden erst durch eine geprüfte Übernahme geändert.</p></details>}
        {row.id && <label className="hub-check"><input type="checkbox" checked={row.archived} onChange={e => set({ archived: e.target.checked })} />Archiviert</label>}
        <div className="hub-actions"><button type="submit" className="primary" disabled={!canWrite || action.busy}>{action.busy ? "Speichern…" : "Datensatz speichern"}</button>{row.id && <button type="button" onClick={() => void loadLatest()}>Serverstand ansehen</button>}</div>
      </fieldset>
    </form>
    {row.id && <><section className="panel"><h2>Beziehungen</h2><p className="hint">Verknüpfungen ändern den Stand des Ausgangsdatensatzes. Speichere zuerst offene Stammdatenänderungen.</p>
      <ErrorNotice error={linkPage.error} onReload={() => void linkPage.refetch()} />{visibleLinks?.length ? <ul className="hub-link-list">{visibleLinks.map(link => <li key={link.id}><div><strong>{link.from_id === row.id ? "Zu" : "Von"} </strong><Link to={`/hub/records/open/${link.from_id === row.id ? link.to_id : link.from_id}`}>{link.from_id === row.id ? link.to_name : link.from_name}</Link><small>{relationLabel(link.relation)}</small></div>{link.from_id === row.id ? <button disabled={!canWrite || draft.dirty || action.busy || row.archived} onClick={() => void removeLink(link.id)}>Beziehung entfernen</button> : <small>Am Ausgangsdatensatz verwalten</small>}</li>)}</ul> : <Empty>Noch keine Beziehungen auf dieser Seite.</Empty>}<Pager offset={linkOffset} count={visibleLinks?.length ?? 0} pageSize={200} onChange={setLinkOffset} />
      <form className="hub-form" onSubmit={e => { e.preventDefault(); void addLink(); }}><fieldset disabled={!canWrite || draft.dirty || action.busy || row.archived}><legend>Beziehung hinzufügen</legend><RecordPicker value={relationship.value.to} onChange={to => relationship.set(old => ({ ...old, to }))} exclude={row.id} label="Verknüpfter Datensatz" /><label>Beziehungsart<select value={relationship.value.relation} onChange={e => relationship.set(old => ({ ...old, relation: e.target.value }))}><option value="related_to">Gehört zusammen</option><option value="works_for">Arbeitet für</option><option value="located_at">Befindet sich an</option><option value="offers">Bietet an</option><option value="managed_by">Wird betreut von</option><option value="supplied_by">Wird geliefert von</option></select></label><button disabled={!relationship.value.to || !canWrite || draft.dirty || action.busy}>Beziehung hinzufügen</button></fieldset></form>
    </section><section className="panel"><button className="hub-disclosure" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>Änderungsverlauf {historyOpen ? "schließen" : "anzeigen"}</button>{historyOpen && <><ErrorNotice error={history.error} onReload={() => void history.refetch()} />{history.isPending && <p role="status">Verlauf wird geladen…</p>}{history.data?.map(version => <details className="hub-history" key={version.revision}><summary>Stand {version.revision} · {formatDate(version.created_at)} · {version.snapshot.name}</summary><ValueView fields={definition.fields} data={version.snapshot.data} />{version.snapshot.source_id && <p>Herkunft: <Link to={`/hub/records/source/${version.snapshot.source_id}`}>Datenquelle ansehen</Link> · Externe Kennung: {version.snapshot.external_id}</p>}{!!version.snapshot.links?.length && <ul>{version.snapshot.links.map(link => <li key={link.id}>{relationLabel(link.relation)} · <Link to={`/hub/records/open/${link.to_id}`}>Verknüpften Datensatz ansehen</Link></li>)}</ul>}<p className="hint">{version.snapshot.archived ? "Archiviert" : "Aktiv"} · {version.snapshot.links?.length ?? 0} ausgehende Beziehungen · Bearbeitet durch {members.data?.find(member => member.user_id === version.actor_id)?.name || members.data?.find(member => member.user_id === version.actor_id)?.email || "früheres Teammitglied"}</p></details>)}<Pager offset={historyOffset} count={history.data?.length ?? 0} onChange={setHistoryOffset} /></>}</section></>}
  </>;
}
function relationLabel(value: string) { return ({ related_to: "Gehört zusammen", works_for: "Arbeitet für", located_at: "Befindet sich an", offers: "Bietet an", managed_by: "Wird betreut von", supplied_by: "Wird geliefert von" } as Record<string, string>)[value] ?? value; }
