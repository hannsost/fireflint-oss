import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import {
  Empty, ErrorNotice, Fields, PageTitle, Pager, RecordPicker,
  useAction, useDraft, useHub, type Field, type HubRecord,
} from "./common";

type Translation = {
  locale: string;
  data: Record<string, unknown>;
  revision: number;
  source_revision: number;
  stale: boolean;
};
type TranslationSnapshot = { record: HubRecord; translations: Translation[] };
type TranslationDraft = {
  data: Record<string, unknown>;
  sourceData: Record<string, unknown>;
  revision: number;
  sourceRevision: number;
  previousSourceRevision: number | null;
};
type Medium = {
  asset_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  title: string;
  alt_text: string;
  credit: string;
  license: string;
  collection: string;
  revision: number;
  record_ids: string[];
};
type MediaDraft = Pick<Medium, "title" | "alt_text" | "credit" | "license" | "collection" | "revision" | "record_ids">;
type Booking = {
  id: string;
  resource_id: string;
  resource_name: string;
  timezone: string;
  title: string;
  starts_at: string;
  ends_at: string;
  status: "confirmed" | "cancelled";
  revision: number;
};
type BookingDraft = {
  resource_id: string;
  title: string;
  start: string;
  end: string;
  originalStart?: string;
  originalEnd?: string;
  cancelled: boolean;
  revision: number;
};

const PAGE_SIZE = 100;
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function localInput(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localToIso(value: string, original?: string) {
  // Preserve the exact instant of existing bookings in the repeated autumn hour.
  if (original && localInput(original) === value) return original;
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()) || localInput(date) !== value) {
    throw new Error("Bitte einen gültigen Zeitpunkt eingeben. Bei der Zeitumstellung existieren manche Uhrzeiten nicht.");
  }
  return date.toISOString();
}

