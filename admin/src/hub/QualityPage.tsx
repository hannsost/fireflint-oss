import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, request } from "../api/client";
import { Empty, ErrorNotice, formatDate, ModuleGate, Pager, PageTitle, useAction, useDraft, useHub, type Kind } from "./common";
import "./quality.css";

type Normalization = "text" | "identifier" | "email" | "phone";
interface Definition { required_any: string[][]; max_age_days: number | null; duplicate_names: boolean; duplicate_keys: { fields: string[]; normalization: Normalization }[] }
interface Rule { kind: string; revision: number; definition: Definition; updated_at?: string }
interface Scan { id: string; kind: string; definition: Definition; rule_revision: number; revision: number; created_at: string; finished_at: string | null; total_records: number; captured_records: number; processed_records: number; finding_count: number; record_limit: number; step_size: number; complete: boolean; completed: boolean; capped: boolean; stale: boolean; rules_stale: boolean; schema_stale: boolean; records_stale: boolean }
interface SourceRef { id: string; kind: string; name: string; revision: number; updated_at: string; source_id: string | null; external_id: string | null; values: Record<string, unknown> }
interface Finding { id: string; scan_id: string; category: string; explanation: string; evidence: { normalized?: string[]; max_age_days?: number; evaluated_at?: string; identity_confirmed?: boolean }; refs: SourceRef[]; status: string; assignee_id: string | null; comment: string; revision: number; updated_by: string; updated_at: string; stale: boolean; scan_complete: boolean; scan_created_at: string; rule_revision: number }
interface Page<T> { items: T[]; total: number; offset: number; limit: number }
interface History<T> { revision: number; actor_id: string; created_at: string; snapshot: T }
interface Member { user_id: string; name: string; email: string; role: string }
const statuses: Record<string, string> = { open: "Offen", in_review: "In Prüfung", resolved: "Prüfung abgeschlossen", dismissed: "Hinweis verworfen" };
const categories: Record<string, string> = { completeness: "Fehlende Angaben", freshness: "Aktualität prüfen", name_hint: "Gleicher Name", duplicate_hint: "Dublettenhinweis" };
const modes: Record<Normalization, string> = { text: "Text · Schreibweise und Leerraum", identifier: "Kennung · ohne Leerraum und Bindestriche", email: "E-Mail · Schreibweise und Rand-Leerraum", phone: "Telefon · ohne Leerraum, Klammern und Bindestriche" };

export function QualityPage() {
  const { org } = useHub();
  return <ModuleGate module="quality"><QualityWorkspace key={org} /></ModuleGate>;
}

function QualityWorkspace() {
  const { org, contracts, modules, canWrite } = useHub();
  const choice = useDraft("quality:kind", "contact");
  const kinds = contracts.data?.kinds.filter(kind => modules.data?.some(module => module.key === kind.module && module.enabled)) ?? [];
  const kind = kinds.find(kind => kind.key === choice.value) ?? kinds[0];
  return <div className="quality-page">
    <PageTitle title="Datenqualität" description="Fehlende Angaben, veraltete Daten und mögliche Dubletten nachvollziehbar prüfen." />
    <p className="quality-boundary">Die Prüfung verändert keine Unternehmensdaten. Gleiche Namen und Vergleichsschlüssel sind Hinweise, die eine Person fachlich beurteilen muss.</p>
    {!canWrite && <p className="quality-notice" role="status">Lesezugriff: Du kannst Regeln, Befunde und bisherige Entscheidungen ansehen.</p>}
    <ErrorNotice error={contracts.error || modules.error} onReload={() => { void contracts.refetch(); void modules.refetch(); }} />
    <label className="hub-field quality-kind">Datentyp<select value={kind?.key ?? ""} onChange={event => choice.set(event.target.value)}>
      {!kind && <option value="">Datentypen werden geladen …</option>}
      {kinds.map(kind => <option key={kind.key} value={kind.key}>{kind.name}</option>)}
    </select></label>
    {kind && <KindQuality key={`${org}:${kind.key}`} kind={kind} />}
  </div>;
}

