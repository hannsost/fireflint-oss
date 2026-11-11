import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type {
  BindingSelector,
  IsolationTopology,
  StorageBinding,
  StorageStatus,
  StorageTarget,
} from "../types";

const TOPOLOGY_LABEL: Record<IsolationTopology, string> = {
  shared_row: "Shared Row",
  schema_per_tenant: "Schema/Tenant",
  database_per_tenant: "DB/Tenant",
  cluster_per_tenant: "Cluster/Tenant",
  external: "Extern",
};

const STATUS_LABEL: Record<StorageStatus, string> = {
  pending: "Ausstehend",
  provisioning: "Wird erstellt",
  ready: "Bereit",
  migrating: "Migration",
  degraded: "Gestört",
  restoring: "Wiederherstellung",
  deleting: "Löschung",
};

function StorageStatusBadge({ status }: { status: StorageStatus }) {
  return <span className={`badge store-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function shortId(id?: string | null) {
  if (!id) return null;
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function selectorSummary(s: BindingSelector): string {
  const parts: string[] = [];
  if (s.organizationId) parts.push(`Org ${shortId(s.organizationId)}`);
  if (s.domain) parts.push(`Domain ${s.domain}`);
  if (s.dataCategory) parts.push(`Kategorie ${s.dataCategory}`);
  if (s.minimumClassification) parts.push(`≥ ${s.minimumClassification}`);
  if (s.region) parts.push(`Region ${s.region}`);
  return parts.length ? parts.join(" · ") : "alle Kontexte";
}

export function StoragePage() {
  const targetsQuery = useQuery({
    queryKey: ["storage", "targets"],
    queryFn: () => api.get<{ targets: StorageTarget[] }>("/api/storage/targets"),
    retry: false,
  });
  const bindingsQuery = useQuery({
    queryKey: ["storage", "bindings"],
    queryFn: () => api.get<{ bindings: StorageBinding[] }>("/api/storage/bindings"),
    retry: false,
  });

  const forbidden =
    (targetsQuery.error instanceof ApiError && targetsQuery.error.status === 403) ||
    (bindingsQuery.error instanceof ApiError && bindingsQuery.error.status === 403);

  const targets = targetsQuery.data?.targets ?? [];
  const bindings = bindingsQuery.data?.bindings ?? [];

  return (
    <>
      <div className="topbar">
        <h1>Speicher &amp; Datenresidenz</h1>
      </div>

      <p className="hint">
        Wo Mandantendaten liegen — Region, Isolations­topologie und Status je Ziel,
        sowie die Bindungsregeln, die einen Kontext (Organisation, Domain,
        Klassifizierung) auf ein Ziel abbilden. Read-only; Verbindungs­geheimnisse
        bleiben opak.
      </p>

      {forbidden && (
        <div className="panel">
          <p className="muted">Diese Ansicht ist Plattform-Administratoren vorbehalten.</p>
        </div>
      )}

      {!forbidden && (
        <>
          <div className="panel">
            <h2>Speicherziele ({targets.length})</h2>
            {targetsQuery.isLoading && <p className="muted">Lädt…</p>}
            {!targetsQuery.isLoading && targets.length === 0 && (
              <p className="muted">Keine Ziele registriert.</p>
            )}
            {targets.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Ziel</th>
                    <th>Topologie</th>
                    <th>Region</th>
                    <th>Status</th>
                    <th>Organisation</th>
                    <th>Schema</th>
                    <th>Endpoint-Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {targets.map((t) => (
                    <tr key={t.id}>
                      <td className="code" data-label="Ziel">{t.id}</td>
                      <td data-label="Topologie">{TOPOLOGY_LABEL[t.topology] ?? t.topology}</td>
                      <td data-label="Region">{t.region}</td>
                      <td data-label="Status">
                        <StorageStatusBadge status={t.status} />
                      </td>
                      <td className="muted" data-label="Organisation">
                        {t.organization_id ? (
                          <span className="code">{shortId(t.organization_id)}</span>
                        ) : (
                          "alle"
                        )}
                      </td>
                      <td className="muted" data-label="Schema">{t.schema_version ?? "—"}</td>
                      <td className="code" data-label="Endpoint-Ref">{t.endpoint_ref}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h2>Bindungsregeln ({bindings.length})</h2>
            {bindingsQuery.isLoading && <p className="muted">Lädt…</p>}
            {!bindingsQuery.isLoading && bindings.length === 0 && (
              <p className="muted">Keine Bindungen definiert — es greift der Default-Pool.</p>
            )}
            {bindings.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Regel</th>
                    <th>Kontext</th>
                    <th>Ziel</th>
                    <th>Priorität</th>
                    <th>Typ</th>
                  </tr>
                </thead>
                <tbody>
                  {bindings
                    .slice()
                    .sort((a, b) => b.priority - a.priority)
                    .map((b) => (
                      <tr key={b.id}>
                        <td className="code" data-label="Regel">{b.id}</td>
                        <td data-label="Kontext">{selectorSummary(b.selector)}</td>
                        <td className="code" data-label="Ziel">{b.target_id}</td>
                        <td data-label="Priorität">{b.priority}</td>
                        <td data-label="Typ">
                          {b.fallback ? (
                            <span className="badge store-fallback">Fallback</span>
                          ) : (
                            <span className="badge store-ready">Regel</span>
                          )}
                        </td>
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
