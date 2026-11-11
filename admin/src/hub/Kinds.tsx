import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { Empty, ErrorNotice, Fields, PageTitle, useAction, useDraft, useHub, useHubQuery, type Field, type Kind } from "./common";

interface KindDefinition extends Kind { builtin: boolean; revision: number }
interface KindDraft { key: string; name: string; fields: Field[]; expected_revision: number; baselineFields: Field[] }
const fieldKinds = [
  ["text", "Kurzer Text"], ["multiline", "Langer Text"], ["email", "E-Mail"],
  ["url", "Webadresse"], ["number", "Zahl"], ["boolean", "Ja / Nein"], ["date", "Datum"], ["select", "Auswahl"],
];
const initialDraft: KindDraft = {
  key: "", name: "", fields: [{ key: "name", label: "Name", kind: "text", required: true, options: [] }],
  expected_revision: 0, baselineFields: [],
};
const draftOf = (definition: KindDefinition): KindDraft => ({
  key: definition.key, name: definition.name, fields: definition.fields,
  expected_revision: definition.revision, baselineFields: definition.fields,
});

export function KindsPage() {
  const { key } = useParams();
  const [search] = useSearchParams();
  const creating = key === "new" && search.get("create") === "1";
  const { org, isOwner, modules } = useHub();
  const query = useHubQuery<KindDefinition[]>("kind-definitions", "/kinds");
  if (!query.data) return <><PageTitle title="Datentypen" /><ErrorNotice error={query.error} onReload={() => void query.refetch()} />{query.isPending && <p role="status">Datentypen werden geladen …</p>}</>;
  const definition = key && !creating ? query.data.find(item => item.key === key) : undefined;
  if (key && !creating && !definition) return <Empty>Dieser Datentyp wurde nicht gefunden. <Link to="/hub/kinds">Alle Datentypen</Link></Empty>;
  if (key) return <>
    <ErrorNotice error={query.error} />
    <KindEditor key={`${org}:${creating ? "create" : `edit:${key}`}`} definition={definition} existingKeys={query.data.map(item => item.key)} />
  </>;
  const customCount = query.data.filter(item => !item.builtin).length;
  return <>
    <PageTitle title="Datentypen" description="Legen Sie fest, welche Informationen Ihr Unternehmen strukturiert erfasst.">
      {isOwner && customCount < 100 && <Link className="button primary" to="/hub/kinds/new?create=1">Datentyp anlegen</Link>}
    </PageTitle>
    <ErrorNotice error={query.error} onReload={() => void query.refetch()} />
    <p className="hint">{customCount} von 100 eigenen Datentypen. Vordefinierte Datentypen gehören zu ihren Modulen. Eigene Datentypen ergänzen die Stammdaten dieses Arbeitsbereichs und veröffentlichen keine Inhalte.</p>
    {!isOwner && <p className="hint">Die Definitionen sind für alle Mitglieder lesbar. Eigene Datentypen verwalten können nur Inhaber.</p>}
    <div className="hub-card-grid">{query.data.map(item => {
      const enabled = modules.data?.some(module => module.key === item.module && module.enabled);
      return <article className="panel hub-card" key={item.key}>
        <div className="hub-inline"><span className="badge">{item.builtin ? "Vordefiniert" : "Eigener Datentyp"}</span>{!item.builtin && <span className="muted">Revision {item.revision}</span>}</div>
        <h2><Link to={`/hub/kinds/${encodeURIComponent(item.key)}`}>{item.name}</Link></h2>
        <p className="hint">{item.fields.length} Felder · Kennung: {item.key}</p>
        <div className="hub-actions">
          <Link className="button" to={`/hub/kinds/${encodeURIComponent(item.key)}`}>{isOwner && !item.builtin ? "Definition bearbeiten" : "Definition ansehen"}</Link>
          {enabled ? <Link className="button" to={`/hub/records/${encodeURIComponent(item.key)}`}>Datensätze ansehen</Link> : <Link className="button" to="/hub/modules">Zugehöriges Modul ansehen</Link>}
        </div>
      </article>;
    })}</div>
  </>;
}

