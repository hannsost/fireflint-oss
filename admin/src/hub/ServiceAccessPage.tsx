import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Empty, ErrorNotice, PageTitle, formatDate, useAction, useHub, useHubQuery } from "./common";

interface ServiceAccess {
  id: string; name: string; scopes: string[]; expires_at: string; revoked_at: string | null;
  revision: number; created_at: string; rotated_at: string | null; last_used_at: string | null;
}
interface Issued { access: ServiceAccess; secret: string }
interface Selection { access: ServiceAccess; mode: "rotate" | "revoke" }

function futureDate() { return new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10); }
function expiresAt(date: string) {
  const expires = new Date(`${date}T23:59:59.000Z`);
  if (!Number.isFinite(expires.getTime())) throw new Error("Bitte ein gültiges Ablaufdatum angeben.");
  return expires.toISOString();
}

export function ServiceAccessPage() {
  const { org, user, isOwner } = useHub();
  if (!isOwner) return <><PageTitle title="Servicezugänge" description="Ausgewählte Unternehmensdaten sicher für andere Systeme bereitstellen." /><section className="panel"><h2>Von Inhabern verwaltet</h2><p>Servicezugänge lesen ausdrücklich freigegebene Datentypen dieses Arbeitsbereichs. Nur Inhaber können Zugänge erstellen, einsehen, erneuern oder widerrufen.</p></section></>;
  return <AccessManager key={`${user?.id}:${org}`} />;
}

