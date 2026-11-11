import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { ChatTranscript } from "./AssistantUi";
import { UiIcon } from "./ProductIdentity";
import { useWorkspaceAssistant } from "./WorkspaceAssistantState";
import "./workspace-assistant.css";

function useWideWorkspace() {
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1280px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

export function AssistantLauncher() {
  const chat = useWorkspaceAssistant();
  if (!chat.allowed) return null;
  return (
    <button
      ref={chat.launcher}
      className="ff-assistant-launcher"
      type="button"
      aria-controls={chat.fullPage ? "assistant-full" : "workspace-assistant"}
      aria-expanded={chat.fullPage ? undefined : chat.open}
      aria-label={
        chat.fullPage
          ? "Nachricht im KI-Assistenten schreiben"
          : "KI-Assistent öffnen oder schließen"
      }
      onClick={() => {
        if (chat.fullPage) document.getElementById("chat-message")?.focus();
        else if (chat.open) chat.close();
        else chat.show();
      }}
    >
      <UiIcon name="spark" />
      <span className="ff-assistant-launcher-label">KI-Assistent</span>
      {chat.unread && !chat.fullPage && (
        <span
          className="ff-assistant-badge"
          role="status"
          aria-label="Neue Antwort"
        >
          Neue Antwort
        </span>
      )}
    </button>
  );
}

export function WorkspaceAssistantPanel({ section }: { section: string }) {
  const chat = useWorkspaceAssistant();
  const wide = useWideWorkspace();
  const [expanded, setExpanded] = useState(false);
  const dock = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!chat.open) setExpanded(false);
  }, [chat.open]);
  useEffect(() => {
    if (!chat.open || chat.fullPage || !wide || expanded) return;
    // Escape belongs to the focused chat. Do not steal Escape from editor dialogs.
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        dock.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        chat.close();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [chat.open, chat.fullPage, wide, expanded, chat.close]);
  if (!chat.allowed || !chat.open || chat.fullPage) return null;
  const actions = (
    <div className="ff-assistant-heading-actions">
      <button
        type="button"
        aria-label={expanded ? "Chat verkleinern" : "Chat vergrößern"}
        title={expanded ? "Chat verkleinern" : "Chat vergrößern"}
        onClick={() => setExpanded((value) => !value)}
      >
        <UiIcon name={expanded ? "back" : "external"} />
      </button>
      <button
        type="button"
        aria-label="KI-Assistent schließen"
        onClick={() => chat.close()}
      >
        <UiIcon name="close" />
      </button>
    </div>
  );
  const conversation = (
    <AssistantConversation section={section} actions={actions} autoFocus />
  );
  if (wide && !expanded)
    return (
      <aside
        id="workspace-assistant"
        ref={dock}
        className="ff-assistant-dock"
        aria-label="KI-Assistent"
      >
        {conversation}
      </aside>
    );
  return createPortal(
    <AssistantDialog expanded={expanded}>{conversation}</AssistantDialog>,
    document.body,
  );
}

function AssistantDialog({
  expanded,
  children,
}: {
  expanded: boolean;
  children: ReactNode;
}) {
  const chat = useWorkspaceAssistant();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      id="workspace-assistant"
      ref={dialog}
      className={`ff-assistant-dialog${expanded ? " ff-assistant-dialog--expanded" : ""}`}
      aria-label="KI-Assistent"
      onCancel={(event) => {
        event.preventDefault();
        chat.close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button, a[href], input, textarea, select, summary, [tabindex]",
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            element.checkVisibility(),
        );
        const target = event.shiftKey ? controls.at(-1) : controls[0];
        const boundary = event.shiftKey ? controls[0] : controls.at(-1);
        if (
          target &&
          (document.activeElement === boundary ||
            !event.currentTarget.contains(document.activeElement))
        ) {
          event.preventDefault();
          target.focus();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          chat.close();
      }}
    >
      {children}
    </dialog>
  );
}

