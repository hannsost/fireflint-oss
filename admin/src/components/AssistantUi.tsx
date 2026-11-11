import { useEffect, useRef, type ReactNode } from 'react';

import { UiIcon } from './ProductIdentity';
import './assistant-ui.css';

export interface ChatTranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export function ChatTranscript({
  messages,
  busy = false,
  error,
  emptyText = 'Noch keine Nachrichten.',
}: {
  messages: ChatTranscriptMessage[];
  busy?: boolean;
  error?: string | null;
  emptyText?: string;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = scroll.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages.length, busy]);
  return (
    <section className="nf-chat-transcript" role="region" aria-label="Chatverlauf">
      <div className="nf-chat-scroll" role="list" ref={scroll} aria-live="polite" aria-relevant="additions text">
        {messages.map((message) => (
          <article
            key={message.id}
            role="listitem"
            className={`nf-chat-message nf-chat-message--${message.role}`}
          >
            <div className="nf-chat-message-icon">
              <UiIcon name={message.role === 'user' ? 'team' : 'spark'} size={20} />
            </div>
            <div className="nf-chat-message-body">
              <div className="nf-chat-message-author">{message.role === 'user' ? 'Du' : 'Assistent'}</div>
              <p className="nf-chat-message-content">{message.content}</p>
            </div>
          </article>
        ))}

        {messages.length === 0 && !busy && !error && (
          <p className="nf-chat-empty">{emptyText}</p>
        )}
        {busy && <div className="nf-chat-busy" role="status">Antwort wird erstellt…</div>}
        {error && <div className="nf-chat-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}

export function AgentSettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="nf-agent-settings-section">
      <header className="nf-agent-settings-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div className="nf-agent-settings-content">{children}</div>
    </section>
  );
}
