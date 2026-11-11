import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useOrg } from "../auth/AuthContext";
import { timeAgo } from "../lib/time";
import type { AuditEntry } from "../types";

const ACTION_LABEL: Record<string, string> = {
  "content.create": "Inhalt angelegt",
  "content.update": "Inhalt geändert",
  "content.publish": "Veröffentlicht",
  "content.unpublish": "Zurückgezogen",
  "content.delete": "Inhalt gelöscht",
  "content.channels": "Channels geändert",
  "content.revert": "Version wiederhergestellt",
  "website.create": "Website angelegt",
  "token.create": "Token erstellt",
  "token.delete": "Token widerrufen",
};

function actionClass(action: string): string {
  if (action.endsWith(".delete")) return "store-degraded";
  if (action.endsWith(".create") || action === "content.publish") return "store-ready";
  return "store-fallback";
}

function shortId(id?: string | null): string {
  if (!id) return "—";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function metaSummary(meta?: Record<string, unknown> | null): string {
  if (!meta) return "—";
  const parts = Object.entries(meta).map(([k, v]) => `${k}: ${String(v)}`);
  return parts.length ? parts.join(" · ") : "—";
}

export function AuditPage() {
  const org = useOrg();
  const [limit, setLimit] = useState(100);

  const { data, isLoading, error } = useQuery({
    queryKey: ["audit", org, limit],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/api/orgs/${org}/audit?limit=${limit}`),
    retry: false,
  });

  const forbidden = error instanceof ApiError && error.status === 403;
  const entries = data?.entries ?? [];

  return (
    <>
      <div className="topbar">
        <h1>
          Aktivität {entries.length > 0 && <span className="muted-count">({entries.length})</span>}
        </h1>
        <label className="row">
          <span className="muted">Anzahl</span>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ width: "auto" }}>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
        </label>
      </div>

      <p className="hint">
        Revisionssicheres Protokoll aller schreibenden Aktionen in dieser
        Organisation — wer hat wann was geändert (Whitepaper §19 / DSGVO-Nachweis).
      </p>

      {forbidden && (
        <div className="panel">
          <p className="muted">Das Aktivitätsprotokoll ist Owner-Konten vorbehalten.</p>
        </div>
      )}

      {!forbidden && (
        <div className="panel">
          {isLoading && <p className="muted">Lädt…</p>}
          {!isLoading && entries.length === 0 && <p className="muted">Noch keine Einträge.</p>}
          {entries.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Zeitpunkt</th>
                  <th>Akteur</th>
                  <th>Aktion</th>
                  <th>Ziel</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td data-label="Zeitpunkt" title={new Date(e.created_at).toLocaleString("de-DE")}>
                      {timeAgo(e.created_at)}
                    </td>
                    <td data-label="Akteur" className={e.user_email ? "" : "muted"}>
                      {e.user_email ?? "System"}
                    </td>
                    <td data-label="Aktion">
                      <span className={`badge ${actionClass(e.action)}`}>
                        {ACTION_LABEL[e.action] ?? e.action}
                      </span>
                    </td>
                    <td data-label="Ziel" className="muted">
                      {e.target_type} <span className="code">{shortId(e.target_id)}</span>
                    </td>
                    <td data-label="Details" className="muted">{metaSummary(e.meta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