function prompts(path: string): Array<{ title: string; text: string }> {
  if (path.startsWith("/content/"))
    return [
      {
        title: "Text klarer formulieren",
        text: "Überarbeite den folgenden Text für unsere Website: verständlich, präzise und ohne neue Tatsachen zu erfinden. Text: ",
      },
      {
        title: "Varianten für Zielgruppen",
        text: "Entwirf aus folgendem Ausgangstext zwei Varianten für unterschiedliche Zielgruppen. Frage nach fehlenden Angaben. Ausgangstext: ",
      },
      {
        title: "Veröffentlichung vorbereiten",
        text: "Hilf mir mit einer kurzen Prüfliste, bevor ich redaktionelle Inhalte auf mehreren Websites veröffentliche.",
      },
    ];
  return [
    {
      title: "Inhalte strukturieren",
      text: "Hilf mir, unsere Standort-, Team- und Angebotsinhalte sinnvoll zu strukturieren. Stelle mir zuerst die wichtigsten Rückfragen.",
    },
    {
      title: "Einen Text entwerfen",
      text: "Ich möchte einen Website-Text entwerfen. Frage mich nach Zielgruppe, Anlass und den belegten Informationen.",
    },
    {
      title: "Änderungen prüfen",
      text: "Worauf sollte ich achten, wenn zentrale Inhalte auf mehreren Websites mit lokalen Ausnahmen erscheinen?",
    },
  ];
}