function KindEditor({ definition, existingKeys }: { definition?: KindDefinition; existingKeys: string[] }) {
  const { base, isOwner, invalidate } = useHub();
  const navigate = useNavigate();
  const draft = useDraft<KindDraft>(`kind:${definition ? `existing:${definition.key}` : "create"}`, definition ? draftOf(definition) : initialDraft);
  const action = useAction();
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(false);
  const [previewData, setPreviewData] = useState<Record<string, unknown>>({});
  const value = draft.value;
  const builtin = definition?.builtin ?? false;
  const locked = !isOwner || builtin || action.busy;
  const existing = value.expected_revision > 0;
  const patch = (change: Partial<KindDraft>) => { draft.set(old => ({ ...old, ...change })); setNotice(""); };
  const patchField = (index: number, change: Partial<Field>) => patch({ fields: value.fields.map((field, i) => i === index ? { ...field, ...change } : field) });

  async function save() {
    if (locked) return;
    await action.run(async () => {
      if (!definition && existingKeys.includes(value.key)) throw new Error("Diese Typkennung ist bereits vergeben. Bitte eine andere Kennung wählen.");
      if (new Set(value.fields.map(field => field.key)).size !== value.fields.length) throw new Error("Jedes Feld benötigt eine eigene, eindeutige Kennung.");
      for (const field of value.fields) {
        if (field.kind === "select" && new Set(field.options).size !== field.options.length) throw new Error(`Die Auswahloptionen für „${field.label}“ müssen eindeutig sein.`);
      }
      const rows = await api.put<KindDefinition[]>(`${base}/kinds`, { key: value.key, name: value.name, fields: value.fields, expected_revision: value.expected_revision });
      if (!action.isActive()) return;
      const saved = rows.find(item => item.key === value.key);
      if (!saved) throw new Error("Die gespeicherte Definition fehlt in der Antwort. Bitte den gespeicherten Stand ausdrücklich neu laden.");
      draft.reset(draftOf(saved));
      setNotice(`Datentyp mit Revision ${saved.revision} gespeichert.`);
      await invalidate();
      if (!definition && action.isActive()) { draft.clear(); navigate(`/hub/kinds/${encodeURIComponent(saved.key)}`, { replace: true }); }
    });
  }
  async function reload() {
    if (!definition) return;
    await action.run(async () => {
      const rows = await api.get<KindDefinition[]>(`${base}/kinds`);
      const current = rows.find(item => item.key === definition.key);
      if (!current) throw new Error("Der Datentyp wurde nicht gefunden.");
      draft.reset(draftOf(current));
      setNotice("Der aktuelle gespeicherte Stand wurde geladen.");
      await invalidate();
    });
  }
  function addField() {
    let number = value.fields.length + 1;
    while (value.fields.some(field => field.key === `feld_${number}`)) number++;
    patch({ fields: [...value.fields, { key: `feld_${number}`, label: "", kind: "text", required: false, options: [] }] });
  }

  return <>
    <PageTitle title={definition ? definition.name : "Datentyp anlegen"} description="Felder verständlich benennen und ihre Eingabe festlegen.">
      <Link className="button" to="/hub/kinds">Alle Datentypen</Link>
      {definition && <Link className="button" to={`/hub/records/${encodeURIComponent(definition.key)}`}>Datensätze ansehen</Link>}
    </PageTitle>
    {builtin && <p className="hint">Dieser Datentyp ist vordefiniert. Seine Definition ist hier nur lesbar.</p>}
    {!isOwner && <p className="hint">Eigene Datentypen konfigurieren können nur Inhaber.</p>}
    {definition && !builtin && <p className="hint">Geladene Revision {value.expected_revision}{draft.dirty ? " · Ungespeicherte Änderungen bleiben beim Seitenwechsel erhalten." : ""}</p>}
    {definition && definition.revision !== value.expected_revision && <p className="hub-warning" role="status">Es liegt eine andere gespeicherte Revision vor. Ihre Eingaben und die geladene Revision bleiben erhalten, bis Sie den Stand ausdrücklich neu laden.</p>}
    <ErrorNotice error={action.error} />
    {notice && <p className="hub-success" role="status">{notice}</p>}
    <form className="hub-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <section className="panel hub-stack" aria-labelledby="kind-description-title">
        <h2 id="kind-description-title">Bezeichnung und Kennung</h2>
        <div className="hub-form-grid">
          <label>Name des Datentyps<input required maxLength={160} value={value.name} disabled={locked} placeholder="Zum Beispiel: Zertifikate" onChange={event => patch({ name: event.target.value })} /></label>
          <label>Typkennung<input required maxLength={64} pattern="[a-z][a-z0-9_]*" title="Kleinbuchstaben, Ziffern und Unterstriche; beginnt mit einem Kleinbuchstaben" value={value.key} disabled={locked || !!definition} placeholder="zertifikat" onChange={event => patch({ key: event.target.value })} /></label>
        </div>
        <p className="hint">Die Kennung ist die dauerhafte Zuordnung für Datensätze und Importe. Sie kann nach dem Anlegen nicht geändert werden.</p>
      </section>
      <section className="panel hub-stack" aria-labelledby="kind-fields-title">
        <div className="hub-section-heading"><h2 id="kind-fields-title">Felder</h2><span className="muted">{value.fields.length} / 40</span></div>
        {existing && <p className="hint">Bestehende Feldkennungen und Feldtypen bleiben erhalten. Neue Felder sind optional, damit vorhandene Datensätze gültig bleiben. Bezeichnungen können Sie ändern und Auswahloptionen ergänzen.</p>}
        {value.fields.map((field, index) => {
          const baseline = value.baselineFields[index];
          const requiredLocked = existing && (!baseline || !baseline.required);
          return <fieldset className="hub-field-builder" key={index} disabled={locked}>
            <legend>Feld {index + 1}{field.label ? `: ${field.label}` : ""}{baseline ? " · gespeichert" : ""}</legend>
            <div className="hub-form-grid">
              <label>Feldbezeichnung<input required maxLength={160} value={field.label} onChange={event => patchField(index, { label: event.target.value })} /></label>
              <label>Feldkennung<input required maxLength={64} pattern="[a-z][a-z0-9_]*" title="Kleinbuchstaben, Ziffern und Unterstriche; beginnt mit einem Kleinbuchstaben" disabled={!!baseline} value={field.key} onChange={event => patchField(index, { key: event.target.value })} /></label>
              <label>Feldtyp<select disabled={!!baseline} value={field.kind} onChange={event => patchField(index, { kind: event.target.value, options: event.target.value === "select" ? ["Option 1"] : [] })}>{fieldKinds.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              <label className="hub-check"><input type="checkbox" disabled={requiredLocked} checked={field.required} onChange={event => patchField(index, { required: event.target.checked })} />Pflichtfeld</label>
            </div>
            {field.kind === "boolean" && <p className="hint">„Ja“ und „Nein“ sind gültige Werte. Bei einem Pflichtfeld muss einer der beiden Werte gewählt werden.</p>}
            {requiredLocked && <p className="hint">Dieses Feld bleibt optional, damit bestehende Datensätze weiterhin gültig sind.</p>}
            {field.kind === "select" && <div className="hub-stack">
              {field.options.map((option, optionIndex) => {
                const savedOption = optionIndex < (baseline?.options.length ?? 0);
                return <div className="hub-inline" key={optionIndex}>
                  <label>Option {optionIndex + 1}<input required maxLength={160} value={option} disabled={savedOption} onChange={event => patchField(index, { options: field.options.map((item, i) => i === optionIndex ? event.target.value : item) })} /></label>
                  <button type="button" disabled={savedOption || field.options.length <= 1} aria-label={`Option ${optionIndex + 1} aus Feld ${index + 1} entfernen`} onClick={() => patchField(index, { options: field.options.filter((_, i) => i !== optionIndex) })}>Entfernen</button>
                </div>;
              })}
              {baseline && <p className="hint">Gespeicherte Auswahloptionen bleiben erhalten. Zusätzliche Optionen sind möglich.</p>}
              <button type="button" disabled={field.options.length >= 100} onClick={() => {
                let number = field.options.length + 1;
                while (field.options.includes(`Option ${number}`)) number++;
                patchField(index, { options: [...field.options, `Option ${number}`] });
              }}>Option hinzufügen</button>
            </div>}
            <button type="button" disabled={!!baseline || value.fields.length <= 1} onClick={() => patch({ fields: value.fields.filter((_, i) => i !== index) })}>Feld entfernen</button>
          </fieldset>;
        })}
        <button type="button" disabled={locked || value.fields.length >= 40} onClick={addField}>Feld hinzufügen</button>
      </section>
      <div className="hub-actions">
        <button className="primary" type="submit" disabled={locked}>{action.busy ? "Wird gespeichert …" : "Datentyp speichern"}</button>
        <button type="button" onClick={() => setPreview(!preview)} aria-expanded={preview}>Eingabevorschau {preview ? "schließen" : "anzeigen"}</button>
        {definition && <button type="button" disabled={action.busy} onClick={reload}>Eingaben verwerfen und gespeicherten Stand laden</button>}
      </div>
    </form>
    {preview && <section className="panel hub-stack" aria-label="Eingabevorschau des Datentyps">
      <h2>{value.name || "Neuer Datentyp"}</h2>
      <p className="hint">So sehen die Eingabefelder für Datensätze aus. Diese Vorschau speichert keine Daten.</p>
      <Fields fields={value.fields} data={previewData} onChange={setPreviewData} disabled={!isOwner || builtin} prefix="kind-preview" />
    </section>}
  </>;
}
