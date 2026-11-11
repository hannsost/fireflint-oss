import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { InstagramAccountSelection } from "../components/InstagramAccountSelection";
import { InstagramPrepare } from "../components/InstagramPrepare";
import { instagramAuthorizationUrl, instagramError, instagramState, type InstagramPublication, type InstagramStatus } from "../lib/instagram";

export function InstagramPage() {
  const org = useOrg();
  return <InstagramWorkspace key={org} org={org} />;
}

function InstagramWorkspace({ org }: { org: string }) {
  const { memberships } = useAuth();
  const role = memberships.find(m => m.org_id === org)?.role;
  const owner = role === "owner", canPublish = owner || role === "editor";
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const root = `/api/orgs/${org}/instagram`;
  const status = useQuery({ queryKey: ["instagram", org], queryFn: () => api.get<InstagramStatus>(root) });
  const publications = useQuery({ queryKey: ["instagram-publications", org], queryFn: () => api.get<InstagramPublication[]>(`${root}/publications`) });
  const connection = status.data?.connection;
  const reload = () => { void qc.invalidateQueries({ queryKey: ["instagram", org] }); void qc.invalidateQueries({ queryKey: ["instagram-publications", org] }); };
  const mutation = useMutation({
    mutationFn: async ({ action, revision, id }: { action: string; revision: number; id?: string }) => {
      if (action === "connect") {
        const result = await api.post<{ authorization_url: string }>(`${root}/connect`, { expected_revision: revision });
        const target = instagramAuthorizationUrl(result.authorization_url, status.data?.login_mode || "instagram_login");
        if (!target) throw new Error("instagram_configuration_invalid");
        if (alive.current) window.location.assign(target);
      } else await api.post(id ? `${root}/publications/${id}/${action}` : `${root}/${action}`, { expected_revision: revision });
      return action;
    },
    onMutate: () => { setError(""); setNotice(""); },
    onSuccess: action => {
      if (!alive.current) return;
      setDisconnecting(false); reload();
      if (action !== "connect") setNotice(action === "disconnect" ? "Die lokale Verbindung wurde getrennt. Unter Instagram → Apps und Websites kannst du zusätzlich die Meta-Freigabe widerrufen." : "Der Auftrag wurde geprüft. Der aktuelle Status wird geladen.");
    },
    onError: error => { if (alive.current) { setError(instagramError(error instanceof Error ? error.message : "")); reload(); } },
  });
  const busy = mutation.isPending;
  const callbackResult = params.get("result");
  const pendingId = params.get("pending");
  const usable = !!connection?.active && !connection.expired && !connection.needs_revalidation && !status.data?.reconnect_required;
  const clearResult = () => { const next = new URLSearchParams(params); next.delete("result"); next.delete("pending"); setParams(next, { replace: true }); };


  return <div>
    <div className="topbar"><h1>Instagram</h1><button type="button" onClick={reload} disabled={status.isFetching || publications.isFetching}>Aktualisieren</button></div>
    <p className="hint">Verbinde das professionelle Instagram-Konto dieses Arbeitsbereichs direkt mit FireFlint. Dein Passwort bleibt bei Meta.</p>
    {callbackResult && callbackResult !== "select_account" && <div className="panel" role="status"><p>{callbackResult === "connected" ? "Die Instagram-Freigabe wurde entgegengenommen. Prüfe unten, welches Konto verbunden ist." : "Die Verbindung wurde nicht abgeschlossen. Prüfe deine Anmeldung, die App-Einrichtung und die freigegebenen Rechte."}</p><button onClick={() => { const next = new URLSearchParams(params); next.delete("result"); setParams(next, { replace: true }); }}>Hinweis schließen</button></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="hint" role="status">{notice}</p>}
    {status.isPending && <p role="status">Verbindung wird geladen…</p>}
    {status.error && <div className="panel" role="alert"><p>Die Instagram-Verbindung konnte nicht geladen werden.</p><button onClick={() => void status.refetch()}>Erneut laden</button></div>}
    {status.data && <section className="panel" aria-label="Instagram-Verbindung">
      <p className="hint">{status.data.login_mode === "unified" ? "Meta-Geschäftsanmeldung" : status.data.login_mode === "instagram_login" ? "Instagram-Anmeldung" : "Verbindung noch nicht eingerichtet"}</p>
      <h2>{connection?.active ? `@${connection.username}` : "Noch nicht verbunden"}</h2>
      {!status.data.configured && <p className="hint">Die Instagram-Verbindung wird noch vom Betreiber eingerichtet. Sobald sie bereit ist, kannst du dein Konto hier verbinden.</p>}
      {connection?.active && <>
        <p>{connection.expired ? "Die Freigabe ist abgelaufen. Bitte erneut verbinden." : connection.expires_at ? `Freigabe gültig bis ${new Date(connection.expires_at).toLocaleDateString("de-DE")}.` : "Kein festes Ablaufdatum. Die Freigabe kann bei Meta trotzdem widerrufen werden."}</p>
        {connection.refresh_recommended && !connection.expired && <p className="hint">Die Freigabe läuft bald ab. Aktualisiere sie rechtzeitig.</p>}
        <details><summary>Freigegebene Rechte</summary><ul>{connection.scopes.map(scope => <li key={scope}><code>{scope}</code></li>)}</ul></details>
      </>}
      {status.data.reconnect_required && <p role="alert">Der Anmeldeweg oder die App-Konfiguration wurde geändert. Verbinde erneut; die bisherige Freigabe wird nicht für den neuen Provider verwendet.</p>}
      {connection?.needs_revalidation && <p role="alert">Die Geschäftskonto-Freigabe wurde verändert. Prüfe die Verbindung vor weiteren Veröffentlichungen.</p>}
      {owner ? <div className="row" style={{ flexWrap: "wrap", gap: ".6rem", marginTop: "1rem" }}>
        <button className="primary" disabled={busy || !status.data.configured} onClick={() => mutation.mutate({ action: "connect", revision: connection?.revision ?? 0 })}>{connection?.active ? "Erneut verbinden" : "Instagram verbinden"}</button>
        {connection?.active && <>{connection.login_mode === "unified" ? <button disabled={busy || !status.data.configured || status.data.reconnect_required} onClick={() => mutation.mutate({ action: "verify", revision: connection.revision })}>Verbindung prüfen</button> : <button disabled={busy || !status.data.configured || connection.expired || status.data.reconnect_required} onClick={() => mutation.mutate({ action: "refresh", revision: connection.revision })}>Freigabe aktualisieren</button>}<button disabled={busy} onClick={() => setDisconnecting(true)}>Verbindung trennen</button></>}
      </div> : <p className="hint">Die Verbindung verwaltet der Inhaber dieses Arbeitsbereichs.</p>}
      {disconnecting && connection && <div role="group" aria-label="Verbindung trennen bestätigen"><p>Die Verbindung für diesen Arbeitsbereich trennen? Neue Veröffentlichungen werden dadurch angehalten. Bereits veröffentlichte Beiträge bleiben bestehen.</p><button disabled={busy} onClick={() => mutation.mutate({ action: "disconnect", revision: connection.revision })}>Jetzt trennen</button><button disabled={busy} onClick={() => setDisconnecting(false)}>Abbrechen</button></div>}
      <p className="hint">Der erste direkte Veröffentlichungsweg unterstützt einzelne JPEG-Bildbeiträge mit ausdrücklich freigegebenem Instagram-Text. Kalendertermine und bestehende Buffer-Aufträge werden hierdurch nicht automatisch umgestellt. Profilbild, Kontoname und Biografie werden über diese Verbindung nicht geändert.</p>
      <p><Link to="/campaigns">Kampagnen &amp; Kalender öffnen</Link></p>
    </section>}
    {owner && pendingId && /^[0-9a-f-]{36}$/i.test(pendingId) && <InstagramAccountSelection org={org} id={pendingId} complete={clearResult} />}
    {status.data?.configured && usable && <InstagramPrepare org={org} canPublish={canPublish} />}
    <section className="panel" aria-label="Direkte Veröffentlichungen"><h2>Direkte Veröffentlichungen</h2>
      <p className="hint">Hier erscheinen nur Aufträge der direkten Anbindung. Ein ungeklärtes Ergebnis wird nicht automatisch erneut versendet.</p>
      {publications.isPending && <p role="status">Aufträge werden geladen…</p>}
      {publications.error && <p role="alert">Die Aufträge konnten nicht geladen werden. <button onClick={() => void publications.refetch()}>Erneut laden</button></p>}
      {publications.data?.length === 0 && <p>Noch keine direkten Veröffentlichungsaufträge.</p>}
      {publications.data?.map(item => <article key={item.id} style={{ borderTop: "1px solid var(--border)", padding: "1rem 0" }}>
        <h3>{instagramState(item.state)}</h3><p className="hint">{new Date(item.created_at).toLocaleString("de-DE")} · Inhaltsrevision {item.content_revision}</p>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.payload.caption}</p>
        {item.media_id && <p className="hint">Instagram-Beitragskennung: {item.media_id}</p>}
        {canPublish && <div className="row" style={{ flexWrap: "wrap", gap: ".6rem" }}>
          {item.state === "prepared" && <button disabled={busy || !status.data?.configured || !usable} onClick={() => mutation.mutate({ action: "advance", revision: item.revision, id: item.id })}>Geprüften Bildbeitrag jetzt veröffentlichen</button>}
          {["creating", "publishing", "outcome_unknown"].includes(item.state) && <button disabled={busy || !status.data?.configured || !usable} onClick={() => mutation.mutate({ action: "reconcile", revision: item.revision, id: item.id })}>Ergebnis bei Instagram prüfen</button>}
        </div>}
      </article>)}
    </section>
  </div>;
}
