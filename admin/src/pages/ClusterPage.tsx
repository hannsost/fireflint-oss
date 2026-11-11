import { useQuery } from "@tanstack/react-query";
import { bff, ApiError } from "../api/client";
import type { ClusterOverview, PodView } from "../types";

function podBadgeClass(pod: PodView): string {
  if (pod.reason) return "store-degraded";
  switch (pod.phase) {
    case "Running":
      return "store-ready";
    case "Succeeded":
      return "store-fallback";
    case "Pending":
      return "store-pending";
    default:
      return "store-degraded";
  }
}

export function ClusterPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["cluster", "overview"],
    queryFn: () => bff.get<ClusterOverview>("/cluster/overview"),
    retry: false,
    refetchInterval: 10000,
  });

  const forbidden = error instanceof ApiError && error.status === 403;
  const unreachable = !!error && !forbidden;

  return (
    <>
      <div className="topbar">
        <h1>Cluster</h1>
        {data && <span className="hint">Namespace {data.namespace}</span>}
      </div>

      <p className="hint">
        <strong>Optionale Ansicht.</strong> Live-Zustand der FireFlint-Workloads
        im Cluster — Operator-Health, Pods, StatefulSets und Volumes. Read-only
        über einen separaten Dienst; der Core bleibt Kubernetes-frei. Ohne
        laufenden Cluster-BFF bleibt diese Seite inaktiv — das ist kein Fehler.
      </p>

      {forbidden && (
        <div className="panel">
          <p className="muted">Diese Ansicht ist Plattform-Administratoren vorbehalten.</p>
        </div>
      )}
      {unreachable && (
        <div className="panel">
          <div className="empty-state">
            <p className="empty-title">Kein Cluster-BFF verbunden — nicht konfiguriert</p>
            <p className="muted">
              Diese Ansicht ist optional und benötigt einen laufenden
              kind-Cluster, den Storage-Operator und den read-only Cluster-BFF
              (Standard <span className="code">http://localhost:8091</span>).
            </p>
            <p className="muted">
              Einrichtung: siehe <span className="code">deploy/operator/</span> und{" "}
              <span className="code">operator/sitegraph-cluster-bff/README.md</span>.
              BFF-URL überschreibbar via <span className="code">VITE_BFF_URL</span>.
            </p>
          </div>
        </div>
      )}

      {!error && (
        <>
          <div className="panel">
            <h2>Operator</h2>
            {isLoading && <p className="muted">Lädt…</p>}
            {data && (
              <div className="row">
                <span className={`badge ${data.operator.healthy ? "store-ready" : "store-degraded"}`}>
                  {data.operator.healthy ? "Gesund" : data.operator.present ? "Gestört" : "Fehlt"}
                </span>
                <span className="code">{data.operator.name}</span>
                <span className="muted">{data.operator.ready} bereit</span>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Pods ({data?.pods.length ?? 0})</h2>
            {data && data.pods.length === 0 && <p className="muted">Keine Pods.</p>}
            {data && data.pods.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Pod</th>
                    <th>Phase</th>
                    <th>Bereit</th>
                    <th>Restarts</th>
                    <th>Hinweis</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pods.map((p) => (
                    <tr key={p.name}>
                      <td className="code" data-label="Pod">{p.name}</td>
                      <td data-label="Phase">
                        <span className={`badge ${podBadgeClass(p)}`}>{p.phase}</span>
                      </td>
                      <td data-label="Bereit">{p.ready}</td>
                      <td data-label="Restarts" className={p.restarts > 0 ? "" : "muted"}>
                        {p.restarts}
                      </td>
                      <td data-label="Hinweis" className={p.reason ? "error" : "muted"}>
                        {p.reason ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h2>Workloads ({data?.workloads.length ?? 0})</h2>
            {data && data.workloads.length === 0 && <p className="muted">Keine StatefulSets.</p>}
            {data && data.workloads.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Art</th>
                    <th>Bereit</th>
                    <th>Image</th>
                  </tr>
                </thead>
                <tbody>
                  {data.workloads.map((w) => (
                    <tr key={w.name}>
                      <td className="code" data-label="Name">{w.name}</td>
                      <td data-label="Art">{w.kind}</td>
                      <td data-label="Bereit">{w.ready}</td>
                      <td className="code" data-label="Image">{w.image ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h2>Volumes ({data?.volumes.length ?? 0})</h2>
            {data && data.volumes.length === 0 && <p className="muted">Keine PersistentVolumeClaims.</p>}
            {data && data.volumes.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Volume</th>
                    <th>Status</th>
                    <th>Kapazität</th>
                    <th>StorageClass</th>
                  </tr>
                </thead>
                <tbody>
                  {data.volumes.map((v) => (
                    <tr key={v.name}>
                      <td className="code" data-label="Volume">{v.name}</td>
                      <td data-label="Status">
                        <span className={`badge ${v.phase === "Bound" ? "store-ready" : "store-pending"}`}>
                          {v.phase}
                        </span>
                      </td>
                      <td data-label="Kapazität">{v.capacity ?? "—"}</td>
                      <td data-label="StorageClass" className="muted">{v.storage_class ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}
