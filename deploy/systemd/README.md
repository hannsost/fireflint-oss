# FireFlint-Vorschau unter systemd --user

Diese Units betreiben den vorhandenen lokalen Devstack als Benutzer aus
`~/Projects/fireflint`. Die Prozesse gehören zum systemd-User-Manager
und hängen damit nicht am Prozessbaum bzw. an der Cgroup eines Cockpit-Owner-Tasks.
`setsid` allein ändert eine Cgroup-Zugehörigkeit nicht und löst dieses Problem nicht.

**Auf diesem Rechner eingerichtet und geprüft am 10.09.2026:** Der Target ist
aktiviert; DB/API/Admin laufen in eigenen User-Service-Cgroups. Nach einem
kontrollierten API-Abbruch war die API nach 8,12 Sekunden wieder bereit, mit
unveränderten Inhaltsdaten. Auch nach Ende des Installationsauftrags blieben alle
drei Dienste verfügbar. Laufzeitnachweis (interne Dokumentation, nicht veröffentlicht).
Die folgenden Installationsschritte sind die Anleitung für eine erneute Einrichtung.

Die Vorlagen werden durch Lesen oder Validieren weder installiert noch gestartet.
Der Betreiber übernimmt sie erst nach dem Build in das kanonische Projekt und
führt die unten beschriebenen Schritte aus. Root, systemweite Units und Änderungen
an Linger sind für diesen Wechsel nicht erforderlich.

| Unit | Prozess / Daten |
| --- | --- |
| `fireflint-db.service` | Ausschließlich bestehender rootless-Podman-Container `fireflint-db`, bestehendes Volume, `0.0.0.0:5433` |
| `fireflint-core.service` | Vorher gebautes `target/debug/sitegraph`, `0.0.0.0:8090`, Assets unter `data/assets` im kanonischen Projekt |
| `fireflint-admin.service` | Vorher installiertes Vite mit `/usr/bin/node`, `0.0.0.0:5174`, `--strictPort` |
| `fireflint.target` | Gemeinsames Starten, Stoppen und Neustarten |

## Voraussetzungen und feste Devwerte

- ein normaler Benutzer, aktiver systemd-User-Manager, Projekt unter `%h/Projects/fireflint`.
- Bereits vorhandener und für den Wechsel **gestoppter** Container `fireflint-db`.
  Die Unit prüft genau `0.0.0.0:5433` für den Containerport 5432. Sie erzeugt keinen
  Container, zieht kein Image und ersetzt oder löscht kein Volume.
- `/usr/bin/podman`, `/usr/bin/node`, Bash, flock, ss und curl. Der explizite
  System-Node wurde bei der Vorbereitung mit Version 26.7.0 vorgefunden; es wird
  keine Shell-/mise-/nvm-Konfiguration geladen. Bei einem anderen Installationsort
  den Node-Pfad in der Unit und der Vorprüfung gemeinsam anpassen.
- API einmal vorher bauen: `cargo build --locked -p sitegraph-bin`. Das Binary
  heißt `sitegraph`, nicht `sitegraph-bin`. Admin vorher mit
  `npm --prefix admin ci` installieren. Units bauen und installieren niemals.
- Die Units setzen `SITEGRAPH_LOAD_DOTENV=0` für API und Vite und lesen kein
  `EnvironmentFile`. Der aktuelle Core und die aktuelle Vite-Konfiguration müssen
  deshalb vor dem Wechsel übernommen und gebaut/installiert sein.

Die API verwendet `APP_ENV=development`, die öffentliche lokale Datenbank-URL
`postgres://sitegraph:sitegraph@127.0.0.1:5433/sitegraph`, den öffentlichen
Dev-JWT-Wert `dev-insecure-secret-change-me` und den öffentlichen bisherigen
Dev-Connector-Wert `development-only-connector-key`. Migrationen und der vorhandene
Dev-Bootstrap laufen wie beim normalen lokalen Start. Dies ist die lokale
Entwicklungsvorschau; Produktionsbetrieb verwendet die getrennte
Produktionskonfiguration mit eigenen Zugangsdaten.

