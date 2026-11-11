# Visual self-review

Renders pages across a viewport matrix (ultrawide → small phone) and writes
full-page PNG screenshots. Used by the agent (and humans) to **check UI/UX at
multiple resolutions and aspect ratios** before considering a UI change done.

The loop: `shoot` → read the PNGs → critique layout/UX/overflow → fix → re-shoot.

## Setup (once)

```bash
npm install
npx playwright install chromium   # if the browser build isn't cached
```

## Usage

```bash
# default: screenshots adapters/web-component/demo.html
node shoot.mjs

# a running dev server (e.g. the admin UI later)
node shoot.mjs http://localhost:5173 admin

# a specific local file + name
node shoot.mjs ../../admin/dist/index.html admin

# viewport-only crop instead of full page
node shoot.mjs --clip http://localhost:5173
```

Output: `screenshots/<target>/<viewport>.png`. The run also reports per-page
**console errors** (a cheap way to catch failed fetches / JS errors).

## Viewport matrix

Edit `viewports.mjs` — it's the single source of truth. Current set:
ultrawide 2560×1080, desktop 1920×1080, laptop 1440×900, tablet
1024×768 & 768×1024, phones 390×844 & 360×640.

## Why this is a standard

UI/UX is a first-class part of the product, and layout bugs (cramped columns,
overflow, unreadable text, broken aspect ratios) are invisible without actually
looking. This tool makes "looking" cheap and repeatable, so every UI change is
self-verified at real sizes — not just at whatever window the author happens to
use. See the development standards (agent memory: `visual-self-review-standard`).
