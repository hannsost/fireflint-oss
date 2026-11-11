# Omarchy-Geräteverwaltung als optionales FireFlint-Modul

Stand: 22. September 2026. Das [manuelle Omarchy-Geräteinventar](DEVICE-INVENTORY.md)
ist als erstes optionales Modul umgesetzt und lokal abgenommen (interne Dokumentation, nicht veröffentlicht).
Technische Geräteanbindung und Fernverwaltung bleiben Gegenstand dieses Entwurfs.
Nutzervorgabe: ausschließlich Linux ausrollen und verwalten, konkret **Omarchy**
als Zielsystem für die Arbeitsrechner. Die Distribution ist damit festgelegt.
Vor der Umsetzung werden der unterstützte Omarchy-Stand und ein dazu passender,
geprüfter Arch-Paketstand dokumentiert. Weitere Distributionen sind nicht geplant.

## Zielbild

Ein Unternehmen ordnet einen registrierten Rechner einem Geräteprofil zu, etwa
„Vertrieb“. FireFlint zeigt die vorgesehene Software und Konfiguration, organisiert
die freigegebene Anwendung und meldet den tatsächlich festgestellten Zustand.
Unbeaufsichtigte Installation bedeutet ohne Installationsdialog; Auftrag,
Änderungen, Fehler und erforderliche Neustarts bleiben nachvollziehbar.

Der erste Ablauf setzt ein bereits installiertes Omarchy voraus. Betriebssystem-
Erstinstallation, Datenträgeraufteilung und Wiederherstellungsmedien bilden einen
späteren Provisionierungsadapter mit eigenem Lebenszyklus.

