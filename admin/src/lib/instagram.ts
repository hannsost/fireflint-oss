export interface InstagramConnection {
  id: string;
  instagram_id: string;
  username: string;
  active: boolean;
  revision: number;
  expires_at: string | null;
  expired: boolean;
  refresh_recommended: boolean;
  scopes: string[];
  login_mode?: "instagram_login" | "unified";
  token_kind?: string;
  client_business_id?: string | null;
  last_verified_at?: string;
  needs_revalidation?: boolean;
  refresh_supported?: boolean;
}

export interface InstagramStatus {
  configured: boolean;
  connection: InstagramConnection | null;
  required_permissions: string[];
  capabilities: string[];
  automatic_publishing: boolean;
  profile_editing: boolean;
  login_mode?: "instagram_login" | "unified" | null;
  api_host?: string | null;
  config_id?: string | null;
  reconnect_required?: boolean;
}

export interface InstagramPublication {
  id: string;
  content_id: string;
  content_revision: number;
  state: string;
  revision: number;
  container_id: string | null;
  media_id: string | null;
  error_code: string | null;
  created_at: string;
  payload: { caption: string; image_url: string; alt: string };
}

export function instagramState(state: string): string {
  return ({ creating: "Ergebnis der Vorbereitung offen", prepared: "Bild vorbereitet", publishing: "Veröffentlichung wird geprüft", published: "Veröffentlicht", outcome_unknown: "Ergebnis ungeklärt", rejected: "Von Instagram abgelehnt" } as Record<string, string>)[state] ?? state;
}

export function instagramError(message: string): string {
  const errors: Record<string, string> = {
    instagram_not_configured: "Die Meta-App ist noch nicht eingerichtet. Der Betreiber muss die Anbindung vervollständigen.",
    instagram_configuration_invalid: "Die Meta-App-Konfiguration muss vom Betreiber geprüft werden.",
    instagram_revision_conflict: "Die Verbindung oder der Auftrag wurde inzwischen geändert. Bitte lade den aktuellen Stand und prüfe ihn erneut.",
    instagram_reconnect_required: "Die Freigabe ist abgelaufen. Bitte verbinde Instagram erneut.",
    instagram_permissions_missing: "Instagram hat nicht alle benötigten Rechte freigegeben. Bitte prüfe die Verbindung.",
    instagram_not_connected: "Für diesen Arbeitsbereich ist Instagram noch nicht verbunden.",
    instagram_source_changed: "Der Inhalt wurde seit der Vorbereitung geändert. Prüfe den aktuellen Stand, bevor du einen neuen Auftrag anlegst.",
    instagram_container_not_ready: "Instagram verarbeitet das Bild noch. Aktualisiere den Auftrag und prüfe ihn später erneut.",
    instagram_request_rejected: "Instagram hat die Anfrage abgelehnt. Prüfe die Verbindung und den Auftrag.",
    instagram_outcome_unknown: "Das Ergebnis konnte nicht sicher bestätigt werden. Es erfolgt kein automatischer erneuter Versand.",
    instagram_jpeg_required: "Für die direkte Veröffentlichung wird ein JPEG-Bild benötigt. Bereite das Instagram-Bild unter Marke & Website vor und gib den aktualisierten Inhalt frei.",
    instagram_idempotency_conflict: "Diese Auftragskennung gehört bereits zu einem anderen Stand. Prüfe die vorhandenen Aufträge.",
    instagram_app_changed_reconnect_required: "Die Meta-App wurde gewechselt. Verbinde Instagram mit der aktuellen App erneut.",
    instagram_provider_changed: "Der Anmeldeweg wurde inzwischen geändert. Bitte starte die Verbindung erneut.",
    instagram_webhook_not_configured: "Die Verifizierung für Meta-Benachrichtigungen ist noch nicht eingerichtet.",
    instagram_revalidation_required: "Die Freigabe der Geschäftskonten wurde verändert. Prüfe die Verbindung erneut, bevor du veröffentlichst.",
    instagram_no_shared_accounts: "Meta hat kein verwendbares Instagram-Konto freigegeben. Prüfe die Kontoauswahl im Geschäftsportfolio.",
    instagram_account_not_shared: "Dieses Instagram-Konto ist nicht mehr Teil der freigegebenen Konten. Bitte verbinde erneut.",
    instagram_unified_refresh_unsupported: "Unified Login verwendet eine andere Tokenverwaltung. Prüfe die Freigabe oder verbinde erneut.",
  };
  return errors[message] ?? "Die Instagram-Anbindung konnte die Anfrage nicht abschließen. Bitte prüfe den aktuellen Stand.";
}

/** Only the fixed Instagram authorization endpoint may receive the browser. */
export function instagramAuthorizationUrl(value: string, mode: "instagram_login" | "unified" = "instagram_login"): string | null {
  try {
    const url = new URL(value);
    const provider = mode === "unified" ? url.hostname === "www.facebook.com" && url.pathname === "/dialog/oauth" && /^\d{1,80}$/.test(url.searchParams.get("config_id") || "") : url.hostname === "www.instagram.com" && url.pathname === "/oauth/authorize";
    return url.protocol === "https:" && provider && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}
