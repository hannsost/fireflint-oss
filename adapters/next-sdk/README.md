# @sitegraph/next (WP1.10)

Typed FireFlint delivery client for Next.js / TypeScript. Reads published content
from the Delivery API (Pull) and participates in Next.js ISR caching via
`fetch(..., { next: { revalidate } })`.

## Installation

```bash
npm install @sitegraph/next   # (lokal im Monorepo via "file:" referenziert)
```

## Nutzung (Server Component)

```ts
import { createClient, type Job } from "@sitegraph/next";

const sitegraph = createClient({
  apiUrl: process.env.SITEGRAPH_API_URL!,
  token: process.env.SITEGRAPH_TOKEN!, // org-weiter oder channel-gebundener Token
  revalidate: 60,                      // ISR-Default in Sekunden
});

export default async function JobsPage() {
  const jobs = await sitegraph.getContent<Job>({ type: "job", channel: "karriere" });
  return <ul>{jobs.map((j, i) => <li key={i}>{j.titel}</li>)}</ul>;
}
```

`getContent<T>()` ist generisch; mitgelieferte Shapes: `Job`, `Standort`,
`TeamMember`. Fehler werfen `SiteGraphError` mit HTTP-Status.

## Build / Typecheck

```bash
npm install && npm run build      # -> dist/index.js + index.d.ts
npm run typecheck
```

## Beispiel-App

`example/` ist eine lauffähige Next.js-App (App Router) mit einer Jobs-Liste:

```bash
cd example
cp .env.local.example .env.local   # API-URL + Token + Channel
npm install
npm run dev                        # http://localhost:3000/jobs
```

Zeigt dieselben Delivery-Daten wie Web Component und WordPress-Plugin – inkl.
channel-spezifischer Overrides – serverseitig gerendert und typsicher.