Omarchy unterstützt bereits unbeaufsichtigte ISO-Installationen mit einem
Konfigurationsdatenträger namens `cidata`. Diesen offiziellen Weg für den späteren
Adapter prüfen. Das Installationsmedium ersetzt keine FireFlint-Geräteregistrierung.
Bei verschlüsselten Installationen verlangt der dokumentierte Weg am ersten Boot
weiterhin die LUKS-Passphrase; die Installationskonfiguration kann Geheimnisse
enthalten und darf weder im öffentlichen Medienbereich noch in Logs landen.
[Offizielle Anleitung](https://omarchy.org/manual/unattended-installs/).

## Fachliche Grenze

- Der Hub bleibt zuständig für Unternehmen, Identitäten und Unternehmensdaten.
  Das optionale Modul verwaltet Gerätezuordnung, Inventar, Profile, Softwarekatalog,
  Aufträge und Ergebnisse. Es nutzt freigegebene APIs statt direkter Schreibzugriffe
  auf Hub-Tabellen. Unternehmensdaten werden nicht unabhängig doppelt gepflegt.
- Geräte sind immer genau einer Organisation zugeordnet. Anmeldung per Keycloak
  ersetzt keine Prüfung der Organisationszugehörigkeit und Geräteberechtigung.
  Bestehende Content-Editor-Rechte gewähren keine Geräteadministration. Zusätzliche
  Rechte wie Inventar lesen, Profile ändern und Aufträge ausführen brauchen einen
  eigenen serverseitig geprüften Vertrag.
- Der vorhandene Servicezugang `/hub/v1` ist ein begrenzter Lese-/Exportzugang.
  Gerätebefehle benötigen eigene APIs und Scopes. Ein späterer Geräteagent erhält
  eine eigene widerrufbare Maschinenidentität statt eines Benutzer-JWT.
- Die serverseitige Auftragsverwaltung ist als Rust-Modul mit React-Oberfläche
  vorgesehen. Laravel ist gemäß Nutzerentscheidung aus der Modulplanung
  gestrichen. Die Linux-Ausführung bleibt hinter einem eigenen Adaptervertrag.

## Geplanter Funktionsumfang

1. **Inventar:** Gerätekennung, Omarchy-/Paketstand, Architektur, installierte
   Software, letzte Rückmeldung und Zuordnung zu Unternehmen und Gerätegruppe.
2. **Softwareprofile:** freigegebene Paketquellen, Software und Versionen sowie
   geprüfte unbeaufsichtigte Installation, Aktualisierung und Entfernung.
3. **Konfigurationsprofile:** versionierte Einstellungen für Benutzer, Dienste
   und verwaltete Dateien; Abweichungen zwischen Soll und Ist sichtbar machen.
4. **Rollouts:** einzelne Testgeräte, anschließend ausgewählte Gruppen,
   Wartungsfenster, Neustartregeln, Ergebnisse und begrenzte Aufbewahrung von Logs.

## Omarchy-spezifische Leitlinien

- **Firmenprofil und persönliche Einstellungen:** Ein Profil benennt ausdrücklich
  die verwalteten Einstellungen. Persönliche Themes, Tastenkürzel und Monitor-
  Einstellungen bleiben außerhalb dieses Bereichs erhalten. Vor einer Änderung
  den erwarteten Dateistand prüfen, sichern und Konflikte melden. Kein pauschales
  Ersetzen kompletter Benutzer-Konfigurationsverzeichnisse.
- **Omarchy-Schnittstellen:** Fähigkeiten der unterstützten Version prüfen und
  passende Omarchy-Kommandos beziehungsweise vorgesehene Benutzerkonfigurationen
  verwenden. Paketverwaltete Dateien unter `/usr/share/omarchy/` bleiben unverändert.
  Desktop-Anpassungen laufen im Kontext des richtigen Benutzers; Systemaufträge
  erhalten nur ihre ausdrücklich benötigten Rechte. Interaktive Assistenten sind
  nicht automatisch für unbeaufsichtigte Aufträge geeignet.
- **Softwarekatalog:** Mit ausgewählten Paketen aus freigegebenen Quellen beginnen.
  Zusätzliche Paketquellen und AUR-Builds benötigen einen eigenen geprüften Build-
  und Freigabeweg. Kein ungeprüfter Quellcode-Build als Installationsnebenwirkung.
- **Updates:** Einen zusammenpassenden Omarchy-/Arch-Systemstand zunächst auf
  Testgeräten prüfen, danach in Gruppen ausrollen. Kein willkürliches Festhalten
  einzelner Basispakete bei gleichzeitiger Aktualisierung ihrer Abhängigkeiten:
  Arch unterstützt keine Teil-Upgrades. Profilrevision und vollständigen
  Geräte-Paketstand getrennt erfassen. Die technische Bereitstellung eines
  reproduzierbaren Paketstands muss vor dem Pilot nachgewiesen werden.
  [Arch-Dokumentation](https://wiki.archlinux.org/title/System_maintenance#Partial_upgrades_are_unsupported).

## Ausführung und Auftragsvertrag

Zuerst einen Adapter für bestehende Linux-Automatisierung, insbesondere Ansible,
gegen einen eigenen Agenten abwägen. Ein Pull-Verfahren ist für zeitweise offline
befindliche Arbeitsrechner ein Kandidat: Das Gerät holt freigegebene Aufträge über
authentifiziertes HTTPS ab und meldet Ergebnisse zurück. Registrierung, Schlüssel-
rotation, Zustandsmeldung und Aktualisierung des Agenten gehören dann zum Modul.

Ansible bietet mit `ansible-pull` bereits die lokale Ausführung von Playbooks aus
einem Repository. Das ersetzt weder die FireFlint-Geräteidentität noch den
Auftragsvertrag. Parallel laufende Ausführungen müssen ausdrücklich verhindert
werden; die Ansible-Dokumentation verlangt dafür Scheduling beziehungsweise Locks.
[Offizielle ansible-pull-Dokumentation](https://docs.ansible.com/projects/ansible/latest/cli/ansible-pull.html).

- Eine Freigabe bindet die konkrete Profilrevision, Softwareartefakte und Zielgeräte.
  Gruppen werden für einen Auftrag in eine feste Zielliste aufgelöst. Dauerhafte
  Richtlinien für neue Gruppenmitglieder benötigen einen eigenen ausdrücklichen
  Geltungsbereich. Profiländerungen prüfen die ursprüngliche erwartete Revision.
- Katalog und Ausführungsadapter begrenzen Paketquellen, Parameter und benötigte
  Privilegien. Artefakte werden anhand freigegebener Signaturen beziehungsweise
  Prüfsummen geprüft. Freie Download-URLs und beliebige privilegierte Shellbefehle
  aus Nutzereingaben oder Modellantworten sind kein Auftragsformat.
- Geräteschlüssel sind einzeln widerrufbar. Ablaufzeit und Widerruf eines Auftrags
  werden vor Beginn geprüft; bereits laufende Änderungen lassen sich nicht als
  rückgängig gemacht behaupten. Ein Modell darf Vorschläge erstellen, erhält aber
  dadurch keine eigenen Installations- oder Freigaberechte.
- Pro Gerät werden kollidierende Aufträge serialisiert. Paketmanager-Sperren,
  Vorbedingungen, wiederholte Zustellungen und Wiederanlauf nach Unterbrechung
  gehören zur Abnahme. Bei unbekanntem Ergebnis zuerst den Istzustand ermitteln;
  keine blinde Wiederholung einer möglicherweise bereits ausgeführten Änderung.
- Aufträge unterscheiden geplant, laufend, erfolgreich, fehlgeschlagen und
  Ergebnis unbekannt. Erreichbarkeit und ausstehender Neustart werden separat
  angezeigt. Erfolg erfordert eine Ergebnisprüfung am Gerät, nicht nur Zustellung.
- Protokolle bleiben organisationsgebunden und bereinigen Zugangsdaten. Private
  Pakete und Logs gehören nicht in den aktuell öffentlich adressierbaren
  Medienbereich. Rücknahme ist nur für ausdrücklich geprüfte Operationen vorgesehen.

## Nächster Umsetzungsschritt nach dem manuellen Inventar

Einen konkreten Omarchy-/Paketstand erfassen und einen kleinen vollständigen
Ablauf in eigenen Omarchy-Test-VMs abnehmen: Registrierung → Inventar → versioniertes
Softwareprofil → Anwendung → geprüfte Rückmeldung. Zwei isolierte Organisationen
prüfen die Mandantengrenze. Zusätzlich doppelte Zustellung, Offline-Phasen,
Widerruf, Paketfehler, Neustartbedarf und veraltete Profilrevisionen testen.
Vor einer Freigabe für Arbeitsrechner zusätzlich den Desktop-Ablauf und ein
Systemupdate auf repräsentativer Zielhardware prüfen; eine VM allein belegt keine
Monitor-, Grafik-, Netzwerk- oder Suspend-Kompatibilität der Geräteflotte.

Erst danach weitere Konfigurationsarten und Omarchy-Provisionierung ergänzen.
Dieser Entwurf installiert nichts und erweitert den unterstützten
Content-Hub-Pilot noch nicht um Geräteverwaltung.