Assets bleiben unter `~/Projects/fireflint/data/assets`, PostgreSQL-Daten
im bestehenden Container-Volume. Die Units führen keinen Reset, Re-Seed per
Hilfsskript oder Datenumzug aus. Abweichend konfigurierte bestehende Datenbank- oder
Connector-Schlüssel werden nicht aus Secretdateien übernommen; diese Vorlagen sind
gezielt auf den normalen öffentlichen Devstack ausgelegt.

Vite erhält `VITE_API_URL=http://localhost:8090`. Der optionale Cluster-BFF hat den
bisherigen Devwert `http://localhost:8091`, wird von diesen Units jedoch nicht
betrieben. Für Zugriff von einem anderen Rechner müsste `VITE_API_URL` auf die
von dessen Browser erreichbare Hostadresse zeigen; das Binden auf `0.0.0.0`
allein ändert die Browser-API-Adresse nicht.

## Wechsel vom bisherigen Bare-Stack

Nur eine Betriebsart gleichzeitig. Die bestehenden Skripte bleiben unverändert.

1. Laufenden Owner über den Wechsel informieren und dessen Start/Stop-/Buildlauf
   beenden lassen. Vorhandene Änderungen und Daten erhalten.
2. Im kanonischen Projekt den alten Stack kontrolliert stoppen:

   ```bash
   cd ~/Projects/fireflint
   ./stop-local.sh --db
   ss -H -ltnp 'sport = :8090 or sport = :5174'
   podman inspect fireflint-db --format '{{.State.Running}}'
   ```

   Die Portausgabe muss leer und der Containerstatus `false` sein. Bei einem
   weiterhin belegten Port oder einem fremden/aliven PID nichts übernehmen oder
   pauschal beenden; zuerst dessen Owner klären. Das Stop-Skript entfernt seine
   erledigten PID-Dateien selbst.
3. Fertigen API-Build und installierte Admin-Abhängigkeiten bereitstellen; danach
   die vier Unitdateien **und** `check-local-service.sh` aus der vorbereiteten
   Arbeitskopie in das kanonische `deploy/systemd/` übernehmen. Keine Unit auf die
   temporäre Release-Arbeitskopie verlinken.
4. Als Entwicklungsbenutzer die Units verlinken und den Manager neu einlesen lassen:

   ```bash
   mkdir -p ~/.config/systemd/user
   for unit in fireflint-db.service fireflint-core.service fireflint-admin.service fireflint.target; do
     ln -sfn "~/Projects/fireflint/deploy/systemd/$unit" "$HOME/.config/systemd/user/$unit"
   done
   systemctl --user daemon-reload
   systemctl --user start fireflint.target
   ```

Ein vorhandener anderer Unitstand ist vor dem Ersetzen zu prüfen. Die Anleitung
ist eine vorbereitete Betreiberaktion, kein automatisch ausgeführter Installer.

Die Units halten während ihrer Laufzeit gemeinsam eine **geteilte Sperre** auf
`data/local/stack.lock`. Die vorhandenen Skripte benötigen dort eine exklusive
Sperre und lehnen dadurch paralleles Starten oder Stoppen ab. Mehrere Units dürfen
die geteilte Sperre halten. `flock --no-fork` ersetzt sich direkt durch den
überwachten Prozess; es entsteht kein losgelöster Hintergrundprozess. Die Units
schreiben keine Bare-Stack-PID-Dateien.

## Betrieb nach dem Wechsel

```bash
systemctl --user status fireflint-db.service fireflint-core.service fireflint-admin.service
systemctl --user stop fireflint.target
systemctl --user start fireflint.target
systemctl --user restart fireflint.target
journalctl --user -u fireflint-core.service -n 80 --no-pager
```

Der Target-Start ordnet DB → API → Admin. DB-Readiness wird über `pg_isready`
geprüft, API über `/readyz`, Admin über `/`. HTTP-Erfolg zählt nur, wenn der
Listener zur `MAINPID` der jeweiligen Unit gehört und auf `0.0.0.0` bindet.
`fireflint.target` gruppiert die Dienste mit `Wants=`; ein aktives Target allein
beweist daher keine gesunde API. Immer die drei Dienstzustände und HTTP prüfen.