function dateTime(value: string, zone = browserZone) {
  try {
    return new Intl.DateTimeFormat("de-DE", {
      dateStyle: "medium", timeStyle: "short", timeZone: zone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function timeWithOffset(value: string, zone: string) {
  try {
    return new Intl.DateTimeFormat("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
      timeZone: zone, timeZoneName: "shortOffset",
    }).format(new Date(value));
  } catch {
    return "Zeitpunkt noch nicht vollständig";
  }
}

async function allPages<T>(path: string, identity: (value: T) => string) {
  const items: T[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset <= 100_000; offset += PAGE_SIZE) {
    const page = await api.get<T[]>(`${path}${path.includes("?") ? "&" : "?"}offset=${offset}`);
    if (page.some((item) => seen.has(identity(item)))) {
      throw new Error("Die Liste hat sich während des Ladens verändert. Bitte erneut laden, damit alle Einträge vollständig angezeigt werden.");
    }
    page.forEach((item) => seen.add(identity(item)));
    items.push(...page);
    if (page.length < PAGE_SIZE) return items;
  }
  throw new Error("Die Liste ist zu groß, um sie vollständig anzuzeigen.");
}

function Unsaved({ dirty }: { dirty: boolean }) {
  return dirty ? <p className="hub-draft-note" role="status">Ungespeicherter Entwurf · Ihre Eingaben bleiben beim Wechsel innerhalb des Hubs erhalten.</p> : null;
}

function ReadOnly() {
  const { canWrite } = useHub();
  return canWrite ? null : <p className="hint">Lesezugriff: Sie können die Angaben ansehen. Änderungen sind für Ihre Rolle gesperrt.</p>;
}

function snapshotTranslation(snapshot: TranslationSnapshot, locale: string): TranslationDraft {
  const translation = snapshot.translations.find((item) => item.locale === locale);
  return {
    data: translation?.data ?? {},
    sourceData: snapshot.record.data,
    revision: translation?.revision ?? 0,
    sourceRevision: snapshot.record.revision,
    previousSourceRevision: translation?.source_revision ?? null,
  };
}

export function TranslationsPage() {
  const { org, base, contracts } = useHub();
  const [params, setParams] = useSearchParams();
  const selection = useDraft("translation-selection", {
    recordId: params.get("record") ?? "",
    locale: params.get("locale") ?? "en",
    localeInput: params.get("locale") ?? "en",
  });
  const recordId = params.get("record") ?? selection.value.recordId;
  const locale = (params.get("locale") ?? selection.value.locale).trim().toLowerCase();
  const [localeError, setLocaleError] = useState("");
  const query = useQuery({
    queryKey: ["hub", org, "translation-record", recordId],
    enabled: !!recordId,
    queryFn: async (): Promise<TranslationSnapshot> => {
      const [record, translations] = await Promise.all([
        api.get<HubRecord>(`${base}/records/${recordId}`),
        allPages<Translation>(`${base}/records/${recordId}/translations`, (translation) => translation.locale),
      ]);
      return { record, translations };
    },
  });
  const fields = contracts.data?.kinds.find((kind) => kind.key === query.data?.record.kind)?.fields
    .filter((field) => field.kind === "text" || field.kind === "multiline")
    .map((field): Field => ({ ...field, required: false })) ?? [];

  function selectRecord(id: string) {
    selection.set((old) => ({ ...old, recordId: id }));
    setParams(id ? { record: id, locale } : {});
  }
  function selectLocale(next: string) {
    const normalized = next.trim().toLowerCase();
    if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(normalized) || normalized.length > 35) {
      setLocaleError("Bitte eine Sprachkennung wie en, fr oder en-gb eingeben.");
      return;
    }
    setLocaleError("");
    selection.set((old) => ({ ...old, locale: normalized, localeInput: normalized }));
    if (recordId) setParams({ record: recordId, locale: normalized });
  }

  return <>
    <PageTitle title="Übersetzungen" description="Texte gemeinsam pflegen und jederzeit erkennen, auf welchem Original eine Übersetzung beruht." />
    <ReadOnly />
    <section className="panel" aria-label="Übersetzung auswählen">
      <div className="hub-grid">
        <RecordPicker value={recordId} onChange={selectRecord} label="Datensatz für die Übersetzung" />
        <form onSubmit={(event) => { event.preventDefault(); selectLocale(selection.value.localeInput); }}>
          <label className="hub-field">Zielsprache
            <input value={selection.value.localeInput} maxLength={35} placeholder="z. B. en-gb"
              aria-describedby="translation-locale-hint" onChange={(event) => selection.set((old) => ({ ...old, localeInput: event.target.value }))} />
          </label>
          <p id="translation-locale-hint" className="hint">Sprachkennung, zum Beispiel en für Englisch oder fr für Französisch.</p>
          <button type="submit" className="button">Sprache öffnen</button>
          {localeError && <p role="alert">{localeError}</p>}
        </form>
      </div>
      {!!query.data?.translations.length && <div className="hub-actions" aria-label="Vorhandene Übersetzungen">
        {query.data.translations.map((translation) => <button key={translation.locale} type="button"
          className="button secondary" aria-pressed={translation.locale === locale} onClick={() => selectLocale(translation.locale)}>
          {translation.locale.toUpperCase()}{translation.stale ? " · Original geändert" : ""}
        </button>)}
      </div>}
    </section>
    {!recordId && <Empty>Wählen Sie einen Datensatz und eine Sprache. Das Original erscheint anschließend neben den übersetzbaren Feldern.</Empty>}
    {recordId && query.isPending && <p role="status">Original und Übersetzungen werden geladen …</p>}
    <ErrorNotice error={query.error || contracts.error} onReload={() => { void query.refetch(); }} />
    {query.data && contracts.data && <TranslationEditor key={`${org}:${recordId}:${locale}`}
      locale={locale} snapshot={query.data} fields={fields}
      reload={async () => {
        const result = await query.refetch();
        if (result.error) throw result.error;
        if (!result.data) throw new Error("Der Datensatz konnte nicht geladen werden.");
        return result.data;
      }} />}
  </>;
}

function TranslationEditor({ locale, snapshot, fields, reload }: {
  locale: string; snapshot: TranslationSnapshot; fields: Field[]; reload: () => Promise<TranslationSnapshot>;
}) {
  const { base, canWrite, invalidate } = useHub();
  const draft = useDraft<TranslationDraft>(`translation:${snapshot.record.id}:${locale}`, snapshotTranslation(snapshot, locale));
  const action = useAction();
  const [review, setReview] = useState<TranslationSnapshot | null>(null);
  const [message, setMessage] = useState("");
  const value = draft.value;
  const remote = snapshot.translations.find((item) => item.locale === locale);
  const remoteChanged = snapshot.record.revision !== value.sourceRevision || (remote?.revision ?? 0) !== value.revision;
  const stale = value.previousSourceRevision !== null && value.previousSourceRevision !== value.sourceRevision;
  const disabled = !canWrite || action.busy || snapshot.record.archived;

  async function loadForReview() {
    const fresh = await action.run(reload);
    if (fresh) { setReview(fresh); setMessage(""); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    setMessage("");
    const result = await action.run(() => api.post<Translation>(`${base}/records/${snapshot.record.id}/translations`, {
      locale, data: value.data, source_revision: value.sourceRevision, expected_revision: value.revision,
    }));
    if (result) {
      draft.reset({ ...value, data: result.data, revision: result.revision, previousSourceRevision: result.source_revision });
      setReview(null);
      setMessage("Übersetzung gespeichert.");
      await invalidate();
    }
  }

  return <section className="panel hub-detail" aria-label={`Übersetzung ${locale}`}>
    <div className="hub-actions"><h2>{snapshot.record.name} · {locale.toUpperCase()}</h2>
      <Link to={`/hub/records/${snapshot.record.kind}/${snapshot.record.id}`}>Original öffnen</Link>
    </div>
    <p className="hub-revision">Geprüftes Original: Revision {value.sourceRevision} · Übersetzung: {value.revision ? `Revision ${value.revision}` : "noch nicht gespeichert"}</p>
    {stale && <p className="hint" role="status">Original geändert: Diese Übersetzung stammt aus Quellrevision {value.previousSourceRevision}. Prüfen Sie die Texte anhand des angezeigten Originals, bevor Sie speichern.</p>}
    {remoteChanged && <p className="hint" role="status">Ein neuerer Serverstand liegt vor. Ihr Entwurf und die beim Öffnen gelesenen Revisionen bleiben erhalten.</p>}
    {snapshot.record.archived && <p className="hint">Dieser Datensatz ist archiviert. Übersetzungen sind nur lesbar.</p>}
    <Unsaved dirty={draft.dirty} />
    <ErrorNotice error={action.error} onReload={() => { void loadForReview(); }} />
    <form onSubmit={(event) => { void save(event); }}>
      {!fields.length && <Empty>Für diesen Datentyp gibt es keine übersetzbaren Textfelder.</Empty>}
      {fields.map((field) => <div className="hub-translation-row" key={field.key}>
        <div className="hub-field"><span>{field.label} · Original</span>
          <div className="hub-source-text" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {String(value.sourceData[field.key] ?? "") || <span className="muted">Nicht angegeben</span>}
          </div>
        </div>
        <Fields fields={[{ ...field, label: `${field.label} · ${locale.toUpperCase()}` }]}
          data={value.data} onChange={(data) => draft.set((old) => ({ ...old, data }))}
          disabled={disabled} prefix={`translation-${snapshot.record.id}-${locale}`} />
      </div>)}
      <div className="hub-actions">
        <button className="button" type="submit" disabled={disabled || !fields.length}>{action.busy ? "Wird verarbeitet …" : "Übersetzung speichern"}</button>
        <button className="button secondary" type="button" disabled={action.busy} onClick={() => { void loadForReview(); }}>Aktuellen Stand prüfen</button>
      </div>
    </form>
    {message && <p role="status">{message}</p>}
    {review && <section className="hub-review" aria-label="Aktueller Übersetzungsstand">
      <h3>Aktueller Serverstand · Originalrevision {review.record.revision}</h3>
      <p className="hint">Ihr Entwurf ist weiterhin unverändert. Vergleichen Sie die Werte und wählen Sie anschließend, wie Sie weiterarbeiten möchten.</p>
      {fields.map((field) => <div className="hub-translation-row" key={field.key}>
        <p><strong>{field.label} · Original</strong><br />{String(review.record.data[field.key] ?? "—")}</p>
        <p><strong>{field.label} · gespeicherte Übersetzung</strong><br />{String(review.translations.find((item) => item.locale === locale)?.data[field.key] ?? "—")}</p>
      </div>)}
      <div className="hub-actions">
        <button type="button" className="button secondary" disabled={!canWrite || action.busy} onClick={() => {
          const fresh = snapshotTranslation(review, locale);
          draft.set({ ...fresh, data: value.data }); setReview(null); action.clear();
          setMessage("Aktuelle Revisionen bewusst übernommen. Ihr Textentwurf bleibt erhalten; prüfen Sie ihn vor dem Speichern.");
        }}>Verglichen: Revisionen übernehmen, Texte behalten</button>
        <button type="button" className="button secondary" disabled={action.busy} onClick={() => {
          draft.reset(snapshotTranslation(review, locale)); setReview(null); action.clear(); setMessage("Serverstand geladen. Der bisherige Entwurf wurde ersetzt.");
        }}>Serverstand laden und Entwurf verwerfen</button>
      </div>
    </section>}
  </section>;
}

function mediaSnapshot(item: Medium): MediaDraft {
  return { title: item.title, alt_text: item.alt_text, credit: item.credit, license: item.license,
    collection: item.collection, revision: item.revision, record_ids: item.record_ids };
}

export function HubMediaPage() {
  const { org, base, canWrite } = useHub();
  const selection = useDraft("media-selection", { offset: 0, id: "" });
  const query = useQuery({ queryKey: ["hub", org, "media", selection.value.offset],
    queryFn: () => api.get<Medium[]>(`${base}/media?offset=${selection.value.offset}`) });
  const selected = query.data?.find((item) => item.asset_id === selection.value.id);
  return <>
    <PageTitle title="Medien & Verwendung" description="Dateien mit verständlichen Beschreibungen, Quellen und Lizenzangaben versehen und Datensätzen zuordnen.">
      <Link className="button secondary" to="/media">{canWrite ? "Dateien hochladen" : "Dateibibliothek öffnen"}</Link>
    </PageTitle>
    <ReadOnly />
    <p className="hint">Hochgeladene Dateien sind öffentlich adressierbar. Die Zuordnungen hier dokumentieren ihre Verwendung in Unternehmensdaten.</p>
    <ErrorNotice error={query.error} onReload={() => { void query.refetch(); }} />
    {query.isPending && <p role="status">Medien werden geladen …</p>}
    {query.data && <>
      {!query.data.length ? <Empty>Noch keine Medien auf dieser Seite. Laden Sie eine Datei in der Dateibibliothek hoch, um ihre Angaben hier zu pflegen.</Empty> : <div className="hub-media-list" aria-label="Medien auswählen">
        {query.data.map((item) => <button type="button" className="hub-list-item" key={item.asset_id}
          aria-pressed={selection.value.id === item.asset_id} onClick={() => selection.set((old) => ({ ...old, id: item.asset_id }))}>
          <strong>{item.title || item.filename}</strong><span className="muted">{item.filename} · {item.content_type} · {new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(item.byte_size / 1024)} KB</span>
          <span>{item.collection || "Ohne Sammlung"} · {item.record_ids.length} Verwendungen</span>
        </button>)}
      </div>}
      <Pager offset={selection.value.offset} count={query.data.length} onChange={(offset) => selection.set({ offset, id: "" })} />
    </>}
    {selected && <MediaEditor key={`${org}:${selected.asset_id}`} item={selected} />}
  </>;
}

function LinkedRecord({ id }: { id: string }) {
  const { org, base } = useHub();
  const query = useQuery({ queryKey: ["hub", org, "record", id], queryFn: () => api.get<HubRecord>(`${base}/records/${id}`) });
  if (query.data) return <Link to={`/hub/records/${query.data.kind}/${id}`}>{query.data.name}{query.data.archived ? " (archiviert)" : ""}</Link>;
  return <span>{query.isPending ? "Datensatz wird geladen …" : `Datensatz derzeit nicht lesbar (${id})`}</span>;
}

function MediaEditor({ item }: { item: Medium }) {
  const { base, canWrite, invalidate } = useHub();
  const draft = useDraft<MediaDraft>(`media:${item.asset_id}`, mediaSnapshot(item));
  const action = useAction();
  const [recordId, setRecordId] = useState("");
  const [review, setReview] = useState<Medium | null>(null);
  const [message, setMessage] = useState("");
  const value = draft.value;
  const disabled = !canWrite || action.busy;
  async function loadForReview() {
    const result = await action.run(async () => {
      const media = await allPages<Medium>(`${base}/media`, (entry) => entry.asset_id);
      const current = media.find((entry) => entry.asset_id === item.asset_id);
      if (!current) throw new Error("Diese Datei ist nicht mehr in der Medienverwaltung vorhanden. Ihr Entwurf bleibt erhalten.");
      return current;
    });
    if (result) setReview(result);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    setMessage("");
    const { revision, ...metadata } = value;
    const result = await action.run(() => api.put<Partial<Medium> & { revision: number }>(`${base}/media/${item.asset_id}`, {
      ...metadata, expected_revision: revision,
    }));
    if (result) {
      draft.reset({ ...value, revision: result.revision });
      setReview(null); setMessage("Medienangaben und Verwendungen gespeichert.");
      await invalidate();
    }
  }
  return <section className="panel hub-detail" aria-label="Medienangaben bearbeiten">
    <h2>{item.filename}</h2>
    <p className="hub-revision">Gelesene Revision {value.revision}</p>
    {item.revision !== value.revision && <p className="hint">Neuere Angaben sind vorhanden. Ihr Entwurf wurde beibehalten.</p>}
    <Unsaved dirty={draft.dirty} />
    <ErrorNotice error={action.error} onReload={() => { void loadForReview(); }} />
    <form onSubmit={(event) => { void save(event); }}>
      <div className="hub-grid">
        <label className="hub-field">Titel<input required maxLength={240} disabled={disabled} value={value.title} onChange={(event) => draft.set((old) => ({ ...old, title: event.target.value }))} /></label>
        <label className="hub-field">Sammlung<input maxLength={240} disabled={disabled} value={value.collection} onChange={(event) => draft.set((old) => ({ ...old, collection: event.target.value }))} placeholder="z. B. Unternehmensporträts" /></label>
        <label className="hub-field">Alternativtext<textarea maxLength={2000} disabled={disabled} value={value.alt_text} onChange={(event) => draft.set((old) => ({ ...old, alt_text: event.target.value }))} rows={3} /></label>
        <label className="hub-field">Urheber / Quelle<textarea maxLength={2000} disabled={disabled} value={value.credit} onChange={(event) => draft.set((old) => ({ ...old, credit: event.target.value }))} rows={3} /></label>
        <label className="hub-field">Lizenz und Nutzungsrechte<textarea maxLength={2000} disabled={disabled} value={value.license} onChange={(event) => draft.set((old) => ({ ...old, license: event.target.value }))} rows={3} placeholder="Lizenzbezeichnung, vereinbarte Rechte oder Quellenlink" /></label>
      </div>
      <fieldset disabled={disabled}>
        <legend>Verwendet in Datensätzen</legend>
        <p className="hint">Dokumentieren Sie, zu welchen Unternehmensdaten diese Datei gehört.</p>
        {!value.record_ids.length && <p className="muted">Noch keine Verwendung zugeordnet.</p>}
        <ul className="hub-usage-list">{value.record_ids.map((id) => <li key={id}>
          <LinkedRecord id={id} /> <button type="button" className="button secondary" aria-label="Datensatz aus den Verwendungen entfernen"
            onClick={() => draft.set((old) => ({ ...old, record_ids: old.record_ids.filter((current) => current !== id) }))}>Entfernen</button>
        </li>)}</ul>
        <RecordPicker label="Verwendung hinzufügen" value={recordId} onChange={setRecordId} disabled={disabled} />
        <button type="button" className="button secondary" disabled={disabled || !recordId || value.record_ids.includes(recordId) || value.record_ids.length >= 100}
          onClick={() => { draft.set((old) => ({ ...old, record_ids: [...old.record_ids, recordId] })); setRecordId(""); }}>Datensatz zuordnen</button>
      </fieldset>
      <div className="hub-actions">
        <button type="submit" className="button" disabled={disabled}>{action.busy ? "Wird verarbeitet …" : "Medienangaben speichern"}</button>
        <button type="button" className="button secondary" disabled={action.busy} onClick={() => { void loadForReview(); }}>Aktuellen Stand prüfen</button>
      </div>
    </form>
    {message && <p role="status">{message}</p>}
    {review && <section className="hub-review" aria-label="Aktuelle Medienangaben">
      <h3>Serverstand · Revision {review.revision}</h3>
      <dl><dt>Titel</dt><dd>{review.title}</dd><dt>Alternativtext</dt><dd>{review.alt_text || "—"}</dd>
        <dt>Urheber / Quelle</dt><dd>{review.credit || "—"}</dd><dt>Lizenz</dt><dd>{review.license || "—"}</dd>
        <dt>Sammlung</dt><dd>{review.collection || "—"}</dd><dt>Verwendungen</dt>
        <dd>{review.record_ids.length ? <ul>{review.record_ids.map((id) => <li key={id}><LinkedRecord id={id} /></li>)}</ul> : "Keine"}</dd></dl>
      <p className="hint">Ihr Entwurf bleibt bis zu Ihrer Entscheidung erhalten.</p>
      <div className="hub-actions">
        <button type="button" className="button secondary" disabled={!canWrite || action.busy} onClick={() => {
          draft.set((old) => ({ ...old, revision: review.revision })); setReview(null); action.clear();
          setMessage("Verglichene Revision übernommen. Ihr Entwurf bleibt erhalten und kann jetzt bewusst gespeichert werden.");
        }}>Verglichen: Revision übernehmen, Entwurf behalten</button>
        <button type="button" className="button secondary" disabled={action.busy} onClick={() => {
          draft.reset(mediaSnapshot(review)); setReview(null); action.clear(); setMessage("Serverstand geladen. Der bisherige Entwurf wurde ersetzt.");
        }}>Serverstand laden und Entwurf verwerfen</button>
      </div>
    </section>}
  </section>;
}

function bookingSnapshot(booking?: Booking, resourceId = ""): BookingDraft {
  if (booking) return {
    resource_id: booking.resource_id, title: booking.title, start: localInput(booking.starts_at), end: localInput(booking.ends_at),
    originalStart: booking.starts_at, originalEnd: booking.ends_at, cancelled: booking.status === "cancelled", revision: booking.revision,
  };
  const start = new Date();
  start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1);
  const end = new Date(start); end.setHours(end.getHours() + 1);
  return { resource_id: resourceId, title: "", start: localInput(start), end: localInput(end), cancelled: false, revision: 0 };
}

function weekDays(anchor: string) {
  const start = new Date(`${anchor}T12:00:00`);
  if (!Number.isFinite(start.getTime())) return [];
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start); day.setDate(start.getDate() + index); return day;
  });
}

