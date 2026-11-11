import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, ApiError } from "../api/client";
import { useOrg } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import { timeAgo } from "../lib/time";
import type {
  AiConnector,
  AiRun,
  AiWorkflow,
  ContentType,
  WorkflowGraph,
  WorkflowSettings,
} from "../types";

interface FlowData extends Record<string, unknown> {
  kind: string;
  config: Record<string, unknown>;
}
type FlowNode = Node<FlowData>;

const KINDS: { kind: string; label: string }[] = [
  { kind: "trigger", label: "Start" },
  { kind: "agent", label: "Agent" },
  { kind: "condition", label: "Bedingung" },
  { kind: "loop", label: "Schleife" },
  { kind: "parallel", label: "Parallel" },
  { kind: "join", label: "Zusammenführen" },
  { kind: "memory", label: "Memory" },
  { kind: "output", label: "Ausgabe" },
];

const KIND_COLOR: Record<string, string> = {
  trigger: "#16a34a",
  agent: "#2563eb",
  condition: "#d97706",
  loop: "#7c3aed",
  parallel: "#0891b2",
  join: "#0891b2",
  memory: "#0f766e",
  output: "#dc2626",
};

function FFNode({ data, selected, id }: NodeProps<FlowNode>) {
  const color = KIND_COLOR[data.kind] ?? "#64748b";
  return (
    <div
      data-testid={`workflow-node-${data.kind}`}
      data-node-id={id}
      style={{
        border: `2px solid ${selected ? "#111827" : color}`,
        borderRadius: 8,
        background: "#fff",
        minWidth: 120,
        fontSize: 12,
        boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div style={{ background: color, color: "#fff", padding: "3px 8px", borderRadius: "6px 6px 0 0", fontWeight: 600 }}>
        {KINDS.find((k) => k.kind === data.kind)?.label ?? data.kind}
      </div>
      <div style={{ padding: "4px 8px", color: "#374151" }}>
        {String(
          (data.config.label as string) ||
            (data.config.content_type as string) ||
            (data.config.key as string) ||
            "",
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { ffnode: FFNode };

function defaultConfig(kind: string): Record<string, unknown> {
  switch (kind) {
    case "agent":
      return { model: "claude-sonnet-4-6", prompt: "{{input}}" };
    case "loop":
      return { model: "claude-sonnet-4-6", prompt: "{{input}} (#{{index}})", iterations: 3 };
    case "condition":
      return { input: "input", contains: "" };
    case "memory":
      return { mode: "store", scope: "run", key: "" };
    case "output":
      return { content_type: "", mode: "draft" };
    default:
      return {};
  }
}

function rid(kind: string): string {
  return `${kind}-${Math.random().toString(36).slice(2, 7)}`;
}

function toFlow(graph: WorkflowGraph): { nodes: FlowNode[]; edges: Edge[] } {
  const nodes: FlowNode[] = (graph.nodes ?? []).map((n, i) => {
    const { __pos, ...config } = n.data ?? {};
    return {
      id: n.id,
      type: "ffnode",
      position: __pos ?? { x: 120, y: 80 + i * 90 },
      data: { kind: n.type, config: config as Record<string, unknown> },
    };
  });
  const edges: Edge[] = (graph.edges ?? []).map((e, i) => ({
    id: `e${i}-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    label: e.branch ?? undefined,
  }));
  return { nodes, edges };
}

function toGraph(nodes: FlowNode[], edges: Edge[], settings: WorkflowSettings): WorkflowGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.kind,
      data: { ...n.data.config, __pos: n.position },
    })),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      branch: typeof e.label === "string" ? e.label : null,
    })),
    settings,
  };
}

export function AiWorkflowEditPage() {
  const org = useOrg();
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ["ai-workflow", org, id],
    queryFn: () => api.get<{ workflow: AiWorkflow }>(`/api/orgs/${org}/ai/workflows/${id}`),
    retry: false,
  });
  const { data: connData } = useQuery({
    queryKey: ["ai-connectors", org],
    queryFn: () => api.get<{ connectors: AiConnector[] }>(`/api/orgs/${org}/ai/connectors`),
    retry: false,
  });
  const { data: typeData } = useQuery({
    queryKey: ["content-types", org],
    queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`),
    retry: false,
  });
  const { data: runsData } = useQuery({
    queryKey: ["ai-runs", org, id],
    queryFn: () => api.get<{ runs: AiRun[] }>(`/api/orgs/${org}/ai/workflows/${id}/runs`),
    retry: false,
  });

  const connectors = connData?.connectors ?? [];
  const contentTypes = typeData ?? [];

  const [name, setName] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runInput, setRunInput] = useState("");
  const [run, setRun] = useState<AiRun | null>(null);
  const [settings, setSettings] = useState<WorkflowSettings>({});
  const [err, setErr] = useState<string | null>(null);

  // Hydrate once the workflow arrives.
  useEffect(() => {
    if (data?.workflow) {
      setName(data.workflow.name);
      const flow = toFlow(data.workflow.graph ?? { nodes: [], edges: [] });
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setSettings(data.workflow.graph?.settings ?? {});
    }
  }, [data?.workflow, setNodes, setEdges]);

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/orgs/${org}/ai/workflows/${id}`, { name, graph: toGraph(nodes, edges, settings) }),
    onSuccess: () => {
      toast("Workflow gespeichert ✓");
      qc.invalidateQueries({ queryKey: ["ai-workflows", org] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Speichern fehlgeschlagen."),
  });

  const doRun = useMutation({
    mutationFn: () =>
      api.post<{ run: AiRun }>(`/api/orgs/${org}/ai/workflows/${id}/run`, { input: runInput }),
    onSuccess: (r) => {
      setRun(r.run);
      setErr(null);
      qc.invalidateQueries({ queryKey: ["ai-runs", org, id] });
      qc.invalidateQueries({ queryKey: ["overview", org] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Ausführung fehlgeschlagen."),
  });

  function addNode(kind: string) {
    const nid = rid(kind);
    setNodes((ns) => [
      ...ns,
      {
        id: nid,
        type: "ffnode",
        position: { x: 100 + Math.random() * 240, y: 60 + ns.length * 30 },
        data: { kind, config: defaultConfig(kind) },
      },
    ]);
  }

  function setConfig(key: string, value: unknown) {
    if (!selectedId) return;
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selectedId ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } } : n,
      ),
    );
  }

  function removeSelected() {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  }

  function onConnect(c: Connection) {
    setEdges((es) => addEdge({ ...c, id: `e-${rid("x")}` }, es));
  }

  // Click an edge to cycle its branch label: none -> true -> false -> none.
  function onEdgeClick(_: unknown, edge: Edge) {
    const next = edge.label === undefined ? "true" : edge.label === "true" ? "false" : undefined;
    setEdges((es) => es.map((e) => (e.id === edge.id ? { ...e, label: next } : e)));
  }

  if (isLoading) return <div className="panel muted">Lädt…</div>;
  if (error) {
    return (
      <div className="panel">
        <p className="error">Workflow nicht gefunden.</p>
        <button onClick={() => nav("/ai/workflows")}>Zurück</button>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>
          <button className="linklike" onClick={() => nav("/ai/workflows")}>KI-Workflows</button> ·{" "}
          <input
            className="title-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Workflow-Name"
          />
        </h1>
        <div className="actions">
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Speichert…" : "Speichern"}
          </button>
        </div>
      </div>

      <p className="hint">
        Ziehe Verbindungen von Knoten zu Knoten. Bei einer <strong>Bedingung</strong> klickst
        du auf eine Kante, um sie auf <span className="code">true</span>/<span className="code">false</span>{" "}
        zu schalten. In Prompts kannst du <span className="code">{"{{input}}"}</span> und{" "}
        <span className="code">{"{{knotenId}}"}</span> als Platzhalter verwenden.
      </p>

      <div className="ai-builder">
        <div className="ai-palette panel">
          <h3>Knoten</h3>
          {KINDS.map((k) => (
            <button key={k.kind} onClick={() => addNode(k.kind)} style={{ display: "block", width: "100%", marginBottom: 6 }}>
              + {k.label}
            </button>
          ))}
        </div>

        <div className="ai-canvas" data-testid="workflow-canvas" style={{ height: 460 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgeClick={onEdgeClick}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <div className="ai-inspector panel">
          {!selected && <p className="muted">Knoten auswählen, um ihn zu konfigurieren.</p>}
          {selected && (
            <>
              <h3>{KINDS.find((k) => k.kind === selected.data.kind)?.label}</h3>
              <p className="muted code">{selected.id}</p>
              <NodeConfig
                kind={selected.data.kind}
                config={selected.data.config}
                connectors={connectors}
                contentTypes={contentTypes}
                nodeIds={nodes.map((n) => n.id).filter((x) => x !== selected.id)}
                onChange={setConfig}
              />
              <button className="danger" onClick={removeSelected} style={{ marginTop: 8 }}>
                Knoten löschen
              </button>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Workflow-Einstellungen</h2>
        <p className="hint">
          Der Preprompt wird jedem Agenten als System-Text vorangestellt (zusätzlich
          zum Connector-Preprompt und dem knoteneigenen System). Das Token-Budget
          begrenzt die Gesamt-Token pro Lauf — bei Überschreitung bricht der Lauf ab.
        </p>
        <div className="field">
          <label htmlFor="wf-preprompt">Preprompt (optional)</label>
          <textarea
            id="wf-preprompt"
            rows={2}
            value={settings.preprompt ?? ""}
            onChange={(e) => setSettings((s) => ({ ...s, preprompt: e.target.value || null }))}
            placeholder="z. B. Schreibe sachlich, auf Deutsch, in der Wir-Form."
          />
        </div>
        <div className="field">
          <label htmlFor="wf-budget">Token-Budget pro Lauf (optional)</label>
          <input
            id="wf-budget"
            type="number"
            min={0}
            value={settings.token_budget ?? ""}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                token_budget: e.target.value ? Number(e.target.value) : null,
              }))
            }
            placeholder="z. B. 100000"
          />
        </div>
      </div>

      <div className="panel">
        <h2>Ausführen</h2>
        <p className="hint">
          Der Eingabetext steht im Graphen als <span className="code">{"{{input}}"}</span> zur Verfügung.
          Speichere vor dem ersten Lauf. Erzeugte Inhalte landen als Entwurf.
        </p>
        <div className="field">
          <label htmlFor="run-input">Eingabe</label>
          <textarea id="run-input" rows={2} value={runInput} onChange={(e) => setRunInput(e.target.value)} placeholder="Thema oder Stichpunkte…" />
        </div>
        {err && <p className="error">{err}</p>}
        <div className="actions">
          <button className="primary" onClick={() => doRun.mutate()} disabled={doRun.isPending}>
            {doRun.isPending ? "Läuft…" : "Workflow ausführen"}
          </button>
        </div>
        {run && <RunTrace run={run} />}
      </div>

      <div className="panel">
        <h2>Letzte Läufe</h2>
        {(runsData?.runs ?? []).length === 0 && <p className="muted">Noch keine Läufe.</p>}
        {(runsData?.runs ?? []).length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Zeit</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(runsData?.runs ?? []).map((r) => (
                <tr key={r.id}>
                  <td data-label="Status">
                    <span className={`badge ${r.status === "succeeded" ? "store-ready" : r.status === "failed" ? "store-degraded" : "store-pending"}`}>
                      {r.status}
                    </span>
                  </td>
                  <td data-label="Zeit" className="muted" title={new Date(r.created_at).toLocaleString("de-DE")}>
                    {timeAgo(r.created_at)}
                  </td>
                  <td data-label="" style={{ textAlign: "right" }}>
                    <button onClick={() => setRun(r)}>Trace anzeigen</button>
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

function RunTrace({ run }: { run: AiRun }) {
  return (
    <div className="ai-trace" style={{ marginTop: 12 }}>
      <p>
        Ergebnis:{" "}
        <span className={`badge ${run.status === "succeeded" ? "store-ready" : "store-degraded"}`}>{run.status}</span>
      </p>
      {run.error && <p className="error">{run.error}</p>}
      <ol style={{ marginTop: 8 }}>
        {(run.trace ?? [])
          .filter((step) => step.type !== "summary")
          .map((step, i) => {
            const tokens = step.tokens as { input?: number; output?: number } | undefined;
            return (
              <li key={i} style={{ marginBottom: 4 }}>
                <span className="code">{String(step.node ?? step.type)}</span>
                {step.node != null && <> · {String(step.type)}</>} ·{" "}
                <span className={`badge ${step.status === "ok" ? "store-ready" : step.status === "error" ? "store-degraded" : "store-pending"}`}>
                  {String(step.status)}
                </span>
                {step.branch != null && <> → {String(step.branch)}</>}
                {step.mode != null && <> · {String(step.mode)}/{String(step.scope)}: {String(step.key)}</>}
                {tokens && (
                  <span className="muted"> · {(tokens.input ?? 0) + (tokens.output ?? 0)} Tok</span>
                )}
                {step.content_id != null && <> · Entwurf {String(step.content_id)}</>}
                {step.output != null && String(step.output) !== "" && (
                  <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{String(step.output)}</div>
                )}
                {step.error != null && <div className="error">{String(step.error)}</div>}
              </li>
            );
          })}
      </ol>
      {(() => {
        const sum = (run.trace ?? []).find((s) => s.type === "summary");
        if (!sum) return null;
        const total = sum.tokens_total as number | undefined;
        const budget = sum.token_budget as number | null | undefined;
        return (
          <p className="muted">
            Token gesamt: <strong>{total ?? 0}</strong>
            {budget != null && <> / Budget {budget}</>}
          </p>
        );
      })()}
    </div>
  );
}

function NodeConfig({
  kind,
  config,
  connectors,
  contentTypes,
  nodeIds,
  onChange,
}: {
  kind: string;
  config: Record<string, unknown>;
  connectors: AiConnector[];
  contentTypes: ContentType[];
  nodeIds: string[];
  onChange: (key: string, value: unknown) => void;
}) {
  const str = (k: string) => (config[k] == null ? "" : String(config[k]));

  if (kind === "agent" || kind === "loop") {
    return (
      <>
        <div className="field">
          <label>Connector</label>
          <select value={str("connector_id")} onChange={(e) => onChange("connector_id", e.target.value || null)}>
            <option value="">Mock (ohne Key)</option>
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Modell</label>
          <select value={str("model")} onChange={(e) => onChange("model", e.target.value)}>
            <option value="claude-opus-4-8">Claude Opus 4.8</option>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
          </select>
        </div>
        {kind === "agent" && (
          <div className="field">
            <label>System (optional)</label>
            <textarea rows={2} value={str("system")} onChange={(e) => onChange("system", e.target.value)} />
          </div>
        )}
        <div className="field">
          <label>Prompt</label>
          <textarea rows={3} value={str("prompt")} onChange={(e) => onChange("prompt", e.target.value)} />
        </div>
        {kind === "loop" && (
          <div className="field">
            <label>Iterationen</label>
            <input
              type="number"
              min={1}
              max={20}
              value={str("iterations") || "1"}
              onChange={(e) => onChange("iterations", Number(e.target.value))}
            />
          </div>
        )}
      </>
    );
  }

  if (kind === "condition") {
    return (
      <>
        <div className="field">
          <label>Prüfe Ausgabe von</label>
          <select value={str("input")} onChange={(e) => onChange("input", e.target.value)}>
            <option value="input">Eingabe</option>
            {nodeIds.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Enthält Text</label>
          <input value={str("contains")} onChange={(e) => onChange("contains", e.target.value)} />
        </div>
        <p className="muted">Kante auf <span className="code">true</span>/<span className="code">false</span> stellen per Klick.</p>
      </>
    );
  }

  if (kind === "output") {
    return (
      <>
        <div className="field">
          <label>Inhaltstyp</label>
          <select value={str("content_type")} onChange={(e) => onChange("content_type", e.target.value)}>
            <option value="">— wählen —</option>
            {contentTypes.map((t) => (
              <option key={t.id} value={t.key}>{t.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Quelle (Knoten)</label>
          <select value={str("input")} onChange={(e) => onChange("input", e.target.value || null)}>
            <option value="">Vorgänger automatisch</option>
            {nodeIds.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Modus</label>
          <select value={str("mode") || "draft"} onChange={(e) => onChange("mode", e.target.value)}>
            <option value="draft">Entwurf (Freigabe nötig)</option>
            <option value="publish">Direkt veröffentlichen</option>
          </select>
        </div>
      </>
    );
  }

  return <p className="muted">Keine Einstellungen.</p>;
}
