import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ContentObject, ContentType } from "../types";

export function RelationField({
  value,
  onChange,
  org,
  refType,
}: {
  value: string;
  onChange: (v: string) => void;
  org: string;
  refType?: string | null;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);
  const { data: types } = useQuery({
    queryKey: ["content-types", org],
    queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`),
  });
  const target = types?.find((t) => t.key === refType);
  const primary = target?.schema.fields?.[0]?.key;
  const { data: items } = useQuery({
    queryKey: ["content", org, refType, "", ""],
    queryFn: () => api.get<ContentObject[]>(`/api/orgs/${org}/content/${refType}`),
    enabled: !!refType,
  });
  const label = (o: ContentObject) => (primary && (o.data[primary] as string)) || o.id.slice(0, 8);

  // No target type configured: fall back to a free-text reference id.
  if (!refType) {
    return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Referenz-ID" />;
  }

  const selected = items?.find((o) => o.id === value);
  return (
    <div>
      <div className="row" style={{ gap: "0.6rem" }}>
        <span className={value ? "" : "muted"}>
          {value ? (selected ? label(selected) : value.slice(0, 8)) : "— keine Auswahl —"}
        </span>
        <span className="spacer" />
        <button type="button" onClick={() => setOpen((o) => !o)}>
          {value ? "Ändern" : "Auswählen"}
        </button>
        {value && (
          <button type="button" className="danger" onClick={() => onChange("")}>
            Entfernen
          </button>
        )}
      </div>
      {open && (
        <div className="panel" style={{ marginTop: "0.6rem" }}>
          {(!items || items.length === 0) && (
            <p className="muted">Keine Einträge vom Typ „{target?.name || refType}".</p>
          )}
          {items && items.length > 0 && (
            <table>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(o.id);
                          setOpen(false);
                        }}
                      >
                        {label(o)}
                      </button>
                    </td>
                    <td className="muted">{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
