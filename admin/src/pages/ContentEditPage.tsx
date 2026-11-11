import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, assetUrl, request } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { SchemaForm } from "../components/SchemaForm";
import { StatusBadge } from "../components/StatusBadge";
import { UiIcon } from "../components/Brand";
import { CopyButton } from "../components/CopyButton";
import { ReleaseImpactPanel } from "../components/ReleaseImpactPanel";
import { useToast } from "../components/Toast";
import { timeAgo } from "../lib/time";
import type {
  ChannelAssignment,
  ContentObject,
  ContentType,
  ContentVersion,
  FieldDef,
  Schedule,
  Website,
} from "../types";

type Data = Record<string, unknown>;
interface ChannelDraft {
  assignments: ChannelAssignment[];
  revision: number;
}
interface ChannelState {
  selected: boolean;
  overrides: Data;
}

export function ContentEditPage() {
  const { typeKey, id } = useParams<{ typeKey: string; id: string }>();
  const org = useOrg();
  // A different tenant/object must never inherit the previous object's draft.
  return <ContentEditor key={`${org}:${typeKey}:${id ?? "new"}`} org={org} typeKey={typeKey!} id={id} />;
}

function ContentEditor({ org, typeKey, id }: { org: string; typeKey: string; id?: string }) {
  const isNew = !id;
  const { memberships } = useAuth();
  const role = memberships.find(member => member.org_id === org)?.role;
  const canWrite = role === "owner" || role === "editor";
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const objectKey = ["content-obj", org, typeKey, id];
  const path = `/api/orgs/${org}/content/${typeKey}/${id}`;
  const channelsKey = ["channels", org, typeKey, id];

  const { data: types } = useQuery({
    queryKey: ["content-types", org],
    queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`),
  });
  const type = types?.find((t) => t.key === typeKey);
  const fields = type?.schema.fields ?? [];
  const objectQuery = useQuery({
    queryKey: objectKey,
    queryFn: () => api.get<ContentObject>(path),
    enabled: !isNew,
  });

  const menuSources = useQuery({
    queryKey: ["menu-content-source", org],
    queryFn: () => api.get<{ id: string; content_id: string }[]>(`/api/orgs/${org}/hub/flintplate`),
    enabled: !isNew && typeKey === "gastro_menu",
  });
  const managedMenu = menuSources.data?.find(source => source.content_id === id);
  const menuScopePending = !isNew && typeKey === "gastro_menu" && (menuSources.isPending || menuSources.isError);
  const canEditData = canWrite && !managedMenu && !menuScopePending;

  // The displayed snapshot owns the revision. Query refetches cannot silently
  // rebase a local draft onto a version its author has never reviewed.
  const [object, setObject] = useState<ContentObject | null>(null);
  const [data, setData] = useState<Data>({});
  const dataRef = useRef(data);
  const [dirty, setDirty] = useState(false);
  const [channelsDirty, setChannelsDirty] = useState(false);
  const [channelsBusy, setChannelsBusy] = useState(false);
  const [channelsRevision, setChannelsRevision] = useState<number | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [serverSnapshot, setServerSnapshot] = useState<ContentObject | null>(null);
  const [serverChannels, setServerChannels] = useState<ChannelDraft | null>(null);
  const [serverSchedule, setServerSchedule] = useState<Schedule | null>(null);
  const [reviewedSchedule, setReviewedSchedule] = useState<Schedule | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const newerQuery = object && objectQuery.data && objectQuery.data.revision > object.revision;
  const hasConflict = conflict || !!newerQuery || !!(object && channelsRevision != null && channelsRevision > object.revision);
  const channelsReady = !!object && channelsRevision === object.revision;
  const replaceInputs = (next: Data) => {
    dataRef.current = next;
    setData(next);
  };
  useEffect(() => {
    if (!isNew && !object && objectQuery.data) {
      setObject(objectQuery.data);
      // Preserve typing even if the first GET was still pending.
      if (!dirty) {
        dataRef.current = objectQuery.data.data;
        setData(objectQuery.data.data);
      }
    }
  }, [isNew, object, objectQuery.data, dirty]);
  const onDataChange = (next: Data) => {
    if (!canEditData) return;
    replaceInputs(next);
    setDirty(true);
  };
  const markConflict = () => {
    if (!mounted.current) return;
    setConflict(true);
    setServerSnapshot(null);
    setServerChannels(null);
    setServerSchedule(null);
    setSaveError(null);
  };
  const remember = (obj: ContentObject) => {
    if (mounted.current) setObject(obj);
    // Create responses belong to the real ID, never the disabled "new" query.
    qc.setQueryData(["content-obj", org, typeKey, obj.id], obj);
    qc.invalidateQueries({ queryKey: ["content", org, typeKey] });
    qc.invalidateQueries({ queryKey: ["versions", org, obj.id] });
    qc.invalidateQueries({ queryKey: ["schedule", org, typeKey, obj.id] });
    qc.invalidateQueries({ queryKey: ["channels", org, typeKey, obj.id] });
  };

  const saveMut = useMutation({
    mutationFn: ({ submitted, revision }: { submitted: Data; revision?: number }) =>
      isNew
        ? api.post<ContentObject>(`/api/orgs/${org}/content/${typeKey}`, { data: submitted })
        : api.put<ContentObject>(path, { data: submitted, expected_revision: revision }),
    onSuccess: (obj, { submitted }) => {
      remember(obj);
      if (!mounted.current) return;
      setSaveError(null);
      // Inputs typed while the request was in flight belong to the next save.
      if (dataRef.current === submitted) {
        replaceInputs(obj.data);
        setDirty(false);
      }
      toast("Gespeichert ✓");
      if (isNew) navigate(`/content/${typeKey}/${obj.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) markConflict();
      else setSaveError(e instanceof ApiError ? e.message : "Speichern fehlgeschlagen.");
    },
  });

  const statusMut = useMutation({
    mutationFn: ({ action, revision }: { action: "publish" | "unpublish"; revision: number }) =>
      api.post<ContentObject>(`${path}/${action}`, { expected_revision: revision }),
    onSuccess: (obj, { action }) => {
      remember(obj);
      if (!mounted.current) return;
      toast(action === "publish" ? "Veröffentlicht ✓" : "Zurückgezogen ✓");
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) markConflict();
    },
  });
  const revertMut = useMutation({
    mutationFn: (versionId: string) =>
      api.post<ContentObject>(`${path}/revert/${versionId}`, { expected_revision: object?.revision }),
    onSuccess: (obj) => {
      remember(obj);
      if (!mounted.current) return;
      replaceInputs(obj.data);
      setDirty(false);
      toast("Version wiederhergestellt ✓");
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) markConflict();
    },
  });
  const compareMut = useMutation({
    mutationFn: async () => {
      const content = await api.get<ContentObject>(path);
      const channels = await api.get<ChannelDraft>(`${path}/channels`);
      const schedule = await api.get<Schedule>(`${path}/schedule`);
      if (channels.revision !== content.revision || schedule.revision !== content.revision) {
        throw new ApiError(409, "Der Stand hat sich während des Vergleichs geändert. Bitte erneut vergleichen.");
      }
      return { content, channels, schedule };
    },
    onSuccess: ({ content, channels, schedule }) => {
      setServerSchedule(schedule);
      setServerSnapshot(content);
      setServerChannels(channels);
    },
  });
  const errorMessage = (error: unknown) => error instanceof ApiError
    ? error.message : "Anfrage fehlgeschlagen. Bitte erneut versuchen.";
  const statusError = statusMut.error && !(statusMut.error instanceof ApiError && statusMut.error.status === 409)
    ? errorMessage(statusMut.error) : null;
  const revertError = revertMut.error && !(revertMut.error instanceof ApiError && revertMut.error.status === 409)
    ? errorMessage(revertMut.error) : null;

  const deleteMut = useMutation({
    mutationFn: (revision: number) => request<void>(path, { method: "DELETE", body: JSON.stringify({ expected_revision: revision }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["content", org, typeKey] });
      if (!mounted.current) return;
      setDirty(false);
      toast("Gelöscht ✓");
      navigate(`/content/${typeKey}`);
    },
    onError: error => { if (error instanceof ApiError && error.status === 409) markConflict(); },
  });
  const mainBusy = saveMut.isPending || statusMut.isPending || revertMut.isPending || deleteMut.isPending;
  const busy = mainBusy || channelsBusy || scheduleBusy;
  const canSave = canEditData && !busy && !hasConflict && (isNew || !!object);
  const save = () => {
    if (canSave) saveMut.mutate({ submitted: dataRef.current, revision: object?.revision });
  };
  const resolveConflict = async (keepInputs: boolean) => {
    if (!serverSnapshot || !serverChannels || !serverSchedule) return;
    await qc.cancelQueries({ queryKey: channelsKey });
    qc.setQueryData(channelsKey, serverChannels);
    await qc.cancelQueries({ queryKey: ["schedule", org, typeKey, id] });
    qc.setQueryData(["schedule", org, typeKey, id], serverSchedule);
    setReviewedSchedule(serverSchedule);
    remember(serverSnapshot);
    if (!keepInputs) replaceInputs(serverSnapshot.data);
    setDirty(keepInputs);
    setConflict(false);
    setServerSnapshot(null);
    setSaveError(null);
    saveMut.reset();
    statusMut.reset();
    revertMut.reset();
    deleteMut.reset();
    compareMut.reset();
    toast(keepInputs ? "Eigene Eingaben erhalten. Bitte prüfen und speichern." : "Serverstand übernommen.");
  };

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty || channelsDirty) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, channelsDirty]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  return (
    <>
      <div className="topbar">
        <h1>{isNew ? "Neu" : canWrite ? "Bearbeiten" : "Ansehen"}: {type?.name ?? typeKey}</h1>
        {object && <StatusBadge status={object.status} />}
      </div>
      <p>
        <Link to={`/content/${typeKey}`} className="editor-back"><UiIcon name="back" size={20} />Zurück zur Liste</Link>
        {object && <span className="muted" style={{ marginLeft: "0.8rem", fontSize: "0.85rem" }}>
          Stand {object.revision} · aktualisiert {timeAgo(object.updated_at)}
        </span>}
      </p>
      {!isNew && !object && (objectQuery.error
        ? <p className="error" role="alert">{errorMessage(objectQuery.error)}</p>
        : <p role="status">Inhalt wird geladen…</p>)}

      {managedMenu && <p className="hint" role="status">Dieses Menü stammt aus einem bestätigten Import. Inhalte ändern Sie im <Link to={`/hub/integrations/flintplate/${managedMenu.id}`}>FlintPlate-Menüimport</Link>. Website-Zuordnung und ausdrückliche Veröffentlichung bleiben hier möglich; lokale Ausnahmen sind gesperrt.</p>}
      {menuScopePending && <p className="hint" role="status">Menüquelle wird geprüft. Inhaltsänderungen bleiben bis zur erfolgreichen Prüfung gesperrt.{menuSources.isError && <button onClick={() => void menuSources.refetch()}>Quelle erneut prüfen</button>}</p>}
      {!canWrite && <p className="hint" role="status">Du hast Lesezugriff. Inhalte, lokale Ausnahmen und veröffentlichte Stände kannst du ansehen. Änderungen übernimmt deine Redaktion.</p>}
      {object && <PublicationPanel org={org} object={object} fields={fields} />}
      <div className="panel">
        <h2>Entwurf</h2>
        <p className="hint">Speichern ändert den Entwurf. Erst Veröffentlichen übernimmt ihn samt gespeicherten Channels und Overrides in die öffentliche Ausgabe.</p>
        <fieldset className="editor-fields" disabled={!canEditData || (!isNew && !object) || (isNew && saveMut.isPending) || statusMut.isPending || revertMut.isPending || deleteMut.isPending}>
          <SchemaForm fields={fields} value={data} onChange={onDataChange} idPrefix="main" org={org} />
        </fieldset>
        {saveError && <p className="error" role="alert">{saveError}</p>}
        {statusError && <p className="error" role="alert">{statusError}</p>}
        {revertError && <p className="error" role="alert">{revertError}</p>}
        {deleteMut.error && !(deleteMut.error instanceof ApiError && deleteMut.error.status === 409) && <p className="error" role="alert">{errorMessage(deleteMut.error)}</p>}
        {hasConflict && <section className="content-conflict" aria-label="Bearbeitungskonflikt">
          <p className="error" role="alert">Dieser Inhalt wurde zwischenzeitlich geändert. Deine Eingaben bleiben erhalten.</p>
          <button onClick={() => compareMut.mutate()} disabled={compareMut.isPending || busy}>
            {compareMut.isPending ? "Serverstand wird geladen…" : "Serverstand vergleichen"}
          </button>
          {compareMut.error && <p className="error" role="alert">{errorMessage(compareMut.error)}</p>}
          {serverSnapshot && serverChannels && serverSchedule && <>
            <div className="conflict-comparison">
              <ConflictValues title="Meine Eingaben" data={data} fields={fields} />
              <ConflictValues title={`Serverstand ${serverSnapshot.revision}`} data={serverSnapshot.data} fields={fields} />
            </div>
            <section aria-label="Geprüfte Server-Channels">
              <h3>Geprüfte Server-Channels</h3>
              <ChannelValues org={org} assignments={serverChannels.assignments} />
            </section>
            <section aria-label="Geprüfte Server-Planung">
              <h3>Geprüfte Server-Planung</h3>
              <p>Veröffentlichung: {serverSchedule.publish_at ? new Date(serverSchedule.publish_at).toLocaleString("de-DE") : "Kein Termin"}</p>
              <p>Rücknahme: {serverSchedule.unpublish_at ? new Date(serverSchedule.unpublish_at).toLocaleString("de-DE") : "Kein Termin"}</p>
              <p className="hint">Eigene ungespeicherte Termine bleiben erhalten. Prüfe und speichere sie nach dem Vergleich ausdrücklich.</p>
            </section>
            {channelsDirty && <p className="hint">Deine ungespeicherten Channel-Eingaben bleiben separat erhalten. Prüfe und speichere sie vor einer Veröffentlichung.</p>}
            <p className="hint">Wenn du deine Eingaben behältst, ersetzen sie beim nächsten Speichern den verglichenen Serverstand. Weitere Änderungen werden erneut auf Konflikte geprüft.</p>
            <div className="actions">
              <button onClick={() => resolveConflict(true)} disabled={compareMut.isPending}>Meine Eingaben behalten</button>
              <button onClick={() => {
                if (!dirty || confirm("Eigene Inhaltsfelder verwerfen und den verglichenen Serverstand übernehmen?")) resolveConflict(false);
              }} disabled={compareMut.isPending}>Serverstand übernehmen</button>
            </div>
          </>}
        </section>}
        {object && (dirty || channelsDirty) && <p className="hint" role="status" id="publish-save-hint">
          Änderungen bitte vor dem Veröffentlichen speichern. Das gilt auch für Channel-Zuweisungen.
        </p>}
        {object && !channelsReady && !hasConflict && <p className="hint">Channel-Stand wird abgeglichen. Freigabe und Planung sind bis dahin gesperrt.</p>}
        {canWrite && <div className={hasConflict ? "actions editor-actions" : "actions sticky editor-actions"}>
          <button className="primary" onClick={save} disabled={!canSave}>
            {saveMut.isPending ? "Speichern…" : "Speichern"}
          </button>
          {dirty && <span className="muted" style={{ alignSelf: "center" }}>● nicht gespeichert</span>}
          {object && <a className="editor-impact-link" href="#website-impact"><UiIcon name="arrow" />Website-Auswirkungen prüfen</a>}
          {object && <button
            onClick={() => statusMut.mutate({ action: "publish", revision: object.revision })}
            disabled={dirty || channelsDirty || busy || hasConflict || !channelsReady || (object.status === "published" && !object.has_unpublished_changes)}
            aria-describedby={dirty || channelsDirty ? "publish-save-hint" : undefined}
          >{object.status === "published" ? "Änderungen veröffentlichen" : "Veröffentlichen"}</button>}
          {object?.status === "published" && <button
            onClick={() => statusMut.mutate({ action: "unpublish", revision: object.revision })}
            disabled={busy || hasConflict}
          >Zurückziehen</button>}
          {object && canEditData && <button className="danger" disabled={busy || hasConflict} onClick={() => {
            if (confirm("Diesen Eintrag wirklich löschen?")) deleteMut.mutate(object.revision);
          }}>Löschen</button>}
        </div>}
      </div>

      {!isNew && id && <ChannelsPanel org={org} typeKey={typeKey} id={id} fields={fields} data={data} allowOverrides={!managedMenu && !menuScopePending}
        revision={object?.revision} disabled={!canWrite || !object || !channelsReady || mainBusy || scheduleBusy || hasConflict}
        onDirty={setChannelsDirty} onBusy={setChannelsBusy} onRevision={setChannelsRevision} onConflict={markConflict}
        onSaved={(next, sourceRevision) => {
          // Only adopt the successor of the displayed, reviewed revision.
          if (next.revision === sourceRevision + 1) remember(next);
          else markConflict();
        }} />}
      {object && <ReleaseImpactPanel org={org} typeKey={typeKey} object={object} fields={fields}
        dirty={dirty} channelsDirty={channelsDirty} busy={busy} conflict={hasConflict}
        contentFetching={objectQuery.isFetching} contentFailed={objectQuery.isError} />}
      {!isNew && id && <SchedulePanel org={org} typeKey={typeKey} id={id}
        revision={object?.revision} disabled={!canWrite || !object || !channelsReady || dirty || channelsDirty || mainBusy || channelsBusy || hasConflict}
        onBusy={setScheduleBusy} onConflict={markConflict} reviewedSchedule={reviewedSchedule} />}
      {canWrite && !isNew && id && <PreviewPanel org={org} typeKey={typeKey} />}
      {!isNew && id && <VersionsPanel org={org} typeKey={typeKey} id={id}
        onRevert={versionId => revertMut.mutate(versionId)} disabled={!canEditData || !object || dirty || busy || hasConflict} />}
      {canWrite && isNew && <p className="hint">Channels, Planung, Vorschau &amp; Versionen erscheinen nach dem ersten Speichern.</p>}
    </>
  );
}

