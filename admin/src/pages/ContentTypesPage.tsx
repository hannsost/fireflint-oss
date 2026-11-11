import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useOrg } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import { EmptyState } from "../components/EmptyState";
import type { ContentType } from "../types";

export function ContentTypesPage() {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const { data: types, error } = useQuery({
    queryKey: ["content-types", org],
    queryFn: () => api.get<ContentType[]>(`/api/orgs/${org}/content-types`),
    retry: false,
  });
  const forbidden = error instanceof ApiError && error.status === 403;

  const deleteMut = useMutation({
    mutationFn: (key: string) => api.del(`/api/orgs/${org}/content-types/${key}`),
    onSuccess: () => {
      toast("Typ gelöscht ✓");
      qc.invalidateQueries({ queryKey: ["content-types", org] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Löschen fehlgeschlagen.", "error"),
  });

  return (
    <>
      <div className="topbar">
        <h1>
          Inhaltstypen {types && types.length > 0 && <span className="muted-count">({types.length})</span>}
        </h1>
        <Link className="button primary" to="/content-types/new">
          Neuer Typ
        </Link>
      </div>

      <p className="hint">
        Modelliere dein Datenmodell selbst — jeder Typ ist ein Schema aus Feldern.
        Neue Typen erscheinen sofort in der Navigation und im Editor.
      </p>

      {forbidden && (
        <div className="panel">
          <p className="muted">Inhaltstypen verwalten ist Owner-Konten vorbehalten.</p>
        </div>
      )}

      {!forbidden && (
        <div className="panel">
          {types && types.length === 0 && (
            <EmptyState title="Noch keine Inhaltstypen.">
              <Link className="button primary" to="/content-types/new">
                Ersten Typ anlegen
              </Link>
            </EmptyState>
          )}
          {types && types.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Felder</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id}>
                    <td data-label="Name">{t.name}</td>
                    <td className="code" data-label="Key">{t.key}</td>
                    <td className="muted" data-label="Felder">{t.schema.fields?.length ?? 0}</td>
                    <td data-label="" style={{ textAlign: "right" }}>
                      <Link className="button" to={`/content-types/${t.key}`}>
                        Bearbeiten
                      </Link>{" "}
                      <button
                        className="danger"
                        onClick={() => {
                          if (confirm(`Typ "${t.name}" löschen?`)) deleteMut.mutate(t.key);
                        }}
                      >
                        Löschen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
