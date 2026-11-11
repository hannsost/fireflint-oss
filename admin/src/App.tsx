import { AssistantPage } from "./pages/AssistantPage";
import { OidcCallback } from "./hub/Oidc";
import { useLocation } from "react-router-dom";
import { HubPage } from "./hub/Hub";
import { PublicFormPage } from "./hub/Forms";
import { useHubSession } from "./hub/common";
import { AccountPage } from "./pages/AccountPage";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { SaasLoginFrame } from "./components/SaasLoginFrame";
import { InstagramPage } from "./pages/InstagramPage";
import { CampaignsPage } from "./pages/CampaignsPage";
import { BrandPage } from "./pages/BrandPage";
import { ContentListPage } from "./pages/ContentListPage";
import { ContentEditPage } from "./pages/ContentEditPage";
import { WebsitesPage } from "./pages/WebsitesPage";
import { TokensPage } from "./pages/TokensPage";
import { StoragePage } from "./pages/StoragePage";
import { ClusterPage } from "./pages/ClusterPage";
import { AuditPage } from "./pages/AuditPage";
import { TeamPage } from "./pages/TeamPage";
import { ContentTypesPage } from "./pages/ContentTypesPage";
import { ContentTypeEditPage } from "./pages/ContentTypeEditPage";
import { MediaPage } from "./pages/MediaPage";
import { DashboardPage } from "./pages/DashboardPage";
import { WebhooksPage } from "./pages/WebhooksPage";
import { AiWorkflowsPage } from "./pages/AiWorkflowsPage";
import { AiWorkflowEditPage } from "./pages/AiWorkflowEditPage";
import { AiConnectorsPage } from "./pages/AiConnectorsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { LegalPage } from "./pages/LegalPage";

export default function App() {
  const { user, loading, sessionError, reload, logout } = useAuth();
  const location = useLocation();

  useHubSession(user?.id ?? null, loading);

  if (location.pathname === "/oidc/callback") return <OidcCallback />;
  if (location.pathname.startsWith("/f/")) return <Routes><Route path="/f/:publicId" element={<PublicFormPage />} /></Routes>;
  // Legal information must be readable before the authentication lookup
  // completes. Nginx serves this SPA route without an API login requirement.
  if (location.pathname === "/legal" || location.pathname === "/en/legal") {
    return <Routes><Route path="/legal" element={<LegalPage language="de" />} /><Route path="/en/legal" element={<LegalPage language="en" />} /></Routes>;
  }

  if (loading) {
    return <div className="login-wrap muted">Lädt…</div>;
  }

  if (sessionError) {
    return <SaasLoginFrame product="fireflint" title="Verbindung unterbrochen" description="Deine Sitzung konnte gerade nicht geprüft werden.">
      <div className="nf-access-form">
        <p role="alert">{sessionError}</p>
        <button className="nf-access-primary" type="button" onClick={() => void reload()}>Erneut versuchen</button>
        <button className="button ghost" type="button" onClick={logout}>Anderes Konto verwenden</button>
      </div>
    </SaasLoginFrame>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/f/:publicId" element={<PublicFormPage />} />
        <Route path="*" element={<Navigate to="/login" state={{ returnTo: location.pathname + location.search + location.hash }} replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to={typeof location.state?.returnTo === "string" && location.state.returnTo.startsWith("/") && !location.state.returnTo.startsWith("//") && !location.state.returnTo.startsWith("/login") ? location.state.returnTo : "/"} replace />} />
      <Route path="/f/:publicId" element={<PublicFormPage />} />
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/hub/*" element={<HubPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/content/:typeKey" element={<ContentListPage />} />
        <Route path="/content/:typeKey/new" element={<ContentEditPage />} />
        <Route path="/content/:typeKey/:id" element={<ContentEditPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/brand" element={<BrandPage />} />
        <Route path="/instagram" element={<InstagramPage />} />
        <Route path="/websites" element={<WebsitesPage />} />
        <Route path="/tokens" element={<TokensPage />} />
        <Route path="/media" element={<MediaPage />} />
        <Route path="/content-types" element={<ContentTypesPage />} />
        <Route path="/content-types/new" element={<ContentTypeEditPage />} />
        <Route path="/content-types/:key" element={<ContentTypeEditPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/ai/assistant" element={<AssistantPage />} />
        <Route path="/ai/workflows" element={<AiWorkflowsPage />} />
        <Route path="/ai/workflows/:id" element={<AiWorkflowEditPage />} />
        <Route path="/ai/connectors" element={<AiConnectorsPage />} />
        <Route path="/webhooks" element={<WebhooksPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/storage" element={<StoragePage />} />
        <Route path="/cluster" element={<ClusterPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
