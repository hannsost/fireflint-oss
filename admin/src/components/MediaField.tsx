import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, assetUrl } from "../api/client";
import type { Asset } from "../types";

const isImage = (ct?: string) => !!ct && ct.startsWith("image/");

export function MediaField({
  value,
  onChange,
  org,
}: {
  value: string;
  onChange: (v: string) => void;
  org: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);
  const { data } = useQuery({
    queryKey: ["assets", org],
    queryFn: () => api.get<{ assets: Asset[] }>(`/api/orgs/${org}/assets`),
    enabled: open,
  });
  const assets = data?.assets ?? [];

  return (
    <div>
      {value ? (
        <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
          <img
            src={assetUrl(value)}
            alt=""
            style={{ height: 48, width: 48, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }}
            onError={(e) => {
              e.currentTarget.style.visibility = "hidden";
            }}
          />
          <span className="code">{value}</span>
          <span className="spacer" />
          <button type="button" onClick={() => setOpen((o) => !o)}>
            Ändern
          </button>
          <button type="button" className="danger" onClick={() => onChange("")}>
            Entfernen
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen((o) => !o)}>
          Medium auswählen
        </button>
      )}
      {open && (
        <div className="panel" style={{ marginTop: "0.6rem" }}>
          {assets.length === 0 && (
            <p className="muted">Keine Medien — lade welche in der Medienbibliothek hoch.</p>
          )}
          <div className="media-grid">
            {assets.map((a) => (
              <button
                type="button"
                key={a.id}
                className="media-tile"
                onClick={() => {
                  onChange(a.url);
                  setOpen(false);
                }}
                title={a.filename}
              >
                {isImage(a.content_type) ? (
                  <img src={assetUrl(a.url)} alt={a.filename} />
                ) : (
                  <span className="media-file">{a.filename.split(".").pop()?.toUpperCase() || "FILE"}</span>
                )}
                <span className="media-name">{a.filename}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
