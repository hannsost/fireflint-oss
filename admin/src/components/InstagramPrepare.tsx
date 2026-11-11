import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, assetUrl, request } from "../api/client";
import type { ContentObject, ContentType, Website } from "../types";
import { instagramError, type InstagramPublication } from "../lib/instagram";

type Candidate = ContentObject & { type: string };
export function InstagramPrepare({ org, canPublish }: { org: string; canPublish: boolean }) {
  const [selected, setSelected] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<InstagramPublication | null>(null);
  const reservation = useRef<{ fingerprint: string; key: string } | null>(null);
  const qc = useQueryClient();
  const root = `/api/orgs/${org}`;
  const websites = useQuery({ queryKey: ["websites", org], queryFn: () => api.get<Website[]>(`${root}/websites`) });
  const candidates = useQuery({ queryKey: ["instagram-candidates", org], queryFn: async () => {
    const types = await api.get<ContentType[]>(`${root}/content-types`);
    const lists = await Promise.all(types.filter(t => ["website_page", "social_plan_post"].includes(t.key)).map(async t => {
      const contents = await api.get<ContentObject[]>(`${root}/content/${t.key}`);
      return contents.map(c => ({ ...c, type: t.key }));
    }));
    return lists.flat().filter(c => c.status === "published" && !c.has_unpublished_changes && c.publication?.revision === c.revision);
  } });
  const candidate = candidates.data?.find(c => `${c.type}:${c.id}` === selected);
  const assigned = websites.data?.filter(w => candidate?.publication?.assignments.some(a => a.website_id === w.id)) ?? [];
  const preview = useMemo(() => {
    const assignment = candidate?.publication?.assignments.find(a => a.website_id === website);
    if (!candidate?.publication || !assignment) return null;
    const data = { ...candidate.publication.data, ...assignment.overrides };
    const text = candidate.type === "website_page" ? data.instagram_text : data.instagram;
    const image = candidate.type === "website_page" ? data.instagram_image || data.hero_image : data.image;
    const alt = candidate.type === "website_page" ? data.instagram_image_alt || data.hero_alt : data.image_alt;
    const owned = typeof image === "string" && (image.startsWith(`/assets/${org}/`) || image.startsWith(`${location.origin}/assets/${org}/`));
    return { text: typeof text === "string" ? text : "", image: owned ? assetUrl(image) : "", alt: typeof alt === "string" ? alt : "" };
  }, [candidate, website, org]);
  const prepare = useMutation({ mutationFn: async (content: Candidate) => {
    const body = { content_type: content.type, content_id: content.id, website_id: website, expected_revision: content.revision };
    const fingerprint = JSON.stringify(body);
    if (!reservation.current || reservation.current.fingerprint !== fingerprint) reservation.current = { fingerprint, key: crypto.randomUUID() };
    return request<InstagramPublication>(`${root}/instagram/publications`, { method: "POST", headers: { "Idempotency-Key": reservation.current.key }, body: fingerprint });
  }, onMutate: () => { setError(""); setResult(null); }, onSuccess: row => {
    setResult(row); void qc.invalidateQueries({ queryKey: ["instagram-publications", org] });
  }, onError: e => {
    setError(instagramError(e instanceof Error ? e.message : ""));
    void qc.invalidateQueries({ queryKey: ["instagram-publications", org] });
  } });

  return <section className="panel" aria-label="Instagram-Bildbeitrag vorbereiten"><h2>Bildbeitrag vorbereiten</h2>
    <p className="hint">Wähle einen unverändert freigegebenen Inhalt und seine Website. Der ausdrücklich hinterlegte Instagram-Text und das JPEG-Bild werden als unveränderlicher Auftrag vorbereitet. Erst der nächste Schritt veröffentlicht ihn.</p>
    {(candidates.isPending || websites.isPending) && <p role="status">Freigegebene Inhalte werden geladen…</p>}
    {(candidates.error || websites.error) && <p role="alert">Die Inhalte konnten nicht geladen werden. <button onClick={() => { void candidates.refetch(); void websites.refetch(); }}>Erneut laden</button></p>}
    {candidates.data?.length === 0 && <p>Noch keine passenden freigegebenen Inhalte. <Link to="/brand">Marke &amp; Website öffnen</Link></p>}
    {candidates.data && candidates.data.length > 0 && <>
      <div><label htmlFor="instagram-reviewed-content">Freigegebener Inhalt</label><select id="instagram-reviewed-content" value={selected} disabled={prepare.isPending} onChange={e => { setSelected(e.target.value); setWebsite(""); setResult(null); setError(""); }}><option value="">Inhalt wählen</option>{candidates.data.map(c => <option key={`${c.type}:${c.id}`} value={`${c.type}:${c.id}`}>{String(c.data.title || c.data.heading || c.id)}</option>)}</select></div>
      {candidate && <div><label htmlFor="instagram-reviewed-website">Website</label><select id="instagram-reviewed-website" value={website} disabled={prepare.isPending} onChange={e => { setWebsite(e.target.value); setResult(null); setError(""); }}><option value="">Website wählen</option>{assigned.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>}
      {candidate && assigned.length === 0 && <p className="hint">Dieser Inhalt besitzt keine freigegebene Website-Zuordnung.</p>}
      {preview && <div style={{ maxWidth: 480, margin: "1rem 0" }}>
        {preview.image ? <img src={preview.image} alt={preview.alt} style={{ display: "block", width: "100%", maxHeight: 520, objectFit: "contain", borderRadius: 10 }} /> : <p className="hint">Wähle ein Bild aus der Medienbibliothek dieses Arbeitsbereichs.</p>}
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview.text || "Es ist noch kein ausdrücklicher Instagram-Text freigegeben."}</p>
        <p className="hint">{Array.from(preview.text).length} / 2.200 Zeichen · Inhaltsrevision {candidate?.revision}</p>
      </div>}
      {canPublish && <button className="primary" disabled={!candidate || !preview?.image || !preview.text.trim() || Array.from(preview.text).length > 2200 || prepare.isPending} onClick={() => { if (candidate) prepare.mutate(candidate); }}>{prepare.isPending ? "Wird vorbereitet…" : "Geprüften Bildbeitrag vorbereiten"}</button>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    {result && <p role="status">Auftrag übernommen. Den Status und den ausdrücklichen Veröffentlichungsschritt findest du unter „Direkte Veröffentlichungen“.</p>}
  </section>;
}
