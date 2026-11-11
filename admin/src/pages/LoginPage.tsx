import { OidcLogin } from "../hub/Oidc";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { UiIcon } from "../components/Brand";
import { SaasLoginFrame } from "../components/SaasLoginFrame";

export function LoginPage() {
  const { login } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try { await login(email.trim(), password); }
    catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "E-Mail oder Passwort falsch."
        : err instanceof ApiError && err.status === 429 ? "Zu viele Versuche. Bitte kurz warten."
        : "Anmeldung fehlgeschlagen. Bitte versuche es erneut.");
    } finally { setBusy(false); }
  };

  return <SaasLoginFrame product="fireflint" title="Willkommen zurück" description="Melde dich an, um in deinem Arbeitsbereich weiterzuarbeiten.">
    <form className="nf-access-form" onSubmit={submit}>
      {params.get("password") === "changed" && <p className="login-confirmation" role="status">Passwort geändert. Melde dich mit deinem neuen Passwort an.</p>}
      <div className="nf-access-field"><label htmlFor="email">E-Mail</label><input id="email" type="email" value={email} autoComplete="username" required autoFocus onChange={e => setEmail(e.target.value)} /></div>
      <div className="nf-access-field"><label htmlFor="password">Passwort</label><input id="password" type="password" value={password} autoComplete="current-password" required onChange={e => setPassword(e.target.value)} /></div>
      {error && <p className="error login-error" role="alert">{error}</p>}
      <button className="nf-access-primary" type="submit" disabled={busy}>{busy ? "Anmelden…" : "Anmelden"}<UiIcon name="arrow" /></button>
      <OidcLogin />
      {params.get("oidc") === "unlinked" && <p className="login-confirmation" role="status">Organisationszugang getrennt. Melde dich mit deinem lokalen Passwort an.</p>}
      {params.get("logout") === "server_failed" && <p className="error" role="alert">Du bist in diesem Browser abgemeldet. Der Server konnte das Beenden weiterer Sitzungen nicht bestätigen. Versuche es nach erneuter Anmeldung noch einmal.</p>}
      <p className="nf-access-hint">Du brauchst einen Zugang? Wende dich an die Person, die deinen Arbeitsbereich verwaltet.</p>
      <p className="nf-access-hint"><Link to="/legal">Impressum, Nutzungsbedingungen &amp; Datenschutz</Link></p>
    </form>
  </SaasLoginFrame>;
}
