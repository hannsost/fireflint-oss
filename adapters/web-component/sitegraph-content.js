// FireFlint / SiteGraph no-build public-content adapter.
// Only use a channel-scoped Delivery token whose content may be public.
// Every visitor can read browser tokens. Keep private tokens on a server.
// See README.md for cache, revocation and HTTPS requirements.

class SiteGraphContent extends HTMLElement {
  static MAX_CACHE_AGE_MS = 15 * 60 * 1000;
  static REQUEST_TIMEOUT_MS = 8000;

  static get observedAttributes() {
    return ["api", "channel", "module", "token"];
  }

  constructor() {
    super();
    this.generation = 0;
    this.controller = null;
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(_name, previous, next) {
    if (this.isConnected && previous !== next) this.render();
  }

  disconnectedCallback() {
    this.generation += 1;
    this.controller?.abort();
  }

  static validItems(items) {
    return Array.isArray(items) && items.every((item) =>
      item !== null && typeof item === "object" && !Array.isArray(item));
  }

  async scopeCacheKey(api, channel, module, token) {
    // No weaker fallback hash: without Web Crypto, delivery still works but
    // persistent caching is disabled. Never persist the credential itself.
    if (!globalThis.crypto?.subtle) return null;
    try {
      const hash = async (value) => Array.from(new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
      ), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const tokenHash = await hash(token);
      return `sitegraph:v2:${await hash(JSON.stringify([api, channel, module, tokenHash]))}`;
    } catch {
      return null;
    }
  }

  discardCache(key) {
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
  }

  readCache(key) {
    if (!key) return null;
    try {
      const cached = JSON.parse(localStorage.getItem(key));
      const age = Date.now() - cached?.savedAt;
      if (cached?.version === 2 && Number.isFinite(cached.savedAt) &&
          age >= 0 && age < SiteGraphContent.MAX_CACHE_AGE_MS &&
          SiteGraphContent.validItems(cached.items)) return cached.items;
    } catch { /* Corrupt JSON or inaccessible storage is a cache miss. */ }
    this.discardCache(key);
    return null;
  }

  writeCache(key, items) {
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ version: 2, savedAt: Date.now(), items }));
    } catch {
      // A failed write must not leave an older snapshot available for fallback.
      this.discardCache(key);
    }
  }

  message(text, error = false) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    paragraph.style.color = error ? "#b00" : "#555";
    paragraph.setAttribute("role", error ? "alert" : "status");
    this.replaceChildren(paragraph);
  }

  async render() {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const current = () => this.isConnected && this.generation === generation;
    // Clear the previous scope immediately, even while hashing or fetching.
    this.message("Inhalte werden geladen …");

    const channel = this.getAttribute("channel");
    const module = this.getAttribute("module");
    const token = this.getAttribute("token") || "";
    if (!channel || !module) {
      this.message("FireFlint: 'channel' und 'module' sind erforderlich.", true);
      return;
    }

    let api;
    try {
      const parsed = new URL(this.getAttribute("api") || "/", document.baseURI);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
          parsed.search || parsed.hash) throw new Error("Invalid API URL");
      api = parsed.href.replace(/\/+$/, "");
    } catch {
      this.message("FireFlint: Die API-URL ist ungültig.", true);
      return;
    }

    const key = await this.scopeCacheKey(api, channel, module, token);
    if (!current()) return;
    const unavailable = () => this.message("FireFlint: Inhalte sind derzeit nicht verfügbar.", true);
    const fallback = () => {
      const cached = this.readCache(key);
      if (cached !== null) {
        this.paint(cached, "Live nicht erreichbar – gespeicherte Version (höchstens 15 Minuten alt).");
      } else unavailable();
    };

    let timedOut = false;
    let response = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SiteGraphContent.REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(`${api}/v1/${encodeURIComponent(channel)}/content/${encodeURIComponent(module)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
        cache: "no-store",
        // Manual redirects become a non-success response (possibly opaque).
        // They must not look like network failures eligible for stale fallback.
        redirect: "manual",
      });
      if (!current()) return;
      if (!response.ok) {
        if (response.status >= 500 && response.status <= 599) fallback();
        else {
          // In particular: 401/403/404 must never revive previously accessible
          // content. Other 4xx/3xx failures also invalidate this cache scope.
          this.discardCache(key);
          unavailable();
        }
        return;
      }
      const body = await response.json();
      if (!current()) return;
      if (!body || !SiteGraphContent.validItems(body.items)) {
        this.discardCache(key);
        unavailable();
        return;
      }
      this.writeCache(key, body.items);
      this.paint(body.items, null);
    } catch {
      if (!current()) return;
      if (timedOut || response === null) fallback();
      else {
        // Invalid JSON / an invalid successful response is not an API outage.
        this.discardCache(key);
        unavailable();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  paint(items, notice) {
    const esc = (s) =>
      (s !== null && typeof s === "object" ? JSON.stringify(s) : String(s ?? "")).replace(/[&<>"]/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
      );
    const cards = items.map((it) => `
      <div style="border:1px solid #e2e2e2;border-radius:8px;padding:12px 16px;margin:8px 0;font-family:system-ui,sans-serif">
        <strong style="font-size:1.1em">${esc(it.name)}</strong>
        <div>${esc(it.adresse)}</div>
        ${it.telefon ? `<div>Tel: ${esc(it.telefon)}</div>` : ""}
        ${it.oeffnungszeiten ? `<div style="color:#555">${esc(it.oeffnungszeiten)}</div>` : ""}
      </div>`).join("");
    const banner = notice
      ? `<div role="status" style="background:#fff6d6;border:1px solid #e6cf66;padding:6px 10px;border-radius:6px;font-size:.85em;margin-bottom:8px">${esc(notice)}</div>`
      : "";
    this.innerHTML = banner + (cards || `<p style="color:#777">Keine Inhalte für diesen Channel.</p>`);
  }
}

customElements.define("sitegraph-content", SiteGraphContent);
