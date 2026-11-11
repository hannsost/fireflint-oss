import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <>
      <div className="topbar">
        <h1>Nicht gefunden</h1>
      </div>
      <div className="panel">
        <p className="muted">Diese Seite existiert nicht (mehr).</p>
        <div className="actions">
          <Link to="/">
            <button className="primary">Zur Übersicht</button>
          </Link>
        </div>
      </div>
    </>
  );
}
