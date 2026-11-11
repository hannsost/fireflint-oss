// Visual self-review screenshotter.
//
// Renders one or more targets (local HTML files or http(s) URLs) across the
// viewport matrix in viewports.mjs and writes PNGs to ./screenshots/<target>/.
// The agent then reads those PNGs back to critique layout/UX at each size.
//
// Usage:
//   node shoot.mjs                                  # default targets
//   node shoot.mjs ../../adapters/web-component/demo.html
//   node shoot.mjs http://localhost:5173 admin      # url + explicit name
//   node shoot.mjs --clip url1 url2                  # viewport-only (no full page)
//
// Env:
//   SHOOT_OUT   output dir (default ./screenshots)
//   SHOOT_WAIT  ms to wait after load for async content (default 600)

import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VIEWPORTS } from "./viewports.mjs";

const OUT = process.env.SHOOT_OUT || path.resolve("screenshots");
const WAIT = Number(process.env.SHOOT_WAIT || 600);

// --- parse args ---
const rawArgs = process.argv.slice(2);
const fullPage = !rawArgs.includes("--clip");
const args = rawArgs.filter((a) => !a.startsWith("--"));

// Build [{ url, name }]. If the arg after a target is a bare word (no slash,
// no dot, not a url), treat it as that target's name.
function toTargets(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const isUrl = /^https?:\/\//.test(a);
    const url = isUrl ? a : pathToFileURL(path.resolve(a)).href;
    let name = isUrl
      ? a.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").replace(/_+$/g, "")
      : path.basename(a).replace(/\.[^.]+$/, "");
    const next = list[i + 1];
    if (next && !/[./\\]/.test(next) && !/^https?:/.test(next)) {
      name = next;
      i++;
    }
    out.push({ url, name });
  }
  return out;
}

const DEFAULT_TARGETS = [
  { url: pathToFileURL(path.resolve("../../adapters/web-component/demo.html")).href, name: "demo" },
];

const targets = args.length ? toTargets(args) : DEFAULT_TARGETS;

// --- run ---
const browser = await chromium.launch();
const results = [];
let failures = 0;

for (const target of targets) {
  const dir = path.join(OUT, target.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    // Optional: seed an authenticated session into localStorage so SPA routes
    // that require a login render (SHOOT_TOKEN / SHOOT_REFRESH).
    if (process.env.SHOOT_TOKEN) {
      await context.addInitScript(
        ([access, refresh]) => {
          localStorage.setItem("sg.access", access);
          if (refresh) localStorage.setItem("sg.refresh", refresh);
        },
        [process.env.SHOOT_TOKEN, process.env.SHOOT_REFRESH || ""],
      );
    }
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

    let ok = true;
    try {
      await page.goto(target.url, { waitUntil: "networkidle", timeout: 15000 });
    } catch {
      // networkidle can time out on pages with long-polling; fall back.
      try {
        await page.goto(target.url, { waitUntil: "load", timeout: 15000 });
      } catch (e) {
        ok = false;
        failures++;
        console.error(`  FAIL ${target.name} @ ${vp.name}: ${e.message}`);
      }
    }
    if (ok) {
      await page.waitForTimeout(WAIT);
      const file = path.join(dir, `${vp.name}.png`);
      await page.screenshot({ path: file, fullPage });
      results.push({ target: target.name, viewport: vp.name, file, consoleErrors });
    }
    await context.close();
  }
}

await browser.close();

// --- report (machine + human readable) ---
console.log(`\nScreenshots written to ${OUT}\n`);
for (const r of results) {
  const errs = r.consoleErrors.length ? `  [${r.consoleErrors.length} console error(s)]` : "";
  console.log(`  ${path.relative(process.cwd(), r.file)}${errs}`);
}
console.log(`\n${results.length} shot(s), ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