function PublicationPanel({ org, object, fields }: { org: string; object: ContentObject; fields: FieldDef[] }) {
  const { data: websites } = useQuery({
    queryKey: ["websites", org],
    queryFn: () => api.get<Website[]>(`/api/orgs/${org}/websites`),
  });
  const publication = object.publication;
  return <section className="panel publication-summary" aria-label="Freigegebener Stand">
    <h2>{publication ? "Freigegebener Stand" : "Noch nicht veröffentlicht"}</h2>
    <p>{publication
      ? object.has_unpublished_changes
        ? "Änderungen im Entwurf. Öffentlich bleibt der zuletzt freigegebene Stand."
        : "Der gespeicherte Entwurf ist veröffentlicht."
      : "Dieser Inhalt ist nicht öffentlich. Der gespeicherte Entwurf bleibt bearbeitbar."}</p>
    {publication && <>
      <p className="hint">Stand {publication.revision} · veröffentlicht am {new Date(publication.published_at).toLocaleString("de-DE")} · {publication.assignments.length} {publication.assignments.length === 1 ? "Channel" : "Channels"}</p>
      <details>
        <summary>Freigegebenen Inhalt ansehen</summary>
        <div className="conflict-comparison">
          <ConflictValues title="Basisinhalt" data={publication.data} fields={fields} />
          <div><h3>Freigegebene Channels</h3>
            {publication.assignments.length === 0 && <p>Keinem Channel zugewiesen.</p>}
            {publication.assignments.map(assignment => <div key={assignment.website_id}>
              <h4>{websites?.find(website => website.id === assignment.website_id)?.name ?? assignment.website_id}</h4>
              {assignment.overrides && Object.keys(assignment.overrides).length > 0
                ? <ConflictValues title="Lokale Overrides" data={assignment.overrides} fields={[]} />
                : <p className="hint">Verwendet den Basisinhalt.</p>}
            </div>)}
          </div>
        </div>
      </details>
    </>}
  </section>;
}

