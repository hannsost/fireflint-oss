import type { FieldDef } from "../types";
import { MediaField } from "./MediaField";
import { RelationField } from "./RelationField";

type Data = Record<string, unknown>;

interface Props {
  fields: FieldDef[];
  value: Data;
  onChange: (next: Data) => void;
  idPrefix?: string;
  /** Org id; enables the media picker for `media` fields. */
  org?: string;
  /** Show fields even when empty; used for per-channel overrides. */
  placeholderHint?: (f: FieldDef) => string | undefined;
}

/** Renders form inputs generated from a content type's field definitions (WP1.7). */
export function SchemaForm({ fields, value, onChange, idPrefix = "f", org, placeholderHint }: Props) {
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <>
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const raw = value[f.key];
        const placeholder = placeholderHint?.(f);
        return (
          <div className="field" key={f.key}>
            <label htmlFor={id}>
              {f.label || f.key}
              {f.required && <span className="req"> *</span>}
            </label>
            {f.type === "media" && org ? (
              <MediaField value={raw == null ? "" : String(raw)} onChange={(v) => set(f.key, v)} org={org} />
            ) : f.type === "relation-ref" && org ? (
              <RelationField
                value={raw == null ? "" : String(raw)}
                onChange={(v) => set(f.key, v)}
                org={org}
                refType={f.ref_type}
              />
            ) : f.type === "richtext" ? (
              <>
                <textarea
                  id={id}
                  value={raw == null ? "" : String(raw)}
                  placeholder={placeholder}
                  onChange={(e) => set(f.key, e.target.value)}
                />
                <span className="muted" style={{ fontSize: "0.75rem" }}>
                  {String(raw ?? "").length} Zeichen
                </span>
              </>
            ) : f.type === "number" ? (
              <input
                id={id}
                type="number"
                value={raw == null || raw === "" ? "" : Number(raw)}
                placeholder={placeholder}
                onChange={(e) =>
                  set(f.key, e.target.value === "" ? "" : Number(e.target.value))
                }
              />
            ) : (
              <input
                id={id}
                value={raw == null ? "" : String(raw)}
                placeholder={placeholder}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
