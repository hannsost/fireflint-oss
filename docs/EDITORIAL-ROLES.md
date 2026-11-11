# Redaktionelle Rollen: aktueller Vertrag und nächste Erweiterung

Stand: 10. September 2026. Der Vertrag gilt innerhalb einer Organisation, nicht
je einzelner Website. Platform-Admin ist eine getrennte Betreiberberechtigung.
Serverseitige Autorisierung entscheidet; ausgeblendete Buttons sind kein Schutz.

| Aktion | Owner | Editor | Viewer |
| --- | --- | --- | --- |
| Inhalte und ihren Verlauf lesen | Ja | Ja | Ja |
| Entwürfe anlegen, ändern, wiederherstellen und löschen | Ja | Ja | Nein |
| Website-Zuordnungen / lokale Content-Ausnahmen ändern | Ja | Ja | Nein |
| Geprüfte Revision veröffentlichen, zurückziehen, planen | Ja | Ja | Nein |
| Inhaltstypen, Websites und Organisationszugänge verwalten | Ja | Nein | Nein |
| Eigenes Passwort ändern / eigenes Konto verwenden | Ja | Ja | Ja |

Die Editor-Direktadresse bleibt für Viewer lesbar. Formularfelder und
Schreibbereiche sind gesperrt, Speichern/Veröffentlichen/Löschen sind ausgeblendet,
Ctrl-S sendet keinen Schreibrequest. Die API verweigert dieselben Schreibwege403.

Ein künftiger Auftrag für getrennte Redaktion und Freigabe sollte diese fachlichen
Entscheidungen ausdrücklich treffen:

- Separate Fähigkeiten `content.edit`, `content.review`, `content.publish` und
  gegebenenfalls Website-Scope, ohne die bestehenden Rollen still umzudeuten.
- Review bezieht sich auf eine feste Content-Revision und die zugehörigen
  Channel-/Override-Werte. Jede relevante Änderung entwertet die Freigabe.
- Wenn Vier-Augen-Prinzip gefordert: Autor und freigebende Person verschieden,
  Owner-Ausnahme nur ausdrücklich entschieden und protokolliert.
- Planung akzeptiert nur eine noch gültig freigegebene Revision; Rechteentzug,
  Review-Rücknahme und Terminänderung müssen atomar berücksichtigt werden.
- Migration bestehender Rollen sowie direkte API-, Zwei-Mandanten-, Rowlock- und
  Browserprüfungen gehören zum Auftrag. Die heutige UI darf diese Regeln nicht
  vorweg als vorhandene Produktfunktion versprechen.

Diese Erweiterung ist **nicht implementiert**. Der unterstützte Pilot verwendet
zentrale Redaktion mit organisationsweiten Rollen und expliziter Veröffentlichung.
