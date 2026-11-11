import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { UiIcon } from "../components/Brand";
import { Empty, ErrorNotice, PageTitle, Pager, RecordPicker, formatDate, useAction, useDraft, useHub, useHubQuery, type HubRecord } from "./common";

interface Member { user_id: string; name: string; email: string; role: string }
interface HubTask {
  id: string;
  title: string;
  description: string;
  assignee_id: string;
  assignee_name: string;
  created_by: string;
  record_id: string | null;
  record_name: string | null;
  subject_revision: number | null;
  requires_approval: boolean;
  due_at: string | null;
  status: string;
  revision: number;
  stale: boolean;
  created_at: string;
}
interface TaskDraft {
  title: string;
  description: string;
  assignee_id: string;
  record: HubRecord | null;
  requires_approval: boolean;
  due_at: string;
}
interface Comment { id: string; actor_name: string; body: string; created_at: string }
interface Notification { id: string; title: string; task_id: string | null; read_at: string | null; created_at: string }
const statuses: Record<string, string> = { open: "Offen", done: "Erledigt", approved: "Freigegeben", rejected: "Abgelehnt" };
const emptyTask: TaskDraft = { title: "", description: "", assignee_id: "", record: null, requires_approval: false, due_at: "" };

async function findTask(base: string, id: string): Promise<HubTask> {
  for (let offset = 0; offset <= 100_000; offset += 100) {
    const rows = await api.get<HubTask[]>(`${base}/tasks?offset=${offset}`);
    const found = rows.find((row) => row.id === id);
    if (found) return found;
    if (rows.length < 100) break;
  }
  throw new Error("Diese Aufgabe wurde nicht gefunden.");
}

export function WorkPage() {
  return <Routes>
    <Route index element={<TaskList />} />
    <Route path="new" element={<TaskEditor />} />
    <Route path=":id" element={<TaskLoader />} />
  </Routes>;
}

function TaskList() {
  const { canWrite, user } = useHub();
  const [offset, setOffset] = useState(0);
  const [mine, setMine] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const query = useHubQuery<HubTask[]>(`tasks:${offset}`, `/tasks?offset=${offset}`);
  const shown = query.data?.filter((task) => (!mine || task.assignee_id === user?.id) && (!openOnly || task.status === "open"));
  return <>
    <PageTitle title="Aufgaben & Freigaben" description="Zuständigkeiten klären, Rückfragen festhalten und einen bestimmten Datensatzstand prüfen.">
      {canWrite && <Link className="button primary" to="/hub/work/new">Aufgabe erstellen</Link>}
    </PageTitle>
    <div className="panel hub-inline">
      <label className="hub-check"><input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />Mir zugewiesen</label>
      <label className="hub-check"><input type="checkbox" checked={openOnly} onChange={(event) => setOpenOnly(event.target.checked)} />Nur offene Aufgaben</label>
      <span className="hint">Filter beziehen sich auf die angezeigte Ergebnisseite.</span>
    </div>
    <ErrorNotice error={query.error} onReload={() => { void query.refetch(); }} />
    {query.isPending && <p role="status">Aufgaben werden geladen…</p>}
    {shown?.length === 0 && <Empty>Auf dieser Seite gibt es keine passenden Aufgaben.</Empty>}
    <div className="hub-stack">{shown?.map((task) => <article className="panel hub-task-row" key={task.id}>
      <div className="hub-stack">
        <div className="hub-inline"><span className="badge">{statuses[task.status] ?? task.status}</span>{task.requires_approval && <span className="badge">Freigabe</span>}{task.stale && <span className="badge">Datensatz inzwischen geändert</span>}</div>
        <h2><Link to={`/hub/work/${task.id}`}>{task.title}</Link></h2>
        <p className="muted">Zuständig: {task.assignee_name || "Unbenannte Person"}{task.record_name ? ` · ${task.record_name}` : ""}</p>
      </div>
      <div className="hub-stack">
        {task.due_at && <p className={task.status === "open" && new Date(task.due_at).getTime() < Date.now() ? "hub-warning" : "muted"}>Fällig: <time dateTime={task.due_at}>{formatDate(task.due_at)}</time></p>}
        <Link className="button" to={`/hub/work/${task.id}`}>Aufgabe öffnen</Link>
      </div>
    </article>)}</div>
    {query.data && <Pager offset={offset} count={query.data.length} onChange={setOffset} />}
  </>;
}