function KindQuality({ kind }: { kind: Kind }) {
  const { org, base, canWrite, isOwner, invalidate } = useHub();
  const action = useAction();
  const [scanId, setScanId] = useState("");
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<Finding | null>(null);
  const [scanOffset, setScanOffset] = useState(0);
  const [removal, setRemoval] = useState<Scan | null>(null);
  const [confirmedRemoval, setConfirmedRemoval] = useState(false);
  const root = `${base}/quality`;
  const rule = useQuery({ queryKey: ["hub", org, "quality-rule", kind.key], queryFn: () => api.get<Rule>(`${root}/rules/${encodeURIComponent(kind.key)}`) });
  const scans = useQuery({ queryKey: ["hub", org, "quality-scans", kind.key, scanOffset], queryFn: () => api.get<Page<Scan>>(`${root}/scans?kind=${encodeURIComponent(kind.key)}&offset=${scanOffset}`) });
  const activeId = scanId || scans.data?.items[0]?.id || "";
  const findings = useQuery({ queryKey: ["hub", org, "quality-findings", activeId, status, offset], enabled: !!activeId,
    queryFn: () => api.get<Page<Finding> & { scan: Scan }>(`${root}/findings?scan_id=${activeId}&status=${status}&offset=${offset}`) });
  const scan = findings.data?.scan;

  async function start() {
    if (!canWrite || !rule.data) return;
    const result = await action.run(() => api.post<Scan>(`${root}/scans`, { kind: kind.key, expected_rule_revision: rule.data!.revision }));
    if (result) { setScanId(result.id); setOffset(0); setStatus(""); setSelected(null); setScanOffset(0); await invalidate(); }
  }
  async function step() {
    if (!canWrite || !scan) return;
    const result = await action.run(() => api.post<Scan>(`${root}/scans/${scan.id}/step`, { expected_revision: scan.revision }));
    if (result) await invalidate();
  }
  async function remove() {
    if (!isOwner || !removal || !confirmedRemoval) return;
    const result = await action.run(async () => {
      await request(`${root}/scans/${removal.id}`, { method: "DELETE", body: JSON.stringify({ expected_revision: removal.revision }) });
      return true;
    });
    if (result) { setRemoval(null); setConfirmedRemoval(false); setScanId(""); setOffset(0); setSelected(null); await invalidate(); }
  }

  return <>
    <ErrorNotice error={rule.error} onReload={() => void rule.refetch()} />
    {rule.isPending && <p role="status">Prüfregeln werden geladen …</p>}
    {rule.data && <RuleEditor key={kind.key} kind={kind} initial={rule.data} />}
    <section className="panel quality-scans" aria-label="Prüfläufe">
      <div className="hub-actions"><div><h2>Prüfläufe</h2><p className="muted">Ein Lauf hält Regeln und Datenstand zum Startzeitpunkt fest.</p></div>
        <button className="button" type="button" disabled={!canWrite || action.busy || !rule.data?.revision} onClick={() => void start()}>{action.busy ? "Wird verarbeitet …" : "Neue Prüfung starten"}</button></div>
      <p className="hint">Bis zu 1.000 aktive Datensätze je Lauf, 100 je Schritt. Archivierte Einträge sind ausgenommen. Es gelten höchstens 100 gespeicherte Läufe je Datentyp und 8 MiB je Prüfsnapshot.</p>
      <ErrorNotice error={action.error} onReload={() => { void scans.refetch(); void findings.refetch(); void rule.refetch(); }} />
      <ErrorNotice error={scans.error} onReload={() => void scans.refetch()} />
      {!!scans.data?.items.length && <>
        <label className="hub-field">Prüflauf auswählen<select value={activeId} onChange={event => { setScanId(event.target.value); setOffset(0); setSelected(null); setRemoval(null); setConfirmedRemoval(false); }}>
          {scans.data.items.map(item => <option key={item.id} value={item.id}>{formatDate(item.created_at)} · {item.processed_records}/{item.total_records} geprüft · {item.finding_count} Hinweise{item.stale ? " · Veraltet" : item.capped ? " · Begrenzter Umfang" : ""}</option>)}
        </select></label>
        <Pager offset={scanOffset} count={scans.data.items.length} total={scans.data.total} onChange={setScanOffset} />
      </>}
      {scans.isPending && <p role="status">Prüfläufe werden geladen …</p>}
      {scans.data?.total === 0 && <Empty>Noch kein Prüflauf. Speichere passende Regeln und starte anschließend die erste Prüfung.</Empty>}
      {scan && <>
        <div className="quality-coverage" aria-label="Prüfumfang">
          <div><strong>{scan.processed_records} / {scan.total_records}</strong><span>Datensätze geprüft</span></div>
          <div><strong>{scan.finding_count}</strong><span>Hinweise ermittelt</span></div>
          <div><strong>{scan.complete ? "Vollständig" : scan.stale ? "Veraltet" : scan.capped ? "Begrenzter Umfang" : "In Arbeit"}</strong><span>{scan.captured_records} Datensätze im Prüfstand</span></div>
        </div>
        <p className="hint">Stand {formatDate(scan.created_at)} · Regelrevision {scan.rule_revision}. Aktualität wird zu diesem Zeitpunkt beurteilt.</p>
        {scan.stale && <p className="quality-warning" role="status">Dieser Prüfstand ist veraltet:{scan.rules_stale ? " Regeln geändert." : ""}{scan.schema_stale ? " Datentyp geändert." : ""}{scan.records_stale ? " Datensätze geändert, hinzugefügt oder archiviert." : ""} Starte nach Prüfung der Regeln einen neuen Lauf. Frühere Befunde und Kommentare bleiben erhalten.</p>}
        {scan.capped && <p className="quality-warning">Nur die ersten {scan.record_limit} Datensätze nach stabiler Kennung sind erfasst. {scan.total_records - scan.captured_records} weitere Datensätze und mögliche Übereinstimmungen mit ihnen sind ungeprüft. Dieser Lauf kann keine vollständige Aussage zum Datentyp liefern.</p>}
        {!scan.completed && <button className="button secondary" type="button" disabled={!canWrite || action.busy || scan.stale} onClick={() => void step()}>Nächste {scan.step_size} Datensätze prüfen</button>}
        <details className="quality-details"><summary>Regeln dieses Prüflaufs ansehen</summary><RuleSummary definition={scan.definition} kind={kind} /></details>
        {isOwner && (scan.completed || scan.stale) && <button type="button" className="button secondary" disabled={action.busy} onClick={() => { setRemoval(scan); setConfirmedRemoval(false); }}>Prüflauf entfernen …</button>}
      </>}
      {removal && <section className="quality-review-server" aria-label="Prüflauf endgültig entfernen"><h3>Prüfnachweise entfernen</h3>
        <p>Der Lauf vom {formatDate(removal.created_at)} mit {removal.finding_count} Befunden und allen zugehörigen Prüfkommentaren wird endgültig entfernt. Die Unternehmensdaten und Prüfregeln bleiben erhalten. Die Entfernung wird im Ereignisverlauf dokumentiert.</p>
        <label className="quality-checkbox"><input type="checkbox" checked={confirmedRemoval} onChange={event => setConfirmedRemoval(event.target.checked)} />Ich möchte diesen Prüflauf und seine Prüfhistorie endgültig entfernen.</label>
        <div className="hub-actions"><button type="button" className="button secondary" disabled={!confirmedRemoval || !isOwner || action.busy} onClick={() => void remove()}>Prüflauf endgültig entfernen</button><button type="button" className="button secondary" disabled={action.busy} onClick={() => { setRemoval(null); setConfirmedRemoval(false); }}>Abbrechen</button></div>
      </section>}
    </section>
    {activeId && <section className="panel" aria-label="Befunde">
      <div className="hub-actions"><h2>Befunde</h2><label className="hub-field">Prüfstatus filtern<select value={status} onChange={event => { setStatus(event.target.value); setOffset(0); setSelected(null); }}><option value="">Alle Status</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <ErrorNotice error={findings.error} onReload={() => void findings.refetch()} />
      {findings.isPending && <p role="status">Befunde werden geladen …</p>}
      {findings.data && <>
        {findings.data.items.length === 0 ? <Empty>{status ? "Keine Befunde für diesen Status." : scan?.complete ? "Für die konfigurierten Regeln wurden im geprüften Stand keine Hinweise gefunden." : "Bislang keine Hinweise. Die Prüfung ist noch nicht vollständig oder ihr Stand ist veraltet."}</Empty> : <div className="quality-finding-list">{findings.data.items.map(item => <button className={`quality-finding ${selected?.id === item.id ? "selected" : ""}`} type="button" key={item.id} onClick={() => setSelected(item)}>
          <span className="quality-label">{categories[item.category]} · {statuses[item.status]}{item.stale ? " · Veraltet" : ""}</span>
          <strong>{item.refs[0]?.name}{item.refs.length > 1 ? ` + ${item.refs.length - 1} weitere` : ""}</strong><span>{item.explanation}</span>
        </button>)}</div>}
        <Pager offset={offset} count={findings.data.items.length} total={findings.data.total} onChange={setOffset} />
      </>}
    </section>}
    {selected && <FindingReview key={selected.id} initial={selected} onClose={() => setSelected(null)} />}
  </>;
}

