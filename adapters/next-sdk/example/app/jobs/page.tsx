import { createClient, type Job } from "@sitegraph/next";

// Server Component: data is fetched on the server with ISR caching (WP1.10).
const client = createClient({
  apiUrl: process.env.SITEGRAPH_API_URL ?? "http://localhost:8080",
  token: process.env.SITEGRAPH_TOKEN ?? "",
  revalidate: 30,
});

const CHANNEL = process.env.SITEGRAPH_CHANNEL ?? "karriere";

export default async function JobsPage() {
  let jobs: Job[] = [];
  let error: string | null = null;
  try {
    jobs = await client.getContent<Job>({ type: "job", channel: CHANNEL });
  } catch (e) {
    error = e instanceof Error ? e.message : "Unbekannter Fehler";
  }

  return (
    <main style={{ maxWidth: 760, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Offene Stellen</h1>
      <p style={{ color: "#666" }}>
        Channel: <code>{CHANNEL}</code> — live aus SiteGraph via{" "}
        <code>@sitegraph/next</code>.
      </p>

      {error && <p style={{ color: "#b00" }}>Inhalte nicht verfügbar: {error}</p>}
      {!error && jobs.length === 0 && <p>Derzeit keine offenen Stellen.</p>}

      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "1rem" }}>
        {jobs.map((job, i) => (
          <li
            key={i}
            style={{ border: "1px solid #e2e2e2", borderRadius: 10, padding: "14px 18px" }}
          >
            <div style={{ fontWeight: 700, fontSize: "1.15rem" }}>{job.titel}</div>
            <div style={{ color: "#444" }}>
              {[job.standort, job.abteilung, job.arbeitsmodell].filter(Boolean).join(" · ")}
            </div>
            {job.beschreibung && <p style={{ marginBottom: 0 }}>{job.beschreibung}</p>}
          </li>
        ))}
      </ul>
    </main>
  );
}
