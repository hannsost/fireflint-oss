import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // An existing file is a non-directory sentinel for explicit no-dotenv runs:
  // no dotenv file can exist beneath it; VITE_* still comes from the process.
  envDir: process.env.SITEGRAPH_LOAD_DOTENV === "0" ? fileURLToPath(import.meta.url) : undefined,
  plugins: [react()],
  // Instance-specific origins for brand-content validation (see src/lib/brandContent.ts).
  define: {
    __FF_PUBLIC_ORIGIN__: JSON.stringify(process.env.VITE_PUBLIC_ORIGIN || ""),
    __FF_BRAND_ASSET_ORIGIN__: JSON.stringify(process.env.VITE_BRAND_ASSET_ORIGIN || ""),
  },
  build: { assetsDir: "_static" },
  server: { host: "0.0.0.0", port: Number(process.env.ADMIN_PORT || 5174), strictPort: true },
});
