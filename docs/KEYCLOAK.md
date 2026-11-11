# Optionales OIDC und lokale Keycloak-Abnahme

Stand 30.09.2026. OIDC ergänzt die lokale Passwortanmeldung. Die Anwendung legt
keine Benutzer oder Mitgliedschaften anhand von Providerdaten an. Eine Identität
wird ausschließlich über das Paar `issuer` + `sub` erkannt. Die Verknüpfung verlangt
ein angemeldetes bestehendes Konto, dessen frisch eingegebenes lokales Passwort
und eine neue externe Anmeldung. E-Mail, Anzeigename und Providerrollen erteilen
keine FireFlint-Rechte. Ein Benutzer kann je Issuer eine Identität verknüpfen;
dieselbe externe Identität kann nicht zwei Konten gehören.

## Betrieb und Konfiguration

Ohne OIDC-Konfiguration bleibt die lokale Anmeldung unverändert verfügbar.
Fehlerhafte oder unvollständige aktivierte Konfiguration verhindert den API-Start;
ein während des Betriebs ausgefallener Provider beeinflusst lokale Passwortsessions
nicht. Der Standardadapter benötigt Discovery, Authorization Code, S256 PKCE,
RS256, `client_secret_basic`, Introspection und Token Revocation. Alle im Discovery-
Dokument angegebenen Endpoints müssen zum selben Origin wie der konfigurierte
Issuer gehören. Andere Standardprovider können dieselbe Implementierung benutzen,
wenn sie diesen Vertrag erfüllen. Andere Signaturalgorithmen oder Provider mit
getrennten Endpoint-Origins benötigen eine ausdrückliche Adaptererweiterung.

| API-Variable | Wert / Bedeutung |
| --- | --- |
| `OIDC_ISSUER_URL` | Exakter HTTPS-Issuer aus Discovery, einschließlich Realm-Pfad |
| `OIDC_CLIENT_ID` | Eigener vertraulicher Webclient |
| `OIDC_CLIENT_SECRET` | Clientpasswort aus einem Secret-Manager; nur als Kubernetes-Secret-Referenz, nicht im Frontend oder in Git |
| `OIDC_REQUIRE_APP_GROUP` | `true` verlangt exakt `/app-fireflint` oder `/all-apps` aus der frischen Introspection; für Produktion empfohlen |
| `OIDC_REDIRECT_URI` | Exakt `https://ADMIN/oidc/callback`; ohne Query/Fragment |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | Exakt `https://ADMIN/login`; derselbe Admin-Origin |
| `OIDC_LABEL` | Optionaler lesbarer Providername, Standard `Single Sign-On` |
| `OIDC_ALLOW_LOOPBACK_HTTP` | Ausschließlich lokale Entwicklung: `1`; in Produktion verboten |

