# FireFlint im eigenen Cluster betreiben

Dieses Paket liefert eine FireFlint-API, eine statische Administration mit Nginx und ein persistentes Medienvolume. PostgreSQL wird vom Betreiber bereitgestellt. Es startet genau **eine API-Instanz**; Migrationen laufen vor dem Server, der erste Administrator wird ausdrücklich angelegt. Demo-Konten und Demo-Tokens gehören nicht zum Produktionsstart. Storage-Operator, Cluster-BFF, Redis und externe AI-Dienste sind keine Pflichtabhängigkeiten.

Dieses Paket ist als Open-Source-Eigenbetrieb im Kundencluster und für betreutes
SaaS nutzbar. Es bindet keine feste Neurofunken-Domain, Registry oder
Anmeldestelle; der Betreiber konfiguriert die bestehenden Values für seine
Domain, Registry/Images und TLS.

Der erste Release ist für betreutes Kunden-Onboarding mit gemeinsamem PostgreSQL-Pool ausgelegt. Organisationen werden durch die Anwendung getrennt. Er enthält keine PostgreSQL-HA, keine regionale Tenant-Verteilung und keine horizontale API-Skalierung. Deployments und Wartung erzeugen kurze Unterbrechungen. Für jede Installation sind Restore und die verwendete Kubernetes-/CSI-/PostgreSQL-Kombination vor Kundendaten zu prüfen.

## Paket und Voraussetzungen

| Datei | Aufgabe |
| --- | --- |
| `deploy/saas/api.Dockerfile` | Rust-Multistage-Build, Binary `sitegraph`, unprivilegierte Distroless-Runtime |
| `deploy/saas/admin.Dockerfile` | Gebautes React/Vite-Frontend, Nginx auf Port 8080 als UID 101 |
| `deploy/saas/helm/fireflint` | StatefulSet, Services, Administration, retained PVC, TLS-Ingress, NetworkPolicies, optionaler Bootstrap-Job |
| `deploy/saas/values.example.yaml` | Zu ersetzende Betreiberwerte, ausdrücklich keine produktiven Credentials |
| `deploy/saas/compose.yaml` | Isolierte lokale Produktions-Fixture mit eigenem PostgreSQL und eigenen Volumes |
| `deploy/saas/ops.py` | Schreibpausierte, age-verschlüsselte DB-/Asset-/Schlüsselsicherung; Restore ausschließlich in leeres Ziel |
| `tools/check_saas_deploy.py` | Offline-Render-/Schema-/Konfigurationsprüfungen ohne Clusterzugriff |

Benötigt werden Kubernetes ab 1.29, Helm, ein bestehender Ingress-/Gateway-TLS-Weg, ein CSI-StorageClass/PVC und eine dedizierte PostgreSQL-Datenbank. Die Versionsuntergrenze ist ein Chartvertrag, keine pauschale Freigabe aller Kubernetes-/CSI-Kombinationen. Die Fixture verwendet PostgreSQL 16; andere Versionen müssen durch Migration-/Restoretests freigegeben werden. API und Administration benötigen keine Kubernetes-Berechtigungen und erhalten keinen ServiceAccount-Token.

