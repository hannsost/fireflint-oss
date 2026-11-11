import { OidcAccount } from "../hub/Oidc";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";

export function AccountPage() {
  const { user, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = String(data.get("new_password") || "");
    if (next !== data.get("confirm_password")) {
      setError("Die neuen Passwörter stimmen nicht überein.");
      return;
    }
    if (new TextEncoder().encode(next).length > 1024 || [...next].length < 12 || new Set(next).size < 6 || next.trim() !== next) {
      setError("Verwende mindestens 12 Zeichen mit mindestens sechs unterschiedlichen Zeichen, ohne Leerzeichen am Anfang oder Ende.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/account/password", { current_password: data.get("current_password"), new_password: next });
      form.reset();
      logout();
      // End the revoked session before loading the confirmation. A competing
      // unauthenticated route redirect must not drop this success message.
      window.location.replace("/login?password=changed");
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 401
        ? "Das aktuelle Passwort stimmt nicht oder deine Sitzung ist abgelaufen. Prüfe das Passwort oder melde dich erneut an."
        : cause instanceof ApiError && cause.status === 429
          ? "Zu viele Versuche. Bitte warte eine Minute."
          : "Das Passwort konnte nicht geändert werden. Bitte versuche es erneut.");
    } finally { setBusy(false); }
  }
  return <section className="account-page">
    <div className="page-header"><div><span className="eyebrow">DEIN ZUGANG</span><h1>Konto &amp; Sicherheit</h1><p className="muted">Angemeldet als {user?.email}</p></div></div>
    <div className="card" style={{ maxWidth: 620, padding: 28 }}>
      <h2>Passwort ändern</h2>
      <p>Alle bisherigen Sitzungen werden danach abgemeldet. Melde dich anschließend mit deinem neuen Passwort an.</p>
      <form onSubmit={submit} className="form" aria-busy={busy}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 20 }}>
          <label>Aktuelles Passwort<input name="current_password" type="password" autoComplete="current-password" required maxLength={1024} /></label>
          <label>Neues Passwort<input name="new_password" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} aria-describedby="password-help" /></label>
          <p id="password-help" className="muted">Mindestens 12 Zeichen, davon sechs unterschiedliche. Eine lange, eigene Passphrase oder ein Passwortmanager hilft.</p>
          <label>Neues Passwort wiederholen<input name="confirm_password" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} /></label>
          {error && <p role="alert" className="error">{error}</p>}
          <button className="btn primary" type="submit">{busy ? "Wird geändert…" : "Passwort ändern und abmelden"}</button>
        </fieldset>
      </form>
    </div>
    <OidcAccount />
  </section>;
}