Alle Services verwenden `Restart=on-failure`, fünf Sekunden Abstand und höchstens
drei Startversuche innerhalb von zehn Minuten. Start und Stop sind zeitlich
begrenzt. Ein sauberer Prozess-Exit oder ein bewusstes `stop` löst keinen
unendlichen Neustart aus. Nach einer behobenen Ursache bzw. einem Startlimit:

```bash
systemctl --user reset-failed fireflint-db.service fireflint-core.service fireflint-admin.service
systemctl --user restart fireflint.target
```

Bei API-Änderungen zuerst den Build erfolgreich fertigstellen, dann ausschließlich
`systemctl --user restart fireflint-core.service`. Admin-Quellen aktualisiert Vite
normalerweise selbst; nach Dependency-/Vite-/Umgebungsänderungen nach erfolgreicher
Installation `systemctl --user restart fireflint-admin.service`. Bei Unitänderungen
zuerst `systemctl --user daemon-reload`, dann die betroffene Unit neu starten. Ein
DB-Neustart ist ein Stack-Eingriff; dafür den gemeinsamen Target-Neustart verwenden.

Owner dürfen ab diesem Wechsel weder `run-local.sh` noch einen zweiten manuellen
Cargo-/Vite-Prozess als Vorschau starten. Für vorübergehenden Rückwechsel zuerst
`systemctl --user stop fireflint.target`; die drei Units müssen inaktiv sein und
ihre Sperren sowie Ports freigegeben haben. Erst dann ist `./run-local.sh` wieder
zulässig. Ein abgeschlossener Owner-Task soll die systemd-Vorschau nicht stoppen.

## Taskende, Benutzeranmeldung und Abnahme

Der User-Manager betreibt die Units unabhängig vom Owner-Task. Das ist noch keine
Zusage für einen Boot ohne Anmeldung oder für das letzte Benutzer-Logout. Optional
aktiviert `systemctl --user enable fireflint.target` den Start mit dem User-Manager.
Ob dieser ohne Anmeldung läuft, hängt vom bereits vorhandenen Host-/Linger-Zustand
ab; die Vorbereitung verändert ihn nicht. Für den aktuellen Taskwechsel ist kein
`sudo loginctl enable-linger` nötig.

Nach dem späteren Start und nochmals **nach Ende des startenden Owner-Tasks**:

```bash
systemctl --user show fireflint-db.service fireflint-core.service fireflint-admin.service \
  -p Id -p ActiveState -p SubState -p MainPID -p ControlGroup
curl --noproxy '*' --fail --silent http://127.0.0.1:8090/readyz
curl --noproxy '*' --fail --silent http://127.0.0.1:5174/ >/dev/null
ss -H -ltnp 'sport = :5433 or sport = :8090 or sport = :5174'
```

Die Cgroups müssen zu den jeweiligen User-Services gehören. Dann gezielten
API-Neustart und die Readiness erneut prüfen. Erst diese Abnahme belegt die
Laufzeitpersistenz auf diesem Host.

## Vorbereitungsprüfung vom 10.09.2026

`bash -n deploy/systemd/check-local-service.sh` und die statische Prüfung aller vier
Units mit Systemd 261.2 waren erfolgreich:

```bash
systemd-analyze --user --generators=no --man=no verify \
  deploy/systemd/fireflint-db.service deploy/systemd/fireflint-core.service \
  deploy/systemd/fireflint-admin.service deploy/systemd/fireflint.target
```

Zusätzlich bestanden 15 isolierte Helper-Prüfungen mit synthetischen Prozess-/
Portdaten und gestubbtem Podman/curl: fehlende Artefakte, lebender Bare-PID, belegte
Ports, exklusive/geteilte Sperren, fehlender/falsch gebundener/laufender Container
sowie eigene und fremde Listener. Dafür wurden weder echte Ports geöffnet noch
reale Container- oder HTTP-Aufrufe ausgeführt.

Der kanonische Projektpfad, das Debug-Binary, die Vite-Datei und `/usr/bin/node`
waren lesend vorhanden. Bei dieser ursprünglichen Vorbereitungsprüfung wurden keine Secretdateien gelesen
oder laufenden Dienste verändert. Die anschließend tatsächlich ausgeführte
Installation und Laufzeitabnahme stehen im oben verlinkten Bericht; eine Reboot-
Abnahme wurde weiterhin nicht durchgeführt.
