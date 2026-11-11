import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { AgentSettingsSection } from "../components/AssistantUi";
import { UiIcon } from "../components/ProductIdentity";
import type { AiConnector } from "../types";
import "../agent-workspace.css";
export function AiConnectorsPage() {
  const org = useOrg();
  return <OrganizationSettings key={org} org={org} />;
}
function OrganizationSettings({ org }: { org: string }) {
  const { memberships } = useAuth();
  const owner = memberships.some((m) => m.org_id === org && m.role === "owner");
  const allowed = memberships.some(
    (m) => m.org_id === org && (m.role === "owner" || m.role === "editor"),
  );
  const qc = useQueryClient();
  const connections = useQuery({
    queryKey: ["ai-connectors", org],
    queryFn: () =>
      api.get<{ connectors: AiConnector[] }>(`/api/orgs/${org}/ai/connectors`),
    enabled: allowed,
    retry: false,
  });
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api.post(`/api/orgs/${org}/ai/connectors`, {
        name: name.trim(),
        provider,
        api_key: provider === "mock" ? null : apiKey || null,
        base_url: provider === "mock" ? null : baseUrl || null,
        default_model: model || null,
        preprompt: instructions || null,
      }),
    onSuccess: () => {
      setApiKey("");
      setName("");
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["ai-connectors", org] });
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : "Speichern fehlgeschlagen."),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/orgs/${org}/ai/connectors/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ai-connectors", org] });
    },
    onError: () => setError("Verbindung konnte nicht gelöscht werden."),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSaved(false);
    create.mutate();
  };
  return (
    <div className="nf-agent-page">
      <h1>Agenten &amp; KI</h1>
      <div className="nf-agent-toolbar">
        <p>Anbieter, Modell und Arbeitsweise für deinen Arbeitsbereich.</p>
        <Link to="/ai/assistant">
          <UiIcon name="spark" />
          KI-Assistent öffnen
        </Link>
      </div>
      {!allowed ? (
        <p>
          Die KI-Konfiguration steht der Redaktion und Inhabern zur Verfügung.
        </p>
      ) : (
        <>
          <AgentSettingsSection
            title="Deine Verbindungen"
            description="Verbindungen stehen Chat und Workflows in diesem Arbeitsbereich zur Verfügung. Schlüssel werden verschlüsselt gespeichert und nicht ausgegeben."
          >
            {connections.isPending ? (
              <p role="status">Verbindungen werden geladen…</p>
            ) : connections.isError ? (
              <div role="alert">
                Verbindungen konnten nicht geladen werden.
                <button onClick={() => void connections.refetch()}>
                  Erneut versuchen
                </button>
              </div>
            ) : !connections.data?.connectors.length ? (
              <p>Noch keine Verbindung eingerichtet.</p>
            ) : (
              connections.data.connectors.map((c) => (
                <article className="nf-agent-connection" key={c.id}>
                  <div>
                    <h3>{c.name}</h3>
                    <p>
                      {c.provider === "mock"
                        ? "Testmodus · simulierte Antworten"
                        : `Anthropic · ${c.default_model ?? "Anbieterstandard"}`}{" "}
                      · Schlüssel{" "}
                      {c.has_key ? "hinterlegt" : "nicht hinterlegt"}
                    </p>
                    {c.preprompt && (
                      <p className="nf-agent-hint">{c.preprompt}</p>
                    )}
                  </div>
                  {owner && (
                    <button
                      disabled={remove.isPending || create.isPending}
                      onClick={() => {
                        if (
                          confirm(
                            `Verbindung „${c.name}“ löschen? Prüfe zuvor, ob Workflows sie verwenden.`,
                          )
                        )
                          remove.mutate(c.id);
                      }}
                    >
                      <UiIcon name="trash" />
                      Löschen
                    </button>
                  )}
                </article>
              ))
            )}
          </AgentSettingsSection>
          {error && <p role="alert">{error}</p>}
          {owner ? (
            <form className="nf-agent-form" onSubmit={submit}>
              <AgentSettingsSection
                title="Verbindung & Modell"
                description="Richte eine zusätzliche KI-Verbindung ein. Den API-Schlüssel erhältst du von deinem Anbieter."
              >
                <fieldset disabled={create.isPending}>
                  <label htmlFor="agent-name">Name der Verbindung</label>
                  <input
                    id="agent-name"
                    required
                    maxLength={200}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Zum Beispiel Redaktion"
                  />
                  <label htmlFor="agent-provider">Anbieter</label>
                  <select
                    id="agent-provider"
                    value={provider}
                    onChange={(e) => {
                      setProvider(e.target.value);
                      setApiKey("");
                    }}
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai_compatible">OpenAI-kompatibel (OpenAI, Mistral, OpenRouter, Ollama, LM Studio …)</option>
                    <option value="mock">Testmodus (ohne KI-Dienst)</option>
                  </select>
                  {provider !== "mock" && (
                    <>
                      <label htmlFor="agent-model">Modell</label>
                      <input
                        id="agent-model"
                        required
                        maxLength={200}
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="Modellkennung deines Anbieters"
                      />
                      <label htmlFor="agent-url">API-Endpunkt (optional)</label>
                      <input
                        id="agent-url"
                        type="url"
                        maxLength={2048}
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={provider === "openai_compatible" ? "https://api.openai.com/v1" : "https://api.anthropic.com"}
                      />
                      <label htmlFor="agent-key">{provider === "openai_compatible" ? "API-Schlüssel (für lokale Modelle optional)" : "API-Schlüssel"}</label>
                      <input
                        id="agent-key"
                        type="password"
                        autoComplete="new-password"
                        required={provider === "anthropic"}
                        maxLength={4096}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                      />
                    </>
                  )}
                </fieldset>
              </AgentSettingsSection>
              <AgentSettingsSection
                title="Arbeitsweise"
                description="Vorgaben ergänzen die Produktregeln. Sie erteilen keine neuen Zugriffsrechte."
              >
                <fieldset disabled={create.isPending}>
                  <label htmlFor="agent-instructions">Anweisungen</label>
                  <textarea
                    id="agent-instructions"
                    rows={5}
                    maxLength={8000}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="Sprache, Tonalität und fachlicher Schwerpunkt"
                  />
                </fieldset>
              </AgentSettingsSection>
              {saved && <p role="status">Verbindung gespeichert.</p>}
              <button
                className="nf-agent-primary"
                disabled={
                  create.isPending ||
                  !name.trim() ||
                  (provider !== "mock" && (!model.trim() || (provider === "anthropic" && !apiKey.trim())))
                }
              >
                {create.isPending ? "Speichern…" : "Verbindung hinzufügen"}
              </button>
            </form>
          ) : (
            <p>Die Konfiguration verwaltet der Inhaber des Arbeitsbereichs.</p>
          )}
          <AgentSettingsSection
            title="Daten & Aktionen"
            description="Der Chat berät und formuliert Vorschläge. Er liest keine Firmendaten automatisch und veröffentlicht keine Inhalte."
          >
            <p>
              Workflows können Entwürfe erstellen. Die Veröffentlichung bleibt
              ein eigener, ausdrücklicher Schritt.
            </p>
            <Link to="/ai/workflows">KI-Workflows öffnen</Link>
          </AgentSettingsSection>
        </>
      )}
    </div>
  );
}
