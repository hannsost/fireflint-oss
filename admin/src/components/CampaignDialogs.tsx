import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, ApiError, assetUrl } from "../api/client";
import { UiIcon } from "./Brand";
import { PLATFORMS, dateKey, draftPreview, entryStatus, formatDate, platformName, type Campaign, type CalendarEntry, type CampaignRun } from "../lib/campaigns";
import type { ContentObject, ContentType } from "../types";

export function CampaignDialog({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className={`campaign-dialog${wide ? " campaign-dialog-wide" : ""}`} aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="campaign-dialog-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Dialog schließen" onClick={close}><UiIcon name="close" /></button></div>
    {children}
  </dialog>;
}

const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;
function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="campaign-error" role="alert">{isConflict(error)
    ? "Inzwischen wurde der gespeicherte Stand geändert. Deine Eingaben bleiben erhalten. Vergleiche den aktuellen Stand, bevor du erneut speicherst."
    : error instanceof Error ? error.message : "Die Änderung konnte nicht gespeichert werden."}</div>;
}

export function CampaignEditor({ org, campaign, saved, close }: { org: string; campaign: Campaign | null; saved: (campaign: Campaign) => void; close: () => void }) {
  const today = dateKey(new Date());
  const [name, setName] = useState(campaign?.name ?? "");
  const [start, setStart] = useState(campaign?.start_date ?? today);
  const [end, setEnd] = useState(campaign?.end_date ?? today);
  const [zone, setZone] = useState(campaign?.time_zone ?? "Europe/Berlin");
  const [platforms, setPlatforms] = useState(campaign?.platforms ?? ["instagram"]);
  const [brief, setBrief] = useState(String(campaign?.rules.brief ?? ""));
  const [instructions, setInstructions] = useState(String(campaign?.rules.instructions ?? ""));
  const [interval, setInterval] = useState(Number(campaign?.rules.interval_days ?? 1));
  const [time, setTime] = useState(String(campaign?.rules.preferred_time ?? "18:00"));
  const [status, setStatus] = useState<Campaign["status"]>(campaign?.status ?? "draft");
  const [base, setBase] = useState(campaign);
  const [latest, setLatest] = useState<Campaign | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), start_date: start, end_date: end, time_zone: zone, platforms, status,
        rules: { ...base?.rules, brief, instructions, interval_days: interval, preferred_time: time } };
      return base ? api.put<Campaign>(`/api/orgs/${org}/campaigns/${base.id}`, { ...body, expected_revision: base.revision }) : api.post<Campaign>(`/api/orgs/${org}/campaigns`, body);
    },
    onSuccess: saved,
  });
  const loadLatest = useMutation({ mutationFn: () => api.get<Campaign>(`/api/orgs/${org}/campaigns/${campaign!.id}`), onSuccess: setLatest });
  return <CampaignDialog title={campaign ? "Kampagne bearbeiten" : "Neue Kampagne"} close={close}>
    <form onSubmit={event => { event.preventDefault(); if (!isConflict(mutation.error)) mutation.mutate(); }}>
      <fieldset className="campaign-fields" disabled={mutation.isPending}>
        <label>Name<input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="Zum Beispiel: Gemeinsam durch den Advent" /></label>
        <div className="campaign-form-row"><label>Von<input type="date" required value={start} max={end || undefined} onChange={event => setStart(event.target.value)} /></label><label>Bis<input type="date" required value={end} min={start} onChange={event => setEnd(event.target.value)} /></label></div>
        <p className="hint">Kampagnen dürfen sich überschneiden. Jeder Beitrag bleibt seiner Kampagne zugeordnet.</p>
        <fieldset className="campaign-platforms"><legend>Plattformen</legend>{[...new Set([...Object.keys(PLATFORMS), ...platforms])].map(platform => <label key={platform}><input type="checkbox" checked={platforms.includes(platform)} onChange={event => setPlatforms(current => event.target.checked ? [...current, platform] : current.filter(value => value !== platform))} />{platformName(platform)}</label>)}</fieldset>
        <label>Ziel &amp; Thema<textarea rows={3} maxLength={8000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="Was soll die Kampagne vermitteln?" /></label>
        <div className="campaign-form-row"><label>Abstand in Tagen<input type="number" min={1} max={365} required value={interval} onChange={event => setInterval(Number(event.target.value))} /></label><label>Gewünschte Uhrzeit<input type="time" required value={time} onChange={event => setTime(event.target.value)} /></label></div>
        <label>Regeln für die Beiträge<textarea rows={4} maxLength={8000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Ton, Bildsprache, Quellen und Dinge, die vermieden werden sollen …" /></label>
        <details className="campaign-more"><summary>Weitere Einstellungen</summary><label>Zeitzone<input required value={zone} onChange={event => setZone(event.target.value)} placeholder="Europe/Berlin" /></label><label>Kampagnenstatus<select value={status} onChange={event => setStatus(event.target.value as Campaign["status"])}><option value="draft">Entwurf</option><option value="ready">Bereit</option><option value="archived">Archiviert</option></select></label></details>
      </fieldset>
      <MutationError error={mutation.error} />
      {isConflict(mutation.error) && <div className="campaign-conflict"><button type="button" disabled={loadLatest.isPending} onClick={() => loadLatest.mutate()}>Aktuellen Stand vergleichen</button><MutationError error={loadLatest.error} />{latest && <><div className="campaign-current"><strong>Aktuell gespeichert: {latest.name}</strong><p>{formatDate(latest.start_date)} – {formatDate(latest.end_date)} · {latest.platforms.map(platformName).join(", ")}</p><p>{latest.time_zone} · {latest.status === "archived" ? "Archiviert" : latest.status === "ready" ? "Bereit" : "Entwurf"} · Abstand: {String(latest.rules.interval_days ?? "individuell")} Tage · {String(latest.rules.preferred_time ?? "ohne Uhrzeit")}</p><p>{String(latest.rules.brief ?? "Kein Ziel hinterlegt")}</p><p>{String(latest.rules.instructions ?? "Keine weiteren Regeln")}</p></div><p className="hint">Übernimm die gewünschten Änderungen oben. Deine Eingaben ersetzen beim nächsten Speichern die gezeigten Felder.</p><button type="button" onClick={() => { setBase(latest); setLatest(null); mutation.reset(); }}>Stand geprüft, Eingaben beibehalten</button></>}</div>}
      <div className="campaign-dialog-actions"><button type="button" onClick={close}>Abbrechen</button><button className="primary" disabled={mutation.isPending || platforms.length === 0 || isConflict(mutation.error)}>{mutation.isPending ? "Speichert…" : "Kampagne speichern"}</button></div>
      <p className="hint">Speichern erstellt keine Beiträge und aktiviert keine Veröffentlichung.</p>
    </form>
  </CampaignDialog>;
}

export function EntryAssignment({ org, campaign, entry, saved, close }: { org: string; campaign: Campaign; entry?: CalendarEntry; saved: (desiredDate: string) => void; close: () => void }) {
  const [typeKey, setTypeKey] = useState(entry?.content_type_key ?? "");
  const [contentId, setContentId] = useState(entry?.content_id ?? "");
  const [search, setSearch] = useState("");
  const [date, setDate] = useState(entry?.desired_date ?? [campaign.start_date, dateKey(new Date()), campaign.end_date].sort()[1]);
  const [time, setTime] = useState(entry?.desired_time ?? String(campaign.rules.preferred_time ?? "18:00"));
  const [platform, setPlatform] = useState(entry?.platform ?? campaign.platforms[0] ?? "instagram");
  const [status, setStatus] = useState<CalendarEntry["status"]>(entry?.status ?? "draft");
  const [baseCampaign, setBaseCampaign] = useState(campaign);
  const [baseEntry, setBaseEntry] = useState(entry);
  const [reviewedContent, setReviewedContent] = useState<ContentObject | null>(null);
  const [latest, setLatest] = useState<{ campaign: Campaign; content: ContentObject; entry?: CalendarEntry } | null>(null);
  const types = useQuery({ queryKey: ["content-types", org], queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`), enabled: !entry });
  const content = useQuery({ queryKey: ["campaign-drafts", org, typeKey], queryFn: () => api.get<ContentObject[]>(`/api/orgs/${org}/content/${encodeURIComponent(typeKey)}?status=draft`), enabled: !entry && !!typeKey });
  const selected = content.data?.find(item => item.id === contentId);
  const mutation = useMutation({ mutationFn: () => {
    const body = { content_id: entry?.content_id ?? contentId, expected_campaign_revision: baseCampaign.revision, content_revision: reviewedContent?.id === (entry?.content_id ?? contentId) ? reviewedContent.revision : baseEntry?.content_revision ?? selected?.revision, desired_date: date, desired_time: time || null, platform, status };
    return entry ? api.put(`/api/orgs/${org}/campaigns/${campaign.id}/entries/${entry.id}`, { ...body, expected_revision: baseEntry?.revision }) : api.post(`/api/orgs/${org}/campaigns/${campaign.id}/entries`, body);
  }, onSuccess: () => saved(date) });
  const loadLatest = useMutation({ mutationFn: async () => {
    const [currentCampaign, currentContent, entries] = await Promise.all([
      api.get<Campaign>(`/api/orgs/${org}/campaigns/${campaign.id}`),
      api.get<ContentObject>(`/api/orgs/${org}/content/${encodeURIComponent(typeKey)}/${entry?.content_id ?? contentId}`),
      entry ? api.get<CalendarEntry[]>(`/api/orgs/${org}/campaign-calendar?campaign_id=${campaign.id}`) : Promise.resolve([]),
    ]);
    const currentEntry = entries.find(value => value.id === entry?.id);
    if (entry && !currentEntry) throw new Error("Diese Zuordnung wurde inzwischen entfernt. Deine Eingaben bleiben zum Übertragen erhalten.");
    return { campaign: currentCampaign, content: currentContent, entry: currentEntry };
  }, onSuccess: setLatest });
  return <CampaignDialog title={entry ? "Wunschdatum bearbeiten" : "Entwurf zuordnen"} close={close}>
    <p className="hint">Kampagne: <strong>{campaign.name}</strong></p>
    <form onSubmit={event => { event.preventDefault(); if (!isConflict(mutation.error)) mutation.mutate(); }}>
      <fieldset className="campaign-fields" disabled={mutation.isPending}>
        {!entry && <><label>Inhaltstyp<select required value={typeKey} onChange={event => { setTypeKey(event.target.value); setContentId(""); }}><option value="">Inhaltstyp wählen</option>{types.data?.map(type => <option key={type.key} value={type.key}>{type.name}</option>)}</select></label>{types.error && <MutationError error={types.error} />}
          {typeKey && <><label>Entwurf suchen<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Titel eingeben" /></label><label>Entwurf<select required value={contentId} onChange={event => setContentId(event.target.value)}><option value="">{content.isPending ? "Entwürfe werden geladen…" : "Entwurf wählen"}</option>{content.data?.filter(item => draftPreview(item.data, platform).title.toLowerCase().includes(search.toLowerCase()) || item.id === contentId).map(item => <option key={item.id} value={item.id}>{draftPreview(item.data, platform).title}</option>)}</select></label>{content.data?.length === 0 && <p className="hint">Noch keine Entwürfe in diesem Inhaltstyp. <Link to={`/content/${typeKey}/new`}>Entwurf anlegen</Link></p>}<MutationError error={content.error} /></>}
        </>}
        {entry && <p><strong>{draftPreview(entry.content_data, platform).title}</strong></p>}
        <div className="campaign-form-row"><label>Wunschdatum<input type="date" required min={baseCampaign.start_date} max={baseCampaign.end_date} value={date} onChange={event => setDate(event.target.value)} /></label><label>Gewünschte Uhrzeit<input type="time" value={time} onChange={event => setTime(event.target.value)} /></label></div>
        <p className="hint">{baseCampaign.time_zone} · {formatDate(baseCampaign.start_date)} – {formatDate(baseCampaign.end_date)}</p>
        <div className="campaign-form-row"><label>Plattform<select value={platform} onChange={event => setPlatform(event.target.value)}>{[...new Set([...baseCampaign.platforms, platform])].map(value => <option key={value} value={value}>{platformName(value)}{!baseCampaign.platforms.includes(value) ? " (nicht mehr in der Kampagne)" : ""}</option>)}</select></label><label>Entwurfsstatus<select value={status} onChange={event => setStatus(event.target.value as CalendarEntry["status"])}><option value="draft">Entwurf</option><option value="ready">Bereit zur Prüfung</option></select></label></div>
      </fieldset>
      <MutationError error={mutation.error} />
      {isConflict(mutation.error) && <div className="campaign-conflict"><button type="button" disabled={loadLatest.isPending} onClick={() => loadLatest.mutate()}>Aktuellen Stand vergleichen</button><MutationError error={loadLatest.error} />{latest && <><div className="campaign-current"><strong>Aktuell gespeichert: {latest.campaign.name}</strong><p>{formatDate(latest.campaign.start_date)} – {formatDate(latest.campaign.end_date)} · {latest.campaign.platforms.map(platformName).join(", ")}</p>{latest.entry && <p>Wunschdatum: {formatDate(latest.entry.desired_date)} · {latest.entry.desired_time?.slice(0, 5) ?? "ohne Uhrzeit"} · {platformName(latest.entry.platform)} · {entryStatus(latest.entry.status)}</p>}<strong>{draftPreview(latest.content.data, platform).title}</strong>{draftPreview(latest.content.data, platform).image && <img className="campaign-conflict-image" src={assetUrl(draftPreview(latest.content.data, platform).image)} alt={draftPreview(latest.content.data, platform).alt || "Aktuelles Bild des Beitrags"} />}<p className="campaign-caption">{draftPreview(latest.content.data, platform).caption || "Kein Beitragstext hinterlegt."}</p></div><p className="hint">Prüfe den aktuellen Inhalt und passe deine Eingaben bei Bedarf oben an. Es wird erst beim nächsten Speichern geändert.</p><button type="button" onClick={() => { setBaseCampaign(latest.campaign); setBaseEntry(latest.entry); setReviewedContent(latest.content); setLatest(null); mutation.reset(); }}>Stand geprüft, Eingaben beibehalten</button></>}</div>}
      <div className="campaign-dialog-actions"><button type="button" onClick={close}>Abbrechen</button><button className="primary" disabled={mutation.isPending || (!entry && !selected) || isConflict(mutation.error) || !baseCampaign.platforms.includes(platform) || baseCampaign.status === "archived"}>{mutation.isPending ? "Speichert…" : "Zuordnung speichern"}</button></div>
      <p className="hint">Das Wunschdatum ist eine Planungshilfe. Es löst keine Veröffentlichung aus.</p>
    </form>
  </CampaignDialog>;
}

export function DraftPreview({ entries, campaigns, color, canWrite, close, edit }: { entries: CalendarEntry[]; campaigns: Campaign[]; color?: string; canWrite: boolean; close: () => void; edit: (entry: CalendarEntry) => void }) {
  const [entryId, setEntryId] = useState(entries[0].id);
  const entry = entries.find(value => value.id === entryId) ?? entries[0];
  const preview = draftPreview(entry.content_data, entry.platform);
  const campaign = campaigns.find(value => value.id === entry.campaign_id);
  return <CampaignDialog title="Beitragsvorschau" close={close} wide>
    <div className="campaign-preview-heading" style={{ "--campaign-color": color ?? "#687067" } as CSSProperties}><span className="campaign-label"><span className="campaign-dot" aria-hidden="true" />{entry.campaign_name}</span><h3>{preview.title}</h3><p className="hint">Wunschdatum: {formatDate(entry.desired_date)}{entry.desired_time ? ` · ${entry.desired_time.slice(0, 5)} Uhr` : ""}{campaign ? ` · ${campaign.time_zone}` : ""}</p></div>
    {entries.length > 1 && <div className="campaign-preview-tabs" aria-label="Plattformvorschau">{entries.map(value => <button key={value.id} aria-pressed={value.id === entryId} onClick={() => setEntryId(value.id)}>{platformName(value.platform)}</button>)}</div>}
    <div className="campaign-preview-body"><figure>{preview.image ? <img src={assetUrl(preview.image)} alt={preview.alt || preview.title} /> : <div className="campaign-no-image"><UiIcon name="media" size={32} /><span>Noch kein Bild hinterlegt</span></div>}{preview.alt && <figcaption>{preview.alt}</figcaption>}</figure><div className="campaign-preview-copy"><div className="campaign-preview-copy-label"><strong>{platformName(entry.platform)}</strong><span>{entryStatus(entry.status)}</span></div>{preview.caption ? <p className="campaign-caption">{preview.caption}</p> : <p className="hint">Für diese Plattform ist noch kein Text hinterlegt.</p>}{preview.objective && <details><summary>Ziel des Beitrags</summary><p>{preview.objective}</p></details>}{preview.source && <a href={preview.source} target="_blank" rel="noreferrer">Quelle ansehen <UiIcon name="external" size={14} /></a>}</div></div>
    <div className="campaign-preview-footer"><p>{entry.publish_at ? `Veröffentlichung terminiert: ${new Date(entry.publish_at).toLocaleString("de-DE")}` : "Nicht zur Veröffentlichung terminiert"}{entry.content_status === "published" && " · Inhalt bereits veröffentlicht"}</p><div>{canWrite && campaign && campaign.status !== "archived" && <button onClick={() => edit(entry)}>Wunschdatum bearbeiten</button>}<Link className="button" to={`/content/${encodeURIComponent(entry.content_type_key)}/${entry.content_id}`}>{canWrite ? "Inhalt bearbeiten" : "Inhalt ansehen"}<UiIcon name="arrow" /></Link></div></div>
  </CampaignDialog>;
}

export function GenerationDialog({ org, campaign, saved, close }: { org: string; campaign: Campaign; saved: () => void; close: () => void }) {
  const [count, setCount] = useState(1);
  const [instructions, setInstructions] = useState("");
  const [submittedBody, setSubmittedBody] = useState<Record<string, unknown> | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const mutation = useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<CampaignRun>(`/api/orgs/${org}/campaigns/${campaign.id}/runs`, body), onSuccess: saved });
  return <CampaignDialog title="Entwürfe erstellen" close={close}>
    <p>Neue Entwürfe für <strong>{campaign.name}</strong> anfragen. Die gespeicherten Kampagnenregeln gelten für diesen Auftrag.</p>
    <form onSubmit={event => { event.preventDefault(); const body = submittedBody ?? { expected_campaign_revision: campaign.revision, idempotency_key: idempotencyKey.current, requested_count: count, instructions }; setSubmittedBody(body); mutation.mutate(body); }}>
      <fieldset className="campaign-fields" disabled={mutation.isPending || !!submittedBody}><label>Anzahl Entwürfe<input type="number" min={1} max={100} required value={count} onChange={event => setCount(Number(event.target.value))} /></label><label>Hinweis für diesen Auftrag<textarea value={instructions} maxLength={8000} onChange={event => setInstructions(event.target.value)} placeholder="Optional, zum Beispiel ein besonderer Anlass" /></label></fieldset>
      <p className="campaign-planning-note"><UiIcon name="info" />Die Ergebnisse erscheinen als Entwürfe zur Prüfung. Dieser Auftrag veröffentlicht nichts.</p>
      <MutationError error={mutation.error} />
      <div className="campaign-dialog-actions"><button type="button" onClick={close}>Schließen</button><button className="primary" disabled={mutation.isPending || isConflict(mutation.error)}>{mutation.isPending ? "Wird angefragt…" : submittedBody ? "Denselben Auftrag erneut anfragen" : "Entwürfe anfragen"}</button></div>
    </form>
  </CampaignDialog>;
}