function TaskEditor() {
  const { base, user, canWrite, invalidate, contracts } = useHub();
  const navigate = useNavigate();
  const draft = useDraft<TaskDraft>("task:new", emptyTask);
  const action = useAction();
  const [search] = useSearchParams();
  const [initialRecord] = useState(() => !draft.dirty && !draft.value.record ? search.get("record") ?? "" : "");
  const initialRecordApplied = useRef(false);
  const preselection = useHubQuery<HubRecord>(`task-preselection:${initialRecord}`, `/records/${initialRecord}`, !!initialRecord);
  useEffect(() => {
    if (preselection.data && !initialRecordApplied.current) {
      initialRecordApplied.current = true;
      draft.set((old) => ({ ...old, record: preselection.data! }));
    }
  }, [preselection.data]);
  const members = useHubQuery<Member[]>("members", "/members");
  const value = draft.value;
  const locked = !canWrite || action.busy || (!!initialRecord && preselection.isPending);
  const eligible = members.data?.filter((member) => ["owner", "editor"].includes(member.role) && (!value.requires_approval || (member.user_id !== user?.id && member.user_id !== value.record?.updated_by)));
  const selectedEligible = eligible?.some((member) => member.user_id === value.assignee_id);
  const patch = (change: Partial<TaskDraft>) => draft.set((old) => ({ ...old, ...change }));
  const chooseRecord = async (id: string) => {
    initialRecordApplied.current = true;
    if (!id) { patch({ record: null }); return; }
    const record = await action.run(() => api.get<HubRecord>(`${base}/records/${id}`));
    if (record) patch({ record });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    const result = await action.run(async () => {
      if (!selectedEligible) throw new Error("Bitte wähle eine berechtigte zuständige Person.");
      if (value.requires_approval && !value.record) throw new Error("Eine Freigabe benötigt einen Datensatz.");
      if (value.record?.archived) throw new Error("Der gewählte Datensatz ist archiviert. Wähle einen aktiven Datensatz.");
      const dueAt = value.due_at ? new Date(value.due_at) : null;
      if (dueAt && Number.isNaN(dueAt.getTime())) throw new Error("Bitte gib einen gültigen Fälligkeitstermin ein.");
      return api.post<HubTask>(`${base}/tasks`, {
        title: value.title, description: value.description, assignee_id: value.assignee_id,
        record_id: value.record?.id ?? null, subject_revision: value.record?.revision ?? null,
        requires_approval: value.requires_approval, due_at: dueAt?.toISOString() ?? null,
      });
    });
    if (result) { draft.clear(); void invalidate(); navigate(`/hub/work/${result.id}`, { replace: true }); }
  };
  return <>
    <Link className="hub-back" to="/hub/work"><UiIcon name="back" />Alle Aufgaben</Link>
    <PageTitle title="Aufgabe erstellen" description="Eine Freigabe bezieht sich auf die hier geladene Datensatzrevision und benötigt eine zweite Person." />
    <ErrorNotice error={action.error} />
    <ErrorNotice error={members.error} onReload={() => { void members.refetch(); }} />
    <ErrorNotice error={preselection.error} onReload={() => { void preselection.refetch(); }} />
    <form className="panel hub-stack" onSubmit={(event) => { void submit(event); }}>
      <label>Titel<input value={value.title} required maxLength={240} disabled={locked} onChange={(event) => patch({ title: event.target.value })} /></label>
      <label>Beschreibung<textarea value={value.description} maxLength={16384} rows={5} disabled={locked} onChange={(event) => patch({ description: event.target.value })} /></label>
      <label className="hub-check"><input type="checkbox" checked={value.requires_approval} disabled={locked} onChange={(event) => patch({ requires_approval: event.target.checked })} />Freigabe durch eine zweite Person anfordern</label>
      {value.requires_approval && <p className="hint">Die prüfende Person darf weder diese Aufgabe erstellen noch den letzten Datensatzstand selbst bearbeitet haben. Diese Entscheidung veröffentlicht keine Website-Inhalte.</p>}
      <RecordPicker value={value.record?.id ?? ""} label={value.requires_approval ? "Zu prüfender Datensatz" : "Verknüpfter Datensatz (optional)"} onChange={(id) => { void chooseRecord(id); }} disabled={locked} />
      {value.record && <aside className="hub-stack hub-note">
        <p><Link to={`/hub/records/${value.record.kind}/${value.record.id}`}>{value.record.name}</Link> · Geladene Revision {value.record.revision}</p>
        <p className="hint">Dieser Stand wird an die Aufgabe gebunden. Wenn der Datensatz geändert wurde, prüfe ihn vor dem erneuten Erstellen.</p>
        <details><summary>Geladenen Datensatzstand ansehen</summary><dl className="hub-details">{Object.entries(value.record.data).map(([key, data]) => <div key={key}><dt>{contracts.data?.kinds.find((kind) => kind.key === value.record?.kind)?.fields.find((field) => field.key === key)?.label ?? key}</dt><dd>{data === true ? "Ja" : data === false ? "Nein" : String(data ?? "—")}</dd></div>)}</dl></details>
        <button type="button" disabled={locked} onClick={() => { if (value.record) void chooseRecord(value.record.id); }}>Aktuellen Datensatzstand neu laden</button>
      </aside>}
      <div className="hub-form-grid">
        <label>Zuständige Person<select required value={value.assignee_id} disabled={locked || members.isPending} onChange={(event) => patch({ assignee_id: event.target.value })}>
          <option value="">Bitte wählen</option>
          {value.assignee_id && !selectedEligible && <option value={value.assignee_id} disabled>Auswahl für diese Aufgabe nicht berechtigt</option>}
          {eligible?.map((member) => <option key={member.user_id} value={member.user_id}>{member.name || member.email}{member.user_id === user?.id ? " (ich)" : ""}</option>)}
        </select></label>
        <label>Fällig am (optional)<input type="datetime-local" value={value.due_at} disabled={locked} onChange={(event) => patch({ due_at: event.target.value })} /></label>
      </div>
      <p className="hint">Zeitzone für den Termin: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
      {members.isPending && <p role="status">Team wird geladen…</p>}
      {eligible?.length === 0 && <p className="hub-warning">Es gibt derzeit keine geeignete zuständige Person. Für eine Freigabe braucht der Arbeitsbereich eine zweite Person mit Schreibrechten.</p>}
      {draft.dirty && <p className="hint">Dein Entwurf bleibt beim Seitenwechsel erhalten.</p>}
      <div className="hub-actions"><button className="primary" type="submit" disabled={locked || !selectedEligible || (value.requires_approval && !value.record)}>{action.busy ? "Wird verarbeitet…" : "Aufgabe erstellen"}</button><Link className="button" to="/hub/work">Zur Aufgabenliste</Link></div>
    </form>
  </>;
}

