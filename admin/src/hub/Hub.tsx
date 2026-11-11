import { useState, type ReactNode } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { FireFlintMark, UiIcon } from "../components/Brand";
import { QualityPage } from "./QualityPage";
import { ServiceAccessPage } from "./ServiceAccessPage";
import { KindsPage } from "./Kinds";
import { RecordsPage } from "./Records";
import { CompanyDossier } from "./CompanyDossier";
import { FormsPage } from "./Forms";
import { WorkPage, NotificationsPage } from "./Work";
import { TranslationsPage, HubMediaPage, BookingsPage } from "./Resources";
import { IntegrationsPage } from "./Integrations";
import { ConnectorsPage, ConnectorPage } from "./Connectors";
import { AssistantPage } from "./Assistant";
import { DevicesPage } from "./Devices";
import { FlintPlatePage } from "./FlintPlate";
import { allRecords, ErrorNotice, PageTitle, Pager, Empty, ModuleGate, formatDate, useAction, useHub, useHubQuery, type HubModule } from "./common";
import "./hub.css";

export const modulePaths: Record<string, string> = { devices: "/hub/devices", directory: "/hub/records/company", notifications: "/hub/notifications", work: "/hub/work", forms: "/hub/forms", integrations: "/hub/integrations", translations: "/hub/translations", media: "/hub/media", booking: "/hub/bookings", service_access: "/hub/service-access", quality: "/hub/quality" };
function Guard({ module, children }: { module: string; children: ReactNode }) { return <ModuleGate module={module}>{children}</ModuleGate>; }
export function HubPage() {
  const { org, user, canWrite } = useHub();
  const location = useLocation();
  return <div className="hub" key={`${user?.id}:${org}:${location.pathname}`}>
    {!canWrite && <p className="hub-reader">Lesezugriff · Du kannst die Daten ansehen. Änderungen sind mit deiner Rolle nicht verfügbar.</p>}
    <Routes>
      <Route index element={<Overview />} />
      <Route path="modules" element={<ModulesPage />} />
      <Route path="kinds" element={<KindsPage />} />
      <Route path="kinds/:key" element={<KindsPage />} />
      <Route path="companies/:id" element={<CompanyDossier />} />
      <Route path="records/:kind" element={<RecordsPage />} />
      <Route path="records/:kind/:id" element={<RecordsPage />} />
      <Route path="forms/*" element={<Guard module="forms"><FormsPage /></Guard>} />
      <Route path="work/*" element={<Guard module="work"><WorkPage /></Guard>} />
      <Route path="notifications" element={<Guard module="notifications"><NotificationsPage /></Guard>} />
      <Route path="translations/*" element={<Guard module="translations"><TranslationsPage /></Guard>} />
      <Route path="media/*" element={<Guard module="media"><HubMediaPage /></Guard>} />
      <Route path="bookings/*" element={<Guard module="booking"><BookingsPage /></Guard>} />
      <Route path="import" element={<Guard module="integrations"><IntegrationsPage /></Guard>} />
      <Route path="integrations" element={<Guard module="integrations"><IntegrationsPage /></Guard>} />
      <Route path="integrations/assistant" element={<Guard module="integrations"><AssistantPage /></Guard>} />
      <Route path="integrations/flintplate" element={<Guard module="integrations"><FlintPlatePage /></Guard>} />
      <Route path="integrations/flintplate/:id" element={<Guard module="integrations"><FlintPlatePage /></Guard>} />
      <Route path="integrations/connectors" element={<Guard module="integrations"><ConnectorsPage /></Guard>} />
      <Route path="integrations/connectors/:id" element={<Guard module="integrations"><ConnectorPage /></Guard>} />
      <Route path="devices" element={<Guard module="devices"><DevicesPage /></Guard>} />
      <Route path="devices/:id" element={<Guard module="devices"><DevicesPage /></Guard>} />
      <Route path="quality" element={<QualityPage />} />
      <Route path="service-access" element={<ServiceAccessPage />} />
      <Route path="events" element={<EventsPage />} />
      <Route path="*" element={<Empty><h1>Diese Hub-Seite gibt es nicht.</h1><Link to="/hub">Zum Unternehmenshub</Link></Empty>} />
    </Routes>
  </div>;
}
function Overview() {
  const { base, org, contracts, modules } = useHub();
  const summary = useHubQuery<{ records: Record<string, number> }>("summary", "");
  const action = useAction();
  const enabledKinds = contracts.data?.kinds.filter(k => modules.data?.some(m => m.enabled && m.key === k.module)) ?? [];
  async function exportRecords() {
    await action.run(async () => {
      const records = await allRecords(base, enabledKinds, true);
      const content = { format: "fireflint.central-records", version: 1, organization: org, exported_at: new Date().toISOString(), kinds: enabledKinds, records };
      const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `fireflint-stammdaten-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  return <><PageTitle title="Alles, was dein Unternehmen verbindet." description="Stammdaten gemeinsam pflegen, Arbeit abstimmen und Daten bewusst weitergeben."><Link className="button" to="/hub/modules">Module verwalten</Link></PageTitle>
    <section className="hub-intro"><div><span className="eyebrow">EIN GEMEINSAMER DATENBESTAND</span><h2>Von der Information zur Zusammenarbeit.</h2><p>Unternehmen, Menschen und Standorte an einem Ort. Hier gespeicherte interne Daten bleiben im Arbeitsbereich. Website-Inhalte veröffentlichst du weiterhin ausdrücklich in der Inhaltsverwaltung.</p><Link to="/hub/records/company" className="button primary">Unternehmensdaten öffnen<UiIcon name="arrow" /></Link></div><div className="hub-intro-mark" aria-hidden="true"><span><FireFlintMark /></span><i /><i /><i /></div></section>
    <ErrorNotice error={summary.error || contracts.error || modules.error} onReload={() => { void summary.refetch(); void contracts.refetch(); void modules.refetch(); }} />
    <div className="hub-section-title"><h2>Deine Stammdaten</h2><Link to="/hub/events">Änderungen ansehen<UiIcon name="arrow" /></Link></div><div className="hub-card-grid">{enabledKinds.map(kind => <Link className="hub-stat-card" to={`/hub/records/${kind.key}`} key={kind.key}><span className="hub-stat-number">{summary.data ? summary.data.records[kind.key] ?? 0 : "—"}</span><strong>{kind.name}</strong><span className="hint">Aktive Datensätze <UiIcon name="arrow" /></span></Link>)}</div>
    <div className="hub-section-title"><h2>Deine Werkzeuge</h2><span className="hint">Passend zu deinem Arbeitsbereich</span></div><div className="hub-card-grid">{modules.data?.filter(m => m.enabled && !m.required).map(module => <Link className="panel hub-tool" key={module.key} to={modulePaths[module.key] ?? "/hub/modules"}><h3>{module.name}<UiIcon name="arrow" /></h3><p>{module.description}</p></Link>)}{!modules.data?.some(m => m.enabled && !m.required) && <section className="panel"><h3>Wachse mit deinen Aufgaben</h3><p>Ergänze Formulare, Aufgaben, Datenaustausch und weitere Werkzeuge, wenn dein Team sie braucht.</p><Link to="/hub/modules">Verfügbare Module ansehen<UiIcon name="arrow" /></Link></section>}</div>
    <section className="panel hub-export"><div><h2>Stammdaten mitnehmen</h2><p className="hint">Exportiert alle aktiven und archivierten zentralen Datensätze der aktivierten Datentypen über sämtliche Ergebnisseiten. Enthält keine Zugangsdaten. Während des Exports können parallele Änderungen stattfinden.</p></div><button disabled={action.busy || !enabledKinds.length} onClick={() => void exportRecords()}>{action.busy ? "Export wird erstellt…" : "Stammdaten exportieren"}</button></section><ErrorNotice error={action.error} />
  </>;
}
function ModulesPage() {
  const { modules, isOwner, base, invalidate } = useHub();
  const action = useAction();
  const [captured, setCaptured] = useState<HubModule[] | null>(null);
  // Capture the list being acted upon; a background refresh must not silently
  // replace the revision of a failed toggle.
  const displayed = captured ?? modules.data;
  async function toggle(module: HubModule) {
    setCaptured(displayed ?? null);
    await action.run(async () => {
      const result = await api.put<HubModule[]>(`${base}/modules/${module.key}`, { enabled: !module.enabled, expected_revision: module.revision });
      setCaptured(result); await invalidate();
    });
  }
  async function reload() { await action.run(async () => { const result = await modules.refetch(); if (result.error) throw result.error; setCaptured(result.data ?? null); }); }
  return <><PageTitle title="Module" description="Aktiviere die Werkzeuge, die dein Team braucht. Bei einer Deaktivierung bleiben vorhandene Daten erhalten."><Link className="button" to="/hub/kinds">Datentypen verwalten</Link></PageTitle>{!isOwner && <p className="hub-reader">Nur Inhaber können Module aktivieren oder deaktivieren.</p>}<ErrorNotice error={action.error || modules.error} onReload={() => void reload()} />{modules.isPending && <p role="status">Module werden geladen…</p>}<div className="hub-module-grid">{displayed?.map(module => {
    const missing = module.dependencies.filter(dep => !displayed.some(m => m.key === dep && m.enabled));
    const dependents = displayed.filter(m => m.enabled && m.dependencies.includes(module.key));
    const blocked = !module.enabled ? missing.length > 0 : dependents.length > 0;
    return <section className={`panel hub-module${module.enabled ? " is-enabled" : ""}`} key={module.key}><div className="hub-inline"><h2>{module.name}</h2><span className={`badge ${module.enabled ? "published" : "draft"}`}>{module.required ? "Grundmodul" : module.enabled ? "Aktiv" : "Inaktiv"}</span></div><p>{module.description}</p><p className="hint">Version {module.version}{module.dependencies.length ? ` · Benötigt: ${module.dependencies.map(dep => displayed.find(m => m.key === dep)?.name ?? dep).join(", ")}` : ""}</p>{blocked && <p className="hint">{module.enabled ? "Zuerst deaktivieren: " : "Zuerst aktivieren: "}{(module.enabled ? dependents.map(m => m.name) : missing.map(dep => displayed.find(m => m.key === dep)?.name ?? dep)).join(", ")}</p>}<div className="hub-actions"><button disabled={!isOwner || module.required || blocked || action.busy} onClick={() => void toggle(module)}>{module.enabled ? "Deaktivieren" : "Aktivieren"}</button>{(module.enabled || (module.key === "service_access" && isOwner)) && <Link to={modulePaths[module.key] ?? "/hub"}>{module.enabled ? "Öffnen" : "Zugänge verwalten"}<UiIcon name="arrow" /></Link>}</div></section>;
  })}</div></>;
}
interface HubEvent { id: string; type: string; subject: string; time: string; actor: string; data: Record<string, unknown> }
function EventsPage() {
  const [offset, setOffset] = useState(0);
  const members = useHubQuery<{user_id:string;name:string;email:string}[]>("event-members", "/members");
  const events = useHubQuery<HubEvent[]>("events", `/events?offset=${offset}`);
  return <><PageTitle title="Änderungen im Arbeitsbereich" description="Nachvollziehbare Ereignisse zu Stammdaten und aktivierten Modulen." /><section className="panel"><ErrorNotice error={events.error} onReload={() => void events.refetch()} />{events.isPending && <p role="status">Änderungen werden geladen…</p>}{events.data?.length === 0 && <Empty>Noch keine Änderungen.</Empty>}<ol className="hub-events">{events.data?.map(event => <li key={event.id}><div><strong>{eventTitle(event.type)}</strong><time dateTime={event.time}>{formatDate(event.time)}</time></div><p className="hint">{event.subject} · Verantwortlich: {event.actor ? members.data?.find(member => member.user_id === event.actor)?.name || members.data?.find(member => member.user_id === event.actor)?.email || "früheres Teammitglied" : "Öffentliches Formular"}</p>{event.data.revision !== undefined && <small>Stand {String(event.data.revision)}</small>}</li>)}</ol><Pager offset={offset} count={events.data?.length ?? 0} onChange={setOffset} /></section></>;
}
function eventTitle(type: string) { const key = type.replace("de.fireflint.", ""); return ({ "menu.connected": "Menüquelle zugeordnet", "menu.connection_changed": "Menüzuordnung geändert", "menu.imported": "Menüentwurf importiert", "device.created": "Gerät erfasst", "device.updated": "Geräteinventar geändert", "record.created": "Datensatz angelegt", "record.updated": "Datensatz geändert", "record.linked": "Beziehung hinzugefügt", "record.unlinked": "Beziehung entfernt", "module.changed": "Modul geändert", "task.created": "Aufgabe angelegt", "task.decided": "Aufgabe entschieden", "task.commented": "Kommentar hinzugefügt", "form.saved": "Formular gespeichert", "form.submitted": "Formular eingegangen", "translation.saved": "Übersetzung gespeichert", "media.saved": "Medienangaben gespeichert", "booking.saved": "Termin gespeichert" } as Record<string, string>)[key] ?? key.replaceAll(".", " · "); }
