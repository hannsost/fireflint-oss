# FireFlint Cluster-View BFF

Read-only Backend-for-Frontend für die Cluster-Sicht der Admin-UI.

## Warum ein eigener Dienst

Der Core bleibt bewusst **Kubernetes-frei** (kein kube-Typ und kein
Kubernetes-API-Aufruf im Request-Pfad). Dieser kleine, separate Dienst hält den
**einzigen** lesenden Kubernetes-Zugriff und liefert eine bereinigte
JSON-Übersicht. Damit bleibt die Architektur-Grenze erhalten und die
Angriffsfläche/Abhängigkeiten des Cores unverändert.

## Endpoints

- `GET /healthz` — Liveness (ungeschützt).
- `GET /cluster/overview` — Operator-Health, Pods, StatefulSets (Workloads) und
  PVCs (Volumes) im konfigurierten Namespace. Geschützt durch das Access-JWT des
  Cores (geteiltes `JWT_SECRET`, HS256, `typ=access`) **und** das
  Plattform-Admin-Claim `pa=true` — andernfalls `403`.

Antwort (gekürzt):

```json
{
  "namespace": "sitegraph-system",
  "operator": { "name": "...", "ready": "2/2", "healthy": true, "present": true },
  "pods":      [ { "name": "...", "phase": "Running", "ready": "1/1", "restarts": 0, "reason": null } ],
  "workloads": [ { "name": "...", "kind": "StatefulSet", "ready": "1/1", "image": "postgres:17" } ],
  "volumes":   [ { "name": "...", "phase": "Bound", "capacity": "1Gi", "storage_class": "standard" } ]
}
```

## Konfiguration (Env)

| Variable | Default | Bedeutung |
| --- | --- | --- |
| `BFF_BIND` | `0.0.0.0:8091` | Bind-Adresse (lokal; `:8090` gehört dem Core) |
| `BFF_NAMESPACE` | `sitegraph-system` | gelesener Namespace |
| `OPERATOR_DEPLOYMENT` | `sitegraph-storage-operator` | Deployment für die Health-Anzeige |
| `JWT_SECRET` | dev-Default (unsicher) | muss mit dem Core übereinstimmen |

Lokal nutzt der Dienst die `kubeconfig` (Default-Context); im Cluster die
In-Cluster-Config des eigenen ServiceAccounts.

## RBAC (minimal, read-only)

Eigener ServiceAccount, namespace-scoped, nur `get`/`list`/`watch` auf
`pods`, `statefulsets`, `persistentvolumeclaims`, `deployments`. Keine
Schreibrechte, kein ClusterRole, kein Wildcard.

## Deployment

Manifeste unter `deploy/cluster-bff` (kustomize): ServiceAccount, minimale
read-only `Role`/`RoleBinding`, Deployment, Service.

```sh
docker build -f operator/cluster-bff.Dockerfile -t ghcr.io/sitegraph/sitegraph-cluster-bff:0.1.0 .
# JWT_SECRET muss mit dem Core übereinstimmen:
kubectl -n sitegraph-system create secret generic sitegraph-cluster-bff \
  --from-literal=jwt-secret="$JWT_SECRET"
kubectl apply -k deploy/cluster-bff   # Namespace via deploy/operator zuerst
```

## Sicherheit / Grenzen

- Read-only; keine Mutationen, kein ClusterRole, kein Wildcard.
- Verbindungs- und Secret-Werte werden nie ausgeliefert.
- Zugriff nur mit gültigem Access-Token **und** Plattform-Admin-Claim (`pa`);
  dasselbe Claim gated das Speicher-Panel im Core.

## UI-Anbindung

Die Admin-UI spricht den Dienst über `VITE_BFF_URL` (Default
`http://localhost:8091`) mit demselben Access-Token an (siehe
`admin/src/api/client.ts`, Export `bff`). Der Core läuft lokal auf `:8090`,
daher bindet der BFF auf `:8091`.