function TaskLoader() {
  const { id = "" } = useParams();
  const { base, org } = useHub();
  const query = useQuery({ queryKey: ["hub", org, "task", id], queryFn: () => findTask(base, id) });
  if (!query.data) return <><ErrorNotice error={query.error} onReload={() => { void query.refetch(); }} />{query.isPending && <p role="status">Aufgabe wird geladen…</p>}</>;
  return <TaskDetail key={id} task={query.data} reload={async () => {
    const result = await query.refetch();
    if (result.error) throw result.error;
    return result.data!;
  }} />;
}

function TaskDetail({ task, reload }: { task: HubTask; reload: () => Promise<HubTask> }) {
  const { base, canWrite, user, invalidate, contracts } = useHub();
  // Decisions always use the task version actually shown, including after route changes.
  const draft = useDraft<HubTask>(`task:${task.id}:decision`, task);
  const value = draft.value;
  const action = useAction();
  const [notice, setNotice] = useState("");
  const recordQuery = useHubQuery<HubRecord>(`task-record:${value.record_id}`, `/records/${value.record_id ?? ""}`, !!value.record_id);
  const record = recordQuery.data;
  const stale = value.stale || task.stale || (!!record && record.revision !== value.subject_revision);
  const selfReview = value.requires_approval && (value.created_by === user?.id || record?.updated_by === user?.id);
  const canDecide = canWrite && value.assignee_id === user?.id && value.status === "open" && !action.busy && (!value.requires_approval || (!stale && !selfReview && !!record && !record.archived));
  const decide = async (status: string) => {
    if (!canDecide) return;
    const result = await action.run(() => api.post<HubTask>(`${base}/tasks/${value.id}/decision`, { status, expected_revision: value.revision }));
    if (result) {
      draft.reset({ ...value, ...result });
      setNotice(`Aufgabe ${statuses[result.status]?.toLocaleLowerCase("de-DE") ?? "entschieden"}.`);
      void invalidate();
    }
  };
  return <>
    <Link className="hub-back" to="/hub/work"><UiIcon name="back" />Alle Aufgaben</Link>
    <PageTitle title={value.title} description={value.requires_approval ? "Freigabe eines bestimmten Datensatzstands durch eine zweite Person." : "Aufgabe mit Zuständigkeit und gemeinsamem Verlauf."} />
    <section className="panel hub-stack">
      <div className="hub-inline"><span className="badge">{statuses[value.status] ?? value.status}</span><span className="muted">Aufgabenrevision {value.revision}</span></div>
      {value.description && <p className="hub-preserve-lines">{value.description}</p>}
      <dl className="hub-details">
        <div><dt>Zuständig</dt><dd>{value.assignee_name || "Unbenannte Person"}{value.assignee_id === user?.id ? " (ich)" : ""}</dd></div>
        <div><dt>Erstellt</dt><dd>{formatDate(value.created_at)}</dd></div>
        <div><dt>Fälligkeit</dt><dd>{value.due_at ? formatDate(value.due_at) : "Kein Termin"}</dd></div>
        {value.record_id && <div><dt>Gebundener Datensatzstand</dt><dd>{value.record_name ?? value.record_id} · Revision {value.subject_revision}</dd></div>}
      </dl>
      {stale && <div className="hub-warning" role="status"><strong>Der Datensatz wurde inzwischen geändert.</strong><p>{value.requires_approval ? "Diese Freigabe gilt für einen früheren Stand und kann nicht mehr entschieden werden. Erstelle nach der Prüfung eine neue Freigabeaufgabe für den aktuellen Stand." : "Diese Aufgabe verweist auf einen früheren Stand. Prüfe die Änderungen vor dem Abschluss."}</p>{canWrite && value.requires_approval && <Link className="button" to="/hub/work/new">Neue Freigabeaufgabe erstellen</Link>}</div>}
      {value.record_id && <>
        <ErrorNotice error={recordQuery.error} onReload={() => { void recordQuery.refetch(); }} />
        {recordQuery.isPending && <p role="status">Verknüpfter Datensatz wird geladen…</p>}
        {record && <details className="hub-note"><summary>Aktuellen Datensatz prüfen · Revision {record.revision}</summary>
          <p><Link to={`/hub/records/${record.kind}/${record.id}`}>{record.name} öffnen</Link>{record.archived ? " · Archiviert" : ""}</p>
          <dl className="hub-details">{Object.entries(record.data).map(([key, data]) => <div key={key}><dt>{contracts.data?.kinds.find((kind) => kind.key === record.kind)?.fields.find((field) => field.key === key)?.label ?? key}</dt><dd>{data === true ? "Ja" : data === false ? "Nein" : String(data ?? "—")}</dd></div>)}</dl>
        </details>}
      </>}
      <ErrorNotice error={action.error} />
      {notice && <p className="hub-success" role="status">{notice}</p>}
      {task.revision !== value.revision && <p className="hint">Der gespeicherte Aufgabenstand hat sich geändert. Lade ihn ausdrücklich neu, um die aktuelle Entscheidung zu sehen.</p>}
      {value.status === "open" && value.assignee_id !== user?.id && <p className="hint">Nur die zuständige Person kann diese Aufgabe abschließen.</p>}
      {value.status === "open" && selfReview && <p className="hint">Du kannst einen von dir erstellten oder zuletzt bearbeiteten Stand nicht selbst freigeben.</p>}
      {value.requires_approval && <p className="hint">Die Freigabe dokumentiert die Prüfung im Hub. Website-Inhalte werden dadurch nicht veröffentlicht.</p>}
      <div className="hub-actions">
        {value.status === "open" && (value.requires_approval ? <>
          <button className="primary" type="button" disabled={!canDecide} onClick={() => { void decide("approved"); }}>Stand freigeben</button>
          <button type="button" disabled={!canDecide} onClick={() => { void decide("rejected"); }}>Stand ablehnen</button>
        </> : <button className="primary" type="button" disabled={!canDecide} onClick={() => { void decide("done"); }}>Als erledigt markieren</button>)}
        <button type="button" disabled={action.busy} onClick={() => { void action.run(reload).then((current) => { if (current) { draft.reset(current); setNotice("Aktueller Aufgabenstand geladen."); void recordQuery.refetch(); } }); }}>Aufgabenstand neu laden</button>
      </div>
    </section>
    <TaskComments taskId={value.id} />
  </>;
}

