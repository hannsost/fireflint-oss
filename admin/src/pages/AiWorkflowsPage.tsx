import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useOrg } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import { timeAgo } from "../lib/time";
import type { AiConnector, AiWorkflow, ContentType, WorkflowGraph } from "../types";

export function AiWorkflowsPage() {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();

  const { data, error } = useQuery({
    queryKey: ["ai-workflows", org],
    queryFn: () => api.get<{ workflows: AiWorkflow[] }>(`/api/orgs/${org}/ai/workflows`),
    retry: false,
  });
  const forbidden = error instanceof ApiError && error.status === 403;
  const workflows = data?.workflows ?? [];

  const { data: connData } = useQuery({
    queryKey: ["ai-connectors", org],
    queryFn: () => api.get<{ connectors: AiConnector[] }>(`/api/orgs/${org}/ai/connectors`),
    enabled: !forbidden,
    retry: false,
  });
  const connectors = connData?.connectors ?? [];

  const { data: typeData } = useQuery({
    queryKey: ["content-types", org],
    queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`),
    enabled: !forbidden,
    retry: false,
  });
  const contentTypes = typeData ?? [];

  const [name, setName] = useState("");
  const [copilot, setCopilot] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [pendingGraph, setPendingGraph] = useState<WorkflowGraph | null>(null);
  const [pendingContentType, setPendingContentType] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (graph: WorkflowGraph) =>
      api.post<{ workflow: AiWorkflow }>(`/api/orgs/${org}/ai/workflows`, {
        name: name || "Neuer Workflow",
        graph,
      }),
    onSuccess: (r) => {
      toast("Workflow angelegt ✓");
      qc.invalidateQueries({ queryKey: ["ai-workflows", org] });
      nav(`/ai/workflows/${r.workflow.id}`);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Anlegen fehlgeschlagen."),
  });

  const scaffold = useMutation({
    mutationFn: () =>
      api.post<{ graph: WorkflowGraph }>(`/api/orgs/${org}/ai/copilot`, {
        message: copilot,
        connector_id: connectorId || null,
      }),
    onSuccess: (r) => {
      setErr(null);
      const output = r.graph.nodes?.find((node) => node.type === "output");
      const target = output?.data?.content_type;
      if (typeof target === "string" && target.trim()) {
        create.mutate(r.graph);
      } else {
        setPendingGraph(r.graph);
        setPendingContentType("");
      }
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Copilot fehlgeschlagen."),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/orgs/${org}/ai/workflows/${id}`),
    onSuccess: () => {
      toast("Workflow gelöscht ✓");
      qc.invalidateQueries({ queryKey: ["ai-workflows", org] });
    },
  });

  if (forbidden) {
    return (
      <>
        <div className="topbar">
          <h1>KI-Workflows</h1>
        </div>
        <div className="panel">
          <p className="muted">Kein Zugriff auf KI-Workflows in dieser Organisation.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>KI-Workflows</h1>
      </div>
      <p className="hint">
        Baue visuelle KI-Pipelines: Agenten, Bedingungen, Schleifen, Parallelisierung
        und Zusammenführung. Das Ergebnis landet als <strong>Entwurf</strong> in deinen
        Inhalten (optionale Freigabe = Veröffentlichung). Ohne Connector wird der
        Mock-Anbieter genutzt — ideal zum Ausprobieren.
      </p>

      <div className="panel">
        {workflows.length === 0 && <p className="muted">Noch keine Workflows.</p>}
        {workflows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Knoten</th>
                <th>Geändert</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.id}>
                  <td data-label="Name">
                    <a href={`/ai/workflows/${w.id}`} onClick={(e) => { e.preventDefault(); nav(`/ai/workflows/${w.id}`); }}>
                      {w.name}
                    </a>
                  </td>
                  <td data-label="Knoten" className="muted">{w.graph?.nodes?.length ?? 0}</td>
                  <td data-label="Geändert" className="muted" title={new Date(w.updated_at).toLocaleString("de-DE")}>
                    {timeAgo(w.updated_at)}
                  </td>
                  <td data-label="" style={{ textAlign: "right" }}>
                    <button onClick={() => nav(`/ai/workflows/${w.id}`)}>Öffnen</button>{" "}
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm("Workflow löschen?")) del.mutate(w.id);
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
        <h2>Neuer Workflow</h2>
        <div className="field">
          <label htmlFor="wf-name">Name</label>
          <input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Blog-Entwürfe aus Stichpunkten" />
        </div>
        <div className="actions">
          <button
            className="primary"
            onClick={() => create.mutate({ nodes: [], edges: [] })}
            disabled={create.isPending}
          >
            Leeren Workflow anlegen
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Mit Copilot erstellen</h2>
        <p className="hint">
          Beschreibe in Worten, was der Workflow tun soll — der Copilot entwirft ein
          erstes Graph-Gerüst, das du anschließend auf dem Board feinjustierst.
        </p>
        {connectors.length > 0 && (
          <div className="field">
            <label htmlFor="cop-conn">Connector (für den Copilot)</label>
            <select id="cop-conn" value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
              <option value="">Mock (ohne Key)</option>
              {connectors.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="cop-msg">Beschreibung</label>
          <textarea
            id="cop-msg"
            rows={3}
            value={copilot}
            onChange={(e) => setCopilot(e.target.value)}
            placeholder="Erzeuge aus einem Thema einen Blog-Entwurf: zuerst Gliederung, dann Ausformulierung, Ergebnis als Entwurf vom Typ 'post'."
          />
        </div>
        {err && <p className="error">{err}</p>}
        {pendingGraph && (
          <div className="field">
            <label htmlFor="cop-type">Ziel-Inhaltstyp (erforderlich)</label>
            <select
              id="cop-type"
              value={pendingContentType}
              onChange={(e) => setPendingContentType(e.target.value)}
            >
              <option value="">— wählen —</option>
              {contentTypes.map((t) => (
                <option key={t.id} value={t.key}>{t.name} ({t.key})</option>
              ))}
            </select>
            <p className="hint">Kein bekannter Typ wurde aus der Beschreibung erkannt. Bitte vor dem Speichern auswählen.</p>
          </div>
        )}
        <div className="actions">
          <button
            className="primary"
            onClick={() => scaffold.mutate()}
            disabled={scaffold.isPending || create.isPending || !copilot.trim()}
          >
            {scaffold.isPending ? "Entwerfe…" : "Workflow entwerfen"}
          </button>
          {pendingGraph && (
            <button
              className="primary"
              disabled={!pendingContentType || create.isPending}
              onClick={() => {
                const graph: WorkflowGraph = {
                  ...pendingGraph,
                  nodes: pendingGraph.nodes.map((node) =>
                    node.type === "output"
                      ? { ...node, data: { ...node.data, content_type: pendingContentType } }
                      : node,
                  ),
                };
                setPendingGraph(null);
                create.mutate(graph);
              }}
            >
              {create.isPending ? "Speichere…" : "Workflow speichern"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
