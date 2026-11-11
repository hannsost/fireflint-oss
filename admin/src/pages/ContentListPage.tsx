import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { UiIcon } from "../components/Brand";
import { timeAgo } from "../lib/time";
import type { ContentObject, ContentType } from "../types";

export function ContentListPage() {
  const { typeKey } = useParams<{ typeKey: string }>();
  const org = useOrg();
  const { memberships } = useAuth();
  const role = memberships.find(member => member.org_id === org)?.role;
  const canWrite = role === "owner" || role === "editor";
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState("");

  // Debounce the search box so we don't query on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data: types } = useQuery({
    queryKey: ["content-types", org],
    queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`),
  });
  const type = types?.find((t) => t.key === typeKey);
  const primaryField = type?.schema.fields?.[0]?.key;

  const params = new URLSearchParams();
  if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
  if (status) params.set("status", status);
  const qs = params.toString();

  const {
    data: items,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["content", org, typeKey, debouncedQ.trim(), status],
    queryFn: () =>
      api.get<ContentObject[]>(`/api/orgs/${org}/content/${typeKey}${qs ? `?${qs}` : ""}`),
    enabled: !!typeKey,
  });

  const title = (o: ContentObject) =>
    (primaryField && (o.data[primaryField] as string)) || o.id.slice(0, 8);

  return (
    <>
      <div className="topbar">
        <h1>
          {type?.name ?? typeKey}{" "}
          {items && items.length > 0 && <span className="muted-count">({items.length})</span>}
        </h1>
        {canWrite && <Link to={`/content/${typeKey}/new`} className="button primary"><UiIcon name="plus" />Neu anlegen</Link>}
      </div>

      <div className="panel">
        <div className="row" style={{ gap: "0.6rem", marginBottom: "1rem" }}>
          <input
            aria-label="Inhalte suchen"
            placeholder="Suchen…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: "20rem" }}
          />
          {q && (
            <button type="button" className="icon-button" onClick={() => setQ("")} title="Suche zurücksetzen" aria-label="Suche zurücksetzen">
              <UiIcon name="close" />
            </button>
          )}
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
            <option value="">Alle Status</option>
            <option value="draft">Entwurf</option>
            <option value="published">Veröffentlicht</option>
          </select>
        </div>
        {isLoading && <p className="muted">Lädt…</p>}
        {error && <p className="error">Konnte Inhalte nicht laden.</p>}
        {items && items.length === 0 && (
          <EmptyState title={debouncedQ || status ? "Keine Treffer." : "Noch keine Einträge."}>
            {canWrite && !debouncedQ && !status && (
              <Link to={`/content/${typeKey}/new`} className="button primary"><UiIcon name="plus" />Ersten Eintrag anlegen</Link>
            )}
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Titel</th>
                <th>Status</th>
                <th>Aktualisiert</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/content/${typeKey}/${o.id}`}>{title(o)}</Link>
                  </td>
                  <td>
                    <StatusBadge status={o.status} />
                    {o.status === "published" && o.has_unpublished_changes && <div className="hint">Änderungen im Entwurf</div>}
                  </td>
                  <td className="muted" title={new Date(o.updated_at).toLocaleString("de-DE")}>
                    {timeAgo(o.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
