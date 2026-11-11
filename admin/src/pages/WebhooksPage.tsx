import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useOrg } from "../auth/AuthContext";
import { CopyButton } from "../components/CopyButton";
import { useToast } from "../components/Toast";
import { timeAgo } from "../lib/time";
import type { Webhook, WebhookDelivery } from "../types";

const DELIVERY_BADGE: Record<string, string> = {
  delivered: "store-ready",
  pending: "store-pending",
  failed: "store-degraded",
};

export function WebhooksPage() {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({
    queryKey: ["webhooks", org],
    queryFn: () => api.get<{ webhooks: Webhook[] }>(`/api/orgs/${org}/webhooks`),
    retry: false,
  });
  const forbidden = error instanceof ApiError && error.status === 403;
  const hooks = data?.webhooks ?? [];

  const { data: deliveryData } = useQuery({
    queryKey: ["webhook-deliveries", org],
    queryFn: () => api.get<{ deliveries: WebhookDelivery[] }>(`/api/orgs/${org}/webhook-deliveries`),
    enabled: !forbidden,
    retry: false,
    refetchInterval: 5000,
  });
  const deliveries = deliveryData?.deliveries ?? [];

  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api.post<{ secret: string }>(`/api/orgs/${org}/webhooks`, { url }),
    onSuccess: (r) => {
      setSecret(r.secret);
      setErr(null);
      setUrl("");
      toast("Webhook angelegt ✓");
      qc.invalidateQueries({ queryKey: ["webhooks", org] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Anlegen fehlgeschlagen."),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/orgs/${org}/webhooks/${id}`),
    onSuccess: () => {
      toast("Webhook gelöscht ✓");
      qc.invalidateQueries({ queryKey: ["webhooks", org] });
    },
  });

  if (forbidden) {
    return (
      <>
        <div className="topbar">
          <h1>Webhooks</h1>
        </div>
        <div className="panel">
          <p className="muted">Webhooks verwalten ist Owner-Konten vorbehalten.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>Webhooks</h1>
      </div>
      <p className="hint">
        Bei jeder Veröffentlichung/Zurückziehung sendet FireFlint ein signiertes
        POST an deine Endpunkte (Header <span className="code">X-FireFlint-Signature</span>,
        HMAC-SHA256) — ideal für Cache-Invalidierung oder Rebuilds.
      </p>

      <div className="panel">
        {hooks.length === 0 && <p className="muted">Noch keine Webhooks.</p>}
        {hooks.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Status</th>
                <th>Erstellt</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hooks.map((h) => (
                <tr key={h.id}>
                  <td className="code" data-label="URL">{h.url}</td>
                  <td data-label="Status">
                    <span className={`badge ${h.active ? "store-ready" : "store-degraded"}`}>
                      {h.active ? "Aktiv" : "Inaktiv"}
                    </span>
                  </td>
                  <td className="muted" data-label="Erstellt">
                    {new Date(h.created_at).toLocaleDateString("de-DE")}
                  </td>
                  <td data-label="" style={{ textAlign: "right" }}>
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm("Webhook löschen?")) del.mutate(h.id);
                      }}
                    >
                      Löschen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Webhook hinzufügen</h2>
        <div className="field">
          <label htmlFor="wh-url">Endpoint-URL</label>
          <input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/fireflint" />
        </div>
        {err && <p className="error">{err}</p>}
        {secret && (
          <p className="hint">
            Signing-Secret (jetzt notieren, wird nicht erneut angezeigt):{" "}
            <span className="code">{secret}</span> <CopyButton text={secret} />
          </p>
        )}
        <div className="actions">
          <button className="primary" onClick={() => add.mutate()} disabled={add.isPending || !url}>
            {add.isPending ? "Anlegen…" : "Hinzufügen"}
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Letzte Zustellungen</h2>
        <p className="hint">
          Persistente Outbox mit Retry/Backoff. Fehlgeschlagene Versuche werden
          erneut zugestellt; nach mehreren Fehlversuchen landen sie im
          Dead-Letter-Zustand („failed").
        </p>
        {deliveries.length === 0 && <p className="muted">Noch keine Zustellungen.</p>}
        {deliveries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Versuche</th>
                <th>HTTP</th>
                <th>Zeit</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td data-label="Event" className="code">{d.event}</td>
                  <td data-label="Status">
                    <span className={`badge ${DELIVERY_BADGE[d.status] ?? "store-pending"}`}>
                      {d.status}
                    </span>
                  </td>
                  <td data-label="Versuche">{d.attempts}</td>
                  <td data-label="HTTP" className={d.last_error ? "error" : "muted"}>
                    {d.response_status ?? (d.last_error ? "—" : "")}
                  </td>
                  <td
                    data-label="Zeit"
                    className="muted"
                    title={new Date(d.delivered_at ?? d.created_at).toLocaleString("de-DE")}
                  >
                    {timeAgo(d.delivered_at ?? d.created_at)}
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
