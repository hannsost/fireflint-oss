import { Link } from "react-router-dom";

type Language = "de" | "en";

/*
 * Legal notice / privacy template.
 *
 * Every operator of a FireFlint instance is responsible for its own legal notice
 * (e.g. § 5 DDG in Germany), terms and privacy information. Configure the
 * operator details at build time via Vite environment variables:
 *
 *   VITE_OPERATOR_NAME, VITE_OPERATOR_ADDRESS (lines separated by "|"),
 *   VITE_OPERATOR_EMAIL, VITE_LEGAL_URL (optional: link to your own legal page)
 *
 * The placeholders below are intentionally generic and must be replaced before
 * running a public instance. This is not legal advice.
 */
const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};
const operator = {
  name: env.VITE_OPERATOR_NAME || "Example Operator GmbH",
  address: (env.VITE_OPERATOR_ADDRESS || "Example Street 1|12345 Example City|Country").split("|"),
  email: env.VITE_OPERATOR_EMAIL || "legal@example.org",
  legalUrl: env.VITE_LEGAL_URL || "",
};

function Address() {
  return <p><strong>{operator.name}</strong>{operator.address.map(line => <span key={line}><br />{line}</span>)}</p>;
}

export function LegalPage({ language }: { language: Language }) {
  const en = language === "en";
  const other = en ? "/legal" : "/en/legal";
  const login = "/login";
  return <main className="ff-legal" id="main">
    <header className="ff-legal-header">
      <Link className="ff-legal-brand" to={login}>FireFlint</Link>
      <nav aria-label={en ? "Legal navigation" : "Rechtsnavigation"}>
        <a href="#notice">{en ? "Legal notice" : "Impressum"}</a>
        <a href="#privacy">{en ? "Privacy" : "Datenschutz"}</a>
        <Link to={other}>{en ? "DE" : "EN"}</Link>
      </nav>
    </header>
    {en ? <English /> : <German />}
    <footer className="ff-legal-footer"><Link to={login}>{en ? "Back to sign in" : "Zur Anmeldung"}</Link><span>FireFlint</span></footer>
  </main>;
}

function German() {
  return <article className="ff-legal-content" lang="de">
    <p className="ff-legal-eyebrow">RECHTLICHE INFORMATIONEN</p>
    <h1>Angaben zum Betreiber dieser Instanz.</h1>
    <section id="notice"><h2>Impressum</h2><Address /><p>E-Mail: <a href={`mailto:${operator.email}`}>{operator.email}</a></p>
      {operator.legalUrl && <p>Vollständige rechtliche Informationen: <a href={operator.legalUrl}>{operator.legalUrl}</a></p>}</section>
    <section id="privacy"><h2>Datenschutz</h2><p>Verantwortlich für die Verarbeitung auf dieser FireFlint-Instanz ist der oben genannte Betreiber. FireFlint verarbeitet Kontodaten, Inhalte, Medien und Protokolldaten ausschließlich zum Betrieb der Instanz. Der Betreiber ergänzt hier seine vollständigen Datenschutzinformationen nach Art. 13 DSGVO.</p></section>
  </article>;
}

function English() {
  return <article className="ff-legal-content" lang="en">
    <p className="ff-legal-eyebrow">LEGAL INFORMATION</p>
    <h1>Operator of this instance.</h1>
    <section id="notice"><h2>Legal notice</h2><Address /><p>Email: <a href={`mailto:${operator.email}`}>{operator.email}</a></p>
      {operator.legalUrl && <p>Full legal information: <a href={operator.legalUrl}>{operator.legalUrl}</a></p>}</section>
    <section id="privacy"><h2>Privacy information</h2><p>The operator named above is the controller for processing on this FireFlint instance. FireFlint processes account data, content, media and logs solely to operate the instance. Operators must add their complete privacy information (e.g. GDPR Art. 13) here.</p></section>
  </article>;
}
