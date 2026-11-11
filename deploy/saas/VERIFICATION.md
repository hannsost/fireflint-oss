# SaaS package verification — 2026-09-10

Offline checks executed in the private release source copy. Actual isolated
cluster/build/backup evidence is recorded in SAAS-CLUSTER-VERIFICATION.md (interne Dokumentation, nicht veröffentlicht).
No external registry push or canonical checkout change was performed:

```text
python3 tools/check_saas_deploy.py --helm /srv/fireflint-work/fireflint-release/.tools/helm
PASS Helm lint/render, production guards, bootstrap, retained/existing PVC and 9 negative configurations
PASS Docker Compose configuration (no daemon/build/start)
PASS nginx/entrypoint contracts, operations CLI dry-run and isolated production fixture
```

The checker also covers optional DB-CA mounts in migration/API/bootstrap pods,
nonroot/read-only containers, secret references, stable API ClusterIP, correct
health probes, CSP/header inheritance, query-free access logs, shell syntax for
every PostgreSQL/asset command, URL credential quoting, and archive traversal,
absolute-path and symlink rejection. Workflow YAML parses. No real secret file
is needed or read. Docker Compose uses `--env-file /dev/null` and synthetic values.

Helm version: 4.3.0; the parent verified its official release checksum. Validation
includes Helm values JSON Schema and rendered resource invariants, not API-server
admission or a full external Kubernetes object-schema validator.

The integration parent actually pulled the official Rust, Node, Nginx and
Distroless bases and built preliminary API/Admin images. Those images were
loaded into the isolated kind cluster and installed using their actual imported
manifest digests and IfNotPresent. API/Nginx and the explicit bootstrap Job
passed restricted admission and ran nonroot with a read-only root filesystem.

Real encrypted backup/restore passed with PostgreSQL16 and separate persistent
asset claims. Content and asset hashes matched after restore; the application
successfully decrypted a stored mock connector credential without external
provider access. Restore preserves a fresh target JWT key, restores only the AI
key, and rejects a historical JWT before database writes. A historical session
revoked after backup remained rejected on the restored application. Both
nonempty database and reused JWT restore refusals passed.

Both releases subsequently upgraded to the final API/Admin digests with their
original PVC identities and secrets preserved. Migration 18 to 19 and the actual
independent schedule-revision/stale-write behavior passed. With PostgreSQL down,
healthz remained 200 while readyz returned 503 in 2.008s; DB recovery restored
readiness in 2.408s. Chromium 151 through the final Nginx passed form login,
dashboard/editor/account deep links, content save, channel assignment, publication
and matching Delivery. Production /_static bundles loaded with zero CSP, browser,
HTTP or cross-origin errors; no screenshots or traces were recorded.

The cluster report and its linked secret-free JSON/log artifacts contain actual
final digests, measured timings and the repaired nonroot tar/PVC issue. The
chosen target cluster's ingress, CNI policy enforcement, CSI, TLS and load
behavior still require operator acceptance. No HA or customer-cluster rollout
is claimed.

After acceptance, the isolated node and its own forwarding/runtime services were
reversibly stopped. Automatic approval review rejected destructive cleanup; no
cluster volume, key, backup, archive or kubeconfig was deleted. Private files
remain protected (directory 0700, credential files 0600). Canonical DB/API/Admin
services and final images/artifacts remain unchanged. The cluster report links
the exact secret-free cleanup/status record.