Die NetworkPolicies sind standardmäßig aktiv. `ingressPeers` muss den wirklichen Ingress-Controller, `databasePeers` die PostgreSQL-Pods bzw. tatsächlichen DB-IP-Adressen auswählen. Der CNI muss Policies durchsetzen; Service-DNAT und NodeLocal-DNS können installationsabhängige Peer-/DNS-Anpassungen verlangen. `dnsNamespace` und `dnsPodLabels` sind konfigurierbar. Ein CNI ohne Durchsetzung wird durch das bloße Anlegen dieser YAML-Dateien nicht sicher ([Kubernetes](https://kubernetes.io/docs/concepts/services-networking/network-policies/)). Für die optionale OIDC-/Keycloak-Einrichtung einschließlich HTTPS-Egress-Peers siehe [KEYCLOAK.md](KEYCLOAK.md).

## Images bauen und bereitstellen

Vom Repository-Root bauen; Dockerfile-spezifische Ignore-Dateien vermeiden `.env`, Buildoutputs und unnötigen Kontext. Diese Befehle bauen lokal und veröffentlichen nichts:

```sh
docker build -f deploy/saas/api.Dockerfile -t fireflint-api:release .
docker build -f deploy/saas/admin.Dockerfile -t fireflint-admin:release .
```

Default-Buildimages sind Rust 1.98.1/Bookworm, Node 24.21.0/Bookworm und Nginx 1.30.4/Alpine; Runtime ist `gcr.io/distroless/cc-debian12:nonroot`. Für einen reproduzierbaren freigegebenen Build können `RUST_IMAGE`, `RUNTIME_IMAGE`, `NODE_IMAGE` und `NGINX_IMAGE` als `--build-arg NAME=repository@sha256:...` vollständig gepinnt werden. Ein Build muss den freigegebenen Lockfile- und Migrationsstand enthalten. Die normalen Builder kopieren die SQL-Migrationen; sie sind im API-Binary eingebettet ([SQLx](https://docs.rs/sqlx/0.8.6/sqlx/macro.migrate.html)).

Beide fertigen Images anschließend über den eigenen autorisierten Registry-Prozess bereitstellen. Helm verlangt ihre echten `sha256:`-Digests; lokale Docker-Image-IDs ersetzen keine Registry-Manifests. `imagePullSecrets` kann private Registries anbinden. Keine der Beispiel-Registry-Adressen ist eine zugesagte veröffentlichte FireFlint-Registry.

Das Frontend verwendet im Produktionsbuild denselben Origin wie die Seite, die Vite-Dateien liegen unter `/_static/`, Medien unter `/assets/`. Pod-Env verändert ein fertig gebautes Vite-Bundle nicht ([Vite](https://vite.dev/guide/env-and-mode)). Nginx routet `/api`, `/auth`, `/v1`, `/preview`, `/assets`, `/readyz`, `/version` und `/openapi.json` zur internen API. SPA-Seiten erhalten einen History-Fallback. Die API hat zusätzlich einen stabilen ClusterIP-Service; der Headless-Service dient nur der StatefulSet-Identität.

## PostgreSQL und Secrets

Vor der Installation eine dedizierte leere DB und eine Rolle mit den erforderlichen Schema-/Tabellenrechten anlegen. Dasselbe Secret wird von Migration und API verwendet; die Rolle darf ausschließlich diese Anwendungsdatenbank verwalten. PostgreSQL liegt nicht im SaaS-Chart. Einen vorhandenen PostgreSQL-Operator des Betreibers weiterverwenden; den FireFlint-Storage-Operator hierfür nicht installieren.

`runtime.existingSecret` bezeichnet ein bestehendes Secret im Release-Namespace mit folgenden Keys:

| Secret-Key | Container-Variable | Vertrag |
| --- | --- | --- |
| `database-url` | `DATABASE_URL` | PostgreSQL-Verbindungsstring mit URL-kodierten Zugangsteilen, dedizierter DB und vereinbartem TLS-Modus |
| `jwt-secret` | `JWT_SECRET` | Stark, dauerhaft, unabhängig vom AI-Schlüssel; mindestens 32 Zeichen und hinreichende Vielfalt |
| `ai-connector-encryption-key` | `AI_CONNECTOR_ENCRYPTION_KEY` | Stark und dauerhaft, auch bei zunächst ungenutztem AI-Modul erforderlich |

Für eigene DB-CAs `database.caSecret`/`database.caKey` setzen. Das Zertifikat wird in Migration, Bootstrap und API unter `/etc/fireflint/database/ca.crt` gemountet. Der Verbindungsstring kann dann `sslmode=verify-full&sslrootcert=/etc/fireflint/database/ca.crt` enthalten; der Hostname muss zum Zertifikat passen. Ein fehlendes/falsches Zertifikat soll einen Verbindungsfehler verursachen. DB-TLS kann nicht aus einem undurchsichtigen Secret beim Helm-Render geprüft werden und muss im Installationscheck tatsächlich verifiziert werden.

Secrets mit dem bestehenden Secret-Manager bereitstellen oder aus geschützten Dateien einlesen, beispielsweise:

```sh
kubectl --context YOUR_CONTEXT -n fireflint create secret generic fireflint-runtime \
  --from-file=database-url=/secure/fireflint/database-url \
  --from-file=jwt-secret=/secure/fireflint/jwt-secret \
  --from-file=ai-connector-encryption-key=/secure/fireflint/ai-key
```

Dateiinhalte sollen keine versehentlichen Zeilenumbrüche enthalten. Keine Passwörter per `--from-literal`/Helm-Values/CLI-Argument, kein Shell-Tracing. Helm generiert und rotiert Credentials nicht. Eine Änderung des AI-Schlüssels ohne Re-Encryption macht vorhandene Connector-Credentials unlesbar. Bei JWT-Rotation werden Sessions ungültig. Sichern heißt daher DB **und** Medien **und** Kryptoschlüssel erhalten.

## Erstadministrator und Installation

Der explizite CLI-Vertrag lautet:

| Aufruf | Wirkung |
| --- | --- |
| `sitegraph serve` oder ohne Argument | Produktionsprüfung, Migrationen und Server/Worker |
| `sitegraph migrate` | Migrationen einschließlich Rust-Nachmigration; kein Listener, kein Worker, kein Demo-Bootstrap |
| `sitegraph bootstrap-admin` | Einmaliger, persistiert markierter Erstzugang; Wiederholung setzt keine Passwörter oder Rollen zurück |
| `sitegraph reset-password` | Betreiber-Recovery über `RESET_ACCOUNT_EMAIL` und `RESET_ACCOUNT_PASSWORD`; existierende JWTs des Kontos werden widerrufen |

Für den optionalen Helm-Bootstrap-Job ein zweites Secret anlegen:

| Key | Variable |
| --- | --- |
| `email` | `BOOTSTRAP_ADMIN_EMAIL` |
| `password` | `BOOTSTRAP_ADMIN_PASSWORD` |
| `org-name` | `BOOTSTRAP_ADMIN_ORG_NAME` |
| `org-slug` | `BOOTSTRAP_ADMIN_ORG_SLUG` |

Alle vier Werte sind erforderlich. Das Passwort wird nur über Secret-Env übertragen und nicht geloggt. Das Bootstrap-Secret ist unabhängig vom dauerhaft benötigten Runtime-Secret.

`values.example.yaml` in eine private Betreiberkonfiguration übernehmen und alle `YOUR_*`-Platzhalter ersetzen. Zusätzlich fürs erste Installieren `bootstrap.enabled: true` und `bootstrap.existingSecret` setzen. Domain/DNS, TLS-Secret, IngressClass, Images, Asset-StorageClass und NetworkPolicy-Peers müssen schon stimmen.

```sh
helm lint deploy/saas/helm/fireflint --strict -f /secure/fireflint/values.yaml
helm template fireflint deploy/saas/helm/fireflint -n fireflint \
  -f /secure/fireflint/values.yaml > /tmp/fireflint-rendered.yaml
helm upgrade --install fireflint deploy/saas/helm/fireflint \
  --kube-context YOUR_CONTEXT --namespace fireflint --create-namespace \
  -f /secure/fireflint/values.yaml --wait --wait-for-jobs --timeout 10m
```

Die Abnahme des Pakets erfolgt in einem ausdrücklich isolierten lokalen kind-Testcluster; Details stehen in `deploy/saas/VERIFICATION.md`. Der Initcontainer `migrate` verhindert einen vorzeitig gestarteten Server. Bootstrap nutzt ebenfalls Migration vor dem Einmalauftrag; SQLx koordiniert Schemaänderungen. Nach erfolgreichem Bootstrap `bootstrap.enabled: false` in der Betreiberkonfiguration halten und das nicht mehr benötigte Bootstrap-Secret entfernen/verwahren. Bei ausdrücklich gewünschter Jobwiederholung `bootstrap.runId` ändern, weil Kubernetes-Jobtemplates unveränderlich sind. Ein erneuter Bootstrap ist kein Passwortreset.

Der Chart erfordert in normalem Betrieb exakt eine API-Replik. Der StatefulSet ersetzt den Pod geordnet. Keine HPA-/Mehrreplika-Erweiterung hinzufügen, solange die Webhook-Worker keine DB-Claims und die Rate-Limits keinen passenden Skalierungsvertrag haben. Force-Delete eines mutmaßlich noch laufenden Pods kann auch eine StatefulSet-Grenze umgehen. [`ReadWriteOnce`](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes) ist zudem keine Ein-Pod-Sperre; `assets.accessMode: ReadWriteOncePod` ist bei passendem CSI vorzuziehen.

Das Chart-PVC hat `helm.sh/resource-policy: keep`; ein Helm-Uninstall lässt es bestehen. Das schützt nicht gegen `kubectl delete pvc`, Namespace-Löschung oder Verlust des Storage-Backends. Storage-Retention und Backup bleiben Betreiberaufgaben. Beim Wiedereinbau eines behaltenen/restoreten PVC `assets.existingClaim` setzen; so erzeugt Helm kein neues Volume. Ein bestehendes PVC kann der Chart nicht beliebig zwischen StorageClasses/AccessModes verschieben.

## Netzwerk und Anwendungssicherheit

Nginx cached keine API-/Auth-/Delivery-/Preview-Antworten und setzt für tokenabhängige Pfade `private, no-store`. Nur unveränderliche Vite-Bundledateien haben einen langen Browser-Cache. Die Administration erhält eine CSP mit Scripts und Verbindungen vom eigenen Origin; Inline-Styles sind für ReactFlow zugelassen, Objekte und fremdes Framing gesperrt. Gemeinsame Header-Includes erhalten die Regeln auch in Locations mit eigenen Cache-Headern. Der vorgelagerte Ingress/CDN muss diese Pfade ebenfalls cachefrei lassen und Query-Tokens aus eigenen Logs entfernen. Nginx-Accesslogs enthalten Methode, Pfad ohne Query, Status, Größe und Dauer. Unredigierbare Nginx-Fehlerlogs sind deaktiviert, weil sie komplette Requests enthalten können; API-Request-IDs und Status-/Readiness-Telemetrie dienen der Fehlersuche.

Login erhält am Edge zusätzlich eine globale 5/s-Kapazitätsgrenze mit kurzem Burst. Die API prüft Kontolimit und separate globale Prozessgrenze. Keine Komponente vertraut beliebigen vom Browser gesetzten Forwarding-Headern für ein vermeintliches Client-IP-Limit. Der vorgeschaltete Ingress kann zusätzlich einen geprüften Client-IP-Schutz bieten. Die reale IP-/Proxy-Konfiguration ist installationsabhängig.

`networkPolicy.allowPublicHTTPS` ist standardmäßig `false`: Kernverwaltung benötigt keinen externen Egress. AI-/Webhook-Nutzung muss ausdrücklich freigegeben werden. Bei `true` erlaubt die enthaltene Policy öffentlichen IPv4-HTTPS-Traffic und sperrt übliche private/link-local Netze; eigene Pod-/Service-/Node-CIDRs sind zusätzlich anhand des Clusters zu prüfen. Die API prüft tatsächliche Outbound-Ziele/DNS/Redirects ebenfalls. `runtime.aiAllowedProviderHosts` erlaubt nur vom Betreiber gewählte AI-Providerhosts. Der beratende Chat hat feste Schutzgrenzen: 20 Anfragen je Minute und Nutzer, höchstens vier gleichzeitige Aufrufe und maximal 2048 Antworttokens; sie sind nicht pro Installation konfigurierbar. Das ist keine allgemeine egressfreie Erweiterung für interne Proxy-Adressen. Öffentliche IPv6-Egress-Regeln sind nicht enthalten.

Die API begrenzt Uploads auf 25 MiB; Ingress-Bodylimits passend setzen. Medien sind öffentliche Dateien, keine privaten Draft-Anhänge. MIME-/Attachment-/Sandbox-Policy kommt aus der gehärteten API; sie muss vor Same-Origin-Auslieferung mit HTML/SVG und falsch deklarierten Dateitypen browserseitig geprüft sein. `/readyz` prüft API-Betriebsbereitschaft/DB, `/healthz` Liveness. Die Admin-Liveness prüft nur Nginx; als Gesamtserviceprobe `https://HOST/readyz` überwachen. CPU-/RAM-Grenzen und API-Probes sind in Values konfigurierbar.

## Backup und Restore

`ops.py` arbeitet nur mit explizitem `--context` und Namespace. Ein Backup stoppt die API, wartet auf deren Ende, mountet das Asset-PVC in einem temporären unprivilegierten PostgreSQL-Toolpod und sichert PostgreSQL per Custom-Format-Dump plus Asset-Tar und historischem JWT-/AI-Schlüsselbundle. DB-Verbindungscredentials werden nicht ins Archiv übernommen. Das Paket erhält Dateihashes und wird lokal mit `age` verschlüsselt. Abschließend wird der Toolpod entfernt und die API wieder auf eins gesetzt. Währenddessen ist die Anwendung nicht verfügbar. Andere Datenbank-/Blobschreiber müssen ebenfalls pausiert sein.

Voraussetzungen auf dem Betreiberrechner: Python 3, kubectl, age; geschützter freier temporärer Speicher in ausreichender Größe für Dump/Assets/Archive. Klartext existiert während der Verarbeitung in einem privaten temporären Verzeichnis; bei Bedarf `TMPDIR` auf ein verschlüsseltes Dateisystem legen. age-Empfänger und Entschlüsselungsidentität getrennt vom Cluster sichern. Der Toolpod benötigt eine PostgreSQL-Imageversion, deren `pg_dump` die Serverversion unterstützt; kein älterer Client für einen neueren Server ([PostgreSQL](https://www.postgresql.org/docs/16/app-pgdump.html)). `--tools-image` verlangt einen echten Digest; der Toolpod verwendet ausdrücklich `IfNotPresent`. Bei privater Registry `--pull-secret`; bei DB-CA `--database-ca-secret`/`--database-ca-key` ergänzen. Der PostgreSQL-URL-Vertrag des Werkzeugs unterstützt einen expliziten Host/DB, URL-kodierte Zugangsteile und die dokumentierten TLS-/Timeout-/Optionsparameter; unbekannte URL-Optionen werden abgewiesen. Credentials gelangen über geschützten stdin-Transfer in eine temporäre Toolpod-Datei, nicht in Prozessargumente. Das Asset-Archiv verwendet `./`-relative Pfade; beim Restore wird diese erste Komponente entfernt, damit tar den vom CSI verwalteten PVC-Mountpunkt nicht umbenennt oder dessen Eigentümer/Metadaten verändert. Ein vorhandenes `lost+found` gehört nicht zu den Anwendungsdaten und wird nicht gesichert.

```sh
python3 deploy/saas/ops.py backup \
  --context YOUR_CONTEXT --namespace fireflint --name fireflint \
  --runtime-secret fireflint-runtime --asset-claim fireflint-assets \
  --tools-image 'YOUR_POSTGRES_TOOLS_REPOSITORY@sha256:YOUR_DIGEST' \
  --recipient 'YOUR_AGE_PUBLIC_RECIPIENT' --output /secure/backups/fireflint-2026-09-10.age \
  --dry-run
```

Nach Prüfung der konkreten Werte `--dry-run` weglassen. Der Planmodus kontaktiert keinen Cluster. `--name` ist der tatsächliche Chart-Ressourcenpräfix, bei `fullnameOverride` dessen Wert. Eine Datei gilt erst nach erfolgreicher Abschlussmeldung als vollständiges Backup. Bei einem Fehler während Toolpod-Löschung muss das Volume erst freigegeben werden; die API wird nicht gegen ein noch gemountetes RWOP-Volume gestartet. Backups außerhalb des Clusters aufbewahren und Restore regelmäßig durchführen.

Restore ist bewusst ein Wiederaufbau in **leere Ressourcen**: neuen Namespace, leere dedizierte PostgreSQL-DB und leeres kompatibles Asset-PVC anlegen. Ein Runtime-Secret mit der **Ziel-DB-Verbindung**, neuem unabhängigem JWT-Schlüssel und vorläufigem starkem AI-Schlüssel vorbereiten. Die Ziel-API darf noch nicht installiert oder muss ausdrücklich auf null gestoppt sein. Im Zielsecret muss ein **neu erzeugter, starker JWT-Schlüssel** stehen. Der Restore weist einen mit dem Backup-JWT oder dessen AI-Schlüssel identischen Wert vor jedem DB-Schreibzugriff ab. Er prüft leere DB/Assets, validiert Archivpfade/Hashes, stellt Daten wieder her und übernimmt ausschließlich den gesicherten AI-Schlüssel. Ziel-JWT und Ziel-DB-Zugang bleiben erhalten; die API bleibt gestoppt. Alle interaktiven JWT-Sitzungen einschließlich Refresh-/Preview-Tokens werden ungültig; interaktive Clients melden sich anschließend neu an. Das verhindert, dass auf den Backupzeitpunkt zurückgesetzte `session_version`-Werte zwischenzeitlich widerrufene JWTs wieder gültig machen.

```sh
python3 deploy/saas/ops.py restore \
  --context YOUR_CONTEXT --namespace fireflint-restore --name fireflint \
  --runtime-secret restored-runtime --asset-claim restored-assets \
  --tools-image 'YOUR_POSTGRES_TOOLS_REPOSITORY@sha256:YOUR_DIGEST' \
  --archive /secure/backups/fireflint-2026-09-10.age --identity /secure/age/restore.key \
  --confirm-empty-target --dry-run
```

Danach bewusst ohne `--dry-run` ausführen. **Vor dem Start der Ziel-API müssen Sicherheitsänderungen seit dem Backup abgeglichen werden:** Benutzerlöschungen/-sperren, Passwortänderungen/-resets, Rollen-/Mitgliedschaftsentzüge sowie widerrufene statische Delivery-Tokens erneut durchsetzen. Der frische JWT-Schlüssel schützt historische Access-/Refresh-/Preview-Tokens, aber keine zurückgespielten Passwort-Hashes oder DB-basierten `api_tokens`. Bei unvollständiger Widerrufshistorie die betroffenen Konten/Passwörter absichern und statische Tokens gezielt rotieren; das Werkzeug löscht keine Kundentokens automatisch. Diesen Abgleich aus einem aktuellen unabhängigen Sicherheitsprotokoll bzw. aktuellen Quellzustand durchführen, während das Ziel für Benutzer und Delivery-Clients unerreichbar bleibt.

Erst danach mit `assets.existingClaim: restored-assets`, `runtime.existingSecret: restored-runtime` und `bootstrap.enabled: false` das passende Release installieren. Content-/Publikationsdaten, Asset-Hashes, Rollen, Sessionverhalten und entschlüsselbare Connector-Konfiguration prüfen. RPO ist der letzte erfolgreiche Backupzeitpunkt; RTO ist die gemessene Wiederherstellungsdauer. Ein fehlgeschlagener Restore bleibt gestoppt; ein teilweise befülltes Ziel nicht überschreiben, sondern für einen neuen Versuch frische Zielressourcen verwenden.

Vor jedem Upgrade einen verifizierten Backupstand sichern und die migrationsseitige Rückwärtskompatibilität prüfen. Ein altes API-Imagedigest allein ist kein Datenbank-Rollback. Bei inkompatibler Migration frische Zielressourcen aus dem zusammengehörigen Backup und passendem vorherigem Release wiederherstellen. Runtime-Secrets dürfen bei Helm-Upgrades nicht neu erzeugt werden.

## Isolierte lokale Fixture

Die Compose-Fixture veröffentlicht ausschließlich Nginx auf `127.0.0.1:18080` (änderbar). DB und API besitzen keine Hostports; beide Datenvolumes gehören zum gewählten Compose-Projekt. `APP_ENV=production` prüft echte Produktionsguards und Demo-Ausschluss. Der ausschließlich lokale Browserzugriff ist HTTP auf demselben Origin; die konfigurierte HTTPS-CORS-Allowlist wird dafür nicht benötigt. Diese Fixture prüft ausdrücklich **keine öffentliche TLS-Terminierung**. Ihr internes Netz verhindert AI-/Webhook-Egress.

Variablen direkt im Prozess oder aus dem eigenen sicheren Testharness liefern; die folgenden Aufrufe lesen keine `.env`:

```sh
# FIXTURE_DB_PASSWORD: zufälliger hex-Wert (URL-sicher)
# FIXTURE_JWT_SECRET und FIXTURE_AI_KEY: unabhängig, stark, über Neustarts stabil
# BOOTSTRAP_ADMIN_EMAIL/PASSWORD/ORG_NAME/ORG_SLUG: eigener Test-Erstzugang
docker compose --env-file /dev/null -p fireflint-release-test -f deploy/saas/compose.yaml build
docker compose --env-file /dev/null -p fireflint-release-test -f deploy/saas/compose.yaml up -d db migrate api admin
docker compose --env-file /dev/null -p fireflint-release-test -f deploy/saas/compose.yaml --profile bootstrap run --rm bootstrap
```

Danach `http://localhost:18080` und `/readyz` prüfen. Nur dieses bewusst gewählte Testprojekt stoppen; `down` erhält seine Volumes. `down --volumes` zerstört ausschließlich diese Fixture-Daten und ist kein normaler Stop-/Upgradebefehl. Niemals vorhandene Projekt-/Kundendatenvolumes dafür wiederverwenden.

## Prüfstatus und Releasefreigabe

```sh
python3 tools/check_saas_deploy.py --helm /path/to/helm
```

Die Paketentwicklung hat Helm 4.3.0 Lint/Render, positive Bootstrap-/PVC-Varianten, neun negative Produktionskonfigurationen, Docker-Compose-Konfiguration ohne Daemon, Shellsyntax und Operations-Dryrun ausgeführt. Archiv-Traversal-, absolute Pfad- und Symlinkfälle wurden offline verworfen. Die darüber hinaus tatsächlich ausgeführte isolierte Clusterinstallation mit Nonroot-Images, Bootstrap, Inhalt/Asset, age-Backup und frischem Restore einschließlich Session-/AI-Schlüsselprüfung ist in SAAS-CLUSTER-VERIFICATION.md (interne Dokumentation, nicht veröffentlicht) dokumentiert. Dort sind erste und finale Image-Digests, tatsächliche Upgrades von Migration 18 auf 19, DB-Ausfall/Readiness, der echte Chromium-Pfad durch Nginx sowie praktische Grenzen mit secretfreien JSON-/Lognachweisen erfasst. Die zusätzliche CI kann die Paketchecks und auf ausdrücklichen manuellen Aufruf Image-Builds ausführen; sie pusht nichts in eine Registry.

Die lokale Paketabnahme mit echten finalen Images, Nonroot/ReadOnly, Bootstrap, Podersatz, persistenten Medien, geordnetem Shutdown, vollständigem DB-/Asset-/AI-Schlüssel-Restore und echtem Chromium-Pfad durch Nginx ist abgeschlossen. Die weiteren Anwendungs-/Tenant-/Medien-/Outbound-Prüfungen sind im Releasebericht verzeichnet. Auf der tatsächlichen Betreiberinfrastruktur bleiben Domain/DNS, öffentliche TLS-Terminierung, Ingress-/CNI-Durchsetzung, PostgreSQL-TLS, produktiver CSI/RWOP und ein eigener Restore-/Lastnachweis erforderlich. Das sind konkrete Betreiberwerte und Infrastrukturabnahmen; der isolierte lokale Nachweis ersetzt sie nicht.
