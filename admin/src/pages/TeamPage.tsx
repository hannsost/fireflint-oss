import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import type { OrgMember, Role } from "../types";

const ROLES: Role[] = ["owner", "editor", "viewer"];
const ROLE_LABEL: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

interface AddResult {
  email: string;
  created: boolean;
  temp_password?: string | null;
}

export function TeamPage() {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, switchOrg, reload } = useAuth();

  const { data, error } = useQuery({
    queryKey: ["members", org],
    queryFn: () => api.get<{ members: OrgMember[] }>(`/api/orgs/${org}/members`),
    retry: false,
  });
  const forbidden = error instanceof ApiError && error.status === 403;
  const members = data?.members ?? [];

  // --- add member ---
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [addError, setAddError] = useState<string | null>(null);
  const [added, setAdded] = useState<AddResult | null>(null);

  const addMut = useMutation({
    mutationFn: () =>
      api.post<AddResult>(`/api/orgs/${org}/members`, { email, name: name || null, role }),
    onSuccess: (res) => {
      setAdded(res);
      setAddError(null);
      setEmail("");
      setName("");
      toast("Mitglied hinzugefügt ✓");
      qc.invalidateQueries({ queryKey: ["members", org] });
    },
    onError: (e) => setAddError(e instanceof ApiError ? e.message : "Hinzufügen fehlgeschlagen."),
  });

  const roleMut = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api.put(`/api/orgs/${org}/members/${id}`, { role }),
    onSuccess: () => {
      toast("Rolle aktualisiert ✓");
      qc.invalidateQueries({ queryKey: ["members", org] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Rollenänderung fehlgeschlagen.", "error"),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => api.del(`/api/orgs/${org}/members/${id}`),
    onSuccess: () => {
      toast("Mitglied entfernt ✓");
      qc.invalidateQueries({ queryKey: ["members", org] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Entfernen fehlgeschlagen.", "error"),
  });

  // --- new org ---
  const [orgName, setOrgName] = useState("");
  const createOrgMut = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/api/orgs`, { name: orgName }),
    onSuccess: async (res) => {
      setOrgName("");
      toast("Organisation angelegt ✓");
      await reload();
      switchOrg(res.id);
    },
    onError: () => toast("Organisation konnte nicht angelegt werden.", "error"),
  });

  if (forbidden) {
    return (
      <>
        <div className="topbar">
          <h1>Team</h1>
        </div>
        <div className="panel">
          <p className="muted">Die Team-Verwaltung ist Owner-Konten vorbehalten.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>Team</h1>
      </div>

      <div className="panel">
        <h2>Mitglieder ({members.length})</h2>
        {members.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>E-Mail</th>
                <th>Name</th>
                <th>Rolle</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.id === user?.id;
                return (
                  <tr key={m.id}>
                    <td className="code" data-label="E-Mail">
                      {m.email}
                      {isSelf && <span className="muted"> (du)</span>}
                    </td>
                    <td data-label="Name" className={m.name ? "" : "muted"}>{m.name || "—"}</td>
                    <td data-label="Rolle">
                      {isSelf ? (
                        <span className="badge role">{ROLE_LABEL[m.role]}</span>
                      ) : (
                        <select
                          value={m.role}
                          onChange={(e) => roleMut.mutate({ id: m.id, role: e.target.value as Role })}
                          style={{ width: "auto" }}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td data-label="" style={{ textAlign: "right" }}>
                      {!isSelf && (
                        <button
                          className="danger"
                          onClick={() => {
                            if (confirm(`${m.email} aus dieser Organisation entfernen?`))
                              removeMut.mutate(m.id);
                          }}
                        >
                          Entfernen
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Mitglied hinzufügen</h2>
        <p className="hint">
          Bestehende Nutzer werden per E-Mail zugeordnet. Für neue Nutzer wird ein
          einmaliges Passwort erzeugt und hier einmalig angezeigt.
        </p>
        <div className="field">
          <label htmlFor="m-email">E-Mail</label>
          <input id="m-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="kollege@example.org" />
        </div>
        <div className="field">
          <label htmlFor="m-name">Name (optional)</label>
          <input id="m-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="m-role">Rolle</label>
          <select id="m-role" value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ width: "auto" }}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        {addError && <p className="error">{addError}</p>}
        {added && (
          <p className="hint">
            <strong>{added.email}</strong> hinzugefügt.
            {added.temp_password && (
              <>
                {" "}Einmal-Passwort: <span className="code">{added.temp_password}</span> — jetzt
                notieren, es wird nicht erneut angezeigt.
              </>
            )}
          </p>
        )}
        <div className="actions">
          <button
            className="primary"
            onClick={() => addMut.mutate()}
            disabled={addMut.isPending || !email}
          >
            {addMut.isPending ? "Hinzufügen…" : "Hinzufügen"}
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Neue Organisation</h2>
        <p className="hint">Lege eine weitere Organisation an — du wirst automatisch deren Owner.</p>
        <div className="field">
          <label htmlFor="o-name">Name</label>
          <input id="o-name" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="z.B. Kunde GmbH" />
        </div>
        <div className="actions">
          <button
            onClick={() => createOrgMut.mutate()}
            disabled={createOrgMut.isPending || !orgName}
          >
            {createOrgMut.isPending ? "Anlegen…" : "Organisation anlegen"}
          </button>
        </div>
      </div>
    </>
  );
}