Im Provider die beiden Redirects exakt registrieren, keine Wildcards verwenden.
Authorization Code aktivieren; Implicit, Password Grant und Offline Access für
den Appclient deaktivieren. Backchannel Logout auf
`https://API/auth/oidc/backchannel-logout` konfigurieren und Session-ID mitsenden.
Realm-Sitzungen verwenden 12 Stunden Inaktivitätsgrenze und 24 Stunden absolute
Maximallaufzeit. Refresh-Token-Rotation muss aktiv sein; in Keycloak gilt
`Revoke Refresh Token=true` und `Refresh Token Max Reuse=0`.
Keycloak verlangt für Introspection, dass der aufrufende Client zur Audience
des Access-Tokens gehört. Der Client erhält deshalb einen Audience-Mapper
(`oidc-audience-mapper`) mit `included.client.audience` gleich seiner Client-ID,
`access.token.claim: true`, `introspection.token.claim: true` und
`id.token.claim: false`. Die Fixture enthält diesen Mapper ausdrücklich;
die Audienceprüfung bleibt aktiviert. Ein Token ohne diese Audience kann direkt
nach erfolgreichem Codeaustausch `active: false` ergeben. Der Vertrag ist im
[Keycloak-26.7.4-Introspection-Code](https://github.com/keycloak/keycloak/blob/26.7.4/services/src/main/java/org/keycloak/protocol/oidc/AccessTokenIntrospectionProvider.java#L273)
und [Audience-Mapper](https://github.com/keycloak/keycloak/blob/26.7.4/services/src/main/java/org/keycloak/protocol/oidc/mappers/AudienceProtocolMapper.java)
nachvollziehbar.

Der Keycloak-Client benötigt keine administrativen Realmrechte. OIDC-Frontend und
API müssen dieselbe bereits freigegebene CORS-/Same-Origin-Konfiguration benutzen.
`/oidc/callback` ist eine SPA-Seite, `/auth/oidc/*` sind API-Endpunkte.

Clientsecret und der bestehende `AI_CONNECTOR_ENCRYPTION_KEY` gehören in das
Deployment-Secret. Letzterer verschlüsselt nun auch PKCE-Verifier und gespeicherte
externe Tokens authentifiziert mit AES-GCM; die bisherigen Connectorfunktionen
bleiben kompatibel. Die bestehende Restore-Regel gilt weiter: Encryption-Key
wiederherstellen, lokalen JWT-Signierschlüssel erneuern. Keine historischen JWTs
nach Restore erneut gültig machen. SQLx-Treiber und RSA-Crate-Features wurden nicht
erweitert; Signaturprüfung nutzt den vorhandenen `jsonwebtoken`/`ring`-Pfad.

## Unterstütztes Helm-Paket

Im Chart `deploy/saas/helm/fireflint` ist OIDC ausdrücklich optional. `oidc.enabled`
aktivieren und `oidc.issuerUrl`, `oidc.clientId`, `oidc.existingSecret`,
`oidc.clientSecretKey`, `oidc.requireAppGroup` sowie optional `oidc.label` setzen.
Der genannte Secret-Key enthält ausschließlich das Clientsecret. Empfohlen ist,
dieses Secret über ein dediziertes, nur lesendes Secret-Manager-
Konto zu synchronisieren; Secretwert, Zugangstoken und Secret-IDs gehören weder in Helmwerte noch in Git. Derselbe
Clientsecretwert muss Keycloak über eine eigene Secretkopie in dessen Namespace
erhalten; ein namespaceübergreifender Podzugriff wird nicht vorausgesetzt.
Callback und Logout-Redirect leitet das Chart als
`https://<ingress.host>/oidc/callback` bzw. `/login` ab. Diese exakten
Werte im Provider registrieren; Backchannel zeigt auf
`https://<ingress.host>/auth/oidc/backchannel-logout`.

Bei aktiver NetworkPolicy benötigen API-Pods Egress zum Provider: entweder die
gezielten `networkPolicy.oidcPeers` mit `networkPolicy.oidcPort` (HTTPS), oder die
bereits vorhandene ausdrücklich gewählte öffentliche HTTPS-Freigabe
`networkPolicy.allowPublicHTTPS`. DNS-/TLS- und Backchannel-Erreichbarkeit auf der
tatsächlichen Infrastruktur separat nachweisen. OIDC-Variablen sind nur im
laufenden API-Server erforderlich; Migration und Erstbootstrap starten ohne
Providerverbindung. Die lokalen Compose-Zugangsdaten gehören nicht in Chartwerte.

## Ablauf und Widerruf

1. `GET /auth/oidc/providers` liefert den optionalen Provider. `POST
   /auth/oidc/start` akzeptiert `{"purpose":"login"}` oder für eine Verknüpfung
   zusätzlich `purpose:"link"`, `current_password` und den lokalen Bearer-Token.
2. Die Antwort enthält `authorization_url` und einen unabhängigen `browser_token`.
   Letzteren nur im Sessionstorage des startenden Tabs halten. Der Server speichert
   State, Browserbindung und Nonce als Hash und den PKCE-Verifier verschlüsselt.
3. Die Callback-Seite entfernt Code/State sofort aus der Browseradresszeile und
   sendet `code`, `state`, `browser_token` und gegebenenfalls `iss` als JSON an
   `/auth/oidc/finish`. Bei einer Verknüpfung bleibt der lokale Bearer erforderlich.
   Alle URLs kommen aus der Operator-Konfiguration; Request-Redirects werden abgelehnt.
4. Ein Flow ist fünf Minuten gültig und wird atomar genau einmal verbraucht.
   Erfolgreicher Login liefert lokale Access-/Refresh-Tokens und das vorhandene
   Benutzerkonto. Nicht verknüpfte Identitäten liefern 409
   `oidc_identity_not_linked`; dieselbe E-Mail ändert das nicht.
5. Das lokale Access-Token endet spätestens mit dem aktuellen externen Access-
   Token. Das lokale Refresh-Token endet nach 12 Stunden Inaktivität und absolut
   spätestens 24 Stunden nach der SSO-Anmeldung. Jeder erfolgreiche Refresh
   rotiert zuerst das externe und danach das lokale Refresh-Token; der lokale
   30-Tage-Passwort-Refreshpfad wird nicht verwendet.
6. Der Server reserviert eine Provider-Refresh-Generation atomar in PostgreSQL,
   bevor er den Tokenendpoint aufruft. Parallele Tabs/Pods können dadurch nicht
   dasselbe Keycloak-Refresh-Token wiederverwenden; alte lokale Refresh-Tokens
   sind nach erfolgreicher Rotation ungültig. Ein mehrdeutiger Providerfehler
   widerruft die lokale OIDC-Session, statt ein möglicherweise verbrauchtes Token
   erneut zu senden. Jeder abgeleitete API-Zugriff prüft Datenbankstatus,
   Benutzer-Sessiongeneration und frische externe Introspection. Es gibt keinen
   positiven Introspectioncache.
7. `POST /auth/logout` widerruft zuerst alle lokalen Sessions dieses Kontos,
   einschließlich aller OIDC-Sessions, und versucht dann den Provider-Widerruf
   für die aktuelle abgeleitete Session. Auch bei Providerfehlern ist der lokale
   Widerruf bereits abgeschlossen. Nur bei einer aktuellen OIDC-Session des
   konfigurierten Providers enthält die Antwort dessen feste Logout-URL mit
   Client-ID und Nach-Logout-Redirect, ohne Token in der URL. Im Browser kann
   Keycloak dafür eine Logoutbestätigung zeigen. Eine reine Passwortsession erhält
   `logout_url: null` und meldet sich ohne Provideraufruf oder -weiterleitung ab;
   das funktioniert auch bei ausgefallenem IdP.
8. Signierter Backchannel Logout widerruft passende lokale OIDC-Sessions nach
   `sid` oder `sub`. Er prüft Signatur, Issuer, Audience/azp, Ereignis, iat und jti,
   verbietet Nonce und schützt gegen Wiederholung. Datenbank-Locks und temporäre
   Logoutmerker verhindern, dass ein gleichzeitiger Codeaustausch eine bereits
   ausgeloggte Providersession wieder aktiviert. Passwortsessions bleiben bei
   einem reinen Providerlogout nutzbar.
9. `POST /auth/oidc/unlink` verlangt erneut das lokale Passwort, entfernt die
   Verbindung und widerruft alle lokalen Sessions. Mitgliedschaften bleiben erhalten.

JWKS werden bei jeder Anmeldung/Logoutnachricht frisch und größenbegrenzt gelesen;
Rotation und Entfernung eines Schlüssels gelten damit unmittelbar beim nächsten
Handshake. Nicht vorhandene oder doppelte `kid`, falsche Schlüsselverwendung,
unzulässige Algorithmen, falsche Signatur, Issuer/Audience/azp, Zeit- oder Noncewerte
werden zurückgewiesen. Netzaufrufe haben ein Fünfsekundenlimit, Antworten maximal
256 KiB, JWTs maximal 16 KiB; Redirects des HTTP-Clients werden nicht verfolgt.
Anonyme Flows besitzen eine globale Obergrenze und ein Handshake-Ratenlimit.

## Isolierte reale Fixture

`deploy/keycloak/compose.yaml` verwendet Keycloak **26.7.4**, ein eigenes Volume
`fireflint-hub-keycloak-data` und den Container `fireflint-hub-keycloak`.
Linux-Hostnetzwerk erlaubt dem Provider den Backchannel zur API auf Loopback;
Keycloak bindet ausschließlich `127.0.0.1:28180`. Die Fixture importiert nur den
Realm `fireflint-local`. Keine bestehende Instanz oder Kundendatenbank ist beteiligt.
Alle folgenden Zugangsdaten sind öffentliche **lokale Testdaten** und gehören
niemals in `deploy/saas` oder eine produktive Installation.

| Zweck | Kennung | Lokales Testpasswort |
| --- | --- | --- |
| Keycloak-Administration, Realm master | `fixture-admin` | `dev-only-keycloak-admin-password` |
| Externe Testidentität | `hub-fixture` | `dev-only-fixture-user-password` |
| Unverknüpfte Identität mit lokaler Demo-E-Mail | `hub-unlinked` | `dev-only-unlinked-user-password` |
| Vertraulicher OIDC-Client | `fireflint-hub` | `dev-only-oidc-client-secret` |

```sh
docker compose -f deploy/keycloak/compose.yaml up -d
# Discovery: http://localhost:28180/realms/fireflint-local/.well-known/openid-configuration
# Vor Start/gezieltem Neustart ausschließlich der isolierten API 28090:
source deploy/keycloak/api-env.sh
# Bestehende isolierte API-Konfiguration beibehalten: DB 25433, Admin 28091.
# Den API-Dienst mit diesen zusätzlich gesetzten Variablen starten.
node deploy/keycloak/acceptance.mjs
```

Der Browserlauf braucht die bereits installierten Admin-Testabhängigkeiten und
System-Chromium (`/usr/bin/chromium`, alternativ `PLAYWRIGHT_CHROMIUM_EXECUTABLE`). Er benutzt ausschließlich API28090, Admin28091 und Keycloak28180;
die Protokollfälle erfassen die tatsächliche Callback-Navigationsanfrage im
Testbrowser. Sie halten den Browsernachweis nur im Testprozess, sodass die SPA
den Code nicht selbst verbraucht. Das Request-Ereignis erfasst auch das Ziel einer
HTTP-Weiterleitung; Playwright-Routing greift laut
[offizieller Dokumentation](https://playwright.dev/docs/api/class-page#page-route)
nur beim ersten Request einer solchen Weiterleitungskette. Ein zusätzlicher Fall
durchläuft die echte Login-Schaltfläche, Keycloak-Anmeldung und unveränderte
SPA-Callbackseite bis zum sichtbaren eigenen Testkonto/Arbeitsbereich. Er prüft
einmaligen Codeaustausch, entferntes Browserbinding und bereinigte URL; optional
schreibt `OIDC_EVIDENCE_SCREENSHOT` einen Screenshot dieses angemeldeten Zustands.
Er prüft mit dem echten IdP:
PKCE-Verknüpfung, Passwortnachweis, unveränderte Mitgliedschaften, E-Mail-Negativfall,
falsche Nonce, falschen PKCE-Verifier, exakten Redirect, State/Browserbindung,
Replay, Login, Refreshbindung, App-Logout und administrativen IdP-Logout inklusive
Ungültigkeit beider lokaler Tokens. Ausgabe enthält nur Fallnamen/Ergebnis,
keine Tokens. Der lokale Demo-Owner wird ausschließlich zum Anlegen der eigenen
Organisation `OIDC acceptance local fixture` und des eigenen Benutzers
`oidc-acceptance-owner@example.test` verwendet. Alle Verknüpfungen, Sitzungen und
Logouts der Abnahme gehören diesem synthetischen Testbenutzer; die Sessions und
das Passwort des Demo-Owners bleiben gültig. Der Testbenutzer hat das öffentliche
lokale Fixturepasswort `dev-only-acceptance-owner-password`. Wiederholte Läufe
verwenden nur diese exakt benannte Fixture weiter und prüfen ihre Zuordnung.
Ausgabe enthält die eigene Org-/Benutzer-ID zur gezielten Nachverfolgung. Kein
Cleanup fremder Daten und kein Demo-Owner-Logout.

```sh
# Gezieltes reversibles Stoppen, Volume bleibt erhalten:
docker compose -f deploy/keycloak/compose.yaml stop
```

Realm-Import wird bei bestehendem Realm nicht erneut angewendet. Änderungen am
Import daher mit bewusst neuer Testfixture oder durch die lokale Keycloak-
Administration prüfen; kein automatisches Löschen bestehender Volumes.

## Tests und Nachweisgrenzen

Der Haupttask führt Cargo-Builds und alle gemeinsamen Gates aus. Dieses Arbeitspaket
führt keine konkurrierenden Cargo-Builds aus. Eigene Tests:

```sh
cargo test -p sitegraph-api oidc::tests
# Nur gegen die isolierte DB, nachdem Migrationen bis 0030 angewendet wurden:
FIRE_FLINT_OIDC_TEST_DATABASE_URL='postgres://…@127.0.0.1:25433/fireflint_hub_test' \
  cargo test -p sitegraph-api oidc_http_link_login_negative_proofs_and_local_and_idp_revocation \
  -- --ignored --nocapture
```

Die Rusttests umfassen echte RSA-Signaturen, falschen Signaturschlüssel, JWKS-Rotation
und Schlüsselentfernung, Issuer/Audience/azp/Zeitgrenzen, S256-Testvektor, URL- und
Antwortlimits sowie einen echten HTTP-/DB-Ablauf mit kontrolliertem IdP. Die
RSA-Dateien in `crates/sitegraph-api/tests/oidc-keys/` sind ausdrücklich öffentliche
Testschlüssel. Die DB-Regression legt eindeutig benannte Testbenutzer/Organisationen
in der isolierten DB an und berührt keine anderen Datenbanken.

Am 19.09.2026 bestätigte der Haupttask den zentralen Workspace-Lauf mit **195
bestandenen Tests, keinem Fehler** und anschließend auch alle fünf zunächst
ignorierten opt-in Tests. Die beiden OIDC-Nachweise wurden separat gelesen:
`fireflint-hub/evidence/oidc-http-tests.log` (1/1, 14,35 s) und
`oidc-storage-tests.log` (1/1, 0,60 s). Nach der Korrektur des lokalen Logoutpfads
bestätigte der Haupttask am 22.09.2026 erneut fmt, Workspace-Clippy, **44 API-
Unittests und alle vier opt-in HTTP-/DB-Tests** sowie API-Build7.

Die echte Keycloak-/SPA-Abnahme bestand am **22.09.2026 von 03:30:27 bis 03:30:52
CEST alle zehn Fälle** gegen API7/28090, das frische Nginx-Bundle28091 und
Keycloak26.7.4/28180. Die persistente Unit `fireflint-hub-oidc-real-4` endete mit
Exit0. Ergebnis: `fireflint-hub/evidence/oidc-keycloak-real-4.log`; visuell geprüfter
Screenshot: `oidc-spa-login-4.png`. Der vollständige SPA-Fall startet über die
Login-Schaltfläche und die echte Keycloak-Form, erreicht die echte Callbackseite
und zeigt anschließend den eigenen Arbeitsbereich. Genau ein Finish-Request,
verbrauchter Browsernachweis, bereinigte URL und die richtige lokale OIDC-Identität
wurden geprüft. App-Logout und administrativer IdP-Logout machen jeweils sowohl
Access- als auch Refresh-Token ungültig.

Die realen Vorläufe fanden zwei korrigierte Fixture-/Skriptfehler: Playwright-
Routing erfasste das Callbackziel einer HTTP-Weiterleitung nicht; die Abnahme
beobachtet jetzt die tatsächliche Navigationsanfrage. Dem Keycloak-Access-Token
fehlte außerdem die Client-Audience. Der eigene Client und der Realmimport
enthalten jetzt den oben beschriebenen Audience-Mapper. Die gezielte Vorher-/
Nachherprobe `oidc-provider-proof-diagnostic-{2,3}.log` belegt `active:false` ohne
Audience und anschließend `active:true` mit korrektem Client/Sub/Issuer/Sid.
Die Sicherheitsprüfungen der API blieben dabei unverändert.

Alle OIDC-Aktionen liefen unter dem eigenen Test-Owner
`ba3705fd-bee1-4224-a14a-5e847b37d445` in der Testorganisation
`0805a544-873c-46bf-b6fd-c8c42ab1c8ac`. Demo-Owner-Sessions und dessen Passwort
wurden nicht widerrufen oder geändert. Die Fixture bleibt für Wiederholungen
erhalten. Dokumentiert sind eine reale lokale Keycloak-Abnahme und getrennte
Rust-Negativtests; andere Provider und produktive Netzwerk-/TLS-Bedingungen
benötigen ihre eigene Abnahme. Kein Produktionsrollout ausgeführt.

## Offizielle Referenzen

Verwendeter Protokollvertrag: [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html),
[PKCE RFC7636](https://www.rfc-editor.org/rfc/rfc7636),
[Token Introspection RFC7662](https://www.rfc-editor.org/rfc/rfc7662),
[Token Revocation RFC7009](https://www.rfc-editor.org/rfc/rfc7009),
[Backchannel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html) und
[RP-Initiated Logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html).
Providerkonfiguration: [Keycloak OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers),
[Container und Realmimport](https://www.keycloak.org/server/containers),
[Server Administration](https://www.keycloak.org/docs/latest/server_admin/index.html).
Der am 16.09.2026 veröffentlichte [Keycloak-26.7.4-Release](https://www.keycloak.org/2026/09/keycloak-2674-released)
ist die am 18.09.2026 recherchierte Grundlage der lokalen Fixture.

### Explizites Operator-Onboarding ohne lokales Passwort

`sitegraph provision-oidc-org` liest höchstens 16 KiB JSON von stdin. Der Operator
bestätigt zuvor den zentralen Nutzer einschließlich `issuer`, `sub` und seiner
FireFlint-Freigabe. `issuer` muss exakt dem konfigurierten `OIDC_ISSUER_URL`
entsprechen. Die normale Runtime-/DB-Konfiguration bleibt erforderlich; der Befehl
führt weder Provider-Login noch Netzwerkprüfung der zentralen Freigabe aus.
Mit `OIDC_REQUIRE_APP_GROUP=true` prüft die laufende API die Freigabe beim
SSO-Login und bei jeder Introspection; für Produktion wird dieser Wert empfohlen.

```json
{
  "issuer": "https://login.example.org/realms/example",
  "subject": "confirmed-central-subject",
  "user_id": "a73472fd-15cd-4949-8b08-046a76f38a03",
  "email": "owner@example.test",
  "user_name": "Tenant Owner",
  "org_id": "3e029563-ae74-4504-8155-469714fb47d1",
  "org_slug": "example-tenant",
  "org_name": "Example Tenant"
}
```

Für neue Ressourcen eigene UUIDs erzeugen; dieselben Werte für Wiederholungen
beibehalten. Den geprüften Input über eine geschützte Datei oder stdin zuführen,
z. B. `sitegraph provision-oidc-org < /run/operator/onboarding.json`. Das JSON-Ergebnis
enthält ausschließlich Ressourcen-IDs und `created`. Neue Konten erhalten einen
nicht ausgegebenen zufälligen Passwort-Hash und nur Owner-Zugriff auf die neue
Organisation, niemals Plattformadministration. Vorhandene lokale Konten werden
nur bei exakt passender UUID, E-Mail und Namen übernommen, ohne Passwortänderung.
Andere Bindungen, fremde Mandantenzugriffe, abweichende Rollen oder bereits belegte
Organisationen führen zum vollständigen Abbruch. Ein unverändert abgeschlossenes
Onboarding ist idempotent; entzogene Rollen werden nicht wiederhergestellt.
