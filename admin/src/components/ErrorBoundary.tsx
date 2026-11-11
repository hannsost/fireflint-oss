import { Component, type ReactNode } from "react";

/** Catches render errors so a crash shows a recoverable fallback, not a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("UI error:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="login-wrap">
          <div className="panel login-card">
            <h2>Etwas ist schiefgelaufen</h2>
            <p className="muted">Ein unerwarteter Fehler ist aufgetreten. Bitte lade die Seite neu.</p>
            <div className="actions">
              <button className="primary" onClick={() => window.location.reload()}>
                Neu laden
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