export function AssistantConversation({
  section = "Dein Arbeitsbereich",
  actions,
  autoFocus = false,
}: {
  section?: string;
  actions?: ReactNode;
  autoFocus?: boolean;
}) {
  const chat = useWorkspaceAssistant();
  const location = useLocation();
  const input = useRef<HTMLTextAreaElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const lastReply = [...chat.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  useEffect(() => {
    setCopied(false);
    setCopyError("");
  }, [lastReply?.id]);
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (
        focused === document.body ||
        focused === chat.launcher.current ||
        container.current?.contains(focused)
      ) {
        (
          input.current ??
          container.current?.querySelector<HTMLButtonElement>("button")
        )?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, chat.connections.isPending]);
  const busy = chat.busy;
  return (
    <div className="ff-assistant-conversation" ref={container}>
      <header className="ff-assistant-heading">
        <div className="ff-assistant-title">
          <span>
            <UiIcon name="spark" />
            KI-Assistent
          </span>
          <small>{section}</small>
        </div>
        {actions}
      </header>
      {chat.allowed &&
        !chat.connections.isPending &&
        !chat.connections.isError &&
        chat.connectors.length > 0 && (
          <details className="ff-assistant-tools">
            <summary>
              <span>
                {chat.selected?.name ?? "Verbindung wählen"}
                {chat.selected?.provider === "mock" ? " · Testmodus" : ""}
              </span>
              <UiIcon name="chevron" size={16} />
            </summary>
            <div className="ff-assistant-options">
              <label htmlFor="chat-connection">KI-Verbindung</label>
              <select
                id="chat-connection"
                value={chat.selected?.id ?? ""}
                disabled={busy || chat.messages.length > 0}
                onChange={(event) => chat.changeConnector(event.target.value)}
              >
                {!chat.selected && <option value="">Bitte wählen</option>}
                {chat.connectors.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
              <p>
                Modell: {chat.selected?.default_model ?? "Anbieterstandard"}.
                Für eine andere Verbindung beginne einen neuen Chat.
              </p>
              {chat.selected?.provider === "mock" && (
                <p className="ff-assistant-connection-warning">
                  Testmodus: simulierte Antworten, kein KI-Dienst.
                </p>
              )}
              <Link to="/ai/connectors" onClick={() => chat.close(false)}>
                Agenten &amp; KI
              </Link>
            </div>
          </details>
        )}
      <div className="ff-assistant-body">
        {!chat.allowed ? (
          <div className="ff-assistant-welcome">
            <p>Der Assistent steht der Redaktion und Inhabern zur Verfügung.</p>
          </div>
        ) : chat.connections.isPending ? (
          <div className="ff-assistant-welcome" role="status">
            Assistent wird geladen…
          </div>
        ) : chat.connections.isError ? (
          <div className="ff-assistant-welcome" role="alert">
            <h3>Verbindung nicht erreichbar</h3>
            <p>Dein Chat und deine Eingabe bleiben erhalten.</p>
            <button onClick={() => void chat.connections.refetch()}>
              Erneut versuchen
            </button>
          </div>
        ) : !chat.connectors.length ? (
          <div className="ff-assistant-welcome">
            <UiIcon name="spark" size={28} />
            <h3>Verbinde dein KI-Modell</h3>
            <p>
              Richte unter „Agenten &amp; KI“ eine Verbindung ein. Danach kannst
              du hier direkt beim Arbeiten Fragen stellen.
            </p>
            <Link to="/ai/connectors" onClick={() => chat.close(false)}>
              Agenten &amp; KI öffnen
            </Link>
          </div>
        ) : chat.transcript.length === 0 && !chat.error ? (
          <div className="ff-assistant-welcome">
            <h3>Woran arbeitest du gerade?</h3>
            <p>
              Ich helfe dir beim Formulieren, Strukturieren und Prüfen deiner
              Inhalte.
            </p>
            <div className="ff-assistant-prompts">
              {prompts(location.pathname).map((prompt) => (
                <button
                  type="button"
                  key={prompt.title}
                  onClick={() => {
                    chat.setDraft(prompt.text);
                    input.current?.focus();
                  }}
                >
                  <span>{prompt.title}</span>
                  <UiIcon name="arrow" size={16} />
                </button>
              ))}
            </div>
            <p className="ff-assistant-note">
              Texte und Angaben fügst du selbst hinzu. Es werden keine
              Firmendaten automatisch gelesen.
            </p>
          </div>
        ) : (
          <ChatTranscript
            messages={chat.transcript}
            busy={busy}
            error={chat.error}
          />
        )}
      </div>
      {chat.allowed && chat.connectors.length > 0 && (
        <>
          <div className="ff-assistant-followup">
            <button
              type="button"
              disabled={busy || (!chat.messages.length && !chat.draft)}
              onClick={() => {
                chat.startNew();
                input.current?.focus();
              }}
            >
              <UiIcon name="plus" size={16} />
              Neuer Chat
            </button>
            {lastReply && (
              <button
                type="button"
                onClick={() => {
                  void Promise.resolve()
                    .then(() =>
                      navigator.clipboard.writeText(lastReply.content),
                    )
                    .then(() => {
                      setCopied(true);
                      setCopyError("");
                    })
                    .catch(() =>
                      setCopyError(
                        "Kopieren nicht möglich. Markiere den Text im Verlauf.",
                      ),
                    );
                }}
              >
                <UiIcon name={copied ? "check" : "content"} size={16} />
                {copied ? "Kopiert" : "Antwort kopieren"}
              </button>
            )}
          </div>
          {copyError && (
            <p className="ff-assistant-error" role="alert">
              {copyError}
            </p>
          )}
          <form
            className="ff-assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void chat.send();
            }}
          >
            <label htmlFor="chat-message">Nachricht</label>
            <textarea
              id="chat-message"
              ref={input}
              rows={2}
              maxLength={8000}
              disabled={busy}
              value={chat.draft}
              onChange={(event) => chat.setDraft(event.target.value)}
              placeholder="Frage stellen oder Text einfügen…"
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void chat.send();
                }
              }}
            />
            <div className="ff-assistant-send-row">
              <small>Strg / ⌘ + Enter</small>
              <button
                type="submit"
                className="primary ff-assistant-send"
                disabled={
                  busy ||
                  !chat.draft.trim() ||
                  !chat.selected ||
                  chat.exhausted ||
                  chat.connections.isError
                }
              >
                <UiIcon name="arrow" size={18} />
                {busy ? "Antwort läuft…" : "Senden"}
              </button>
            </div>
            {chat.exhausted && (
              <p role="status">
                Dieser Chat ist voll. Bitte beginne einen neuen Chat.
              </p>
            )}
            <p className="ff-assistant-note">
              KI kann sich irren. Kein automatisches Speichern oder
              Veröffentlichen. Chat bleibt bis zum Neuladen oder
              Arbeitsbereichswechsel erhalten.
            </p>
          </form>
        </>
      )}
    </div>
  );
}
