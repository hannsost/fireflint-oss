import type { ReactNode } from "react";

export const metadata = {
  title: "SiteGraph – Next.js Demo",
  description: "Jobs live aus SiteGraph via @sitegraph/next",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body style={{ fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", margin: 0, color: "#1c2430" }}>
        {children}
      </body>
    </html>
  );
}