function ChannelValues({ org, assignments }: { org: string; assignments: ChannelAssignment[] }) {
  const { data: websites } = useQuery({
    queryKey: ["websites", org],
    queryFn: () => api.get<Website[]>(`/api/orgs/${org}/websites`),
  });
  if (assignments.length === 0) return <p className="hint">Keine Channels zugewiesen.</p>;
  return <ul>{assignments.map(assignment => <li key={assignment.website_id}>
    <strong>{websites?.find(website => website.id === assignment.website_id)?.name ?? assignment.website_id}</strong>
    {assignment.overrides && Object.keys(assignment.overrides).length > 0
      ? <ConflictValues title="Overrides" data={assignment.overrides} fields={[]} />
      : <p className="hint">Verwendet den Basisinhalt.</p>}
  </li>)}</ul>;
}

function ConflictValues({ title, data, fields }: { title: string; data: Data; fields: FieldDef[] }) {
  const keys = [...new Set([...fields.map(field => field.key), ...Object.keys(data)])];
  return <div>
    <h3>{title}</h3>
    <dl>{keys.map(key => <div key={key}>
      <dt>{fields.find(field => field.key === key)?.label || key}</dt>
      <dd>{data[key] == null || data[key] === "" ? "—" : typeof data[key] === "object" ? JSON.stringify(data[key], null, 2) : String(data[key])}</dd>
    </div>)}</dl>
  </div>;
}