function AccessManager() {
  const { base, modules, contracts, invalidate } = useHub();
  const entries = useHubQuery<ServiceAccess[]>("service-access", "/service-access");
  const action = useAction();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiry, setExpiry] = useState(futureDate);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [rotationExpiry, setRotationExpiry] = useState(futureDate);
  // Never enter query caches, drafts, storage, URL state, analytics or examples.
  const [issued, setIssued] = useState<Issued | null>(null);
  const [notice, setNotice] = useState("");
  const enabled = modules.data?.some(module => module.key === "service_access" && module.enabled) ?? false;
  const availableKinds = contracts.data?.kinds.filter(kind => modules.data?.some(module => module.key === kind.module && module.enabled)) ?? [];
  const scopeName = (key: string) => contracts.data?.kinds.find(kind => kind.key === key)?.name ?? key;
  const busy = action.busy;

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!scopes.length) throw new Error("Bitte mindestens einen Datentyp auswählen.");
      const result = await api.post<Issued>(`${base}/service-access`, { name, scopes, expires_at: expiresAt(expiry) });
      setIssued(result); setName(""); setScopes([]); setNotice("");
      await invalidate();
    });
  }
  async function applySelection(event: FormEvent) {
    event.preventDefault();
    if (!selection) return;
    const { access, mode } = selection;
    await action.run(async () => {
      if (mode === "rotate") {
        const result = await api.post<Issued>(`${base}/service-access/${access.id}/rotate`, { expected_revision: access.revision, expires_at: expiresAt(rotationExpiry) });
        setIssued(result); setNotice("");
      } else {
        await api.post(`${base}/service-access/${access.id}/revoke`, { expected_revision: access.revision });
        setNotice(`„${access.name}“ wurde widerrufen.`);
        if (issued?.access.id === access.id) setIssued(null);
      }
      setSelection(null); await invalidate();
    });
  }
  async function reload() {
    await action.run(async () => {
      const result = await entries.refetch();
      if (result.error) throw result.error;
      if (selection) {
        const current = result.data?.find(entry => entry.id === selection.access.id);
        if (!current) throw new Error("Der Zugang wurde nicht gefunden.");
        setSelection({ ...selection, access: current });
      }
      await modules.refetch(); await contracts.refetch();
    });
  }

  return <>
    <PageTitle title="Servicezugänge" description="Gib anderen Systemen lesenden Zugriff auf ausgewählte Daten dieses Arbeitsbereichs."><Link className="button" to="/hub/modules">Module verwalten</Link></PageTitle>
    <p className="hub-reader">Jeder Zugang gilt ausschließlich für die gewählten Datentypen. Er kann Daten lesen und Änderungen abfragen. Private Daten werden dadurch nicht veröffentlicht.</p>
    {!enabled && !modules.isPending && <p className="hub-warning">Das Modul ist deaktiviert. Bestehende Zugänge sind gesperrt und können weiterhin widerrufen werden. Zum Erstellen oder Erneuern das Modul aktivieren.</p>}
    <ErrorNotice error={action.error || entries.error || contracts.error || modules.error} onReload={() => void reload()} />
    {notice && <p className="hub-success" role="status">{notice}</p>}
    {issued && <OneTimeSecret key={issued.secret} issued={issued} onClose={() => setIssued(null)} />}

    <section className="panel" aria-labelledby="service-list-title"><h2 id="service-list-title">Deine Zugänge</h2>
      {entries.isPending && <p role="status">Zugänge werden geladen …</p>}
      {entries.data?.length === 0 && <Empty>Noch keine Servicezugänge. Erstelle einen Zugang für ein bestimmtes System und wähle dessen Datentypen.</Empty>}
      <div className="hub-stack">{entries.data?.map(access => {
        const expired = new Date(access.expires_at).getTime() <= Date.now();
        const blockedScope = access.scopes.some(scope => !availableKinds.some(kind => kind.key === scope));
        const status = access.revoked_at ? "Widerrufen" : expired ? "Abgelaufen" : !enabled || blockedScope ? "Durch Modul gesperrt" : "Aktiv";
        return <article className="hub-list-item" key={access.id} aria-label={access.name}>
          <div className="hub-section-heading"><h3>{access.name}</h3><span className="badge">{status}</span></div>
          <p>{access.scopes.map(scopeName).join(" · ")}</p>
          <p className="hint">Läuft ab: {formatDate(access.expires_at)} · Zuletzt verwendet: {access.last_used_at ? formatDate(access.last_used_at) : "Noch nie"}</p>
          <p className="hint">Revision {access.revision}{access.revoked_at && ` · Widerrufen am ${formatDate(access.revoked_at)}`}</p>
          {!access.revoked_at && <div className="hub-actions">
            <button type="button" disabled={busy || !!issued || !enabled} onClick={() => { setSelection({ access: { ...access }, mode: "rotate" }); setRotationExpiry(futureDate()); action.clear(); }}>Schlüssel erneuern</button>
            <button type="button" disabled={busy || !!issued} onClick={() => { setSelection({ access: { ...access }, mode: "revoke" }); action.clear(); }}>Zugang widerrufen</button>
          </div>}
        </article>;
      })}</div>
    </section>

    {selection && <section className="panel hub-review" aria-labelledby="service-action-title">
      <h2 id="service-action-title">{selection.mode === "rotate" ? "Schlüssel erneuern" : "Zugang widerrufen"}: {selection.access.name}</h2>
      <p>{selection.mode === "rotate" ? "Der bisherige Schlüssel und seine Fortsetzungsmarken werden sofort ungültig. Hinterlege den neuen Schlüssel im verbundenen System und starte dort einen neuen Export." : "Das verbundene System verliert seinen Zugriff. Ein widerrufener Zugang kann nicht reaktiviert werden."}</p>
      <p className="hint">Geprüfte Revision: {selection.access.revision}. Bei einer gleichzeitigen Änderung bleiben deine Eingaben erhalten.</p>
      <form className="hub-form" onSubmit={event => void applySelection(event)}>
        {selection.mode === "rotate" && <label>Neues Ablaufdatum (UTC)<input type="date" required value={rotationExpiry} onChange={event => setRotationExpiry(event.target.value)} disabled={busy} /></label>}
        {selection.access.revoked_at && <p className="hub-warning">Dieser Zugang wurde bereits widerrufen.</p>}
        <div className="hub-actions"><button type="submit" className="primary" disabled={busy || !!selection.access.revoked_at || !!issued || (selection.mode === "rotate" && !enabled)}>{busy ? "Wird gespeichert …" : selection.mode === "rotate" ? "Neuen Schlüssel erstellen" : "Zugang jetzt widerrufen"}</button><button type="button" disabled={busy} onClick={() => { setSelection(null); action.clear(); }}>Abbrechen</button></div>
      </form>
    </section>}

    <section className="panel" aria-labelledby="service-create-title"><h2 id="service-create-title">Neuer Servicezugang</h2>
      <form className="hub-form" onSubmit={event => void create(event)}><fieldset disabled={busy || !enabled || !!issued || !!selection || contracts.isPending || !!contracts.error}>
        <div className="hub-form-grid"><label>Name des verbundenen Systems<input required maxLength={160} value={name} onChange={event => setName(event.target.value)} placeholder="Zum Beispiel: internes Kundenportal" /></label><label>Ablaufdatum (UTC)<input type="date" required value={expiry} onChange={event => setExpiry(event.target.value)} /></label></div>
        <p className="hint">Gültigkeit bis zum Ende des gewählten Tages (UTC), höchstens 366 Tage.</p>
        <fieldset><legend>Lesbare Datentypen</legend><div className="hub-form-grid">{availableKinds.map(kind => <label className="hub-check" key={kind.key}><input type="checkbox" checked={scopes.includes(kind.key)} onChange={event => setScopes(old => event.target.checked ? [...old, kind.key] : old.filter(key => key !== kind.key))} />{kind.name}</label>)}</div></fieldset>
        <p className="hint">Beziehungen und Herkunftskennungen werden nur ausgegeben, wenn auch der betreffende Datentyp freigegeben ist. Eigene Datentypen sind einzeln auswählbar. Für andere Berechtigungen einen neuen Zugang anlegen.</p>
        <div className="hub-actions"><button className="primary" type="submit" disabled={!scopes.length}>Lesenden Zugang erstellen</button></div>
      </fieldset></form>
    </section>
    <details className="panel hub-details"><summary>Mit einem System verbinden</summary>
      <p>Den Schlüssel ausschließlich serverseitig als <code>Authorization: Bearer &lt;Schlüssel&gt;</code> über HTTPS verwenden. Er gehört weder in eine URL noch in eine öffentliche Website.</p>
      <ol><li><code>GET /hub/v1/kinds</code> liefert die freigegebenen Datentypen.</li><li><code>GET /hub/v1/export</code> startet einen vollständigen Export mit festem Datenstand. Solange <code>has_more</code> wahr ist, die nächste Seite über <code>?cursor=&lt;next_cursor&gt;</code> abrufen.</li><li>Nach der letzten Exportseite <code>changes_cursor</code> speichern. Mit <code>GET /hub/v1/changes?cursor=&lt;changes_cursor&gt;</code> Änderungen abholen und nach erfolgreicher Verarbeitung <code>next_cursor</code> speichern.</li></ol>
      <p>Archivierte Datensätze tragen <code>archived: true</code>. Seiten können wiederholt werden; Datensätze anhand von ID und Revision übernehmen. Bis zu 100 Datensätze pro Seite und 120 Anfragen pro Minute je Zugang.</p>
    </details>
  </>;
}

function OneTimeSecret({ issued, onClose }: { issued: Issued; onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  return <section className="panel hub-review" aria-labelledby="service-secret-title"><h2 id="service-secret-title">Schlüssel für {issued.access.name}</h2>
    <p>Dieser Schlüssel wird nur jetzt angezeigt. Speichere ihn im Secret-Speicher des verbundenen Systems. Nach dem Schließen kann er nur ersetzt werden.</p>
    <label>Einmaliger Serviceschlüssel<input type={visible ? "text" : "password"} readOnly value={issued.secret} autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} /></label>
    <div className="hub-actions"><button type="button" onClick={() => setVisible(old => !old)}>{visible ? "Verbergen" : "Anzeigen"}</button><button type="button" disabled={action.busy} onClick={() => void action.run(async () => { await navigator.clipboard.writeText(issued.secret); setCopied(true); })}>Schlüssel kopieren</button><button className="primary" type="button" onClick={onClose}>Gesichert, schließen</button></div>
    {copied && <p role="status">Schlüssel kopiert.</p>}<ErrorNotice error={action.error} />
  </section>;
}
