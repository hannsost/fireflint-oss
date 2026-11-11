import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, List, Plus, RefreshCw } from "lucide-react";
import { api, ApiError, assetUrl } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { UiIcon } from "../components/Brand";
import { CampaignEditor, DraftPreview, EntryAssignment, GenerationDialog } from "../components/CampaignDialogs";
import { adjacentMonth, campaignColors, campaignRunError, campaignStatus, dateKey, draftPreview, entryStatus, formatDate, groupEntries, monthDays, parseDate, platformName, type Campaign, type CalendarEntry, type CampaignRun } from "../lib/campaigns";
import "../campaigns.css";

const weekdays = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const colorStyle = (color?: string) => ({ "--campaign-color": color ?? "#687067" }) as CSSProperties;
const runLabels: Record<string, string> = { queued: "Angefragt", pending: "Angefragt", dispatched: "Übergeben", accepted: "Übernommen", running: "In Bearbeitung", completed: "Abgeschlossen", succeeded: "Abgeschlossen", failed: "Fehlgeschlagen", blocked: "Unterbrochen", cancelled: "Abgebrochen" };

function CampaignRunItem({ org, run, canWrite }: { org: string; run: CampaignRun; canWrite: boolean }) {
  const qc = useQueryClient();
  const path = `/api/orgs/${org}/campaigns/${run.campaign_id}/runs/${run.id}`;
  const update = (current: CampaignRun) => qc.setQueryData<CampaignRun[]>(["campaign-runs", org, run.campaign_id], entries => entries?.map(entry => entry.id === current.id ? current : entry));
  const cancel = useMutation({ mutationFn: (revision: number) => api.post<CampaignRun>(`${path}/cancel`, { expected_revision: revision }), onSuccess: update });
  const reload = useMutation({ mutationFn: () => api.get<CampaignRun>(path), onSuccess: current => { update(current); cancel.reset(); } });
  const conflict = cancel.error instanceof ApiError && cancel.error.status === 409;
  return <li><div><strong>{runLabels[run.status] ?? run.status}</strong><time dateTime={run.created_at}>{new Date(run.created_at).toLocaleString("de-DE")}</time></div>
    {["queued", "pending"].includes(run.status) && <p>Der Auftrag wartet auf die Übernahme. Es liegen noch keine bestätigten Ergebnisse vor.</p>}
    {run.error || run.error_message ? <p className="error">{campaignRunError(run.error || run.error_message || "")}</p> : null}
    {canWrite && ["queued", "running"].includes(run.status) && <button disabled={cancel.isPending || conflict} onClick={() => cancel.mutate(run.revision)}>{cancel.isPending ? "Wird abgebrochen…" : "Erstellung abbrechen"}</button>}
    {cancel.error && <div className="campaign-error" role="alert">{conflict ? "Der Auftrag wurde inzwischen geändert. Lade den aktuellen Stand, bevor du ihn erneut abbrichst." : cancel.error.message}{conflict && <button disabled={reload.isPending} onClick={() => reload.mutate()}>Auftragsstatus neu laden</button>}</div>}
    {reload.error && <p className="campaign-error" role="alert">Der Auftragsstatus konnte nicht geladen werden: {reload.error.message}</p>}
  </li>;
}

function CalendarCard({ entries, color, open }: { entries: CalendarEntry[]; color?: string; open: () => void }) {
  const entry = entries[0];
  const preview = draftPreview(entry.content_data, entry.platform);
  return <button type="button" className="campaign-entry" style={colorStyle(color)} data-testid="calendar-entry" onClick={open} aria-label={`${preview.title} · ${entry.campaign_name} · ${formatDate(entry.desired_date)} · ${entries.map(item => platformName(item.platform)).join(", ")}`}>
    {preview.image && <img src={assetUrl(preview.image)} alt="" loading="lazy" />}
    <span className="campaign-entry-copy"><span className="campaign-entry-meta">{entry.desired_time && <span>{entry.desired_time.slice(0, 5)}</span>}<span>{platformName(entry.platform)}{entries.length > 1 ? ` +${entries.length - 1}` : ""}</span></span><strong>{preview.title}</strong><span className="campaign-entry-campaign">{entry.campaign_name}</span><span className="campaign-entry-status">{entryStatus(entry.status)}</span></span>
  </button>;
}

export function CampaignsPage() {
  const org = useOrg();
  const { memberships } = useAuth();
  const role = memberships.find(member => member.org_id === org)?.role;
  const canWrite = role === "owner" || role === "editor";
  // The shell remounts on organisation changes; private form state never crosses customers.
  return <CampaignWorkspace key={org} org={org} canWrite={canWrite} />;
}

