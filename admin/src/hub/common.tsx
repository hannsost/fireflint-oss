import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";

export interface Field { key: string; label: string; kind: string; required: boolean; options: string[] }
export interface Kind { builtin?: boolean; revision?: number; key: string; name: string; module: string; fields: Field[] }
export interface HubModule { key: string; name: string; description: string; version: string; dependencies: string[]; required: boolean; enabled: boolean; revision: number }
export interface Contracts { version: number; kinds: Kind[]; modules: HubModule[] }
export interface HubLink { id: string; from_id: string; to_id: string; relation: string; from_name: string; to_name: string; from_revision: number }
export interface HubRecord { id: string; org_id: string; kind: string; name: string; data: Record<string, unknown>; revision: number; archived: boolean; source_id: string | null; external_id: string | null; updated_by: string; created_by: string; created_at: string; updated_at: string; links?: HubLink[]; links_total?: number }
export interface RecordPage { items: HubRecord[]; total: number; offset: number; limit: number }

export async function fetchHubContracts(org: string): Promise<Contracts> {
  const [contracts, kinds] = await Promise.all([api.get<Contracts>("/api/hub/contracts"), api.get<Kind[]>(`/api/orgs/${org}/hub/kinds`)]);
  return { ...contracts, kinds };
}
export function useHub() {
  const org = useOrg();
  const { user, memberships } = useAuth();
  const client = useQueryClient();
  const role = memberships.find(m => m.org_id === org)?.role;
  const base = `/api/orgs/${org}/hub`;
  const modules = useQuery({ queryKey: ["hub", org, "modules"], queryFn: () => api.get<HubModule[]>(`${base}/modules`) });
  const contracts = useQuery({ queryKey: ["hub", org, "contracts"], queryFn: () => fetchHubContracts(org) });
  return { org, base, user, role, canWrite: role === "owner" || role === "editor", isOwner: role === "owner", modules, contracts,
    invalidate: () => client.invalidateQueries({ queryKey: ["hub", org] }) };
}
export function useHubQuery<T>(key: string, path: string, enabled = true) {
  const org = useOrg();
  return useQuery({ queryKey: ["hub", org, key, path], queryFn: () => api.get<T>(path.startsWith("/api/") ? path : `/api/orgs/${org}/hub${path}`), enabled });
}

