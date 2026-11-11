import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, assetUrl } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { FireFlintBrand, UiIcon } from "../components/Brand";
import { CopyButton } from "../components/CopyButton";
import { Empty, ErrorNotice, Fields, PageTitle, Pager, useAction, useDraft, useHub, useHubQuery, type Field } from "./common";

interface HubForm {
  id: string;
  public_id: string;
  name: string;
  description: string;
  fields: Field[];
  published: boolean;
  revision: number;
  submission_count?: number;
}

interface FormDraft {
  name: string;
  description: string;
  fields: Field[];
  published: boolean;
  expected_revision: number;
}

interface Submission {
  id: string;
  form_revision: number;
  form_snapshot: { name: string; fields: Field[] };
  data: Record<string, unknown>;
  status: string;
  revision: number;
  created_at: string;
}

const fieldKinds = [
  ["text", "Kurzer Text"], ["multiline", "Langer Text"], ["email", "E-Mail"],
  ["url", "Webadresse"], ["number", "Zahl"], ["boolean", "Ja / Nein"],
  ["date", "Datum"], ["select", "Auswahl"],
];
const submissionStatuses: Record<string, string> = { new: "Neu", processing: "In Bearbeitung", closed: "Abgeschlossen" };
const newForm: FormDraft = {
  name: "", description: "", fields: [{ key: "name", label: "Name", kind: "text", required: true, options: [] }],
  published: false, expected_revision: 0,
};
const draftOf = (form: HubForm): FormDraft => ({
  name: form.name, description: form.description, fields: form.fields,
  published: form.published, expected_revision: form.revision,
});
const dateLabel = (value: string) => new Date(value).toLocaleString("de-DE");

async function findForm(base: string, id: string): Promise<HubForm> {
  for (let offset = 0; offset <= 100_000; offset += 100) {
    const rows = await api.get<HubForm[]>(`${base}/forms?offset=${offset}`);
    const found = rows.find((row) => row.id === id);
    if (found) return found;
    if (rows.length < 100) break;
  }
  throw new Error("Dieses Formular wurde nicht gefunden.");
}

export function FormsPage() {
  return <Routes>
    <Route index element={<FormList />} />
    <Route path="new" element={<FormEditor />} />
    <Route path=":id" element={<FormLoader />} />
    <Route path=":id/submissions" element={<SubmissionsPage />} />
  </Routes>;
}

function FormList() {
  const { canWrite } = useHub();
  const [offset, setOffset] = useState(0);
  const query = useHubQuery<HubForm[]>(`forms:${offset}`, `/forms?offset=${offset}`);
  return <>
    <PageTitle title="Formulare" description="Informationen strukturiert erfassen. Jede Einreichung bewahrt ihre Formularversion.">
      {canWrite && <Link className="button primary" to="/hub/forms/new">Formular erstellen</Link>}
    </PageTitle>
    <ErrorNotice error={query.error} onReload={() => { void query.refetch(); }} />
    {query.isPending && <p role="status">Formulare werden geladen…</p>}
    {query.data?.length === 0 && <Empty>Noch keine Formulare vorhanden. Erstelle ein Formular und gib den öffentlichen Link weiter.</Empty>}
    <div className="hub-card-grid">
      {query.data?.map((form) => <article className="panel hub-card" key={form.id}>
        <div className="hub-inline"><span className="badge">{form.published ? "Öffentlich erreichbar" : "Entwurf"}</span><span className="muted">Version {form.revision}</span></div>
        <h2><Link to={`/hub/forms/${form.id}`}>{form.name}</Link></h2>
        {form.description && <p>{form.description}</p>}
        <p className="muted">{form.fields.length} Felder · {form.submission_count ?? 0} Eingänge</p>
        <div className="hub-actions">
          <Link className="button" to={`/hub/forms/${form.id}`}>{canWrite ? "Bearbeiten" : "Ansehen"}</Link>
          <Link className="button" to={`/hub/forms/${form.id}/submissions`}>Eingänge ansehen</Link>
        </div>
      </article>)}
    </div>
    {query.data && <Pager offset={offset} count={query.data.length} onChange={setOffset} />}
  </>;
}