function TaskComments({ taskId }: { taskId: string }) {
  const { base, canWrite, invalidate } = useHub();
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState("");
  const comments = useHubQuery<Comment[]>(`comments:${taskId}:${offset}`, `/tasks/${taskId}/comments?offset=${offset}`);
  const draft = useDraft(`comment:${taskId}`, { body: "" });
  const action = useAction();
  return <section className="panel hub-stack" aria-labelledby="task-comments-heading">
    <h2 id="task-comments-heading">Kommentare</h2>
    <ErrorNotice error={comments.error} onReload={() => { void comments.refetch(); }} />
    {comments.isPending && <p role="status">Kommentare werden geladen…</p>}
    {comments.data?.length === 0 && <p className="muted">Noch keine Kommentare auf dieser Seite.</p>}
    <ol className="hub-timeline">{comments.data?.map((comment) => <li key={comment.id}>
      <div className="hub-inline"><strong>{comment.actor_name || "Teammitglied"}</strong><time className="muted" dateTime={comment.created_at}>{formatDate(comment.created_at)}</time></div>
      <p className="hub-preserve-lines">{comment.body}</p>
    </li>)}</ol>
    {comments.data && <Pager offset={offset} count={comments.data.length} pageSize={200} onChange={setOffset} />}
    <ErrorNotice error={action.error} />
    <form className="hub-stack" onSubmit={(event) => {
      event.preventDefault();
      if (!canWrite || action.busy || !draft.value.body.trim()) return;
      void action.run(() => api.post<Comment>(`${base}/tasks/${taskId}/comments`, { body: draft.value.body })).then((result) => {
        if (result) { draft.reset({ body: "" }); setNotice("Kommentar hinzugefügt."); void invalidate(); }
      });
    }}>
      <label>Kommentar hinzufügen<textarea value={draft.value.body} required maxLength={8000} rows={3} disabled={!canWrite || action.busy} onChange={(event) => { draft.set({ body: event.target.value }); setNotice(""); }} /></label>
      <button type="submit" disabled={!canWrite || action.busy || !draft.value.body.trim()}>{action.busy ? "Wird gesendet…" : "Kommentar senden"}</button>
    </form>
    {notice && <p role="status">{notice}</p>}
  </section>;
}

