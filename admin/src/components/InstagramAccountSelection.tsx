import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { instagramError } from "../lib/instagram";

interface Pending { id: string; accounts: { id: string; username: string }[]; expected_revision: number; expires_at: string; client_business_id: string }
export function InstagramAccountSelection({ org, id, complete }: { org: string; id: string; complete: () => void }) {
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const qc = useQueryClient(), root = `/api/orgs/${org}/instagram/pending/${encodeURIComponent(id)}`;
  const pending = useQuery({ queryKey: ["instagram-pending", org, id], queryFn: () => api.get<Pending>(root) });
  const mutation = useMutation({ mutationFn: (action: "select" | "cancel") => action === "cancel" ? api.del(root) : api.post(`${root}/select`, { account_id: selected, expected_revision: pending.data?.expected_revision }), onSuccess: () => {
    if (!alive.current) return;
    void qc.invalidateQueries({ queryKey: ["instagram", org] }); complete();
  }, onError: e => { if (alive.current) setError(instagramError(e instanceof Error ? e.message : "")); } });
  return <section className="panel" aria-label="Instagram-Konto auswählen"><h2>Welches Instagram-Konto gehört hierher?</h2>
    <p className="hint">Meta hat mehrere Konten freigegeben. Wähle ausdrücklich das Konto für diesen Arbeitsbereich. Bis dahin wird keine neue Verbindung aktiv.</p>
    {pending.isPending && <p role="status">Konten werden geladen…</p>}
    {pending.error && <p role="alert">Die Auswahl ist nicht mehr verfügbar oder gehört zu einem anderen Arbeitsbereich. Wechsle gegebenenfalls in den ursprünglichen Bereich und verbinde erneut.</p>}
    {pending.data && <><label htmlFor="instagram-shared-account">Freigegebenes Instagram-Konto</label><select id="instagram-shared-account" value={selected} disabled={mutation.isPending} onChange={e => setSelected(e.target.value)}><option value="">Konto auswählen</option>{pending.data.accounts.map(a => <option key={a.id} value={a.id}>@{a.username}</option>)}</select><p className="hint">Die Auswahl ist bis {new Date(pending.data.expires_at).toLocaleTimeString("de-DE")} möglich. Sie bindet nur das gewählte Konto.</p><button className="primary" disabled={!selected || mutation.isPending} onClick={() => mutation.mutate("select")}>Dieses Konto verbinden</button></>}
    <button disabled={mutation.isPending} onClick={() => mutation.mutate("cancel")}>Auswahl abbrechen</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
