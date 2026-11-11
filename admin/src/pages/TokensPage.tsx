import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useOrg } from "../auth/AuthContext";
import { CopyButton } from "../components/CopyButton";
import { useToast } from "../components/Toast";
import type { ApiToken, Website } from "../types";

export function TokensPage() {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const { data } = useQuery({
    queryKey: ["tokens", org],
    queryFn: () => api.get<{ tokens: ApiToken[] }>(`/api/orgs/${org}/tokens`),
  });
  const { data: websites } = useQuery({
    queryKey: ["websites", org],
    queryFn: () => api.get<Website[]>(`/api/orgs/${org}/websites`),
  });

  const [name, setName] = useState("");
  const [websiteId, setWebsiteId] = useState("");
  const [created, setCreated] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () =>
      api.post<{ token: string }>(`/api/orgs/${org}/tokens`, {
        name,
        website_id: websiteId || null,
      }),
    onSuccess: (res) => {
      setCreated(res.token);
      setName("");
      setWebsiteId("");
      toast("Token erstellt ✓");
      qc.invalidateQueries({ queryKey: ["tokens", org] });
    },
    onError: () => toast("Token konnte nicht erstellt werden.", "error"),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => api.del(`/api/orgs/${org}/tokens/${id}`),
    onSuccess: () => {
      toast("Token widerrufen ✓");
      qc.invalidateQueries({ queryKey: ["tokens", org] });
    },
  });

  const websiteName = (id: string | null) =>
    id ? (websites?.find((w) => w.id === id)?.name ?? id) : "Alle Channels (org-weit)";

  return (
    <>
      <div className="topbar">
        <h1>API-Tokens</h1>
      </div>

      <div className="panel">
        <p className="hint">
          Tokens autorisieren die öffentliche Delivery-API. Ein channel-gebundener
          Token kann nur seinen Channel lesen.
        </p>
        {data && data.tokens.length === 0 && <p className="muted">Noch keine Tokens.</p>}
        {data && data.tokens.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="muted">{websiteName(t.website_id)}</td>
                  <td>
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm("Token widerrufen? Bestehende Integrationen brechen ab."))
                          revokeMut.mutate(t.id);
                      }}
                    >
                      Widerrufen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Neuen Token erstellen</h2>
        <div className="field">
          <label htmlFor="t-name">Name</label>
          <input id="t-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="z.B. WordPress-Karriere" />
        </div>
        <div className="field">
          <label htmlFor="t-scope">Scope</label>
          <select id="t-scope" value={websiteId} onChange={(e) => setWebsiteId(e.target.value)}>
            <option value="">Alle Channels (org-weit)</option>
            {websites?.map((w) => (
              <option key={w.id} value={w.id}>
                Nur: {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => createMut.mutate()} disabled={createMut.isPending || !name}>
            Token erstellen
          </button>
        </div>

        {created && (
          <div className="panel" style={{ marginTop: "1rem", background: "#fff8e6", borderColor: "#e6cf66" }}>
            <strong>Token (wird nur einmal angezeigt):</strong>
            <p className="code" style={{ wordBreak: "break-all", display: "block", marginTop: "0.5rem" }}>
              {created}
            </p>
            <div className="actions">
              <CopyButton text={created} label="Token kopieren" />
              <button onClick={() => setCreated(null)}>Verstanden, ausblenden</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
