import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { UiIcon } from "../components/Brand";
import { timeAgo } from "../lib/time";
import type { AuditEntry, ContentType, OrgOverview } from "../types";
import "../dashboard-ux.css";

const ACTION_LABEL: Record<string, string> = {
  "content.create": "Inhalt angelegt", "content.update": "Entwurf geändert",
  "content.publish": "Inhalt veröffentlicht", "content.unpublish": "Inhalt zurückgezogen",
  "content.delete": "Inhalt gelöscht", "content.schedule": "Veröffentlichung geplant",
  "content.channels": "Website-Zuweisung geändert", "content_type.create": "Inhaltstyp angelegt",
  "asset.upload": "Medium hochgeladen", "webhook.create": "Webhook erstellt", "member.add": "Mitglied hinzugefügt",
};

function Stat({ label, value, to, href }: { label: string; value?: number; to?: string; href?: string }) {
  const children = <><span className="stat-label">{label}</span><span className="stat-value">{value == null ? "—" : value.toLocaleString("de-DE")}</span>{(to || href) && <UiIcon name="arrow" />}</>;
  return to ? <Link to={to} className="stat-card">{children}</Link>
    : href ? <a href={href} className="stat-card">{children}</a> : <div className="stat-card">{children}</div>;
}

export function DashboardPage() {
  const org = useOrg();
  const { memberships } = useAuth();
  const membership = memberships.find(m => m.org_id === org);
  const role = membership?.role;
  const canWrite = role === "owner" || role === "editor";
  const overview = useQuery({ queryKey: ["overview", org], queryFn: () => api.get<OrgOverview>(`/api/orgs/${org}/overview`) });
  const types = useQuery({ queryKey: ["content-types", org], queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`) });
  const audit = useQuery({ queryKey: ["audit", org, 6], queryFn: () => api.get<{ entries: AuditEntry[] }>(`/api/orgs/${org}/audit?limit=6`), enabled: role === "owner", retry: false });
  const ov = overview.isError ? undefined : overview.data;
  const firstType = types.data?.[0];
  const contentLink = firstType ? `/content/${firstType.key}` : undefined;

  const steps = ov ? [
    { title: "Inhaltstypen angelegt", detail: "Inhaltstypen bestimmen, welche Angaben gepflegt werden.", done: ov.content_types > 0, to: role === "owner" ? "/content-types" : contentLink, action: role === "owner" ? "Inhaltstypen ansehen" : "Inhalte ansehen" },
    { title: "Websites eingerichtet", detail: "Websites legen fest, wo Inhalte erscheinen können.", done: ov.websites > 0, to: role === "owner" ? "/websites" : undefined, action: "Websites verwalten" },
    { title: "Inhalte gespeichert", detail: "Zentrale Inhalte und ihre Website-Zuordnungen bleiben gemeinsam sichtbar.", done: ov.content_total > 0, to: contentLink ? `${contentLink}${canWrite && ov.content_total === 0 ? "/new" : ""}` : undefined, action: ov.content_total > 0 ? "Inhalte öffnen" : "Inhalt anlegen" },
    { title: "Erste Veröffentlichung", detail: "Änderungen werden erst nach einer ausdrücklichen Veröffentlichung ausgeliefert.", done: ov.content_published > 0, to: contentLink, action: "Inhalte prüfen" },
  ] : [];

  const stepsDone = steps.filter(step => step.done).length;
  const setupComplete = steps.length > 0 && stepsDone === steps.length;
  let nextTitle = "Arbeitsbereich wird geladen";
  let nextDetail = "Die nächste Aktion erscheint, sobald die Übersicht bereit ist.";
  let nextTo: string | undefined;
  let nextLabel: string | undefined;

  if (overview.isError) {
    nextTitle = "Übersicht nicht verfügbar";
    nextDetail = "Lade die Übersicht erneut, um die nächsten Schritte zu sehen.";
  } else if (overview.isPending) {
    nextTitle = "Übersicht wird geladen";
  } else if (types.isError) {
    nextTitle = "Inhaltstypen nicht verfügbar";
    nextDetail = "Lade die Inhaltstypen erneut, um deine Inhalte zu öffnen.";
  } else if (types.isPending) {
    nextTitle = "Inhaltstypen werden geladen";
    nextDetail = "Dein nächster Schritt wird vorbereitet.";
  } else if (role === "owner" && ov?.content_types === 0) {
    nextTitle = "Inhaltstyp einrichten";
    nextDetail = "Lege fest, welche Angaben ein Standort, Teammitglied oder Stellenangebot braucht.";
    nextTo = "/content-types/new";
    nextLabel = "Ersten Inhaltstyp anlegen";
  } else if (role === "owner" && ov?.websites === 0) {
    nextTitle = "Website verbinden";
    nextDetail = "Trage eine Website ein, damit du Inhalte gezielt zuordnen kannst.";
    nextTo = "/websites";
    nextLabel = "Website einrichten";
  } else if (firstType && ov?.content_total === 0 && canWrite) {
    nextTitle = "Ersten Inhalt anlegen";
    nextDetail = "Beginne mit einem Entwurf und ordne ihn den passenden Websites zu.";
    nextTo = `${contentLink}/new`;
    nextLabel = "Inhalt anlegen";
  } else if (firstType && ov && ov.content_total > 0) {
    nextTitle = "Inhalte öffnen";
    nextDetail = role === "viewer" ? "Sieh dir die vorhandenen Inhalte und ihre Website-Zuordnungen an." : "Prüfe vorhandene Inhalte und ihre Website-Zuordnungen.";
    nextTo = contentLink;
    nextLabel = "Inhalte ansehen";
  } else if (role === "owner" && ov?.content_types) {
    nextTitle = "Inhaltstypen ansehen";
    nextDetail = "Öffne die vorhandenen Inhaltstypen, um im Arbeitsbereich weiterzumachen.";
    nextTo = "/content-types";
    nextLabel = "Inhaltstypen ansehen";
  } else {
    nextTitle = "Auf Einrichtung warten";
    nextDetail = role === "viewer" ? "Sobald Inhalte eingerichtet sind, kannst du sie hier öffnen." : "Bitte den Owner, zuerst einen Inhaltstyp einzurichten.";
  }

  const roleLabel = role === "owner" ? "Inhaber" : role === "editor" ? "Redaktion" : role === "viewer" ? "Lesezugriff" : undefined;

  return <div className="dashboard-page">
    <div className="dashboard-head">
      <div><h1>Dein Arbeitsbereich</h1></div>
      <div className="dashboard-context">{roleLabel && <span className="dashboard-role">{roleLabel}</span>}<span className="workspace-pill">{membership?.org_name}</span></div>
    </div>

    <section className="dashboard-next" aria-labelledby="dashboard-next-title" aria-busy={overview.isPending || types.isPending}>
      <div className="dashboard-next-copy">
        <p className="dashboard-kicker">NÄCHSTER SCHRITT</p>
        <h2 id="dashboard-next-title">{nextTitle}</h2>
        <p className="dashboard-next-detail">{nextDetail}</p>
        <div className="dashboard-actions">
          {nextTo && nextLabel && <Link className="button primary" to={nextTo}>{nextLabel}<UiIcon name="arrow" /></Link>}
          <a className="dashboard-secondary" href="#content-collections">Inhalte im Überblick<UiIcon name="arrow" /></a>
          {role === "owner" && ov && ov.websites > 0 && <Link className="dashboard-secondary" to="/websites">Websites verwalten<UiIcon name="arrow" /></Link>}
        </div>
      </div>
    </section>

    {overview.isPending && <p className="hint" role="status">Dein Arbeitsbereich wird geladen…</p>}
    {overview.isError && <div className="panel inline-error" role="alert"><p>Die Übersicht konnte nicht geladen werden.</p><button onClick={() => overview.refetch()}>Übersicht erneut laden</button></div>}

    <div className="stat-grid dashboard-stat-grid" aria-label="Aktueller Bestand" aria-busy={overview.isPending}>
      <Stat label="Inhalte insgesamt" value={ov?.content_total} href="#content-collections" />
      <Stat label="Veröffentlicht" value={ov?.content_published} />
      <Stat label="Websites" value={ov?.websites} to={role === "owner" ? "/websites" : undefined} />
      <Stat label="Medien" value={ov?.assets} to="/media" />
    </div>

    <section className="content-collections" id="content-collections" aria-labelledby="collections-title"><div className="section-heading"><div><p className="eyebrow">ZENTRAL PFLEGEN</p><h2 id="collections-title">Deine Inhalte</h2></div>{role === "owner" && <Link className="text-link" to="/content-types">Inhaltstypen verwalten <UiIcon name="arrow" /></Link>}</div>
      {types.isPending && <p className="hint" role="status">Inhaltstypen werden geladen…</p>}
      {types.isError && <div className="panel" role="alert"><p>Die Inhalte konnten nicht geladen werden.</p><button onClick={() => types.refetch()}>Inhalte erneut laden</button></div>}
      {types.data?.length === 0 && <div className="panel empty-state"><span className="empty-symbol"><UiIcon name="content" /></span><h3>Noch Platz für deine Inhalte.</h3><p className="hint">{role === "owner" ? "Lege einen Inhaltstyp an, zum Beispiel für Standorte, Teammitglieder oder Stellenangebote." : "Sobald ein Inhaltstyp eingerichtet ist, findest du die Inhalte hier."}</p>{role === "owner" && <Link className="button primary" to="/content-types/new">Inhaltstyp anlegen</Link>}</div>}
      <div className="collection-grid">{types.data?.map(type => <article className="collection-card" key={type.id}><span className="collection-symbol"><UiIcon name="content" /></span><h3><Link to={`/content/${type.key}`}>{type.name}</Link></h3><p>{(type.schema.fields ?? []).length} {(type.schema.fields ?? []).length === 1 ? "Feld" : "Felder"} im Inhaltstyp</p><div className="collection-actions"><Link to={`/content/${type.key}`}>Inhalte öffnen<UiIcon name="arrow" /></Link>{canWrite && <Link className="collection-add" to={`/content/${type.key}/new`} aria-label={`${type.name}: Inhalt anlegen`}><UiIcon name="plus" /></Link>}</div></article>)}</div>
    </section>

    <div className={`dashboard-lower${role !== "owner" ? " single-column" : ""}`}>
      <section className="panel setup-panel" aria-labelledby="setup-title">
        {ov ? <details className="setup-details" open={!setupComplete}>
          <summary className="setup-summary"><span><span className="eyebrow">ARBEITSBEREICH EINRICHTEN</span><h2 className="setup-heading" id="setup-title">Schritt für Schritt</h2></span><span className="setup-count">{stepsDone} / {steps.length}</span><UiIcon name="chevron" /></summary>
          <ol className="setup-list">{steps.map((step, index) => <li key={step.title} className={step.done ? "step-done" : ""}><span className="step-index" aria-label={step.done ? "Erledigt" : "Noch offen"}>{step.done ? <UiIcon name="check" /> : index + 1}</span><div><h3>{step.title}</h3><p>{step.detail}</p>{step.to ? <Link to={step.to}>{step.action}<UiIcon name="arrow" /></Link> : <span className="hint">{step.done ? "Im Arbeitsbereich vorhanden." : role === "owner" ? "Zuerst einen Inhaltstyp einrichten." : "Wird im Arbeitsbereich eingerichtet."}</span>}</div></li>)}</ol>
        </details> : <><div className="section-heading"><div><p className="eyebrow">ARBEITSBEREICH EINRICHTEN</p><h2 id="setup-title">Schritt für Schritt</h2></div></div><p className="hint">Die Schritte erscheinen, sobald die Übersicht geladen ist.</p></>}
      </section>
      {role === "owner" && <section className="panel activity-panel" aria-labelledby="activity-title"><div className="section-heading"><div><p className="eyebrow">ÄNDERUNGEN IM BLICK</p><h2 id="activity-title">Letzte Aktivität</h2></div><UiIcon name="activity" /></div>
        {audit.isPending ? <p className="hint" role="status">Aktivität wird geladen…</p> : audit.isError ? <div role="alert"><p className="hint">Das Protokoll konnte nicht geladen werden.</p><button onClick={() => audit.refetch()}>Aktivität erneut laden</button></div>
          : audit.data?.entries.length === 0 ? <div className="activity-empty"><span className="empty-symbol"><UiIcon name="activity" /></span><h3>Hier beginnt dein Verlauf.</h3><p className="hint">Sobald Inhalte oder Einstellungen geändert werden, erscheinen die Einträge hier.</p></div>
            : <ol className="activity-list">{audit.data?.entries.map(entry => <li key={entry.id}><span className="activity-dot" aria-hidden="true" /><div><strong>{ACTION_LABEL[entry.action] ?? entry.action}</strong><span>{entry.user_email ?? "System"}</span></div><time dateTime={entry.created_at} title={new Date(entry.created_at).toLocaleString("de-DE")}>{timeAgo(entry.created_at)}</time></li>)}</ol>}
        <Link className="text-link activity-link" to="/audit">Vollständiges Protokoll<UiIcon name="arrow" /></Link>
      </section>}
    </div>
  </div>;
}
