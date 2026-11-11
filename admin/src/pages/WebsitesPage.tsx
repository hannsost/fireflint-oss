import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useAuth, useOrg } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import { EmptyState } from "../components/EmptyState";
import { slugify } from "../lib/slug";
import type { Website } from "../types";

export function WebsitesPage() {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const { memberships } = useAuth();
  const isOwner = memberships.find((m) => m.org_id === org)?.role === "owner";

  const { data: websites } = useQuery({
    queryKey: ["websites", org],
    queryFn: () => api.get<Website[]>(`/api/orgs/${org}/websites`),
  });

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [domain, setDomain] = useState("");

  const onName = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  };

  const createMut = useMutation({
    mutationFn: () =>
      api.post(`/api/orgs/${org}/websites`, { name, slug, domain: domain || null }),
    onSuccess: () => {
      setName("");
      setSlug("");
      setSlugTouched(false);
      setDomain("");
      toast("Website angelegt ✓");
      qc.invalidateQueries({ queryKey: ["websites", org] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Fehler beim Anlegen.", "error"),
  });

  const count = websites?.length ?? 0;

  return (
    <>
      <div className="topbar">
        <h1>
          Websites {count > 0 && <span className="muted-count">({count})</span>}
        </h1>
      </div>

      <div className="panel">
        {websites && count === 0 && (
          <EmptyState title="Noch keine Websites.">
            {isOwner && <span className="hint">Lege unten die erste an.</span>}
          </EmptyState>
        )}
        {websites && count > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Domain</th>
              </tr>
            </thead>
            <tbody>
              {websites.map((w) => (
                <tr key={w.id}>
                  <td data-label="Name">{w.name}</td>
                  <td className="code" data-label="Slug">{w.slug}</td>
                  <td className="muted" data-label="Domain">{w.domain ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isOwner && (
        <div className="panel">
          <h2>Neue Website</h2>
          <div className="field">
            <label htmlFor="w-name">Name</label>
            <input id="w-name" value={name} onChange={(e) => onName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="w-slug">Slug</label>
            <input
              id="w-slug"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder="z.B. karriere"
            />
          </div>
          <div className="field">
            <label htmlFor="w-domain">Domain (optional)</label>
            <input id="w-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="karriere.firma.de" />
          </div>
          <div className="actions">
            <button
              className="primary"
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending || !name || !slug}
            >
              Anlegen
            </button>
          </div>
        </div>
      )}
    </>
  );
}
