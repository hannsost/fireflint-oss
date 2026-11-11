import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { assetUrl, ApiError, tokens } from "../api/client";
import { useAuth } from "../auth/AuthContext";

const BROWSER_KEY = "fireflint.oidc.browser_token";
// One-shot protocol operations deliberately bypass the normal refresh/retry path.
async function oidcRequest<T>(path: string, body?: unknown, authorized = false): Promise<T> {
  const response = await fetch(assetUrl(path), { method: body === undefined ? "GET" : "POST", credentials: "omit", signal: AbortSignal.timeout(30000), headers: { "content-type": "application/json", ...(authorized && tokens.access ? { authorization: `Bearer ${tokens.access}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, typeof result.error === "string" ? result.error : "Anmeldung fehlgeschlagen.");
  return result as T;
}
function message(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Kein Zugriff auf FireFlint. Bitte app-fireflint oder all-apps bei einem Administrator freigeben lassen.";
    if (error.status === 409) return "Dieser Organisationszugang ist noch nicht mit einem FireFlint-Konto verbunden. Melde dich mit deinem lokalen Passwort an und verbinde den Zugang unter Konto & Sicherheit.";
    if (error.status === 429) return "Zu viele Versuche. Bitte warte kurz und versuche es erneut.";
    if (error.status === 503) return "Der Anmeldedienst ist gerade nicht erreichbar. Dein lokales FireFlint-Konto bleibt verfügbar.";
    if (error.status === 401) return "Der Anmeldenachweis ist abgelaufen oder ungültig. Starte die Anmeldung erneut. Prüfe beim Verknüpfen dein lokales Passwort.";
    return "Der Anmeldedienst hat die Anfrage nicht angenommen. Bitte starte den Vorgang erneut.";
  }
  if (error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")) return "Der Anmeldedienst ist gerade nicht erreichbar. Bitte versuche es erneut.";
  return error instanceof Error ? error.message : "Die Anmeldung konnte nicht abgeschlossen werden. Bitte starte sie erneut.";
}
async function start(purpose: "login" | "link", password?: string) {
  const version = tokens.version;
  const refresh = tokens.refresh;
  const result = await oidcRequest<{ authorization_url: string; browser_token: string }>("/auth/oidc/start", { purpose, ...(purpose === "link" ? { current_password: password } : {}) }, purpose === "link");
  if (version !== tokens.version || refresh !== tokens.refresh) return;
  if (!result.browser_token || !result.authorization_url) throw new Error("Der Anmeldedienst hat keine gültige Antwort gesendet.");
  sessionStorage.setItem(BROWSER_KEY, result.browser_token);
  window.location.assign(result.authorization_url);
}
export function OidcLogin() {
  const providers = useQuery({ queryKey: ["oidc-providers"], queryFn: () => oidcRequest<{ providers: { id: string; label: string }[] }>("/auth/oidc/providers"), retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function login() {
    if (busy) return;
    setBusy(true); setError("");
    try { await start("login"); } catch (cause) { setError(message(cause)); setBusy(false); }
  }
  if (!providers.data?.providers.length && !providers.error) return null;
  return <div className="oidc-login">{providers.data?.providers.map(provider => <button key={provider.id} type="button" disabled={busy} onClick={() => void login()}>{busy ? "Anmeldung wird geöffnet…" : `Mit ${provider.label} anmelden`}</button>)}{providers.error && <p className="hint">Organisationsanmeldung zurzeit nicht verfügbar. Du kannst dich mit deinem Passwort anmelden.</p>}{error && <p className="error" role="alert">{error}</p>}</div>;
}
export function OidcCallback() {
  const { acceptSession } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [error, setError] = useState("");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const version = tokens.version;
    const params = new URLSearchParams(window.location.search);
    window.history.replaceState(window.history.state, "", window.location.pathname);
    const browserToken = sessionStorage.getItem(BROWSER_KEY);
    sessionStorage.removeItem(BROWSER_KEY);
    const code = params.get("code"), state = params.get("state"), issuer = params.get("iss");
    if (params.has("error") || !code || !state || !browserToken) { setError("Die Anmeldung wurde abgebrochen oder ist abgelaufen. Bitte starte sie erneut."); return; }
    void (async () => {
      try {
        const result = await oidcRequest<{ status: string; access_token?: string; refresh_token?: string }>("/auth/oidc/finish", { code, state, browser_token: browserToken, ...(issuer ? { iss: issuer } : {}) }, true);
        if (!active.current || version !== tokens.version) return;
        if (result.status === "linked") { navigate("/account?oidc=linked", { replace: true }); return; }
        if (result.status !== "authenticated" || !result.access_token || !result.refresh_token) throw new Error("Der Anmeldedienst hat keine gültige Sitzung geliefert.");
        await acceptSession(result.access_token, result.refresh_token);
        if (active.current) navigate("/hub", { replace: true });
      } catch (cause) { setError(message(cause)); }
    })();
  }, [acceptSession, navigate]);
  return <div className="login-wrap"><section className="panel" style={{ maxWidth: 520 }}><h1>Organisationsanmeldung</h1>{error ? <><p className="error" role="alert">{error}</p><Link to="/login" className="button">Zur Anmeldung</Link></> : <p role="status">Dein Zugang wird geprüft…</p>}</section></div>;
}
export function OidcAccount() {
  const { user, logout } = useAuth();
  const [params] = useSearchParams();
  const account = useQuery({ queryKey: ["oidc-account", user?.id], queryFn: () => oidcRequest<{ linked: boolean; provider_label: string | null }>("/auth/oidc/account", undefined, true), enabled: !!user });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const version = tokens.version;
    const refresh = tokens.refresh;
    const entered = password; setPassword(""); setBusy(true); setError("");
    try {
      if (account.data?.linked) { await oidcRequest("/auth/oidc/unlink", { current_password: entered }, true); if (version !== tokens.version || refresh !== tokens.refresh) return; logout(); window.location.replace("/login?oidc=unlinked"); }
      else await start("link", entered);
    } catch (cause) { setError(message(cause)); setBusy(false); }
  }
  return <section className="panel oidc-account"><h2>Organisationszugang</h2>{params.get("oidc") === "linked" && <p className="hub-success" role="status">Dein Organisationszugang wurde verbunden.</p>}{account.isPending && <p role="status">Verbindung wird geladen…</p>}{account.error && <p className="error" role="alert">Der Verbindungsstatus konnte nicht geladen werden. <button onClick={() => void account.refetch()}>Erneut laden</button></p>}{account.data && (account.data.provider_label || account.data.linked ? <><p>{account.data.linked ? `Dein Konto ist mit ${account.data.provider_label ?? "dem Organisationszugang"} verbunden.` : `Verbinde dein bestehendes Konto mit ${account.data.provider_label}. Es werden keine Konten anhand gleicher E-Mail-Adressen zusammengeführt.`}</p><p className="hint">{account.data.linked ? "Beim Trennen werden alle bestehenden Sitzungen beendet. Dein lokales Passwort bleibt erhalten." : "Bestätige die Verknüpfung mit deinem lokalen Passwort und anschließend beim Anmeldedienst."}</p><form onSubmit={submit}><label>Lokales Passwort zur Bestätigung<input type="password" required autoComplete="current-password" maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>{error && <p role="alert" className="error">{error}</p>}<button disabled={busy} type="submit">{busy ? "Wird geprüft…" : account.data.linked ? "Verbindung trennen und abmelden" : "Organisationszugang verbinden"}</button></form></> : <p className="muted">Für diese Installation ist kein Organisationsanmeldedienst eingerichtet. Dein lokales Konto bleibt verfügbar.</p>)}</section>;
}
export async function logoutServer(clear: () => void) {
  const version = tokens.version;
  const refresh = tokens.refresh;
  const current = () => version === tokens.version && refresh === tokens.refresh;
  let destination = "/login";
  try { const result = await oidcRequest<{ logout_url: string | null }>("/auth/logout", {}, true); destination = result.logout_url || "/login"; }
  catch { destination = "/login?logout=server_failed"; }
  finally { if (current()) { sessionStorage.removeItem(BROWSER_KEY); clear(); window.location.assign(destination); } }
}
