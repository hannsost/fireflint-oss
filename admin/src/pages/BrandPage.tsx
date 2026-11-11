import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, assetUrl, upload } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { UiIcon } from "../components/Brand";
import { ReleaseImpactPanel } from "../components/ReleaseImpactPanel";
import { useToast } from "../components/Toast";
import { BRAND_KINDS, BRAND_SCHEMAS, brandColor, changedBrandFields, characterCount, effectiveData, imageSourceFingerprint, instagramImageSource, instagramPreview, outdatedInstagramImage, publishedBrandProfile, recordTitle, stringValue, validBrandImage, validateBrandData, type BrandData, type BrandKind } from "../lib/brandContent";
import { composeInstagramImage } from "../lib/instagramImage";
import type { Asset, ChannelAssignment, ContentObject, ContentType, Website } from "../types";
import "../brand-content.css";

type SavedChannels = { assignments: ChannelAssignment[]; revision: number };
const message = (error: unknown) => error instanceof ApiError ? error.message : "Die Änderung konnte nicht bestätigt werden. Bitte den gespeicherten Stand prüfen.";

export function BrandPage() {
  const org = useOrg();
  return <BrandWorkspace key={org} org={org} />;
}

function BrandWorkspace({ org }: { org: string }) {
  const [params, setParams] = useSearchParams();
  const typeKey: BrandKind = params.get("type") === "website_page" ? "website_page" : "brand_profile";
  const { memberships } = useAuth();
  const canWrite = memberships.some(item => item.org_id === org && ["owner", "editor"].includes(item.role));
  const types = useQuery({ queryKey: ["content-types", org], queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`) });
  const profiles = useQuery({ queryKey: ["brand-records", org, "brand_profile"], queryFn: () => api.get<ContentObject[]>(`/api/orgs/${org}/content/brand_profile`), enabled: !!types.data?.some(type => type.key === "brand_profile") });
  const pages = useQuery({ queryKey: ["brand-records", org, "website_page"], queryFn: () => api.get<ContentObject[]>(`/api/orgs/${org}/content/website_page`), enabled: !!types.data?.some(type => type.key === "website_page") });
  const records = typeKey === "brand_profile" ? profiles : pages;
  const selectedId = params.get("id") || records.data?.[0]?.id;
  const selected = records.data?.find(item => item.id === selectedId);
  const available = !!types.data?.some(type => type.key === typeKey);
  const [dirty, setDirty] = useState(false);
  const change = (type: BrandKind, id?: string) => {
    if (dirty && !window.confirm("Deine ungespeicherten Änderungen verwerfen?")) return;
    setDirty(false);
    setParams({ type, ...(id ? { id } : {}) });
  };
  return <div className="brand-workspace">
    <header className="brand-page-heading"><div><h1>Marke &amp; Website</h1><p className="hint">Logo, Bilder und Texte gemeinsam pflegen. Instagram-Varianten vorab ansehen.</p></div><Link className="button" to="/media"><UiIcon name="media" />Medienbibliothek</Link></header>
    <div className="brand-workspace-note"><UiIcon name="website" /><p>Freigegebene Quellen stehen der verbundenen Website und neuen Instagram-Entwürfen zur Verfügung. Bestehende Kalenderbeiträge werden separat überarbeitet und freigegeben.</p></div>
    {!canWrite && <p className="hint" role="status">Lesezugriff · Du kannst Inhalte und Vorschauen ansehen.</p>}
    <div className="brand-content-tabs" role="group" aria-label="Inhaltsbereich">{BRAND_KINDS.map(kind => <button key={kind} aria-pressed={typeKey === kind} onClick={() => change(kind)}>{kind === "brand_profile" ? "Markenprofil" : "Website-Seiten"}</button>)}</div>
    {types.isPending && <p role="status">Inhalte werden geladen…</p>}
    {(types.error || records.error) && <div className="panel" role="alert"><p>Die Inhalte konnten nicht geladen werden.</p><button onClick={() => { void types.refetch(); if (available) void records.refetch(); }}>Erneut laden</button></div>}
    {types.data && !available && <div className="panel"><h2>Noch nicht eingerichtet</h2><p>Für diesen Arbeitsbereich ist noch kein {typeKey === "brand_profile" ? "Markenprofil" : "Website-Inhalt"} angebunden. Die Einrichtung verbindet eure vorhandenen Inhalte und Medien mit der Website.</p></div>}
    {available && !records.error && <>
      <div className="brand-record-picker"><label htmlFor="brand-record">{typeKey === "brand_profile" ? "Markenprofil auswählen" : "Website-Seite auswählen"}</label><select id="brand-record" value={selectedId ?? ""} onChange={event => change(typeKey, event.target.value)} disabled={records.isPending || !records.data?.length}>{records.data?.map(item => <option key={item.id} value={item.id}>{recordTitle(typeKey, item)}{typeKey === "website_page" ? ` · ${stringValue(item.data, "path")}` : ""}</option>)}</select>{canWrite && <Link className="button" to={`/content/${typeKey}/new`}>{typeKey === "brand_profile" ? "Profil anlegen" : "Seite anlegen"}</Link>}</div>
      {records.isPending && <p role="status">Inhalte werden geladen…</p>}
      {records.data?.length === 0 && <div className="panel"><h2>Noch keine Inhalte</h2><p>Lege einen Eintrag an und ordne ihn im Inhaltseditor der passenden Website zu.</p></div>}
      {records.data && records.data.length > 0 && !selected && <p role="alert" className="brand-error">Der ausgewählte Inhalt gehört nicht zu dieser Liste. Bitte einen Eintrag auswählen.</p>}
      {selected && <BrandEditor key={`${org}:${typeKey}:${selected.id}`} org={org} kind={typeKey} initial={selected} profiles={profiles.data ?? []} canWrite={canWrite} onDirty={setDirty} />}
    </>}
  </div>;
}

function BrandImageField({ org, label, value, onChange, disabled }: { org: string; label: string; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const assets = useQuery({ queryKey: ["assets", org], queryFn: () => api.get<{ assets: Asset[] }>(`/api/orgs/${org}/assets`), enabled: open });
  const qc = useQueryClient();
  const uploadImage = useMutation({ mutationFn: async (file: File) => {
    if (!["image/png", "image/jpeg", "image/webp", "image/avif"].includes(file.type)) throw new Error("Bitte PNG, JPEG, WebP oder AVIF verwenden.");
    if (file.size > 5 * 1024 * 1024) throw new Error("Das Bild darf höchstens 5 MB groß sein.");
    return upload<Asset>(`/api/orgs/${org}/assets`, file);
  }, onSuccess: asset => { if (validBrandImage(asset.url, org)) { onChange(asset.url); setOpen(false); } void qc.invalidateQueries({ queryKey: ["assets", org] }); } });
  const image = validBrandImage(value, org) ? value : "";
  return <div className="brand-image-field"><div className="brand-image-choice">{image ? <img src={assetUrl(image)} alt={`${label}: ausgewähltes Bild`} /> : <span className="brand-image-empty"><UiIcon name="media" /></span>}<div><strong>{label}</strong><div className="brand-image-actions"><button type="button" disabled={disabled || uploadImage.isPending} onClick={() => setOpen(value => !value)}>Bild auswählen</button><button type="button" disabled={disabled || uploadImage.isPending} onClick={() => input.current?.click()}>{uploadImage.isPending ? "Lädt hoch…" : "Hochladen"}</button>{value && <button type="button" disabled={disabled} onClick={() => onChange("")}>Entfernen</button>}</div></div></div>
    <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/avif" disabled={disabled} aria-label={`${label} hochladen`} onChange={event => { const file = event.target.files?.[0]; if (file) uploadImage.mutate(file); event.target.value = ""; }} />
    {uploadImage.error && <p className="brand-error" role="alert">{uploadImage.error instanceof Error ? uploadImage.error.message : "Upload fehlgeschlagen."}</p>}
    {value && !image && <p className="brand-error">Dieses Bild ist für diesen Arbeitsbereich nicht freigegeben. Bitte neu auswählen.</p>}
    {open && <div className="brand-image-library"><p className="hint">Öffentliche Bilder dieses Arbeitsbereichs. Ein Upload speichert die Datei; erst die Inhaltsfreigabe ändert die Website.</p>{assets.isPending && <p role="status">Bilder werden geladen…</p>}{assets.error && <p role="alert">Medien konnten nicht geladen werden. <button onClick={() => void assets.refetch()}>Erneut laden</button></p>}<div className="brand-image-options">{assets.data?.assets.filter(asset => /^image\/(png|jpeg|webp|avif)$/.test(asset.content_type) && validBrandImage(asset.url, org)).map(asset => <button type="button" key={asset.id} title={asset.filename} disabled={disabled} onClick={() => { onChange(asset.url); setOpen(false); }}><img src={assetUrl(asset.url)} alt={asset.filename} /><span>{asset.filename}</span></button>)}</div>{assets.data && !assets.data.assets.some(asset => /^image\/(png|jpeg|webp|avif)$/.test(asset.content_type) && validBrandImage(asset.url, org)) && <p className="hint">Noch keine passenden Bilder. Lade ein Bild hoch.</p>}</div>}
  </div>;
}

function BrandEditor({ org, kind, initial, profiles, canWrite, onDirty }: { org: string; kind: BrandKind; initial: ContentObject; profiles: ContentObject[]; canWrite: boolean; onDirty: (dirty: boolean) => void }) {
  const [object, setObject] = useState(initial);
  const [data, setData] = useState<BrandData>(initial.data);
  const dataRef = useRef(data);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [serverVersion, setServerVersion] = useState<ContentObject>();
  const [comparisonError, setComparisonError] = useState("");
  const [preview, setPreview] = useState<"website" | "instagram">("website");
  const [previewStand, setPreviewStand] = useState<"draft" | "public">("draft");
  const [websiteId, setWebsiteId] = useState("");
  const [publishReview, setPublishReview] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  const path = `/api/orgs/${org}/content/${kind}/${object.id}`;
  const objectQuery = useQuery({ queryKey: ["content-obj", org, kind, object.id], queryFn: () => api.get<ContentObject>(path) });
  const channels = useQuery({ queryKey: ["channels", org, kind, object.id], queryFn: () => api.get<SavedChannels>(`${path}/channels`) });
  const websites = useQuery({ queryKey: ["websites", org], queryFn: () => api.get<Website[]>(`/api/orgs/${org}/websites`) });
  const newerVersion = !!objectQuery.data && objectQuery.data.revision > object.revision;
  const conflicted = conflict || newerVersion || !!channels.data && channels.data.revision > object.revision;
  const channelsReady = !!channels.data && channels.data.revision === object.revision;
  const assignments = channelsReady ? channels.data!.assignments : [];
  const allSiteIds = [...new Set([...assignments, ...(object.publication?.assignments ?? [])].map(item => item.website_id))];
  const currentSite = allSiteIds.includes(websiteId) ? websiteId : allSiteIds[0] || "";
  const errors = validateBrandData(kind, data, org);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["brand-records", org, kind] });
    void qc.invalidateQueries({ queryKey: ["content", org, kind] });
    void qc.invalidateQueries({ queryKey: ["channels", org, kind, object.id] });
    void qc.invalidateQueries({ queryKey: ["content-obj", org, kind, object.id] });
  };
  const remember = (value: ContentObject) => {
    qc.setQueryData(["content-obj", org, kind, object.id], value);
    if (mounted.current) { setObject(value); setPublishReview(false); }
    refresh();
  };
  const fail = (error: unknown) => { if (mounted.current && error instanceof ApiError && error.status === 409) { setConflict(true); setPublishReview(false); } };
  const save = useMutation({ mutationFn: ({ submitted, revision }: { submitted: BrandData; revision: number }) => api.put<ContentObject>(path, { data: submitted, expected_revision: revision }), onSuccess: (value, { submitted }) => {
    remember(value);
    if (!mounted.current) return;
    if (dataRef.current === submitted) { dataRef.current = value.data; setData(value.data); setDirty(false); }
    toast("Entwurf gespeichert. Der öffentliche Stand bleibt bis zur Freigabe bestehen.");
  }, onError: fail });
  const publish = useMutation({ mutationFn: (revision: number) => api.post<ContentObject>(`${path}/publish`, { expected_revision: revision }), onSuccess: value => { remember(value); if (mounted.current) toast("Quelle freigegeben. Verbundene Websites übernehmen sie gemäß ihrer Anbindung."); }, onError: fail });
  const busy = save.isPending || publish.isPending;
  const update = (key: string, value: string) => { if (!canWrite || busy) return; const next = { ...dataRef.current, [key]: value, ...(key === "instagram_image" ? { instagram_image_source: "" } : {}) }; dataRef.current = next; setData(next); setDirty(true); setPublishReview(false); };
  const previewSource = previewStand === "public" ? object.publication?.data : data;
  const previewAssignments = previewStand === "public" ? object.publication?.assignments ?? [] : assignments;
  const effective = previewSource && effectiveData(previewSource, previewAssignments, currentSite);
  const profile = publishedBrandProfile(profiles, currentSite);
  const social = instagramPreview(kind, effective ?? {}, profile.data);
  const changed = changedBrandFields(kind, data, object.publication?.data);
  const safeImage = (value: string) => validBrandImage(value, org) ? assetUrl(value) : "";
  const image = effective && (stringValue(effective, kind === "brand_profile" ? "primary_image" : "hero_image") || stringValue(profile.data, "primary_image"));
  const fields = BRAND_SCHEMAS[kind].fields;
  const effectiveDraft = effectiveData(data, assignments, currentSite);
  const imageSource = instagramImageSource(effectiveDraft, profile.data);
  const imageOutdated = outdatedInstagramImage(effectiveDraft, profile.data);
  const composition = useMutation({ mutationFn: async (source: { image: string; logo: string; color: string; alt: string }) => {
    if (!validBrandImage(source.image, org) || !validBrandImage(source.logo, org)) throw new Error("Bitte Vorlagenbilder aus diesem Arbeitsbereich auswählen.");
    const blob = await composeInstagramImage({ ...source, image: assetUrl(source.image), logo: assetUrl(source.logo) });
    const file = new File([blob], `instagram-${Date.now()}.jpg`, { type: "image/jpeg" });
    const result = await upload<Asset>(`/api/orgs/${org}/assets`, file);
    if (result.content_type !== "image/jpeg" || !validBrandImage(result.url, org)) throw new Error("Das vorbereitete Bild konnte nicht bestätigt werden. Bitte die Medienbibliothek prüfen.");
    return result;
  }, onSuccess: (asset, source) => {
    void qc.invalidateQueries({ queryKey: ["assets", org] });
    if (!mounted.current) return;
    const next = { ...dataRef.current, instagram_image: asset.url, instagram_image_alt: source.alt, instagram_image_source: imageSourceFingerprint(source) };
    dataRef.current = next; setData(next); setDirty(true); setPublishReview(false);
    toast("Instagram-Bild vorbereitet. Prüfe die Vorschau und speichere den Entwurf.");
  } });
  const formBusy = busy || composition.isPending;

  return <>
    <section className="brand-state-line"><div><span className={`brand-state ${object.status === "published" ? "is-published" : ""}`}>{object.status === "published" ? "Quelle veröffentlicht" : object.publication ? "Quelle zurückgezogen" : "Noch nicht veröffentlicht"}</span><span>{dirty ? "Ungespeicherte Änderungen" : object.has_unpublished_changes ? "Gespeicherter Entwurf wartet auf Freigabe" : "Gespeicherter Stand"} · Revision {object.revision}</span></div><Link to={`/content/${kind}/${object.id}`}>Zuordnung &amp; Verlauf</Link></section>
    {conflicted && <section className="brand-conflict panel" role="alert"><h2>Inzwischen geändert</h2><p>Deine Eingaben bleiben erhalten. Vergleiche zuerst den neueren gespeicherten Stand.</p><button disabled={busy} onClick={() => { setComparisonError(""); void api.get<ContentObject>(path).then(value => { if (mounted.current) setServerVersion(value); }).catch(error => { if (mounted.current) setComparisonError(message(error)); }); }}>Serverstand zum Vergleich laden</button>{comparisonError && <p>{comparisonError}</p>}{serverVersion && <div><p>Serverrevision {serverVersion.revision} · Deine geprüfte Revision {object.revision}</p><div className="brand-conflict-values">{fields.filter(field => stringValue(data, field.key) !== stringValue(serverVersion.data, field.key)).map(field => <div key={field.key}><strong>{field.label}</strong><p>Deine Eingabe: {stringValue(data, field.key) || "Leer"}</p><p>Serverstand: {stringValue(serverVersion.data, field.key) || "Leer"}</p></div>)}</div><div className="brand-actions"><button onClick={() => { setObject(serverVersion); dataRef.current = serverVersion.data; setData(serverVersion.data); setDirty(false); setConflict(false); setServerVersion(undefined); refresh(); }}>Serverstand übernehmen</button><button onClick={() => { setObject(serverVersion); setDirty(true); setConflict(false); setServerVersion(undefined); refresh(); }}>Eigene Eingaben nach Vergleich beibehalten</button></div></div>}</section>}
    {(save.error || publish.error) && !conflicted && <p className="brand-error" role="alert">{message(save.error || publish.error)}</p>}
    <div className="brand-editor-layout">
      <section className="panel brand-edit-panel" aria-label="Markeninhalte bearbeiten"><div className="section-heading"><h2>{kind === "brand_profile" ? "Deine Marke" : "Website & Instagram"}</h2><span className="hint">{canWrite ? "Entwurf bearbeiten" : "Lesezugriff"}</span></div>
        <form onSubmit={event => { event.preventDefault(); if (canWrite && dirty && !busy && !conflicted && !errors.length) save.mutate({ submitted: dataRef.current, revision: object.revision }); }}>
          <fieldset disabled={!canWrite || formBusy}>{fields.filter(field => field.key !== "instagram_image_source").map(field => {
            const value = stringValue(data, field.key);
            if (field.type === "media") return <BrandImageField key={field.key} org={org} label={field.label} value={value} onChange={next => update(field.key, next)} disabled={!canWrite || formBusy} />;
            return <div className="field" key={field.key}><label htmlFor={`brand-${field.key}`}>{field.label}{field.required && <span className="req"> *</span>}</label>{field.type === "richtext" ? <textarea id={`brand-${field.key}`} value={value} onChange={event => update(field.key, event.target.value)} rows={field.key === "body" ? 10 : 5} /> : <input id={`brand-${field.key}`} value={value} readOnly={kind === "website_page" && field.key === "path"} onChange={event => update(field.key, event.target.value)} placeholder={field.key === "brand_color" ? "#376b50" : undefined} />}{field.type === "richtext" && <span className="hint">{characterCount(value)}{field.key === "instagram_text" ? " / 2200" : field.key === "instagram_bio" ? " / 150" : ""} Zeichen</span>}{field.key === "path" && <p className="hint">Die Seitenadresse wird bei der Website-Anbindung festgelegt.</p>}{field.key === "body" && <p className="hint">Bearbeitet den Haupttext beziehungsweise die Einleitung. Navigation, Kontaktbereiche und interaktive Website-Module bleiben im vorhandenen Layout.</p>}{field.key === "instagram_text" && <p className="hint">Eigene Instagram-Fassung. Ohne diesen Text ist die Vorschau nur ein Beispiel aus dem Seitentext und kein freigegebener Instagram-Beitrag.</p>}{field.key === "instagram_bio" && <p className="hint">Vorlage zum manuellen Übertragen ins Instagram-Profil. Name, Profilfoto und Bio werden hier nicht automatisch im Instagram-Konto geändert.</p>}</div>;
          })}</fieldset>
          {errors.length > 0 && <ul className="brand-validation" aria-label="Eingaben prüfen">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
          {kind === "website_page" && <section className="brand-composer" aria-label="Instagram-Bild vorbereiten"><h3>Ein Bild für Instagram</h3><p className="hint">Website-Motiv und Logo der Vorschau-Website als eigenes Hochformat mit 1080 × 1350 Pixeln vorbereiten. Das Ergebnis wird als gemeinsames Instagram-Bild hinterlegt; vorhandene Website-Ausnahmen bleiben bestehen. Der Beitragstext bleibt separat.</p>{imageOutdated && <p className="brand-error" role="status">Logo, Farbe oder Website-Bild haben sich seit der Bildvorbereitung geändert. Bereite das Instagram-Bild neu vor.</p>}{profile.ambiguous && <p className="brand-error">Bitte zuerst das passende Markenprofil zuordnen.</p>}{canWrite && <button type="button" disabled={formBusy || !imageSource.image || profile.ambiguous || !channelsReady || conflicted} onClick={() => composition.mutate({ ...imageSource, alt: stringValue(effectiveDraft, "hero_alt") || stringValue(profile.data, "primary_image_alt") || "Bild aus der Website-Vorlage" })}>{composition.isPending ? "Bereitet Bild vor…" : "Instagram-Bild vorbereiten"}</button>}{composition.error && <p className="brand-error" role="alert">{composition.error instanceof Error ? composition.error.message : "Das Bild konnte nicht vorbereitet werden. Dein bisheriges Bild bleibt erhalten."}</p>}</section>}
          {canWrite && <div className="brand-save-bar"><button className="primary" type="submit" disabled={!dirty || formBusy || conflicted || errors.length > 0}>{save.isPending ? "Speichert…" : "Entwurf speichern"}</button><span className="hint">Speichern veröffentlicht noch nichts.</span></div>}
        </form>
      </section>
      <aside className="brand-preview-panel" aria-label="Inhaltsvorschau"><div className="brand-preview-heading"><h2>Vorschau</h2><div className="brand-preview-switch" role="group" aria-label="Vorschaukanal"><button aria-pressed={preview === "website"} onClick={() => setPreview("website")}>Website</button><button aria-pressed={preview === "instagram"} onClick={() => setPreview("instagram")}>Instagram</button></div></div>
        <div className="brand-preview-selectors"><label>Stand<select aria-label="Vorschaustand" value={previewStand} onChange={event => setPreviewStand(event.target.value as "draft" | "public")}><option value="draft">Aktueller Entwurf</option><option value="public">Bisher freigegeben</option></select></label>{allSiteIds.length > 0 && <label>Website<select aria-label="Vorschau-Website" value={currentSite} onChange={event => setWebsiteId(event.target.value)}>{allSiteIds.map(id => <option key={id} value={id}>{websites.data?.find(site => site.id === id)?.name || id}</option>)}</select></label>}</div>
        {profile.ambiguous && kind === "website_page" && <p className="brand-error" role="alert">Mehrere veröffentlichte Markenprofile sind dieser Website zugeordnet. Bitte die Zuordnung klären; es wird keines automatisch ausgewählt.</p>}
        {kind === "website_page" && currentSite && !profile.data && !profile.ambiguous && <p className="hint">Für diese Website ist noch kein Markenprofil freigegeben. Logo und Markenangaben erscheinen nach der Profilfreigabe.</p>}
        {!effective ? <p className="panel hint">Für diesen Inhalt gibt es noch keinen freigegebenen Stand.</p> : preview === "website" ? <div className="brand-site-preview" style={{ "--brand-preview-color": brandColor(effective.brand_color || profile.data?.brand_color) } as CSSProperties}>
          <div className="brand-site-preview-header">{safeImage(stringValue(kind === "brand_profile" ? effective : profile.data, "logo")) && <img src={safeImage(stringValue(kind === "brand_profile" ? effective : profile.data, "logo"))} alt="Website-Logo" />}<span>{stringValue(kind === "brand_profile" ? effective : profile.data, "name") || "Website"}</span></div>
          {image && safeImage(image) && <img className="brand-site-preview-image" src={safeImage(image)} alt={stringValue(effective, kind === "brand_profile" ? "primary_image_alt" : "hero_alt")} />}
          <div className="brand-site-preview-copy"><h3>{stringValue(effective, kind === "brand_profile" ? "tagline" : "heading") || stringValue(effective, "name")}</h3><div className="brand-preview-text">{stringValue(effective, kind === "brand_profile" ? "description" : "body")}</div></div>
        </div> : <div className="brand-instagram-preview"><div className="brand-instagram-header"><span className="brand-instagram-mark">{safeImage(social.logo) ? <img src={safeImage(social.logo)} alt="Logo aus dem Markenprofil" /> : <UiIcon name="media" />}</span><strong>{social.name}</strong><span aria-hidden="true">•••</span></div>{social.image && safeImage(social.image) ? <img className="brand-instagram-image" src={safeImage(social.image)} alt={social.alt} /> : <div className="brand-instagram-placeholder"><UiIcon name="media" /><span>Beitragsbild auswählen</span></div>}<div className="brand-instagram-copy"><span className="brand-preview-text">{social.text || "Dein Beitragstext erscheint hier."}</span></div></div>}
        {effective && preview === "instagram" && <div className="brand-preview-footnote">{social.fallbackText && <p>Textbeispiel aus dem Seitentext. Bitte eine eigene Instagram-Fassung hinterlegen.</p>}{social.fallbackImage && <p>Das Website-Bild wird als Bildvorlage verwendet.</p>}<p>Vorlagenvorschau. Sie zeigt keinen bestehenden Instagram-Beitrag und ändert das Instagram-Profil nicht.</p></div>}
        {preview === "website" && <p className="brand-preview-footnote">Inhaltsvorschau mit Website-Ausnahmen. Layout und Bildausschnitt können auf der verbundenen Website abweichen.</p>}
        <section className="brand-change-summary"><h3>Änderungen zur Freigabe</h3>{changed.length ? <ul>{changed.map(field => <li key={field.key}>{field.label}</li>)}</ul> : <p className="hint">Keine Änderungen an den gepflegten Feldern.</p>}<p className="hint">Instagram-Entwürfe werden aus freigegebenen Quellen neu erstellt oder ausdrücklich überarbeitet. Bereits geplante oder veröffentlichte Beiträge behalten ihren eigenen Freigabestand.</p></section>
      </aside>
    </div>
    <ReleaseImpactPanel org={org} typeKey={kind} object={object} fields={fields} dirty={dirty} channelsDirty={false} busy={busy} conflict={conflicted} contentFetching={objectQuery.isFetching} contentFailed={objectQuery.isError} />
    {canWrite && <section className="panel brand-publish-panel"><div><h2>Quelle freigeben</h2><p className="hint">Prüfe Vorschau und Website-Auswirkungen. Die Freigabe veröffentlicht den gespeicherten Stand {object.revision} einschließlich seiner Website-Ausnahmen.</p></div>{!assignments.length && channelsReady && <p className="brand-error">Ohne Website-Zuordnung wird der Inhalt nicht ausgeliefert. <Link to={`/content/${kind}/${object.id}`}>Website zuordnen</Link></p>}{!dirty && !formBusy && !conflicted && channelsReady && assignments.length > 0 && !errors.length && <label className="brand-publish-check"><input type="checkbox" checked={publishReview} onChange={event => setPublishReview(event.target.checked)} />Ich habe den gespeicherten Stand und die Website-Auswirkungen geprüft.</label>}<button className="primary" disabled={dirty || formBusy || conflicted || !channelsReady || !assignments.length || errors.length > 0 || !publishReview || objectQuery.isFetching || objectQuery.isError || channels.isFetching || channels.isError} onClick={() => publish.mutate(object.revision)}>{publish.isPending ? "Gibt frei…" : "Gespeicherten Stand freigeben"}</button></section>}
  </>;
}