// Only in-memory, scoped to the authenticated identity and organisation. No private
// draft is written into shared browser storage. An acknowledged save or explicit
// reload is the only way to replace an editor's captured server revision.
interface DraftEntry<T> { value: T; dirty: boolean }
const drafts = new Map<string, DraftEntry<unknown>>();
let draftIdentity: string | null = null;
export function useHubSession(identity: string | null, loading: boolean) {
  useEffect(() => {
    if (!loading && identity !== draftIdentity) { drafts.clear(); draftIdentity = identity; }
  }, [identity, loading]);
}
export function useDraft<T>(key: string, initial: T) {
  const { user, activeOrg } = useAuth();
  const scope = JSON.stringify([user?.id, activeOrg, key]);
  const [entry, setEntry] = useState<DraftEntry<T>>(() => (drafts.get(scope) as DraftEntry<T> | undefined) ?? { value: initial, dirty: false });
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const latest = useRef(entry);
  latest.current = entry;
  const set = (next: T | ((old: T) => T)) => {
    if (!active.current) return;
    const value = typeof next === "function" ? (next as (old: T) => T)(latest.current.value) : next;
    const updated = { value, dirty: true };
    latest.current = updated; drafts.set(scope, updated); setEntry(updated);
  };
  const reset = (value: T) => { if (!active.current) return; const updated = { value, dirty: false }; latest.current = updated; drafts.delete(scope); setEntry(updated); };
  const clear = () => { if (active.current) drafts.delete(scope); };
  return { value: entry.value, set, dirty: entry.dirty, reset, clear };
}
export function useAction() {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return { error, busy, isActive: () => active.current, clear: () => setError(null), run: async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true; setBusy(true); setError(null);
    try { const result = await fn(); return active.current ? result : undefined; } catch (cause) { if (active.current) setError(cause); return undefined; }
    finally { inFlight.current = false; setBusy(false); }
  } };
}
export function ErrorNotice({ error, onReload }: { error: unknown; onReload?: () => void }) {
  if (!error) return null;
  const conflict = error instanceof ApiError && error.status === 409;
  return <div className="hub-error" role="alert"><strong>{conflict ? "Der Stand wurde inzwischen geändert." : "Das hat nicht geklappt."}</strong><p>{conflict ? "Deine Eingaben bleiben erhalten. Prüfe den aktuellen Stand und lade ihn ausdrücklich neu, bevor du erneut speicherst." : error instanceof Error ? error.message : "Bitte versuche es erneut."}</p>{onReload && <button type="button" onClick={onReload}>Aktuellen Stand laden</button>}</div>;
}
export function PageTitle({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <header className="hub-title"><div><p className="eyebrow">UNTERNEHMENSHUB</p><h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>{children && <div className="hub-actions">{children}</div>}</header>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="hub-empty">{children}</div>; }
export function Pager({ offset, count, total, onChange, pageSize = 100 }: { offset: number; count: number; total?: number; onChange: (offset: number) => void; pageSize?: number }) {
  return <nav className="hub-pager" aria-label="Ergebnisseiten"><button type="button" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - pageSize))}>Zurück</button><span>{count ? `${offset + 1}–${offset + count}` : "0 Ergebnisse"}{total !== undefined ? ` von ${total}` : ""}</span><button type="button" disabled={total !== undefined ? offset + count >= total : count < pageSize} onClick={() => onChange(offset + pageSize)}>Weiter</button></nav>;
}
export function Fields({ fields, data, onChange, disabled = false, prefix = "field" }: { fields: Field[]; data: Record<string, unknown>; onChange: (data: Record<string, unknown>) => void; disabled?: boolean; prefix?: string }) {
  const instance = useId();
  return <div className="hub-fields">{fields.map(field => {
    const id = `${prefix}-${instance}-${field.key}`;
    const value = data[field.key];
    const change = (next: unknown) => onChange({ ...data, [field.key]: next });
    return <div className={`hub-field${field.kind === "multiline" ? " hub-wide" : ""}`} key={field.key}>
      <label htmlFor={id}>{field.label}{field.required && <span className="req"> *</span>}</label>
      {field.kind === "boolean" ? <select id={id} disabled={disabled} required={field.required} value={value === true ? "true" : value === false ? "false" : ""} onChange={e => change(e.target.value === "" ? null : e.target.value === "true")}><option value="">Bitte wählen</option><option value="true">Ja</option><option value="false">Nein</option></select>
        : field.kind === "select" ? <select id={id} disabled={disabled} required={field.required} value={String(value ?? "")} onChange={e => change(e.target.value)}><option value="">Bitte wählen</option>{field.options.map((option, i) => <option key={i} value={option}>{option}</option>)}</select>
        : field.kind === "multiline" ? <textarea id={id} disabled={disabled} required={field.required} maxLength={16384} value={String(value ?? "")} onChange={e => change(e.target.value)} />
        : <input id={id} disabled={disabled} required={field.required} type={["email", "url", "number", "date"].includes(field.kind) ? field.kind : "text"} step={field.kind === "number" ? "any" : undefined} maxLength={field.kind === "url" ? 2048 : 1024} value={String(value ?? "")} onChange={e => change(field.kind === "number" ? e.target.value === "" ? null : Number(e.target.value) : e.target.value)} />}
    </div>;
  })}</div>;
}
export function ValueView({ fields, data }: { fields: Field[]; data: Record<string, unknown> }) {
  return <dl className="hub-values">{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{data[field.key] === true ? "Ja" : data[field.key] === false ? "Nein" : String(data[field.key] ?? "—") || "—"}</dd></div>)}</dl>;
}
export async function allRecords(base: string, kinds: Kind[], includeArchived = false) {
  const records: HubRecord[] = [];
  for (const kind of kinds) for (const archived of includeArchived ? [false, true] : [false]) {
    let offset = 0;
    while (true) {
      const page = await api.get<RecordPage>(`${base}/records?kind=${encodeURIComponent(kind.key)}&archived=${archived}&offset=${offset}`);
      records.push(...page.items);
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
      const next = offset + page.items.length;
      offset = next;
    }
  }
  return records;
}
export function RecordPicker({ value, onChange, label = "Datensatz", kind, disabled, exclude }: { value: string; onChange: (id: string) => void; label?: string; kind?: string; disabled?: boolean; exclude?: string }) {
  const { org, base, contracts, modules } = useHub();
  const kinds = contracts.data?.kinds.filter(k => (!kind || kind === k.key) && modules.data?.some(m => m.key === k.module && m.enabled));
  const records = useQuery({ queryKey: ["hub", org, "picker", kind ?? "all", kinds?.map(k => k.key)], queryFn: () => allRecords(base, kinds ?? []), enabled: !!kinds && !modules.isPending });
  return <div className="hub-field"><label>{label}<select value={value} onChange={e => onChange(e.target.value)} disabled={disabled || records.isPending}><option value="">Bitte wählen</option>{value && !records.data?.some(r => r.id === value) && <option value={value}>Gespeicherter Datensatz ({value})</option>}{records.data?.filter(r => r.id !== exclude).map(r => <option value={r.id} key={r.id}>{r.name} · {contracts.data?.kinds.find(k => k.key === r.kind)?.name}</option>)}</select></label>{records.isPending && <small role="status">Datensätze werden geladen…</small>}<ErrorNotice error={records.error} onReload={() => void records.refetch()} /></div>;
}
export function ModuleGate({ module, children }: { module: string; children: ReactNode }) {
  const { modules } = useHub();
  if (modules.isPending) return <p role="status">Module werden geladen…</p>;
  if (modules.error) return <ErrorNotice error={modules.error} onReload={() => void modules.refetch()} />;
  const entry = modules.data?.find(m => m.key === module);
  return entry?.enabled ? children : <section className="panel hub-empty"><h1>{entry?.name ?? "Modul"} ist nicht aktiviert</h1><p>Die vorhandenen Daten bleiben erhalten. Inhaber können das Modul für diesen Arbeitsbereich aktivieren.</p><Link to="/hub/modules" className="button">Module ansehen</Link></section>;
}
export function formatDate(value: string) { return new Date(value).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }); }
