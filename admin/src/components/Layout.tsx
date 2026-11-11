import { WorkspaceAssistantProvider, useWorkspaceAssistant } from "./WorkspaceAssistantState";
import { AssistantLauncher, WorkspaceAssistantPanel } from "./WorkspaceAssistant";
import { logoutServer } from "../hub/Oidc";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, assetUrl } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { FireFlintBrand, UiIcon } from "./Brand";
import { fetchHubContracts, type HubModule } from "../hub/common";
import type { ContentType } from "../types";

const TITLES: Record<string, string> = {
  hub: "Unternehmenshub", "": "Übersicht", content: "Inhalte", campaigns: "Kampagnen & Kalender", brand: "Marke & Website", instagram: "Instagram", "content-types": "Inhaltstypen", media: "Medien",
  websites: "Websites", tokens: "API-Tokens", team: "Team", ai: "KI-Workflows",
  webhooks: "Webhooks", audit: "Aktivität", account: "Konto & Sicherheit", storage: "Speicher & Residenz", cluster: "Cluster",
};
const ROLE_LABEL = { owner: "Inhaber", editor: "Redaktion", viewer: "Lesezugriff" };

export function Layout() {
  const { user, activeOrg, memberships } = useAuth();
  const role = memberships.find(m => m.org_id === activeOrg)?.role;
  return <WorkspaceAssistantProvider key={`${user?.id}:${activeOrg}:${role}`} org={activeOrg} allowed={!!activeOrg && (role === "owner" || role === "editor")}><WorkspaceLayout /></WorkspaceAssistantProvider>;
}
function WorkspaceLayout() {
  const assistant = useWorkspaceAssistant();
  const { user, memberships, activeOrg: org, platformAdmin, logout, switchOrg } = useAuth();
  const membership = memberships.find(m => m.org_id === org);
  const role = membership?.role;
  const orgName = membership?.org_name;
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);


  useEffect(() => {
    if (previousPath.current !== location.pathname) {
      previousPath.current = location.pathname;
      setMenuOpen(false);
      mainRef.current?.focus({ preventScroll: true });
    }
  }, [location.pathname]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuOpen) { setMenuOpen(false); menuButton.current?.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  const types = useQuery({ queryKey: ["content-types", org], queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`), enabled: !!org });
  const hubModules = useQuery({ queryKey: ["hub", org, "modules"], queryFn: () => api.get<HubModule[]>(`/api/orgs/${org}/hub/modules`), enabled: !!org });
  const hubContracts = useQuery({ queryKey: ["hub", org, "contracts"], queryFn: () => fetchHubContracts(org!), enabled: !!org });
  const hubPaths: Record<string, string> = { devices: "devices", work: "work", forms: "forms", integrations: "integrations", translations: "translations", media: "media", booking: "bookings", notifications: "notifications", service_access: "service-access", quality: "quality" };
  const sectionKey = location.pathname.split("/").filter(Boolean)[0] ?? "";
  const recordKind = location.pathname.split("/")[3];
  const hubTitle = location.pathname.startsWith("/hub/records/")
    ? hubContracts.data?.kinds.find(kind => kind.key === recordKind)?.name
    : location.pathname === "/hub/modules" ? "Module"
    : location.pathname === "/hub/kinds" ? "Datentypen"
    : hubModules.data?.find(module => hubPaths[module.key] && location.pathname.startsWith(`/hub/${hubPaths[module.key]}`))?.name;
  const section = hubTitle ?? (sectionKey === "content" ? types.data?.find(type => type.key === location.pathname.split("/")[2])?.name : undefined)
    ?? (location.pathname === "/ai/assistant" ? "KI-Assistent" : location.pathname === "/ai/connectors" ? "Agenten & KI" : TITLES[sectionKey]) ?? "Übersicht";
  useEffect(() => { document.title = orgName ? `FireFlint · ${section} — ${orgName}` : `FireFlint · ${section}`; }, [section, orgName]);
  useEffect(() => {
    navigationRef.current?.querySelectorAll("details").forEach(group => {
      if (group.querySelector('a[aria-current="page"]')) group.open = true;
    });
  }, [location.pathname, hubModules.data, hubContracts.data]);
  const navClass = ({ isActive }: { isActive: boolean }) => isActive ? "active" : "";

  return <div className="shell">
    <a className="skip-link" href="#main-content">Zum Inhalt springen</a>
    <aside className={`sidebar${menuOpen ? " menu-open" : ""}`} aria-label="Arbeitsbereich">
      <div className="sidebar-brand-row"><NavLink to="/" className="brand-link" aria-label="FireFlint Übersicht"><FireFlintBrand /></NavLink>
        <button className="mobile-nav-toggle" ref={menuButton} aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(open => !open)}><UiIcon name={menuOpen ? "close" : "menu"} />{menuOpen ? "Schließen" : "Menü"}</button>
      </div>
      {memberships.length > 0 ? <div className="org-context"><label className="org-context-label" htmlFor="workspace-org">Aktueller Bereich</label>
        <select id="workspace-org" className="org-switch" value={org ?? ""} onChange={e => switchOrg(e.target.value)} aria-label="Organisation wechseln">
          {memberships.map(m => <option key={m.org_id} value={m.org_id}>{m.org_name || m.org_id}</option>)}
        </select>
      </div> : <p className="nav-note">Kein Arbeitsbereich zugewiesen</p>}
      <div className="sidebar-body" id="workspace-navigation">
        <div className="nf-sidebar-scroll">
        <nav className="nav" aria-label="Hauptnavigation" ref={navigationRef} onClick={event => {
          if (menuOpen && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
            && event.target instanceof Element && event.target.closest("a[href]")) {
            setMenuOpen(false); mainRef.current?.focus({ preventScroll: true });
          }
        }}>
          <NavLink to="/" end className={navClass}><UiIcon name="overview" />Übersicht</NavLink>
          {org && <>
          <div className="nav-section">Unternehmenshub</div>
          <NavLink to="/hub" end className={navClass}><UiIcon name="overview" />Daten & Zusammenarbeit</NavLink>
          {hubContracts.data?.kinds.some(k => hubModules.data?.some(m => m.enabled && m.key === k.module)) && <details className="nav-technical nav-group"><summary>Stammdaten<UiIcon name="chevron" /></summary>
          {hubContracts.data?.kinds.filter(k => hubModules.data?.some(m => m.enabled && m.key === k.module)).map(k => <NavLink key={k.key} to={`/hub/records/${k.key}`} className={navClass}><UiIcon name={k.key === "contact" ? "team" : "content"} />{k.name}</NavLink>)}
          </details>}
          <details className="nav-technical nav-group"><summary>Module &amp; Werkzeuge<UiIcon name="chevron" /></summary>
          {hubModules.data?.filter(m => m.enabled && !m.required).map(m => <NavLink key={m.key} to={`/hub/${hubPaths[m.key] ?? "modules"}`} className={navClass}><UiIcon name={m.key === "media" ? "media" : "activity"} />{m.name}</NavLink>)}
          <NavLink to="/hub/modules" className={navClass}><UiIcon name="settings" />Module</NavLink>
          <NavLink to="/hub/kinds" className={navClass}><UiIcon name="content" />Datentypen</NavLink>
          </details>
          {hubModules.isError && <button className="nav-retry" onClick={() => hubModules.refetch()}>Hub-Navigation erneut laden</button>}
          <div className="nav-section">Website-Inhalte</div>
          {types.isPending && <p className="nav-note" role="status">Inhaltstypen werden geladen…</p>}
          {types.isError && <button className="nav-retry" onClick={() => types.refetch()}>Inhaltstypen erneut laden</button>}
          {types.data?.map(t => <NavLink key={t.id} to={`/content/${t.key}`} className={navClass}><UiIcon name="content" /><span>{t.name}</span></NavLink>)}
          {types.data?.length === 0 && <p className="nav-note">Noch keine Inhaltstypen.</p>}
          <NavLink to="/brand" className={navClass}><UiIcon name="website" />Marke &amp; Website</NavLink>
          <NavLink to="/campaigns" className={navClass}><UiIcon name="board" />Kampagnen &amp; Kalender</NavLink>
          <NavLink to="/media" className={navClass}><UiIcon name="media" />Medien</NavLink>
          <NavLink to="/instagram" className={navClass}><UiIcon name="activity" />Instagram</NavLink>
          {(role === "owner" || role === "editor") && <>
            <div className="nav-section">Unterstützung</div>
            <NavLink to="/ai/assistant" className={navClass}><UiIcon name="spark" />KI-Assistent</NavLink>
            <NavLink to="/ai/connectors" className={navClass}><UiIcon name="settings" />Agenten &amp; KI</NavLink>
            <NavLink to="/ai/workflows" className={navClass}><UiIcon name="spark" />KI-Workflows<span className="nav-beta">Beta</span></NavLink>
          </>}
          {role === "owner" && <>
            <div className="nav-section">Verwaltung</div>
            <NavLink to="/websites" className={navClass}><UiIcon name="website" />Websites</NavLink>
            <NavLink to="/content-types" className={navClass}><UiIcon name="settings" />Inhaltstypen</NavLink>
            <NavLink to="/team" className={navClass}><UiIcon name="team" />Team</NavLink>
            <NavLink to="/audit" className={navClass}><UiIcon name="activity" />Aktivität</NavLink>
            <details className="nav-technical"><summary>Verbindungen<UiIcon name="chevron" /></summary>
              <NavLink to="/tokens" className={navClass}><UiIcon name="key" />API-Tokens</NavLink>
              <NavLink to="/webhooks" className={navClass}><UiIcon name="activity" />Webhooks</NavLink>
            </details>
          </>}
          {platformAdmin && <details className="nav-technical"><summary>Plattform<UiIcon name="chevron" /></summary>
            <NavLink to="/storage" className={navClass}>Speicher &amp; Residenz</NavLink>
            {(import.meta.env.DEV || !!import.meta.env.VITE_BFF_URL) && <NavLink to="/cluster" className={navClass}>Cluster <span className="nav-beta">Optional</span></NavLink>}
          </details>}
          </>}
        </nav>
        <div className="sidebar-footer">
          <NavLink className="account-link" to="/account"><UiIcon name="settings" />Konto &amp; Sicherheit</NavLink>
          {role === "owner" && <a className="nav-doclink" href={assetUrl("/openapi.json")} target="_blank" rel="noreferrer">API-Dokumentation <UiIcon name="external" size={16} /></a>}
        </div>
        </div>
        <footer className="nf-sidebar-session" aria-label="Dein Konto">
          <div className="nf-sidebar-user"><span className="nf-sidebar-avatar" aria-hidden="true">{(user?.name || user?.email || "F").slice(0, 1).toUpperCase()}</span><div className="nf-sidebar-user-copy"><span title={user?.name || user?.email}>{user?.name || user?.email}</span><small title={user?.email}>{role ? ROLE_LABEL[role] : user?.email}</small></div></div>
          <button className="nf-sidebar-logout" type="button" onClick={() => void logoutServer(logout)}><UiIcon name="logout" size={20} /><span>Abmelden</span></button>
        </footer>
      </div>
    </aside>
    <div className={`workspace-body${assistant.open && !assistant.fullPage ? " ff-assistant-is-open" : ""}`}><header className="workspace-header"><span>Aktueller Bereich <span aria-hidden="true">/</span> <strong>{section}</strong></span><span className="workspace-name">{orgName}</span><AssistantLauncher /></header>
      <main className="main" id="main-content" tabIndex={-1} ref={mainRef}>
        {org || location.pathname === "/account" ? <Outlet /> : <section className="panel empty-state" aria-labelledby="no-workspace-title">
          <span className="empty-symbol"><UiIcon name="team" /></span><h1 id="no-workspace-title">Noch kein Arbeitsbereich</h1>
          <p className="hint">Dein Konto ist angemeldet, aber keinem Arbeitsbereich zugewiesen. Bitte die zuständige Person, dich zu ihrem Team hinzuzufügen.</p>
          <div className="empty-actions"><NavLink className="button primary" to="/account">Konto &amp; Sicherheit</NavLink></div>
        </section>}
      </main>
      <WorkspaceAssistantPanel section={section} />
    </div>
  </div>;
}
