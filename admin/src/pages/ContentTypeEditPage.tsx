import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useOrg } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import { UiIcon } from "../components/Brand";
import { slugify } from "../lib/slug";
import type { ContentType, FieldDef } from "../types";

const FIELD_TYPES = ["text", "richtext", "select", "date", "number", "media", "relation-ref"];
const TYPE_LABEL: Record<string, string> = {
  text: "Text",
  richtext: "Rich Text",
  select: "Auswahl",
  date: "Datum",
  number: "Zahl",
  media: "Medien",
  "relation-ref": "Referenz",
};

function emptyField(): FieldDef {
  return { key: "", label: "", type: "text", required: false };
}

export function ContentTypeEditPage() {
  const { key } = useParams<{ key: string }>();
  const isNew = !key;
  const org = useOrg();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const { data: types } = useQuery({
    queryKey: ["content-types", org],
    queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`),
  });
  const existing = types?.find((t) => t.key === key);

  const [typeKey, setTypeKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [name, setName] = useState("");
  const [fields, setFields] = useState<FieldDef[]>([emptyField()]);
  const [error, setError] = useState<string | null>(null);

  const onName = (v: string) => {
    setName(v);
    if (isNew && !keyTouched) setTypeKey(slugify(v));
  };

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setFields(existing.schema.fields?.length ? existing.schema.fields : [emptyField()]);
    }
  }, [existing]);

  const setField = (i: number, patch: Partial<FieldDef>) =>
    setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((fs) => [...fs, emptyField()]);
  const removeField = (i: number) => setFields((fs) => fs.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) =>
    setFields((fs) => {
      const j = i + dir;
      if (j < 0 || j >= fs.length) return fs;
      const next = fs.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const saveMut = useMutation({
    mutationFn: () => {
      const cleaned = fields.filter((f) => f.key.trim() || f.label.trim());
      const body = { name, fields: cleaned };
      return isNew
        ? api.post(`/api/orgs/${org}/content-types`, { key: typeKey, ...body })
        : api.put(`/api/orgs/${org}/content-types/${key}`, body);
    },
    onSuccess: () => {
      setError(null);
      toast(isNew ? "Typ angelegt ✓" : "Typ gespeichert ✓");
      qc.invalidateQueries({ queryKey: ["content-types", org] });
      navigate("/content-types");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Speichern fehlgeschlagen."),
  });

  return (
    <>
      <div className="topbar">
        <h1>{isNew ? "Neuer Inhaltstyp" : `Typ bearbeiten: ${existing?.name ?? key}`}</h1>
      </div>

      <div className="panel">
        {isNew && (
          <div className="field">
            <label htmlFor="ct-key">Key</label>
            <input
              id="ct-key"
              value={typeKey}
              onChange={(e) => {
                setTypeKey(e.target.value);
                setKeyTouched(true);
              }}
              placeholder="z.B. event (Kleinbuchstaben, _ oder -)"
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="ct-name">Name</label>
          <input id="ct-name" value={name} onChange={(e) => onName(e.target.value)} placeholder="z.B. Veranstaltung" />
        </div>
      </div>

      <div className="panel">
        <h2>Felder</h2>
        {fields.map((f, i) => (
          <div
            key={i}
            className="row"
            style={{ gap: "0.5rem", flexWrap: "wrap", borderTop: i ? "1px solid var(--border)" : "none", paddingTop: i ? "0.7rem" : 0, marginTop: i ? "0.7rem" : 0 }}
          >
            <input
              placeholder="key"
              value={f.key}
              onChange={(e) => setField(i, { key: e.target.value })}
              style={{ width: "9rem" }}
            />
            <input
              placeholder="Label"
              value={f.label}
              onChange={(e) => setField(i, { label: e.target.value })}
              style={{ width: "11rem" }}
            />
            <select value={f.type} onChange={(e) => setField(i, { type: e.target.value })} style={{ width: "auto" }}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            {f.type === "relation-ref" && (
              <select
                value={f.ref_type ?? ""}
                onChange={(e) => setField(i, { ref_type: e.target.value || null })}
                style={{ width: "auto" }}
                title="Ziel-Typ"
              >
                <option value="">Ziel-Typ…</option>
                {(types ?? [])
                  .filter((t) => t.key !== key)
                  .map((t) => (
                    <option key={t.id} value={t.key}>
                      {t.name}
                    </option>
                  ))}
              </select>
            )}
            <label className="row" style={{ gap: "0.3rem" }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={f.required}
                onChange={(e) => setField(i, { required: e.target.checked })}
              />
              Pflicht
            </label>
            <span className="spacer" />
            <button type="button" className="icon-button" onClick={() => move(i, -1)} disabled={i === 0} title="Nach oben" aria-label="Feld nach oben verschieben">
              <UiIcon name="up" />
            </button>
            <button type="button" className="icon-button" onClick={() => move(i, 1)} disabled={i === fields.length - 1} title="Nach unten" aria-label="Feld nach unten verschieben">
              <UiIcon name="down" />
            </button>
            <button type="button" className="icon-button danger" onClick={() => removeField(i)} title="Feld entfernen" aria-label="Feld entfernen">
              <UiIcon name="trash" />
            </button>
          </div>
        ))}
        <div className="actions">
          <button onClick={addField}>Feld hinzufügen</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button
          className="primary"
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending || !name || (isNew && !typeKey)}
        >
          {saveMut.isPending ? "Speichern…" : "Speichern"}
        </button>
        <button onClick={() => navigate("/content-types")}>Abbrechen</button>
      </div>
    </>
  );
}
