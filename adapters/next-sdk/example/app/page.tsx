import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: 760, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>SiteGraph – Next.js Demo</h1>
      <p style={{ color: "#666" }}>
        Dieselben Inhalte wie im WordPress-Plugin und der Web Component – hier
        typsicher über <code>@sitegraph/next</code> in einer Server Component.
      </p>
      <p>
        <Link href="/jobs">→ Offene Stellen ansehen</Link>
      </p>
    </main>
  );
}