export function NotificationsPage() {
  const { base, canWrite, invalidate, modules } = useHub();
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState("");
  const query = useHubQuery<Notification[]>(`notifications:${offset}`, `/notifications?offset=${offset}`);
  const action = useAction();
  const workEnabled = modules.data?.some((module) => module.key === "work" && module.enabled);
  return <>
    <PageTitle title="Benachrichtigungen" description="Deine persönlichen Hinweise zu neuen Aufgaben und Entscheidungen in diesem Arbeitsbereich." />
    <ErrorNotice error={query.error} onReload={() => { void query.refetch(); }} />
    <ErrorNotice error={action.error} />
    {notice && <p role="status">{notice}</p>}
    {query.isPending && <p role="status">Benachrichtigungen werden geladen…</p>}
    {query.data?.length === 0 && <Empty>Auf dieser Seite gibt es keine Benachrichtigungen.</Empty>}
    <ul className="hub-notifications hub-stack">{query.data?.map((notification) => <li className="panel hub-task-row" key={notification.id}>
      <div className="hub-stack"><span className="badge">{notification.read_at ? "Gelesen" : "Ungelesen"}</span><h2>{notification.title}</h2><time className="muted" dateTime={notification.created_at}>{formatDate(notification.created_at)}</time></div>
      <div className="hub-actions">
        {notification.task_id && workEnabled && <Link className="button" to={`/hub/work/${notification.task_id}`}>Aufgabe öffnen</Link>}
        {!notification.read_at && <button type="button" disabled={!canWrite || action.busy} onClick={() => {
          void action.run(async () => { await api.post(`${base}/notifications/${notification.id}/read`); return true; }).then((result) => {
            if (result) { setNotice("Benachrichtigung als gelesen markiert."); void invalidate(); }
          });
        }}>Als gelesen markieren</button>}
      </div>
    </li>)}</ul>
    {query.data && <Pager offset={offset} count={query.data.length} onChange={setOffset} />}
  </>;
}