function FieldsChoice({ kind, fields, duplicate = false, disabled, onChange }: { kind: Kind; fields: string[]; duplicate?: boolean; disabled: boolean; onChange: (fields: string[]) => void }) {
  const options = kind.fields.filter(field => !duplicate || !["boolean", "number"].includes(field.kind)).map(field => ({ key: field.key, label: field.label }));
  if (duplicate) options.push({ key: "$external_id", label: "Externe Kennung innerhalb derselben Quelle" });
  return <div className="quality-field-options">{options.map(field => <label key={field.key}><input type="checkbox" disabled={disabled || (!fields.includes(field.key) && fields.length >= 8)} checked={fields.includes(field.key)} onChange={event => onChange(event.target.checked ? [...fields, field.key] : fields.filter(value => value !== field.key))} />{field.label}</label>)}</div>;
}

function RuleEditor({ kind, initial }: { kind: Kind; initial: Rule }) {
  const { org, base, canWrite, invalidate } = useHub();
  const draft = useDraft<Rule>(`quality:rule:${kind.key}`, initial);
  const action = useAction();
  const [server, setServer] = useState<Rule | null>(null);
  const [message, setMessage] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const root = `${base}/quality/rules/${encodeURIComponent(kind.key)}`;
  const history = useQuery({ queryKey: ["hub", org, "quality-rule-history", kind.key, historyOffset], enabled: showHistory, queryFn: () => api.get<Page<History<Rule>>>(`${root}/history?offset=${historyOffset}`) });
  const value = draft.value.definition;
  const disabled = !canWrite || action.busy;
  function change(patch: Partial<Definition>) { draft.set(old => ({ ...old, definition: { ...old.definition, ...patch } })); setMessage(""); }
  async function load() { const result = await action.run(() => api.get<Rule>(root)); if (result) setServer(result); }
  async function save() {
    if (disabled) return;
    const result = await action.run(() => api.put<Rule>(root, { definition: value, expected_revision: draft.value.revision }));
    if (result) { draft.reset(result); setServer(null); setMessage("Regeln gespeichert. Starte einen neuen Prüflauf für diesen Regelstand."); await invalidate(); }
  }
  return <section className="panel" aria-label="Prüfregeln">
    <h2>Prüfregeln für {kind.name}</h2><p className="hint">Regelrevision {draft.value.revision}{draft.dirty ? " · Ungespeicherte Änderungen" : ""}. Regeländerungen machen frühere Prüfläufe ungültig.</p>
    <ErrorNotice error={action.error} onReload={() => void load()} />
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className="quality-rule-section" disabled={disabled}><legend>Vollständigkeit</legend><p>Jede Gruppe verlangt mindestens eines ihrer Felder. Alle Gruppen müssen erfüllt sein.</p>
        {value.required_any.map((fields, index) => <fieldset className="quality-group" key={index}><legend>Pflichtfeldgruppe {index + 1} · ODER</legend>
          <FieldsChoice kind={kind} fields={fields} disabled={disabled} onChange={fields => change({ required_any: value.required_any.map((old, i) => i === index ? fields : old) })} />
          <button type="button" className="button secondary" onClick={() => change({ required_any: value.required_any.filter((_, i) => i !== index) })}>Gruppe {index + 1} entfernen</button>
        </fieldset>)}
        <div className="hub-actions"><button type="button" className="button secondary" disabled={disabled || value.required_any.length >= 16} onClick={() => change({ required_any: [...value.required_any, []] })}>Pflichtfeldgruppe hinzufügen</button>
          {kind.fields.some(field => field.key === "email") && kind.fields.some(field => field.key === "phone") && <button type="button" className="button secondary" disabled={disabled || value.required_any.length >= 16} onClick={() => change({ required_any: [...value.required_any, ["email", "phone"]] })}>E-Mail oder Telefon verlangen</button>}</div>
      </fieldset>
      <fieldset className="quality-rule-section" disabled={disabled}><legend>Aktualität</legend><label className="hub-field">Maximales Alter seit letzter Änderung (Tage)<input type="number" min={1} max={36500} value={value.max_age_days ?? ""} onChange={event => change({ max_age_days: event.target.value ? Number(event.target.value) : null })} placeholder="Keine Altersregel" /></label><p className="hint">Eine alte Änderung ist ein Prüfanlass. Sie beweist nicht, dass der Inhalt falsch ist.</p></fieldset>
      <fieldset className="quality-rule-section" disabled={disabled}><legend>Dublettenhinweise</legend>
        <label className="quality-checkbox"><input type="checkbox" checked={value.duplicate_names} onChange={event => change({ duplicate_names: event.target.checked })} />Gleiche Namen als unverbindlichen Hinweis anzeigen</label>
        {value.duplicate_keys.map((key, index) => <fieldset className="quality-group" key={index}><legend>Vergleichsschlüssel {index + 1}</legend><p>Alle ausgewählten Felder müssen befüllt sein und zusammen übereinstimmen, zum Beispiel Straße und Postleitzahl.</p>
          <FieldsChoice kind={kind} duplicate fields={key.fields} disabled={disabled} onChange={fields => change({ duplicate_keys: value.duplicate_keys.map((old, i) => i === index ? { ...old, fields } : old) })} />
          <label className="hub-field">Vergleichsart {index + 1}<select value={key.normalization} onChange={event => change({ duplicate_keys: value.duplicate_keys.map((old, i) => i === index ? { ...old, normalization: event.target.value as Normalization } : old) })}>{Object.entries(modes).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}</select></label>
          <button type="button" className="button secondary" onClick={() => change({ duplicate_keys: value.duplicate_keys.filter((_, i) => i !== index) })}>Vergleichsschlüssel {index + 1} entfernen</button>
        </fieldset>)}
        <button className="button secondary" type="button" disabled={disabled || value.duplicate_keys.length >= 8} onClick={() => change({ duplicate_keys: [...value.duplicate_keys, { fields: [], normalization: "text" }] })}>Vergleichsschlüssel hinzufügen</button>
        <p className="hint">Keine unscharfe Namenssuche, keine automatische Adresskorrektur oder Länderkennung. E-Mail-Vergleiche ignorieren die Schreibweise; gemeinsame Postfächer können unterschiedliche Personen betreffen.</p>
      </fieldset>
      <div className="hub-actions"><button type="submit" className="button" disabled={disabled}>{action.busy ? "Wird gespeichert …" : "Prüfregeln speichern"}</button><button type="button" className="button secondary" disabled={action.busy} onClick={() => void load()}>Aktuellen Regelstand prüfen</button></div>
    </form>
    {message && <p role="status">{message}</p>}
    {server && <section className="quality-review-server" aria-label="Aktueller Regelstand"><h3>Serverstand · Regelrevision {server.revision}</h3><RuleSummary kind={kind} definition={server.definition} />
      <p>Deine Eingaben bleiben bis zu einer ausdrücklichen Auswahl erhalten.</p><div className="hub-actions">
        <button className="button secondary" disabled={disabled} type="button" onClick={() => { draft.set(old => ({ ...old, revision: server.revision })); setServer(null); action.clear(); }}>Verglichen: Revision übernehmen, Eingaben behalten</button>
        <button className="button secondary" type="button" disabled={action.busy} onClick={() => { draft.reset(server); setServer(null); action.clear(); }}>Serverstand laden und Eingaben verwerfen</button>
      </div></section>}
    <details className="quality-details" onToggle={event => setShowHistory(event.currentTarget.open)}><summary>Regelhistorie</summary><ErrorNotice error={history.error} />
      {history.isFetching && <p role="status">Historie wird geladen …</p>}{history.data && <><ol className="quality-history">{history.data.items.map(item => <li key={item.revision}><strong>Revision {item.revision}</strong> · {formatDate(item.created_at)}<RuleSummary definition={item.snapshot.definition} kind={kind} /></li>)}</ol><Pager offset={historyOffset} count={history.data.items.length} total={history.data.total} onChange={setHistoryOffset} /></>}
    </details>
  </section>;
}

