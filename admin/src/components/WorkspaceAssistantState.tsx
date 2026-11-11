import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, request, ApiError } from "../api/client";
import type { AiConnector } from "../types";
import type { ChatTranscriptMessage } from "./AssistantUi";

function useAssistantState(org: string | null, allowed: boolean) {
  const location = useLocation();
  const fullPage = location.pathname === "/ai/assistant";
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatTranscriptMessage[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const launcher = useRef<HTMLButtonElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const visible = useRef(false);
  visible.current = open || fullPage;
  // State is keyed by account, organization and role in Layout. No private state
  // is persisted in browser storage or carried into a new access scope.
  useEffect(
    () => () => {
      inFlight.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (fullPage) {
      setOpen(false);
      setUnread(false);
    }
  }, [fullPage]);

  const connections = useQuery({
    queryKey: ["ai-connectors", org],
    queryFn: () =>
      api.get<{ connectors: AiConnector[] }>(`/api/orgs/${org}/ai/connectors`),
    enabled: allowed && !!org && (open || fullPage),
    retry: false,
  });
  const connectors = connections.data?.connectors.filter((c) => c.active) ?? [];
  const selected =
    connectors.find((c) => c.id === connectorId) ??
    (connectorId ? undefined : connectors[0]);
  const busy = pending !== null;
  const transcript =
    pending === null
      ? messages
      : [
          ...messages,
          {
            id: "pending-user-message",
            role: "user" as const,
            content: pending,
          },
        ];
  const exhausted = messages.length >= 78;

  function show() {
    if (allowed) {
      setUnread(false);
      setOpen(true);
    }
  }
  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus)
      requestAnimationFrame(() =>
        launcher.current?.focus({ preventScroll: true }),
      );
  }
  function startNew() {
    if (inFlight.current) return;
    if (
      (messages.length || draft.trim()) &&
      !window.confirm(
        "Neuen Chat beginnen? Der aktuelle Verlauf und die Eingabe werden verworfen.",
      )
    )
      return;
    setMessages([]);
    setDraft("");
    setError("");
    setUnread(false);
  }
  function changeConnector(id: string) {
    if (inFlight.current || messages.length) return;
    setConnectorId(id);
    setError("");
  }
  async function send() {
    const content = draft.trim();
    if (
      !allowed ||
      !org ||
      !selected ||
      !content ||
      inFlight.current ||
      exhausted
    )
      return;
    if (new TextEncoder().encode(content).length > 16000) {
      setError(
        "Die Nachricht ist zu lang. Bitte kürze sie etwas und sende erneut.",
      );
      return;
    }
    if (
      messages.reduce(
        (size, message) =>
          size + new TextEncoder().encode(message.content).length,
        0,
      ) +
        new TextEncoder().encode(content).length >
      200000
    ) {
      setError("Dieser Verlauf ist zu lang. Bitte beginne einen neuen Chat.");
      return;
    }
    // Lock the chosen connection on the first request; a background list refresh
    // must never silently switch an established conversation to another provider.
    setConnectorId(selected.id);
    const controller = new AbortController();
    inFlight.current = controller;
    setError("");
    setPending(content);
    try {
      const result = await request<{
        message: { role: "assistant"; content: string };
      }>(`/api/orgs/${org}/ai/chat`, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          connector_id: selected.id,
          messages: [
            ...messages.map(({ role, content }) => ({ role, content })),
            { role: "user", content },
          ],
        }),
      });
      if (controller.signal.aborted) return;
      if (
        result.message?.role !== "assistant" ||
        typeof result.message.content !== "string"
      )
        throw new Error("Invalid chat response");
      setMessages((previous) => [
        ...previous,
        { id: crypto.randomUUID(), role: "user", content },
        { id: crypto.randomUUID(), ...result.message },
      ]);
      setDraft("");
      if (!visible.current) setUnread(true);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof ApiError && err.status === 429
          ? "Der Assistent ist gerade ausgelastet. Bitte kurz warten und erneut senden."
          : err instanceof ApiError &&
              (err.status === 401 || err.status === 403)
            ? "Dein Zugang ist nicht mehr berechtigt. Bitte melde dich erneut an. Deine Eingabe bleibt hier erhalten."
            : "Die Antwort konnte nicht erstellt werden. Deine Nachricht bleibt erhalten. Prüfe die Verbindung unter „Agenten & KI“ oder versuche es erneut.",
      );
    } finally {
      if (!controller.signal.aborted) {
        setPending(null);
        inFlight.current = null;
      }
    }
  }
  return {
    allowed,
    fullPage,
    open,
    unread,
    launcher,
    show,
    close,
    draft,
    setDraft,
    transcript,
    messages,
    busy,
    error,
    selected,
    connectors,
    connections,
    exhausted,
    startNew,
    changeConnector,
    send,
  };
}

type AssistantState = ReturnType<typeof useAssistantState>;
const AssistantContext = createContext<AssistantState | null>(null);
export function WorkspaceAssistantProvider({
  org,
  allowed,
  children,
}: {
  org: string | null;
  allowed: boolean;
  children: ReactNode;
}) {
  const state = useAssistantState(org, allowed);
  return (
    <AssistantContext.Provider value={state}>
      {children}
    </AssistantContext.Provider>
  );
}
export function useWorkspaceAssistant() {
  const state = useContext(AssistantContext);
  if (!state) throw new Error("WorkspaceAssistantProvider is required");
  return state;
}