function FormLoader() {
  const { id = "" } = useParams();
  const { base, org } = useHub();
  const query = useQuery({ queryKey: ["hub", org, "form", id], queryFn: () => findForm(base, id) });
  if (!query.data) return <><ErrorNotice error={query.error} onReload={() => { void query.refetch(); }} />{query.isPending && <p role="status">Formular wird geladen…</p>}</>;
  return <FormEditor key={id} form={query.data} reload={async () => {
    const result = await query.refetch();
    if (result.error) throw result.error;
    return result.data!;
  }} />;
}

function FormEditor({ form, reload }: { form?: HubForm; reload?: () => Promise<HubForm> }) {
  const { base, canWrite, invalidate } = useHub();
  const navigate = useNavigate();
  const draft = useDraft<FormDraft>(`form:${form?.id ?? "new"}`, form ? draftOf(form) : newForm);
  const action = useAction();
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(false);
  const [previewData, setPreviewData] = useState<Record<string, unknown>>({});
  const value = draft.value;
  const locked = !canWrite || action.busy;
  const patch = (change: Partial<FormDraft>) => { draft.set((old) => ({ ...old, ...change })); setNotice(""); };
  const patchField = (index: number, change: Partial<Field>) => patch({ fields: value.fields.map((field, i) => i === index ? { ...field, ...change } : field) });
  const move = (index: number, direction: number) => {
    const fields = [...value.fields];
    [fields[index], fields[index + direction]] = [fields[index + direction], fields[index]];
    patch({ fields });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    const saved = await action.run(async () => {
      if (new Set(value.fields.map((field) => field.key)).size !== value.fields.length) throw new Error("Jede Feldkennung muss eindeutig sein.");
      return form ? api.put<HubForm>(`${base}/forms/${form.id}`, value) : api.post<HubForm>(`${base}/forms`, value);
    });
    if (!saved) return;
    draft.reset(draftOf(saved));
    setNotice(`Formularversion ${saved.revision} gespeichert.`);
    void invalidate();
    if (!form) { draft.clear(); navigate(`/hub/forms/${saved.id}`, { replace: true }); }
  };
  const reloadForm = async () => {
    if (!reload) return;
    const current = await action.run(reload);
    if (current) { draft.reset(draftOf(current)); setNotice("Aktueller gespeicherter Stand geladen."); }
  };
  const publicLink = form ? `${window.location.origin}/f/${form.public_id}` : "";
  return <>
    <Link className="hub-back" to="/hub/forms"><UiIcon name="back" />Alle Formulare</Link>
    <PageTitle title={form ? "Formular bearbeiten" : "Formular erstellen"} description="Felder gestalten, Vorschau prüfen und den öffentlichen Zugriff bewusst aktivieren.">
      {form && <Link className="button" to={`/hub/forms/${form.id}/submissions`}>Eingänge ansehen</Link>}
    </PageTitle>
    <ErrorNotice error={action.error} />
    {notice && <p className="hub-success" role="status">{notice}</p>}
    {form && <p className="hint">Geladene Version {value.expected_revision}{draft.dirty ? " · Ungespeicherte Änderungen bleiben beim Seitenwechsel erhalten." : ""}</p>}
    {form && form.revision !== value.expected_revision && <p className="hub-warning" role="status">Es liegt eine andere gespeicherte Version vor. Prüfe deine Änderungen vor dem erneuten Speichern.</p>}
    <form className="hub-stack" onSubmit={(event) => { void submit(event); }}>
      <section className="panel hub-stack">
        <h2>Formularbeschreibung</h2>
        <label>Name des Formulars<input value={value.name} required maxLength={240} disabled={locked} onChange={(event) => patch({ name: event.target.value })} /></label>
        <label>Beschreibung<textarea value={value.description} rows={3} maxLength={4000} disabled={locked} onChange={(event) => patch({ description: event.target.value })} /></label>
        <label className="hub-check"><input type="checkbox" checked={value.published} disabled={locked} onChange={(event) => patch({ published: event.target.checked })} />Öffentlichen Zugriff aktivieren</label>
        <p className="hint">Nach dem Speichern eines aktivierten Formulars sind Name, Beschreibung und Felder für alle mit dem Link sichtbar. Eingänge bleiben im Arbeitsbereich.</p>
        {form && <div className="hub-public-link">
          <label>Öffentlicher Formularlink<input readOnly value={publicLink} onFocus={(event) => event.target.select()} /></label>
          <div className="hub-actions"><CopyButton text={publicLink} label="Link kopieren" />{form.published && <a className="button" href={publicLink} target="_blank" rel="noreferrer">Formular öffnen<UiIcon name="external" size={16} /></a>}</div>
        </div>}
      </section>
      <section className="panel hub-stack" aria-labelledby="form-fields-heading">
        <div className="hub-section-heading"><h2 id="form-fields-heading">Formularfelder</h2><span className="muted">{value.fields.length} / 40</span></div>
        <p className="hint">Feldkennungen verbinden Antworten mit ihren Feldern. Verwende zum Beispiel „telefon“ oder „kundennummer“. Historische Eingänge behalten ihre ursprünglichen Bezeichnungen.</p>
        {value.fields.map((field, index) => <fieldset className="hub-field-builder" key={index} disabled={locked}>
          <legend>Feld {index + 1}{field.label ? `: ${field.label}` : ""}</legend>
          <div className="hub-form-grid">
            <label>Bezeichnung<input value={field.label} required maxLength={160} onChange={(event) => patchField(index, { label: event.target.value })} /></label>
            <label>Feldkennung<input value={field.key} required maxLength={64} pattern="[a-z][a-z0-9_]*" title="Kleinbuchstaben, Ziffern und Unterstriche; beginnt mit einem Kleinbuchstaben" onChange={(event) => patchField(index, { key: event.target.value })} /></label>
            <label>Feldtyp<select value={field.kind} onChange={(event) => patchField(index, { kind: event.target.value, options: event.target.value === "select" ? ["Option 1"] : [] })}>{fieldKinds.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
            <label className="hub-check"><input type="checkbox" checked={field.required} onChange={(event) => patchField(index, { required: event.target.checked })} />Pflichtfeld</label>
          </div>
          {field.kind === "boolean" && <p className="hint">„Ja“ und „Nein“ sind gültige Antworten. Ein Pflichtfeld verlangt eine Auswahl.</p>}
          {field.kind === "select" && <div className="hub-stack">
            {(field.options ?? []).map((option, optionIndex) => <div className="hub-inline" key={optionIndex}>
              <label>Option {optionIndex + 1}<input value={option} required maxLength={160} onChange={(event) => patchField(index, { options: field.options.map((item, i) => i === optionIndex ? event.target.value : item) })} /></label>
              <button type="button" disabled={field.options.length <= 1} onClick={() => patchField(index, { options: field.options.filter((_, i) => i !== optionIndex) })} aria-label={`Option ${optionIndex + 1} aus Feld ${index + 1} entfernen`}>Entfernen</button>
            </div>)}
            <button type="button" disabled={field.options.length >= 100} onClick={() => patchField(index, { options: [...field.options, `Option ${field.options.length + 1}`] })}>Option hinzufügen</button>
          </div>}
          <div className="hub-actions">
            <button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Feld ${index + 1} nach oben verschieben`}><UiIcon name="up" />Nach oben</button>
            <button type="button" disabled={index === value.fields.length - 1} onClick={() => move(index, 1)} aria-label={`Feld ${index + 1} nach unten verschieben`}><UiIcon name="down" />Nach unten</button>
            <button type="button" disabled={value.fields.length <= 1} onClick={() => patch({ fields: value.fields.filter((_, i) => i !== index) })}>Feld entfernen</button>
          </div>
        </fieldset>)}
        <button type="button" disabled={locked || value.fields.length >= 40} onClick={() => {
          let next = value.fields.length + 1;
          while (value.fields.some((field) => field.key === `feld_${next}`)) next++;
          patch({ fields: [...value.fields, { key: `feld_${next}`, label: "", kind: "text", required: false, options: [] }] });
        }}>Feld hinzufügen</button>
      </section>
      <div className="hub-actions">
        <button className="primary" type="submit" disabled={locked}>{action.busy ? "Wird gespeichert…" : "Formular speichern"}</button>
        <button type="button" onClick={() => setPreview(!preview)} aria-expanded={preview}>Vorschau {preview ? "schließen" : "anzeigen"}</button>
        {reload && <button type="button" disabled={action.busy} onClick={() => { void reloadForm(); }}>Eingaben verwerfen und neu laden</button>}
      </div>
    </form>
    {preview && <section className="panel hub-stack" aria-label="Formularvorschau">
      <p className="hub-eyebrow">Vorschau · Antworten werden nicht versendet</p>
      <h2>{value.name || "Unbenanntes Formular"}</h2><p>{value.description}</p>
      <Fields fields={value.fields} data={previewData} onChange={setPreviewData} disabled={!canWrite} prefix="form-preview" />
    </section>}
    {form && <FormHistory formId={form.id} />}
  </>;
}

function FormHistory({ formId }: { formId: string }) {
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const history = useHubQuery<{ revision: number; snapshot: HubForm; actor_id: string; created_at: string }[]>(`form-history:${formId}:${offset}`, `/forms/${formId}/history?offset=${offset}`, expanded);
  const members = useHubQuery<{ user_id: string; name: string; email: string }[]>("members", "/members", expanded);
  return <section className="panel hub-stack">
    <div className="hub-section-heading"><h2>Formularhistorie</h2><button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "Historie schließen" : "Versionen ansehen"}</button></div>
    {expanded && <>
      <ErrorNotice error={history.error} onReload={() => { void history.refetch(); }} />
      {history.isPending && <p role="status">Formularversionen werden geladen…</p>}
      {history.data?.length === 0 && <p className="muted">Keine Versionen auf dieser Seite vorhanden.</p>}
      {history.data?.map((version) => <details className="hub-note" key={version.revision}>
        <summary>Version {version.revision} · {dateLabel(version.created_at)} · {version.snapshot.published ? "Öffentlich erreichbar" : "Entwurf"}</summary>
        <p className="hint">Bearbeitet von {members.data?.find((member) => member.user_id === version.actor_id)?.name || "Teammitglied"}</p>
        <h3>{version.snapshot.name}</h3><p className="hub-preserve-lines">{version.snapshot.description}</p>
        <ol>{version.snapshot.fields.map((field) => <li key={field.key}><strong>{field.label}</strong> · {fieldKinds.find(([kind]) => kind === field.kind)?.[1] ?? field.kind}{field.required ? " · Pflichtfeld" : ""}<span className="hint"> · Kennung: {field.key}</span>{field.kind === "select" && <p>{field.options.join(" · ")}</p>}</li>)}</ol>
      </details>)}
      {history.data && <Pager offset={offset} count={history.data.length} onChange={setOffset} />}
    </>}
  </section>;
}

function SubmissionsPage() {
  const { id = "" } = useParams();
  const [offset, setOffset] = useState(0);
  const query = useHubQuery<Submission[]>(`submissions:${id}:${offset}`, `/forms/${id}/submissions?offset=${offset}`);
  return <>
    <Link className="hub-back" to={`/hub/forms/${id}`}><UiIcon name="back" />Zum Formular</Link>
    <PageTitle title="Formulareingänge" description="Antworten mit den Bezeichnungen zum Zeitpunkt der Einreichung. Der Bearbeitungsstand wird revisionsgeprüft gespeichert." />
    <ErrorNotice error={query.error} onReload={() => { void query.refetch(); }} />
    {query.isPending && <p role="status">Eingänge werden geladen…</p>}
    {query.data?.length === 0 && <Empty>Auf dieser Seite sind noch keine Eingänge vorhanden.</Empty>}
    <div className="hub-stack">{query.data?.map((submission) => <SubmissionCard key={submission.id} submission={submission} reload={async () => {
      const fresh = await query.refetch();
      if (fresh.error) throw fresh.error;
      const found = fresh.data?.find((row) => row.id === submission.id);
      if (!found) throw new Error("Dieser Eingang ist auf der aktuellen Seite nicht mehr vorhanden. Lade die Eingangsliste erneut.");
      return found;
    }} />)}</div>
    {query.data && <Pager offset={offset} count={query.data.length} onChange={setOffset} />}
  </>;
}

function Answers({ fields, data }: { fields: Field[]; data: Record<string, unknown> }) {
  return <dl className="hub-details">{fields.map((field) => <div key={field.key}>
    <dt>{field.label}</dt><dd>{data[field.key] === undefined || data[field.key] === null || data[field.key] === "" ? "—" : typeof data[field.key] === "boolean" ? data[field.key] ? "Ja" : "Nein" : String(data[field.key])}</dd>
  </div>)}</dl>;
}

function SubmissionCard({ submission, reload }: { submission: Submission; reload: () => Promise<Submission> }) {
  const { base, canWrite, invalidate } = useHub();
  const draft = useDraft(`submission:${submission.id}`, { status: submission.status, revision: submission.revision });
  const action = useAction();
  const [saved, setSaved] = useState(false);
  return <article className="panel hub-stack">
    <div className="hub-section-heading"><h2>{submission.form_snapshot.name}</h2><time dateTime={submission.created_at}>{dateLabel(submission.created_at)}</time></div>
    <p className="hint">Formularversion {submission.form_revision} · Eingang {submission.id}</p>
    <Answers fields={submission.form_snapshot.fields} data={submission.data} />
    <ErrorNotice error={action.error} />
    <form className="hub-inline" onSubmit={(event) => {
      event.preventDefault();
      if (!canWrite || action.busy) return;
      void action.run(() => api.put<Submission>(`${base}/submissions/${submission.id}`, { status: draft.value.status, expected_revision: draft.value.revision })).then((result) => {
        if (result) { draft.reset({ status: result.status, revision: result.revision }); setSaved(true); void invalidate(); }
      });
    }}>
      <label>Bearbeitungsstand<select value={draft.value.status} disabled={!canWrite || action.busy} onChange={(event) => { draft.set({ ...draft.value, status: event.target.value }); setSaved(false); }}>{Object.entries(submissionStatuses).map(([status, label]) => <option value={status} key={status}>{label}</option>)}</select></label>
      <button type="submit" disabled={!canWrite || action.busy || !draft.dirty}>Status speichern</button>
      <button type="button" disabled={action.busy} onClick={() => { void action.run(reload).then((result) => { if (result) { draft.reset({ status: result.status, revision: result.revision }); setSaved(false); } }); }}>Gespeicherten Status laden</button>
    </form>
    {saved && <p role="status">Bearbeitungsstand gespeichert.</p>}
  </article>;
}

interface PublicForm { id: string; name: string; description: string; fields: Field[]; revision: number }
interface PublicDraft {
  form: PublicForm;
  data: Record<string, unknown>;
  key: string;
  accepted?: string;
  previous?: { fields: Field[]; data: Record<string, unknown> };
}
// Public drafts contain no login state and stay in this tab's memory only.
const publicDrafts = new Map<string, PublicDraft>();

async function publicRequest<T>(id: string, payload?: unknown): Promise<T> {
  const response = await fetch(assetUrl(`/forms/${encodeURIComponent(id)}`), {
    method: payload ? "POST" : "GET", credentials: "omit",
    ...(payload ? { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : {}),
  });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new ApiError(response.status, body?.error || (response.status === 404 ? "Dieses Formular ist derzeit nicht öffentlich verfügbar." : "Das Formular konnte nicht geladen oder gesendet werden."));
  return body as T;
}

export function PublicFormPage() {
  const { publicId = "" } = useParams();
  const { user, loading } = useAuth();
  const scope = `${user?.id ?? "anonymous"}:${publicId}`;
  const query = useQuery({ queryKey: ["public-form", publicId], queryFn: () => publicRequest<PublicForm>(publicId), staleTime: Infinity, refetchOnWindowFocus: false, retry: false });
  return <main className="hub hub-public-page">
    <div className="hub-public-brand"><FireFlintBrand /></div>
    <ErrorNotice error={query.error} onReload={() => { void query.refetch(); }} />
    {query.isPending && <p role="status">Formular wird geladen…</p>}
    {query.data && !loading && <PublicFormEditor key={scope} scope={scope} publicId={publicId} initial={query.data} />}
  </main>;
}

function PublicFormEditor({ publicId, initial, scope }: { publicId: string; initial: PublicForm; scope: string }) {
  const [draft, setDraft] = useState<PublicDraft>(() => publicDrafts.get(scope) ?? { form: initial, data: {}, key: crypto.randomUUID() });
  const [latest, setLatest] = useState<PublicForm | null>(null);
  const action = useAction();
  const update = (next: PublicDraft) => { publicDrafts.set(scope, next); setDraft(next); };
  if (draft.accepted) return <section className="panel hub-stack" role="status">
    <h1>Vielen Dank für deine Antwort.</h1><p>Deine Angaben zu „{draft.form.name}“ sind eingegangen.</p>
    <p className="hint">Eingangsnummer: {draft.accepted}</p>
    <button type="button" onClick={() => { update({ form: draft.form, data: {}, key: crypto.randomUUID() }); action.clear(); }}>Weitere Antwort senden</button>
  </section>;
  return <section className="panel hub-stack">
    <p className="hub-eyebrow">Formular · Version {draft.form.revision}</p>
    <h1>{draft.form.name}</h1>
    {draft.form.description && <p className="hub-preserve-lines">{draft.form.description}</p>}
    <p className="hint">Mit * markierte Felder sind erforderlich.</p>
    <ErrorNotice error={action.error} />
    {Boolean(action.error) && <button type="button" disabled={action.busy} onClick={() => { void action.run(() => publicRequest<PublicForm>(publicId)).then((result) => { if (result) setLatest(result); }); }}>Aktuelle Formularversion prüfen</button>}
    {latest && <aside className="hub-warning hub-stack" aria-label="Aktuelle Formularversion prüfen">
      <h2>{latest.revision === draft.form.revision ? "Die Formularversion ist unverändert" : `Neue Formularversion ${latest.revision}`}</h2>
      <p>{latest.name}</p><p>{latest.description}</p>
      <ul>{latest.fields.map((field) => <li key={field.key}>{field.label}{field.required ? " (Pflichtfeld)" : ""}</li>)}</ul>
      {latest.revision !== draft.form.revision && <><p>Prüfe die geänderten Felder. Passende Antworten werden übernommen; deine bisherigen Angaben bleiben darunter lesbar.</p>
        <button type="button" onClick={() => {
          const data: Record<string, unknown> = {};
          for (const field of latest.fields) {
            const old = draft.form.fields.find((item) => item.key === field.key && item.kind === field.kind);
            const value = draft.data[field.key];
            if (old && value !== undefined && (field.kind !== "select" || field.options.includes(String(value)))) data[field.key] = value;
          }
          update({ form: latest, data, key: crypto.randomUUID(), previous: { fields: draft.form.fields, data: draft.data } });
          setLatest(null); action.clear();
        }}>Geprüfte Formularversion übernehmen</button></>}
    </aside>}
    <form className="hub-stack" onSubmit={(event) => {
      event.preventDefault();
      if (action.busy) return;
      publicDrafts.set(scope, draft);
      void action.run(() => publicRequest<{ id: string; accepted: boolean }>(publicId, { expected_revision: draft.form.revision, submission_key: draft.key, data: draft.data, website: "" })).then((result) => {
        if (result?.accepted) update({ ...draft, accepted: result.id });
      });
    }}>
      <Fields fields={draft.form.fields} data={draft.data} onChange={(data) => update({ ...draft, data, key: crypto.randomUUID() })} disabled={action.busy} prefix="public-form" />
      <button className="primary" type="submit" disabled={action.busy}>{action.busy ? "Wird gesendet…" : "Antwort senden"}</button>
      <p className="hint">Deine Antwort wird an das Unternehmen übermittelt, das dieses Formular bereitstellt.</p>
    </form>
    {draft.previous && <details><summary>Bisherige Angaben vor dem Versionswechsel</summary><Answers fields={draft.previous.fields} data={draft.previous.data} /></details>}
  </section>;
}
