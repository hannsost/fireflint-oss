import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, assetUrl, upload } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import { EmptyState } from "../components/EmptyState";
import type { Asset } from "../types";

const isImage = (ct: string) => ct.startsWith("image/");

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function MediaPage() {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const { memberships } = useAuth();
  const role = memberships.find((m) => m.org_id === org)?.role;
  const canEdit = role === "owner" || role === "editor";
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const { data } = useQuery({
    queryKey: ["assets", org],
    queryFn: () => api.get<{ assets: Asset[] }>(`/api/orgs/${org}/assets`),
  });
  const assets = data?.assets ?? [];

  const uploadMut = useMutation({
    mutationFn: (file: File) => upload<Asset>(`/api/orgs/${org}/assets`, file),
    onSuccess: (a) => {
      toast(`„${a.filename}" hochgeladen ✓`);
      qc.invalidateQueries({ queryKey: ["assets", org] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Upload fehlgeschlagen.", "error"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.del(`/api/orgs/${org}/assets/${id}`),
    onSuccess: () => {
      toast("Medium gelöscht ✓");
      qc.invalidateQueries({ queryKey: ["assets", org] });
    },
  });

  return (
    <>
      <div className="topbar">
        <h1>
          Medien {assets.length > 0 && <span className="muted-count">({assets.length})</span>}
        </h1>
        {canEdit && (
          <>
            <input
              ref={fileInput}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadMut.mutate(f);
                e.target.value = "";
              }}
            />
            <button className="primary" onClick={() => fileInput.current?.click()} disabled={uploadMut.isPending}>
              {uploadMut.isPending ? "Lädt hoch…" : "Hochladen"}
            </button>
          </>
        )}
      </div>

      <p className="hint">
        Bilder und Dateien für deine Inhalte. Verweise sie über Felder vom Typ
        „Medien". Die Auslieferung erfolgt über eine stabile, öffentliche URL.
        {canEdit && " Dateien lassen sich auch per Drag & Drop hier ablegen."}
      </p>

      <div
        className={`panel${dragOver ? " dropzone-active" : ""}`}
        onDragOver={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          setDragOver(false);
          for (const f of Array.from(e.dataTransfer.files)) uploadMut.mutate(f);
        }}
      >
        {assets.length === 0 && (
          <EmptyState title="Noch keine Medien.">
            {canEdit && <span className="hint">Hochladen-Button oben oder Datei hierher ziehen.</span>}
          </EmptyState>
        )}
        <div className="media-grid">
          {assets.map((a) => (
            <div key={a.id} className="media-tile">
              {isImage(a.content_type) ? (
                <img src={assetUrl(a.url)} alt={a.filename} />
              ) : (
                <span className="media-file">{a.filename.split(".").pop()?.toUpperCase() || "FILE"}</span>
              )}
              <span className="media-name" title={a.filename}>{a.filename}</span>
              <span className="muted" style={{ fontSize: "0.75rem" }}>{humanSize(a.byte_size)}</span>
              {canEdit && (
                <button
                  className="danger"
                  style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                  onClick={() => {
                    if (confirm(`"${a.filename}" löschen?`)) deleteMut.mutate(a.id);
                  }}
                >
                  Löschen
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
