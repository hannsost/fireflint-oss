# Native SSO – lokaler Reviewstand

Bestehender confidential OIDC-Adapter bleibt der Loginpfad. Neue Flag
`OIDC_REQUIRE_APP_GROUP=true` prüft `/app-fireflint` oder `/all-apps` in der
vertrauenswürdigen Token-Introspection; Groups-Mapper braucht
`introspection.token.claim=true` (lokale Ergänzung zu !115). Ohne passende Gruppe
403; Browser zeigt „Kein Zugriff“. Default false; Rollback false.
Explizite bestehende Identity-Verknüpfung und Organisationsrechte bleiben.
Das produktive Helm-Paket führt den Schalter nun als typisiertes
`oidc.requireAppGroup` und setzt daraus nur bei aktivem OIDC die API-Variable.
Empfohlen ist der Aktivierungswert `true`; das Clientsecret bleibt außerhalb
von Git und wird über einen Secret-Manager (z. B. External Secrets) in ein bestehendes Kubernetes-
Secret mit dem Key `client-secret` synchronisiert.

Die Tages-Session ist lokal implementiert: externe Refresh-Tokens werden mit
`MaxReuse=0` genau einmal verwendet, Refreshes durch eine DB-Generation und einen
kurzlebigen Claim über Pods/Tabs serialisiert und anschließend zusammen mit dem
lokalen Refresh-JWT rotiert. Die Inaktivitätsgrenze beträgt 12 Stunden, die
absolute Laufzeit 24 Stunden. Access bleibt zusätzlich an die aktuelle Provider-
Introspection gebunden. Providerfehler nach einer beanspruchten Rotation widerrufen
die lokale OIDC-Session fail-closed; lokaler Logout bleibt trotz IdP-Ausfall
erfolgreich. Gruppenprüfung, bestehende Identitätsverknüpfung und Organisationsrechte
bleiben unverändert.

Geprüft am 30.09.2026: `cargo fmt`, Workspace-Clippy mit `-D warnings`, kompletter
Rust-Workspace (0 Fehler; 7 explizite Opt-ins im Gesamtlauf erwartungsgemäß
ignoriert), neuer echter Provider-Rotationstest, Admin-Typecheck, 9/9
Admin-Unit-Tests und Produktionsbuild. Danach bestanden beide OIDC-Opt-ins gegen
eine kurzlebige, ausschließlich an `127.0.0.1:25433` gebundene PostgreSQL-18-
Fixture mit Migrationen bis 0030: HTTP/Refresh/Logout sowie DB-Verschlüsselung,
genau ein Gewinner bei parallelen Claims und Ablehnung der alten Generation.
Die Fixture wurde anschließend entfernt. Die reale Keycloak-/Browserabnahme und
der Rollout bleiben offen. Draft-MR, kein Deployment. Lokaler Login bleibt als
Rückfallweg verfügbar.