function CampaignWorkspace({ org, canWrite }: { org: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const today = dateKey(new Date());
  const [month, setMonth] = useState(today.slice(0, 7));
  const [campaignId, setCampaignId] = useState("");
  const [platform, setPlatform] = useState("");
  const [status, setStatus] = useState("");
  const [view, setView] = useState<"month" | "list">("month");
  const [editor, setEditor] = useState<{ campaign: Campaign | null } | null>(null);
  const [preview, setPreview] = useState<CalendarEntry[] | null>(null);
  const [assignment, setAssignment] = useState<{ campaign: Campaign; entry?: CalendarEntry } | null>(null);
  const [generation, setGeneration] = useState<Campaign | null>(null);
  const [notice, setNotice] = useState("");
  const days = useMemo(() => monthDays(month), [month]);
  const campaigns = useQuery({ queryKey: ["campaigns", org], queryFn: () => api.get<Campaign[]>(`/api/orgs/${org}/campaigns`) });
  const colors = useMemo(() => campaignColors(campaigns.data ?? []), [campaigns.data]);
  const selected = campaigns.data?.find(campaign => campaign.id === campaignId);
  const params = new URLSearchParams({ from: days[0], to: days[days.length - 1] });
  if (campaignId) params.set("campaign_id", campaignId);
  if (platform) params.set("platform", platform);
  if (status) params.set("status", status);
  const calendar = useQuery({ queryKey: ["campaign-calendar", org, month, campaignId, platform, status], queryFn: () => api.get<CalendarEntry[]>(`/api/orgs/${org}/campaign-calendar?${params}`) });
  const runs = useQuery({ queryKey: ["campaign-runs", org, campaignId], queryFn: () => api.get<CampaignRun[]>(`/api/orgs/${org}/campaigns/${campaignId}/runs`), enabled: !!campaignId,
    refetchInterval: query => query.state.data?.some(run => ["queued", "pending", "dispatched", "accepted", "running"].includes(run.status)) ? 10000 : false });
  const observedCompletions = useRef(new Set<string>());
  useEffect(() => {
    let changed = false;
    for (const run of runs.data ?? []) {
      const key = `${run.id}:${run.revision}`;
      if (["completed", "succeeded"].includes(run.status) && !observedCompletions.current.has(key)) {
        observedCompletions.current.add(key); changed = true;
      }
    }
    if (changed) void qc.invalidateQueries({ queryKey: ["campaign-calendar", org] });
  }, [runs.data, org, qc]);
  const entriesByDay = useMemo(() => {
    const result = new Map<string, CalendarEntry[]>();
    for (const entry of calendar.data ?? []) result.set(entry.desired_date, [...(result.get(entry.desired_date) ?? []), entry]);
    return result;
  }, [calendar.data]);
  const monthEntries = calendar.data?.filter(entry => entry.desired_date.startsWith(month)) ?? [];
  const platforms = [...new Set(campaigns.data?.flatMap(campaign => campaign.platforms) ?? [])];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["campaigns", org] });
    void qc.invalidateQueries({ queryKey: ["campaign-calendar", org] });
    void qc.invalidateQueries({ queryKey: ["campaign-runs", org] });
  };
  const campaignSaved = (campaign: Campaign) => {
    refresh(); setEditor(null); setCampaignId(campaign.id); setMonth(campaign.start_date.slice(0, 7)); setNotice("Kampagne gespeichert.");
  };
  const resetFilters = () => { setCampaignId(""); setPlatform(""); setStatus(""); };
  const monthTitle = parseDate(`${month}-01`).toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  const dataError = campaigns.error || calendar.error;

  return <div className="campaign-page">
    <header className="campaign-page-heading"><div><h1>Kampagnen &amp; Kalender</h1><p className="hint">Themen planen, Entwürfe ansehen und gemeinsam den Überblick behalten.</p></div>{canWrite && <button className="primary" onClick={() => setEditor({ campaign: null })}><Plus size={18} />Kampagne anlegen</button>}</header>
    <div className="campaign-planning-note"><CalendarDays size={20} /><span>Wunschdaten planen Entwürfe. Sie lösen keine Veröffentlichung aus.</span>{!canWrite && <span className="campaign-readonly">Lesezugriff</span>}</div>
    {notice && <p className="campaign-notice" role="status">{notice}<button className="icon-button" aria-label="Hinweis schließen" onClick={() => setNotice("")}><UiIcon name="close" size={16} /></button></p>}

    <section className="campaign-controls" aria-label="Kalenderfilter">
      <label>Kampagne<select aria-label="Kampagne filtern" value={campaignId} onChange={event => { setCampaignId(event.target.value); setNotice(""); }}><option value="">Alle Kampagnen</option>{campaigns.data?.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}{campaign.status === "archived" ? " (Archiviert)" : ""}</option>)}</select></label>
      <label>Plattform<select aria-label="Plattform filtern" value={platform} onChange={event => setPlatform(event.target.value)}><option value="">Alle Plattformen</option>{platforms.map(value => <option key={value} value={value}>{platformName(value)}</option>)}</select></label>
      <label>Status<select aria-label="Entwurfsstatus filtern" value={status} onChange={event => setStatus(event.target.value)}><option value="">Alle Entwürfe</option><option value="draft">Entwurf</option><option value="ready">Bereit zur Prüfung</option></select></label>
      <button className="icon-button" aria-label="Kalender aktualisieren" disabled={calendar.isFetching || campaigns.isFetching} onClick={refresh}><RefreshCw size={18} /></button>
      {(campaignId || platform || status) && <button className="campaign-reset" onClick={resetFilters}>Filter zurücksetzen</button>}
    </section>

    {selected && <section className="campaign-focus" style={colorStyle(colors.get(selected.id))} aria-label={`Kampagne ${selected.name}`}><div className="campaign-focus-main"><div><span className="campaign-label">{campaignStatus(selected.status)}</span><h2>{selected.name}</h2><p>{formatDate(selected.start_date)} – {formatDate(selected.end_date)} · {selected.platforms.map(platformName).join(", ")}</p>{typeof selected.rules.brief === "string" && selected.rules.brief && <p className="hint">{selected.rules.brief}</p>}</div><button onClick={() => setMonth(selected.start_date.slice(0, 7))}>Zum Beginn</button></div>
      {canWrite && <div className="campaign-focus-actions"><button onClick={() => setEditor({ campaign: selected })}><UiIcon name="settings" size={16} />Kampagne bearbeiten</button>{selected.status !== "archived" && <><button onClick={() => setAssignment({ campaign: selected })}><Plus size={16} />Entwurf zuordnen</button><button onClick={() => setGeneration(selected)}><UiIcon name="spark" size={16} />Entwürfe erstellen</button></>}</div>}
      <details className="campaign-details"><summary>Regeln &amp; Erstellungsaufträge</summary><div className="campaign-rules-summary"><p>{Number(selected.rules.interval_days) > 0 ? `Alle ${selected.rules.interval_days} ${selected.rules.interval_days === 1 ? "Tag" : "Tage"}` : "Individueller Rhythmus"}{selected.rules.preferred_time ? ` · ${String(selected.rules.preferred_time)} Uhr` : ""} · {selected.time_zone}</p>{selected.rules.instructions ? <p className="campaign-caption">{String(selected.rules.instructions)}</p> : <p className="hint">Keine weiteren Regeln hinterlegt.</p>}{["included_dates", "excluded_dates"].map(key => Array.isArray(selected.rules[key]) && selected.rules[key].length > 0 ? <p key={key}><strong>{key === "included_dates" ? "Nur an diesen Tagen" : "Ausgenommene Tage"}:</strong> {(selected.rules[key] as string[]).map(formatDate).join(" · ")}</p> : null)}</div>{runs.isPending && <p role="status" className="hint">Aufträge werden geladen…</p>}{runs.error && <p className="campaign-error" role="alert">Aufträge konnten nicht geladen werden. <button onClick={() => void runs.refetch()}>Erneut laden</button></p>}{runs.data?.length === 0 && <p className="hint">Noch keine Erstellung angefragt.</p>}{runs.data && runs.data.length > 0 && <ul className="campaign-runs">{[...runs.data].sort((a, b) => Number(["queued", "running"].includes(b.status)) - Number(["queued", "running"].includes(a.status)) || b.created_at.localeCompare(a.created_at)).slice(0, 10).map(run => <CampaignRunItem key={run.id} org={org} run={run} canWrite={canWrite} />)}</ul>}</details>
    </section>}

    {!selected && campaigns.data && campaigns.data.length > 0 && <div className="campaign-legend" aria-label="Kampagnen im Überblick">{campaigns.data.filter(campaign => campaign.status !== "archived").map(campaign => <button key={campaign.id} style={colorStyle(colors.get(campaign.id))} onClick={() => setCampaignId(campaign.id)}><span className="campaign-dot" aria-hidden="true" /><span>{campaign.name}</span></button>)}</div>}

    {dataError && <div className="campaign-error" role="alert"><strong>Der Kalender konnte nicht vollständig geladen werden.</strong><p>{dataError instanceof Error ? dataError.message : "Bitte versuche es erneut."}</p><button onClick={refresh}>Erneut laden</button></div>}
    {!dataError && campaigns.data?.length === 0 && <section className="panel campaign-empty"><CalendarDays size={34} /><h2>Platz für deine nächste Kampagne</h2><p>Lege einen Zeitraum und ein Thema fest. Anschließend ordnest du vorhandene Entwürfe zu oder lässt neue erstellen.</p>{canWrite && <button onClick={() => setEditor({ campaign: null })}>Erste Kampagne anlegen</button>}</section>}

    <section className="campaign-calendar" aria-label="Redaktionskalender" aria-busy={calendar.isFetching}>
      <div className="campaign-calendar-toolbar"><div className="campaign-month-nav"><button className="icon-button" aria-label="Vorheriger Monat" onClick={() => setMonth(adjacentMonth(month, -1))}><ChevronLeft size={20} /></button><h2>{monthTitle}</h2><button className="icon-button" aria-label="Nächster Monat" onClick={() => setMonth(adjacentMonth(month, 1))}><ChevronRight size={20} /></button></div><div className="campaign-calendar-actions"><input aria-label="Monat wählen" type="month" value={month} onChange={event => { if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value); }} /><button onClick={() => setMonth(today.slice(0, 7))}>Heute</button><div className="campaign-view-toggle" aria-label="Kalenderansicht"><button aria-label="Monatsansicht" aria-pressed={view === "month"} onClick={() => setView("month")}><CalendarDays size={18} /></button><button aria-label="Listenansicht" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={18} /></button></div></div></div>
      <div className="campaign-calendar-summary" role="status">{calendar.isPending ? "Entwürfe werden geladen…" : `${monthEntries.length} ${monthEntries.length === 1 ? "Zuordnung" : "Zuordnungen"} im ${monthTitle}`}{calendar.isFetching && !calendar.isPending ? " · Wird aktualisiert…" : ""}</div>
      {!calendar.isPending && !calendar.error && monthEntries.length === 0 && <p className="campaign-month-empty">Für diesen Monat sind keine Entwürfe zugeordnet.{selected && <button onClick={() => setMonth(selected.start_date.slice(0, 7))}>Zum Kampagnenbeginn</button>}</p>}
      <div className={`campaign-calendar-content campaign-view-${view}`}>
        <div className="campaign-month-grid" aria-label={monthTitle}><div className="campaign-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div><div className="campaign-days">{days.map(day => <section key={day} className={`campaign-day${day.startsWith(month) ? "" : " campaign-other-month"}${day === today ? " campaign-today" : ""}`} aria-label={formatDate(day)}><time className="campaign-day-number" dateTime={day}>{Number(day.slice(-2))}{day === today && <span>Heute</span>}</time><div className="campaign-day-entries">{groupEntries(entriesByDay.get(day) ?? []).map(group => <CalendarCard key={group[0].id} entries={group} color={colors.get(group[0].campaign_id)} open={() => setPreview(group)} />)}</div></section>)}</div></div>
        <div className="campaign-agenda" aria-label="Entwürfe als Liste">{days.filter(day => day.startsWith(month) && entriesByDay.has(day)).map(day => <section className="campaign-agenda-day" key={day}><h3><time dateTime={day}>{parseDate(day).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" })}</time>{day === today && <span>Heute</span>}</h3><div>{groupEntries(entriesByDay.get(day) ?? []).map(group => <CalendarCard key={group[0].id} entries={group} color={colors.get(group[0].campaign_id)} open={() => setPreview(group)} />)}</div></section>)}</div>
      </div>
    </section>
    {canWrite && editor && <CampaignEditor org={org} campaign={editor.campaign} saved={campaignSaved} close={() => setEditor(null)} />}
    {preview && <DraftPreview entries={preview} color={colors.get(preview[0].campaign_id)} campaigns={campaigns.data ?? []} canWrite={canWrite} close={() => setPreview(null)} edit={entry => { const campaign = campaigns.data?.find(item => item.id === entry.campaign_id); if (campaign) { setPreview(null); setAssignment({ campaign, entry }); } }} />}
    {canWrite && assignment && <EntryAssignment org={org} {...assignment} close={() => setAssignment(null)} saved={desiredDate => { refresh(); setMonth(desiredDate.slice(0, 7)); setAssignment(null); setNotice("Zuordnung gespeichert. Die Veröffentlichung bleibt unverändert."); }} />}
    {canWrite && generation && <GenerationDialog org={org} campaign={generation} close={() => setGeneration(null)} saved={() => { refresh(); setGeneration(null); setNotice("Erstellungsauftrag gespeichert. Den Fortschritt findest du unter Regeln & Erstellungsaufträge."); }} />}
  </div>;
}
