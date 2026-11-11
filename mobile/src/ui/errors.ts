import { ApiError, CredentialStorageError, NetworkError, SessionChangedError } from '../core';

export function userError(error: unknown): string {
  if (error instanceof SessionChangedError) return 'Der Arbeitsbereich oder deine Berechtigung hat sich geändert. Öffne den Inhalt erneut.';
  if (error instanceof CredentialStorageError) return 'Die sichere Geräteablage ist nicht verfügbar. Prüfe, ob das Gerät entsperrt ist, und versuche es erneut.';
  if (error instanceof NetworkError) return 'Keine verlässliche Verbindung zum Server. Deine Eingaben bleiben hier erhalten.';
  if (error instanceof ApiError) {
    if (error.code === 'access_refreshed') return 'Deine Sitzung wurde erneuert. Die Änderung wurde nicht wiederholt. Prüfe den Stand und bestätige die Aktion erneut.';
    if (error.status === 409) return 'Dieser Inhalt wurde inzwischen geändert. Deine Eingaben bleiben erhalten. Vergleiche zuerst den aktuellen Serverstand.';
    if (error.status === 401) return 'Die Anmeldung ist abgelaufen. Bitte melde dich erneut an.';
    if (error.status === 403) return 'Deine aktuelle Berechtigung erlaubt diesen Zugriff nicht mehr.';
    if (error.status === 404) return 'Dieser Inhalt ist nicht mehr verfügbar.';
    if (error.status === 429) return 'Zu viele Anfragen. Warte bitte kurz, bevor du es erneut versuchst.';
    if (error.status === 400 || error.status === 422) return 'Der Server konnte die Eingabe nicht übernehmen. Prüfe die Felder und erforderlichen Werte.';
  }
  return 'Der Vorgang konnte nicht abgeschlossen werden. Bitte prüfe die Verbindung und versuche es bewusst erneut.';
}