function RuleSummary({ definition, kind }: { definition: Definition; kind: Kind }) {
  const label = (field: string) => field === "$external_id" ? "Externe Kennung (gleiche Quelle)" : kind.fields.find(item => item.key === field)?.label ?? field;
  return <ul className="quality-rule-summary">
    {definition.required_any.map((group, index) => <li key={`r${index}`}>Pflichtgruppe {index + 1}: {group.map(label).join(" oder ") || "Keine Felder ausgewählt"}</li>)}
    <li>Aktualität: {definition.max_age_days ? `höchstens ${definition.max_age_days} Tage seit Änderung` : "keine Altersregel"}</li>
    <li>Namenshinweise: {definition.duplicate_names ? "aktiv" : "aus"}</li>
    {definition.duplicate_keys.map((key, index) => <li key={`d${index}`}>{key.fields.map(label).join(" + ")} · {modes[key.normalization]}</li>)}
  </ul>;
}

function FindingReview({ initial, onClose }: { initial: Finding; onClose: () => void }) {
  const { org, base, canWrite, contracts, invalidate } = useHub();
  const root = `${base}/quality/findings/${initial.id}`;
  const draft = useDraft(`quality:review:${initial.id}`, { revision: initial.revision, status: initial.status, assignee_id: initial.assignee_id ?? "", comment: initial.comment });
  const action = useAction();
  const [server, setServer] = useState<Finding | null>(null);
  const [message, setMessage] = useState("");
  const [refsOffset, setRefsOffset] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const current = useQuery({ queryKey: ["hub", org, "quality-finding", initial.id], queryFn: () => api.get<Finding>(root) });
  const members = useQuery({ queryKey: ["hub", org, "members"], queryFn: () => api.get<Member[]>(`${base}/members`) });
  const history = useQuery({ queryKey: ["hub", org, "quality-review-history", initial.id, historyOffset], queryFn: () => api.get<Page<History<Finding>>>(`${root}/history?offset=${historyOffset}`) });
  const finding = current.data ?? initial;
  const disabled = !canWrite || action.busy || finding.stale || current.isPending || !!current.error;
  const memberName = (id: string | null) => members.data?.find(member => member.user_id === id)?.name ?? (id ? "Früheres Mitglied" : "Noch nicht zugeordnet");
  async function load() { const result = await action.run(() => api.get<Finding>(root)); if (result) setServer(result); }
  async function save() {
    if (disabled) return;
    const result = await action.run(() => api.put<Finding>(root, { expected_revision: draft.value.revision, status: draft.value.status, assignee_id: draft.value.assignee_id || null, comment: draft.value.comment }));
    if (result) { draft.reset({ revision: result.revision, status: result.status, assignee_id: result.assignee_id ?? "", comment: result.comment }); setServer(null); setMessage("Prüfung dokumentiert. Unternehmensdaten bleiben unverändert."); await invalidate(); }
  }
  return <section className="panel quality-review" aria-label="Befund prüfen">
    <div className="hub-actions"><h2>{categories[finding.category]}</h2><button className="button secondary" type="button" onClick={onClose}>Schließen · Eingaben behalten</button></div>
    <p>{finding.explanation}</p><p className="hint">Prüfstand {formatDate(finding.scan_created_at)} · Regelrevision {finding.rule_revision} · Gelesene Befundrevision {draft.value.revision}{draft.dirty ? " · Ungespeicherte Eingaben" : ""}</p>
    {finding.stale && <p className="quality-warning" role="status">Veralteter Befund: Der Daten- oder Regelstand ist inzwischen geändert. Ein neuer Prüflauf ist erforderlich. Deine bisherigen Eingaben bleiben erhalten.</p>}
    {!finding.scan_complete && !finding.stale && <p className="quality-notice">Der gesamte Datentyp ist noch nicht vollständig geprüft. Dieser Hinweis bezieht sich auf die unten aufgeführten Datensätze.</p>}
    <ErrorNotice error={current.error || members.error} /><ErrorNotice error={action.error} onReload={() => void load()} />
    {finding.evidence.normalized && <p className="quality-normalized"><strong>Verglichener Wert:</strong> {finding.evidence.normalized.join(" · ")}</p>}
    <h3>Geprüfte Datensätze und Herkunft</h3><ul className="quality-source-list">{finding.refs.slice(refsOffset, refsOffset + 20).map(ref => <li key={ref.id}>
      <Link to={`/hub/records/${ref.kind}/${ref.id}`}>{ref.name}</Link><span> · Revision {ref.revision} · {formatDate(ref.updated_at)}</span>
      <p>{ref.source_id ? <><Link to={`/hub/records/source/${ref.source_id}`}>Datenquelle ansehen</Link> · Externe Kennung: {ref.external_id}</> : "Ohne externe Quellzuordnung"}</p>
      {!!Object.keys(ref.values).length && <dl>{Object.entries(ref.values).map(([key, value]) => <div key={key}><dt>{key === "$external_id" ? "Externe Kennung" : contracts.data?.kinds.find(kind => kind.key === ref.kind)?.fields.find(field => field.key === key)?.label ?? key}</dt><dd>{value === null || value === undefined || value === "" ? "Nicht angegeben" : String(value)}</dd></div>)}</dl>}
    </li>)}</ul><Pager offset={refsOffset} count={finding.refs.slice(refsOffset, refsOffset + 20).length} total={finding.refs.length} pageSize={20} onChange={setRefsOffset} />
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="hub-grid"><label className="hub-field">Prüfstatus<select disabled={disabled} value={draft.value.status} onChange={event => draft.set(old => ({ ...old, status: event.target.value }))}>{Object.entries(statuses).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
        <label className="hub-field">Zuständige Person<select disabled={disabled || members.isPending || !!members.error} required={draft.value.status !== "open"} value={draft.value.assignee_id} onChange={event => draft.set(old => ({ ...old, assignee_id: event.target.value }))}><option value="">Noch nicht zugeordnet</option>{draft.value.assignee_id && !members.data?.some(member => member.user_id === draft.value.assignee_id && member.role !== "viewer") && <option value={draft.value.assignee_id}>Bisherige Person (nicht mehr zuweisbar)</option>}{members.data?.filter(member => member.role === "owner" || member.role === "editor").map(member => <option key={member.user_id} value={member.user_id}>{member.name} · {member.email}</option>)}</select></label></div>
      <label className="hub-field">Prüfkommentar<textarea required maxLength={4000} disabled={disabled} value={draft.value.comment} onChange={event => draft.set(old => ({ ...old, comment: event.target.value }))} placeholder="Was wurde geprüft? Warum wird der Hinweis bestätigt oder verworfen?" /></label>
      <p className="hint">„Prüfung abgeschlossen“ dokumentiert die fachliche Beurteilung. Änderungen an Datensätzen werden separat vorgenommen und mit einem neuen Lauf geprüft.</p>
      <div className="hub-actions"><button className="button" type="submit" disabled={disabled}>Prüfung dokumentieren</button><button className="button secondary" type="button" disabled={action.busy} onClick={() => void load()}>Aktuelle Prüfung vergleichen</button></div>
    </form>
    {message && <p role="status">{message}</p>}
    {server && <section className="quality-review-server" aria-label="Aktueller Befundstand"><h3>Serverstand · Befundrevision {server.revision}{server.stale ? " · Veraltet" : ""}</h3><p>{statuses[server.status]} · {memberName(server.assignee_id)}</p><blockquote>{server.comment || "Noch kein Prüfkommentar."}</blockquote><div className="hub-actions">
      <button className="button secondary" type="button" disabled={!canWrite || action.busy || server.stale} onClick={() => { draft.set(old => ({ ...old, revision: server.revision })); setServer(null); action.clear(); }}>Verglichen: Revision übernehmen, Eingaben behalten</button>
      <button className="button secondary" type="button" disabled={action.busy} onClick={() => { draft.reset({ revision: server.revision, status: server.status, assignee_id: server.assignee_id ?? "", comment: server.comment }); setServer(null); action.clear(); }}>Serverstand laden und Eingaben verwerfen</button>
    </div></section>}
    <h3>Prüfhistorie</h3><ErrorNotice error={history.error} />{history.isPending && <p role="status">Prüfhistorie wird geladen …</p>}
    {history.data && <><ol className="quality-history">{history.data.items.map(item => <li key={item.revision}><strong>Revision {item.revision} · {statuses[item.snapshot.status]}</strong><p>{formatDate(item.created_at)} · {memberName(item.actor_id)} · Zuständig: {memberName(item.snapshot.assignee_id)}</p><p>{item.snapshot.comment || "Hinweis durch Prüflauf angelegt."}</p></li>)}</ol><Pager offset={historyOffset} count={history.data.items.length} total={history.data.total} onChange={setHistoryOffset} /></>}
  </section>;
}