export function BookingsPage() {
  const { org, base, canWrite } = useHub();
  const filters = useDraft("booking-filters", { resource: "", from: "", to: "", status: "confirmed", view: "list", week: localInput(new Date()).slice(0, 10) });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Booking | "new" | null>(null);
  const query = useQuery({ queryKey: ["hub", org, "bookings-all"],
    queryFn: () => allPages<Booking>(`${base}/bookings`, (booking) => booking.id) });
  const invalidRange = !!filters.value.from && !!filters.value.to && filters.value.to < filters.value.from;
  const filtered = useMemo(() => {
    if (invalidRange) return [];
    const from = filters.value.from ? new Date(`${filters.value.from}T00:00:00`).getTime() : -Infinity;
    const toDate = filters.value.to ? new Date(`${filters.value.to}T00:00:00`) : null;
    toDate?.setDate(toDate.getDate() + 1);
    const to = toDate?.getTime() ?? Infinity;
    return (query.data ?? []).filter((booking) =>
      (!filters.value.resource || booking.resource_id === filters.value.resource)
      && (filters.value.status === "all" || booking.status === filters.value.status)
      && new Date(booking.ends_at).getTime() > from && new Date(booking.starts_at).getTime() < to)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [query.data, filters.value.resource, filters.value.from, filters.value.to, filters.value.status, invalidRange]);
  const days = weekDays(filters.value.week);
  function filter(key: "resource" | "from" | "to" | "status" | "view" | "week", value: string) {
    filters.set((old) => ({ ...old, [key]: value })); setOffset(0);
  }
  function moveWeek(amount: number) {
    const date = new Date(`${filters.value.week}T12:00:00`);
    date.setDate(date.getDate() + amount * 7);
    filter("week", localInput(date).slice(0, 10));
  }
  return <>
    <PageTitle title="Termine & Ressourcen" description="Räume, Geräte und andere Ressourcen planen. Überschneidungen werden beim Reservieren geprüft.">
      <Link to="/hub/records/resource" className="button secondary">Ressourcen verwalten</Link>
      <button type="button" className="button" disabled={!canWrite} onClick={() => setSelected("new")}>Termin anlegen</button>
    </PageTitle>
    <ReadOnly />
    <section className="panel" aria-label="Termine filtern">
      <div className="hub-filter-row">
        <RecordPicker label="Nach Ressource filtern" kind="resource" value={filters.value.resource} onChange={(id) => filter("resource", id)} />
        <label className="hub-field">Ab Datum<input type="date" value={filters.value.from} onChange={(event) => filter("from", event.target.value)} /></label>
        <label className="hub-field">Bis Datum<input type="date" value={filters.value.to} onChange={(event) => filter("to", event.target.value)} /></label>
        <label className="hub-field">Status<select value={filters.value.status} onChange={(event) => filter("status", event.target.value)}>
          <option value="confirmed">Reserviert</option><option value="cancelled">Storniert</option><option value="all">Alle Termine</option>
        </select></label>
      </div>
      <p className="hint">Datumsfilter und Kalender verwenden Ihre Browser-Zeitzone: {browserZone}. Auch Termine, die in den gewählten Zeitraum hineinreichen, werden angezeigt.</p>
      {invalidRange && <p role="alert">Das Enddatum darf nicht vor dem Anfangsdatum liegen.</p>}
      <div className="hub-actions" aria-label="Termindarstellung">
        <button type="button" className="button secondary" aria-pressed={filters.value.view === "list"} onClick={() => filter("view", "list")}>Liste</button>
        <button type="button" className="button secondary" aria-pressed={filters.value.view === "calendar"} onClick={() => filter("view", "calendar")}>Wochenkalender</button>
        <button type="button" className="button secondary" onClick={() => { filters.set((old) => ({ ...old, resource: "", from: "", to: "", status: "confirmed" })); setOffset(0); }}>Filter zurücksetzen</button>
      </div>
    </section>
    <ErrorNotice error={query.error} onReload={() => { void query.refetch(); }} />
    {query.isPending && <p role="status">Alle Termine werden geladen, damit Filter und Kalender vollständig sind …</p>}
    {query.data && <>
      <p className="muted" role="status">{filtered.length} passende Termine · {query.data.length} insgesamt</p>
      {filters.value.view === "list" ? <>
        {!filtered.length ? <Empty>Keine Termine für diese Auswahl. Wählen Sie einen anderen Zeitraum oder legen Sie einen Termin an.</Empty> : <div className="hub-booking-list">
          {filtered.slice(offset, offset + PAGE_SIZE).map((booking) => <BookingCard key={booking.id} booking={booking} onSelect={() => setSelected(booking)} />)}
        </div>}
        <Pager offset={offset} count={filtered.slice(offset, offset + PAGE_SIZE).length} total={filtered.length} onChange={setOffset} />
      </> : <section className="panel" aria-label="Wochenkalender">
        <div className="hub-actions">
          <button type="button" className="button secondary" onClick={() => moveWeek(-1)}>Vorherige Woche</button>
          <label className="hub-field">Woche mit Datum<input type="date" required value={filters.value.week} onChange={(event) => { if (event.target.value) filter("week", event.target.value); }} /></label>
          <button type="button" className="button secondary" onClick={() => moveWeek(1)}>Nächste Woche</button>
          <button type="button" className="button secondary" onClick={() => filter("week", localInput(new Date()).slice(0, 10))}>Heute</button>
        </div>
        <div className="hub-calendar">{days.map((day) => {
          const end = new Date(day); end.setDate(end.getDate() + 1);
          const bookings = filtered.filter((booking) => new Date(booking.starts_at) < end && new Date(booking.ends_at) > day);
          return <section className="hub-calendar-day" key={day.toISOString()}>
            <h3>{day.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" })}</h3>
            {!bookings.length && <p className="muted">Keine Termine</p>}
            {bookings.map((booking) => <BookingCard key={booking.id} booking={booking} onSelect={() => setSelected(booking)} compact />)}
          </section>;
        })}</div>
      </section>}
    </>}
    {selected && <BookingEditor key={`${org}:${selected === "new" ? "new" : selected.id}`}
      booking={selected === "new" ? undefined : selected} resourceId={filters.value.resource}
      onClose={() => setSelected(null)} onSaved={(booking) => setSelected(booking)} />}
  </>;
}

function BookingCard({ booking, onSelect, compact = false }: { booking: Booking; onSelect: () => void; compact?: boolean }) {
  return <button type="button" className="hub-list-item" onClick={onSelect}>
    <strong>{booking.title}</strong>
    <span>{booking.resource_name} · {booking.status === "cancelled" ? "Storniert" : "Reserviert"}</span>
    <span><time dateTime={booking.starts_at}>{dateTime(booking.starts_at)}</time> – <time dateTime={booking.ends_at}>{dateTime(booking.ends_at)}</time></span>
    {!compact && <span className="muted">Ressource: {booking.timezone} · {timeWithOffset(booking.starts_at, booking.timezone)} – {timeWithOffset(booking.ends_at, booking.timezone)}</span>}
  </button>;
}

function BookingEditor({ booking, resourceId, onClose, onSaved }: {
  booking?: Booking; resourceId: string; onClose: () => void; onSaved: (booking: Booking) => void;
}) {
  const { org, base, canWrite, invalidate } = useHub();
  const draft = useDraft<BookingDraft>(`booking:${booking?.id ?? "new"}`, bookingSnapshot(booking, resourceId));
  const action = useAction();
  const [review, setReview] = useState<Booking | null>(null);
  const [message, setMessage] = useState("");
  const value = draft.value;
  const disabled = !canWrite || action.busy;
  const resource = useQuery({ queryKey: ["hub", org, "record", value.resource_id], enabled: !!value.resource_id,
    queryFn: () => api.get<HubRecord>(`${base}/records/${value.resource_id}`) });
  const resourceZone = typeof resource.data?.data.timezone === "string" ? resource.data.data.timezone : booking?.timezone;
  let previewStart = "";
  let previewEnd = "";
  try {
    previewStart = localToIso(value.start, value.originalStart);
    previewEnd = localToIso(value.end, value.originalEnd);
  } catch { /* Incomplete date inputs are validated on submission. */ }

  async function loadForReview() {
    if (!booking) return;
    const result = await action.run(async () => {
      const all = await allPages<Booking>(`${base}/bookings`, (entry) => entry.id);
      const current = all.find((entry) => entry.id === booking.id);
      if (!current) throw new Error("Dieser Termin ist nicht mehr vorhanden. Ihr Entwurf bleibt erhalten.");
      return current;
    });
    if (result) setReview(result);
  }
  async function save(cancelled: boolean) {
    if (disabled) return;
    setMessage("");
    const saved = await action.run(async () => {
      if (!value.resource_id) throw new Error("Bitte eine Ressource auswählen.");
      const starts_at = localToIso(value.start, value.originalStart);
      const ends_at = localToIso(value.end, value.originalEnd);
      if (new Date(ends_at) <= new Date(starts_at)) throw new Error("Das Ende muss nach dem Beginn liegen.");
      if (new Date(ends_at).getTime() - new Date(starts_at).getTime() > 366 * 24 * 60 * 60 * 1000) throw new Error("Ein Termin darf höchstens 366 Tage dauern.");
      const payload = { title: value.title, resource_id: value.resource_id, starts_at, ends_at,
        cancelled, expected_revision: value.revision };
      const result = booking ? await api.put<Booking>(`${base}/bookings/${booking.id}`, payload)
        : await api.post<Booking>(`${base}/bookings`, payload);
      return { ...result, resource_name: resource.data?.name ?? booking?.resource_name ?? "Ressource", timezone: resourceZone ?? browserZone };
    });
    if (saved) {
      if (booking) draft.reset(bookingSnapshot(saved));
      else draft.clear();
      setReview(null); setMessage(saved.status === "cancelled" ? "Termin storniert. Der Zeitraum ist wieder verfügbar." : "Termin gespeichert.");
      onSaved(saved);
      await invalidate();
    }
  }

  return <section className="panel hub-detail" aria-label={booking ? "Termin bearbeiten" : "Termin anlegen"}>
    <div className="hub-actions"><h2>{booking ? booking.title : "Neuer Termin"}</h2>
      <button type="button" className="button secondary" onClick={onClose}>Schließen · Entwurf behalten</button></div>
    <p className="hub-revision">{booking ? `Gelesene Revision ${value.revision}` : "Neue Reservierung"}{value.cancelled ? " · Storniert" : ""}</p>
    <Unsaved dirty={draft.dirty} />
    <ErrorNotice error={action.error} onReload={booking ? () => { void loadForReview(); } : undefined} />
    <form onSubmit={(event) => { event.preventDefault(); void save(value.cancelled); }}>
      <div className="hub-grid">
        <label className="hub-field">Terminbezeichnung<input required maxLength={240} value={value.title} disabled={disabled}
          onChange={(event) => draft.set((old) => ({ ...old, title: event.target.value }))} /></label>
        <RecordPicker label="Ressource" kind="resource" value={value.resource_id} disabled={disabled}
          onChange={(id) => draft.set((old) => ({ ...old, resource_id: id }))} />
        <label className="hub-field">Beginn<input required type="datetime-local" value={value.start} disabled={disabled}
          aria-describedby="booking-timezone" onChange={(event) => draft.set((old) => ({ ...old, start: event.target.value }))} /></label>
        <label className="hub-field">Ende<input required type="datetime-local" value={value.end} disabled={disabled}
          aria-describedby="booking-timezone" onChange={(event) => draft.set((old) => ({ ...old, end: event.target.value }))} /></label>
      </div>
      <p className="hint" id="booking-timezone">Ihre Eingaben gelten in der Browser-Zeitzone {browserZone}. Die Zeitzone der Ressource ist {resourceZone ?? "nach Auswahl sichtbar"}.</p>
      <ErrorNotice error={resource.error} />
      {resource.data && <p><Link to={`/hub/records/resource/${resource.data.id}`}>Ressource „{resource.data.name}“ öffnen</Link></p>}
      {resourceZone && previewStart && previewEnd && <p className="hint">An der Ressource: {timeWithOffset(previewStart, resourceZone)} bis {timeWithOffset(previewEnd, resourceZone)}.</p>}
      <p className="hint">Beim Speichern wird geprüft, ob die Ressource frei ist. Bei einer Überschneidung bleiben Ihre Eingaben erhalten.</p>
      <div className="hub-actions">
        <button type="submit" className="button" disabled={disabled || !value.resource_id}>{action.busy ? "Wird verarbeitet …" : booking ? "Termin speichern" : "Ressource reservieren"}</button>
        {booking && <button type="button" className="button secondary" disabled={disabled}
          onClick={() => { draft.set((old) => ({ ...old, cancelled: !old.cancelled })); }}>
          {value.cancelled ? "Reservierung wiederherstellen" : "Stornierung vormerken"}</button>}
        {booking && <button type="button" className="button secondary" disabled={action.busy} onClick={() => { void loadForReview(); }}>Aktuellen Stand prüfen</button>}
      </div>
      {booking && value.cancelled !== (booking.status === "cancelled") && <p className="hint" role="status">{value.cancelled ? "Die Stornierung wird erst mit „Termin speichern“ wirksam." : "Die erneute Reservierung wird beim Speichern auf Überschneidungen geprüft."}</p>}
    </form>
    {message && <p role="status">{message}</p>}
    {review && <section className="hub-review" aria-label="Aktueller Terminstand">
      <h3>Serverstand · Revision {review.revision}</h3>
      <p><strong>{review.title}</strong> · {review.resource_name}</p>
      <p>{dateTime(review.starts_at)} – {dateTime(review.ends_at)} · {review.status === "cancelled" ? "Storniert" : "Reserviert"}</p>
      <p className="hint">Ihr Entwurf ist unverändert. Erst die folgende Auswahl übernimmt den geprüften Serverstand.</p>
      <div className="hub-actions">
        <button type="button" className="button secondary" disabled={!canWrite || action.busy} onClick={() => {
          draft.set((old) => ({ ...old, revision: review.revision })); setReview(null); action.clear();
          setMessage("Verglichene Revision übernommen. Prüfen Sie Ihren erhaltenen Entwurf vor dem Speichern.");
        }}>Verglichen: Revision übernehmen, Entwurf behalten</button>
        <button type="button" className="button secondary" disabled={action.busy} onClick={() => {
          draft.reset(bookingSnapshot(review)); setReview(null); action.clear(); setMessage("Serverstand geladen. Der bisherige Entwurf wurde ersetzt.");
        }}>Serverstand laden und Entwurf verwerfen</button>
      </div>
    </section>}
  </section>;
}