// --- Channel assignment (with per-channel overrides, Whitepaper §6) ---------

function ChannelsPanel({ org, typeKey, id, fields, data, revision, disabled, allowOverrides = true, onDirty, onBusy, onRevision, onSaved, onConflict }: {
  org: string; typeKey: string; id: string; fields: FieldDef[]; data: Data;
  revision?: number; disabled: boolean; allowOverrides?: boolean;
  onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void;
  onRevision: (revision: number) => void;
  onConflict: () => void;
  onSaved: (object: ContentObject, sourceRevision: number) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: websites } = useQuery({
    queryKey: ["websites", org],
    queryFn: () => api.get<Website[]>(`/api/orgs/${org}/websites`),
  });
  const key = ["channels", org, typeKey, id];
  const current = useQuery({
    queryKey: key,
    queryFn: () => api.get<ChannelDraft>(`/api/orgs/${org}/content/${typeKey}/${id}/channels`),
  });
  const [state, setState] = useState<Record<string, ChannelState>>({});
  const [dirty, setDirty] = useState(false);
  const saveMut = useMutation({
    mutationFn: async () => {
      const assignments: ChannelAssignment[] = (websites ?? [])
        .filter(w => state[w.id]?.selected)
        .map(w => {
          const overrides = allowOverrides ? state[w.id].overrides : {};
          return { website_id: w.id, overrides: Object.values(overrides).some(v => v !== "" && v != null) ? overrides : null };
        });
      if (revision == null || current.data?.revision !== revision) {
        throw new ApiError(409, "Der Channel-Stand muss zuerst verglichen werden.");
      }
      const sourceRevision = revision;
      const response = await api.put<{ assignments: ChannelAssignment[]; content: ContentObject }>(
        `/api/orgs/${org}/content/${typeKey}/${id}/channels`, { assignments, expected_revision: sourceRevision });
      return { ...response, sourceRevision };
    },
    onSuccess: async response => {
      await qc.cancelQueries({ queryKey: key });
      setDirty(false);
      onDirty(false);
      qc.setQueryData(key, { assignments: response.assignments, revision: response.content.revision });
      onSaved(response.content, response.sourceRevision);
      toast("Channel-Entwurf gespeichert. Veröffentlichung steht noch aus.");
    },
    onError: error => { if (error instanceof ApiError && error.status === 409) onConflict(); },
  });
  useEffect(() => { onBusy(saveMut.isPending); }, [saveMut.isPending, onBusy]);
  useEffect(() => {
    if (current.data) onRevision(current.data.revision);
    if (current.data && revision != null && current.data.revision < revision && !current.isFetching && !current.isError) {
      void qc.invalidateQueries({ queryKey: ["channels", org, typeKey, id] });
    }
  }, [current.data, current.isFetching, current.isError, revision, onRevision, qc, org, typeKey, id]);
  useEffect(() => {
    if (!websites || !current.data || dirty || saveMut.isPending) return;
    const next: Record<string, ChannelState> = {};
    for (const website of websites) {
      const assigned = current.data.assignments.find(a => a.website_id === website.id);
      next[website.id] = { selected: !!assigned, overrides: assigned?.overrides ?? {} };
    }
    setState(next);
  }, [websites, current.data, dirty, saveMut.isPending]);
  const change = (wid: string, next: ChannelState) => {
    setState(previous => ({ ...previous, [wid]: next }));
    setDirty(true);
    onDirty(true);
  };
  return <section className="panel" aria-label="Channel-Entwurf">
    <h2>Channels</h2>
    {!allowOverrides && <p className="hint">Importierte Menüs verwenden auf jeder Website die geprüften Quelldaten. Lokale Ausnahmen sind gesperrt.</p>}
    <p className="hint">Zuweisungen und lokale Overrides gehören zum Entwurf. Nach dem Speichern werden sie erst mit der nächsten Veröffentlichung öffentlich. Das gilt auch für das Entfernen eines Channels.</p>
    <fieldset className="editor-fields" disabled={disabled || saveMut.isPending || !current.data}>
      {websites?.map(website => {
        const cs = state[website.id];
        if (!cs) return null;
        return <div key={website.id} className="channel-draft">
          <label className="row" style={{ fontWeight: 600 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={cs.selected}
              onChange={() => change(website.id, { ...cs, selected: !cs.selected })} />
            {website.name} <span className="muted code">{website.slug}</span>
          </label>
          {cs.selected && allowOverrides && <details style={{ marginTop: "0.5rem" }}>
            <summary className="muted">Lokale Overrides (optional)</summary>
            <div style={{ marginTop: "0.6rem" }}><SchemaForm fields={fields} value={cs.overrides}
              onChange={overrides => change(website.id, { ...cs, overrides })}
              idPrefix={`ov-${website.id}`} org={org}
              placeholderHint={field => data[field.key] == null ? undefined : `Standard: ${String(data[field.key])}`} /></div>
          </details>}
        </div>;
      })}
      <div className="actions">
        <button className="primary" onClick={() => saveMut.mutate()} disabled={!dirty}>
          {saveMut.isPending ? "Speichern…" : "Channel-Zuweisung speichern"}
        </button>
        {dirty && <span className="hint">Channel-Änderungen nicht gespeichert</span>}
      </div>
    </fieldset>
    {current.error && <button onClick={() => current.refetch()} disabled={current.isFetching}>Channels erneut laden</button>}
    {(current.error || saveMut.error) && <p className="error" role="alert">{(current.error || saveMut.error) instanceof ApiError
      ? ((current.error || saveMut.error) as ApiError).message : "Channels konnten nicht geladen oder gespeichert werden."}</p>}
  </section>;
}

// --- Version history + revert (WP1.5) --------------------------------------

function VersionsPanel({
  org,
  typeKey,
  id,
  onRevert,
  disabled,
}: {
  org: string;
  typeKey: string;
  id: string;
  onRevert: (versionId: string) => void;
  disabled: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["versions", org, id],
    queryFn: () =>
      api.get<{ versions: ContentVersion[] }>(
        `/api/orgs/${org}/content/${typeKey}/${id}/versions`,
      ),
  });

  const versions = data?.versions ?? [];

  return (
    <div className="panel">
      <h2>Versionen</h2>
      {versions.length === 0 && <p className="muted">Noch keine Versionen.</p>}
      {versions.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Zeitpunkt</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v, i) => (
              <tr key={v.id}>
                <td>
                  {new Date(v.created_at).toLocaleString("de-DE")}
                  {i === 0 && <span className="muted"> (aktuell)</span>}
                </td>
                <td>
                  {i !== 0 && (
                    <button onClick={() => onRevert(v.id)} disabled={disabled}>
                      Wiederherstellen
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Scheduling (v2) -------------------------------------------------------

function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function SchedulePanel({ org, typeKey, id, revision, disabled, onBusy, onConflict, reviewedSchedule }: {
  org: string; typeKey: string; id: string; revision?: number; disabled: boolean;
  onBusy: (busy: boolean) => void; onConflict: () => void;
  reviewedSchedule: Schedule | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["schedule", org, typeKey, id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<Schedule>(`/api/orgs/${org}/content/${typeKey}/${id}/schedule`),
    refetchInterval: 10_000,
  });
  const [pub, setPub] = useState("");
  const [unp, setUnp] = useState("");
  const [dirty, setDirty] = useState(false);
  const [scheduleRevision, setScheduleRevision] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: () => api.put<Schedule>(`/api/orgs/${org}/content/${typeKey}/${id}/schedule`, {
      publish_at: fromLocalInput(pub), unpublish_at: fromLocalInput(unp), expected_revision: revision,
      expected_schedule_revision: scheduleRevision,
    }),
    onSuccess: async result => {
      await qc.cancelQueries({ queryKey: key });
      setDirty(false);
      setScheduleRevision(result.schedule_revision);
      qc.setQueryData(key, result);
      toast("Planung für den geprüften Entwurf gespeichert ✓");
    },
    onError: error => { if (error instanceof ApiError && error.status === 409) onConflict(); },
  });
  useEffect(() => { onBusy(save.isPending); }, [save.isPending, onBusy]);
  useEffect(() => {
    if (query.data && !dirty && !save.isPending) {
      setScheduleRevision(query.data.schedule_revision);
      setPub(toLocalInput(query.data.publish_at));
      setUnp(toLocalInput(query.data.unpublish_at));
    }
  }, [query.data, dirty, save.isPending]);
  // Only an explicit comparison may rebase unsaved deadlines. Polling can
  // refresh the query but cannot replace the revision owned by this form.
  useEffect(() => {
    if (reviewedSchedule) {
      setScheduleRevision(reviewedSchedule.schedule_revision);
      save.reset();
    }
  }, [reviewedSchedule]);
  const conflict = query.data?.publish_conflict || (query.data?.publish_revision != null && query.data.publish_revision !== revision);
  return <section className="panel" aria-label="Veröffentlichung planen">
    <h2>Planung</h2>
    <p className="hint">Eine geplante Veröffentlichung gilt für den gespeicherten Entwurf samt Channels. Spätere Änderungen stoppen die Freigabe, bis du den neuen Stand prüfst und neu planst. Eine Rücknahme gilt auch bei weiteren Entwurfsänderungen.</p>
    <p className="hint">Zeiten gelten in deiner lokalen Zeitzone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Leere Felder löschen die Planung. Manuelles Veröffentlichen oder Zurückziehen löscht beide Termine.</p>
    {conflict && <p className="error" role="alert">Die geplante Veröffentlichung ist durch neuere Änderungen blockiert. Prüfe den Entwurf und speichere die Planung erneut.</p>}
    {query.data?.publish_revision != null && !conflict && <p className="hint">Geplante Freigabe von Stand {query.data.publish_revision}.</p>}
    <fieldset className="editor-fields" disabled={disabled || save.isPending || !query.data || scheduleRevision == null}>
      <div className="field"><label htmlFor="sched-pub">Veröffentlichen am</label>
        <input id="sched-pub" type="datetime-local" value={pub} onChange={event => { setPub(event.target.value); setDirty(true); }} /></div>
      <div className="field"><label htmlFor="sched-unp">Zurückziehen am</label>
        <input id="sched-unp" type="datetime-local" value={unp} onChange={event => { setUnp(event.target.value); setDirty(true); }} /></div>
      <div className="actions"><button className="primary" onClick={() => save.mutate()}>
        {save.isPending ? "Speichern…" : "Planung speichern"}
      </button>{dirty && <span className="hint">Planung nicht gespeichert</span>}</div>
    </fieldset>
    {(query.error || save.error) && <p className="error" role="alert">{(query.error || save.error) instanceof ApiError
      ? ((query.error || save.error) as ApiError).message : "Planung konnte nicht geladen oder gespeichert werden."}</p>}
  </section>;
}

// --- Preview link (v2) -----------------------------------------------------

function PreviewPanel({ org, typeKey }: { org: string; typeKey: string }) {
  const { data: websites } = useQuery({
    queryKey: ["websites", org],
    queryFn: () => api.get<Website[]>(`/api/orgs/${org}/websites`),
  });
  const [slug, setSlug] = useState("");
  const [link, setLink] = useState("");
  useEffect(() => {
    if (websites && websites.length && !slug) setSlug(websites[0].slug);
  }, [websites, slug]);

  const gen = useMutation({
    mutationFn: () => api.post<{ token: string }>(`/api/orgs/${org}/preview-tokens`),
    onSuccess: (r) => setLink(assetUrl(`/preview/${slug}/content/${typeKey}?token=${r.token}`)),
  });

  return (
    <div className="panel">
      <h2>Vorschau</h2>
      <p className="hint">
        Erzeuge einen zeitlich begrenzten Vorschau-Link, der auch Entwürfe ausliefert.
      </p>
      <div className="row" style={{ gap: "0.6rem" }}>
        <select value={slug} onChange={(e) => setSlug(e.target.value)} style={{ width: "auto" }}>
          {websites?.map((w) => (
            <option key={w.id} value={w.slug}>
              {w.name}
            </option>
          ))}
        </select>
        <button onClick={() => gen.mutate()} disabled={!slug || gen.isPending}>
          Vorschau-Link erzeugen
        </button>
      </div>
      {link && (
        <div className="row" style={{ gap: "0.6rem", marginTop: "0.6rem" }}>
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={link} />
        </div>
      )}
    </div>
  );
}
