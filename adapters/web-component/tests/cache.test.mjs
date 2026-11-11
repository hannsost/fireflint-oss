import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../sitegraph-content.js", import.meta.url), "utf8");
const data = (name) => ({ items: [{ name }] });
const response = (name, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data(name) });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((done) => setTimeout(done, 5));
async function until(condition) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await tick();
  assert.ok(condition(), "async fixture did not reach the expected state");
}

function harness() {
  const storage = new Map();
  const requests = [];
  let registered;
  let now = 1_800_000_000_000;
  let fetcher = async () => response("First");
  let storageThrows = false;
  class Element {
    constructor() { this.attrs = new Map(); this.isConnected = true; this.output = ""; }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    setAttribute(name, value) {
      const old = this.getAttribute(name);
      this.attrs.set(name, value);
      this.attributeChangedCallback(name, old, value);
    }
    replaceChildren(...children) { this.output = children.map((child) => child.textContent).join(""); }
    set innerHTML(value) { this.output = value; }
  }
  const localStorage = {
    getItem(key) { if (storageThrows) throw new Error("storage denied"); return storage.get(key) ?? null; },
    setItem(key, value) { if (storageThrows) throw new Error("quota"); storage.set(key, value); },
    removeItem(key) { if (storageThrows) throw new Error("storage denied"); storage.delete(key); },
  };
  const context = vm.createContext({
    HTMLElement: Element, customElements: { define(_name, component) { registered = component; } },
    document: { baseURI: "https://fixture.test/page", createElement() { return { textContent: "", style: {}, setAttribute() {} }; } },
    crypto: webcrypto, TextEncoder, URL, AbortController, setTimeout, clearTimeout, localStorage,
    Date: class extends Date { static now() { return now; } },
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher(url, options); },
  });
  vm.runInContext(source, context);
  const element = new registered();
  element.attrs = new Map(Object.entries({ api: "https://delivery.test/", channel: "public", module: "standort", token: "public-fixture-token-a" }));
  return {
    element, storage, requests, context, registered,
    fetchWith(fn) { fetcher = fn; },
    advance(ms) { now += ms; },
    denyStorage() { storageThrows = true; },
  };
}

test("token, API, channel and type changes cannot reuse another scope, including legacy cache", async () => {
  const h = harness();
  await h.element.render();
  const firstKey = [...h.storage.keys()][0];
  assert.match(firstKey, /^sitegraph:v2:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify([...h.storage]).includes("public-fixture-token-a"));
  for (const [attribute, value] of [["token", "public-fixture-token-b"], ["api", "https://other.test"], ["channel", "other"], ["module", "job"]]) {
    const original = h.element.attrs.get(attribute);
    h.element.attrs.set(attribute, value);
    h.fetchWith(async () => response("", 503));
    await h.element.render();
    assert.ok(!h.element.output.includes("First"), attribute);
    assert.match(h.element.output, /nicht verfügbar/);
    h.element.attrs.set(attribute, original);
  }
  h.storage.clear();
  h.storage.set("sitegraph:public:standort", JSON.stringify(data("Legacy").items));
  await h.element.render();
  assert.ok(!h.element.output.includes("Legacy"));
  assert.equal(h.requests[0].options.cache, "no-store");
  assert.equal(h.requests[0].options.redirect, "manual");
});

test("network and 5xx use visible bounded fallback without renewing its age", async () => {
  const h = harness();
  await h.element.render();
  h.advance(14 * 60 * 1000);
  h.fetchWith(async () => { throw new Error("network failure"); });
  await h.element.render();
  assert.match(h.element.output, /First/);
  assert.match(h.element.output, /gespeicherte Version/);
  assert.match(h.element.output, /role="status"/);
  h.fetchWith(async () => response("", 503));
  await h.element.render();
  assert.match(h.element.output, /First/);
  h.advance(60 * 1000);
  await h.element.render();
  assert.match(h.element.output, /nicht verfügbar/);
  assert.equal(h.storage.size, 0);
});

test("401/403/404 and every other non-5xx error discard cache, including for subsequent outages", async () => {
  for (const status of [301, 400, 401, 403, 404, 408, 429]) {
    const h = harness();
    await h.element.render();
    h.fetchWith(async () => response("", status));
    await h.element.render();
    assert.match(h.element.output, /nicht verfügbar/);
    assert.equal(h.storage.size, 0, `HTTP ${status}`);
    h.fetchWith(async () => response("", 503));
    await h.element.render();
    assert.ok(!h.element.output.includes("First"));
  }
});

test("malformed successful responses are errors; empty publication replaces old content", async () => {
  for (const json of [async () => { throw new SyntaxError("<img src=x onerror=evil()>"); }, async () => ({}), async () => ({ items: [null] })]) {
    const h = harness();
    await h.element.render();
    h.fetchWith(async () => ({ ok: true, status: 200, json }));
    await h.element.render();
    assert.match(h.element.output, /nicht verfügbar/);
    assert.equal(h.storage.size, 0);
    assert.ok(!h.element.output.includes("<img"));
  }
  const h = harness();
  await h.element.render();
  h.fetchWith(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }));
  await h.element.render();
  h.fetchWith(async () => response("", 503));
  await h.element.render();
  assert.match(h.element.output, /Keine Inhalte/);
  assert.ok(!h.element.output.includes("First"));
});

test("storage failures, corrupt or future-dated snapshots and unavailable Web Crypto are contained", async () => {
  const h = harness();
  await h.element.render();
  const key = [...h.storage.keys()][0];
  h.storage.set(key, "{broken");
  h.fetchWith(async () => response("", 503));
  await h.element.render();
  assert.match(h.element.output, /nicht verfügbar/);
  assert.equal(h.storage.size, 0);
  h.fetchWith(async () => response("Fresh"));
  await h.element.render();
  h.advance(-1000);
  h.fetchWith(async () => response("", 503));
  await h.element.render();
  assert.match(h.element.output, /nicht verfügbar/);
  h.denyStorage();
  h.fetchWith(async () => response("Live despite storage denial"));
  await h.element.render();
  assert.match(h.element.output, /Live despite storage denial/);
  h.fetchWith(async () => { throw new Error("<img src=x onerror=evil()>"); });
  await h.element.render();
  assert.match(h.element.output, /nicht verfügbar/);
  assert.ok(!h.element.output.includes("<img"));
  const noCrypto = harness();
  noCrypto.context.crypto = undefined;
  await noCrypto.element.render();
  assert.match(noCrypto.element.output, /First/);
  assert.equal(noCrypto.storage.size, 0);
});

test("attribute changes abort the old request and late responses cannot repaint or cache another scope", async () => {
  const h = harness();
  const oldResponse = deferred();
  h.fetchWith((_url, { headers }) => headers.Authorization.endsWith("-a") ? oldResponse.promise : response("New scope"));
  const first = h.element.render();
  await until(() => h.requests.length >= 1);
  h.element.setAttribute("token", "public-fixture-token-b");
  assert.ok(h.requests[0].options.signal.aborted);
  assert.match(h.element.output, /geladen/);
  await until(() => h.element.output.includes("New scope"));
  oldResponse.resolve(response("Old scope must disappear"));
  await first;
  assert.match(h.element.output, /New scope/);
  assert.ok(!JSON.stringify([...h.storage]).includes("Old scope"));
  assert.equal(h.storage.size, 1);
});

test("late JSON and disconnected requests cannot update the view or persist a snapshot", async () => {
  const h = harness();
  const json = deferred();
  h.fetchWith(async () => ({ ok: true, status: 200, json: () => json.promise }));
  const pending = h.element.render();
  await until(() => h.requests.length >= 1);
  h.element.isConnected = false;
  h.element.disconnectedCallback();
  json.resolve(data("Detached old value"));
  await pending;
  assert.ok(h.requests[0].options.signal.aborted);
  assert.equal(h.storage.size, 0);
  assert.ok(!h.element.output.includes("Detached"));
});

test("request timeout uses the same bounded outage fallback", async () => {
  const h = harness();
  await h.element.render();
  h.registered.REQUEST_TIMEOUT_MS = 10;
  h.fetchWith((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })));
  await h.element.render();
  assert.match(h.element.output, /First/);
  assert.match(h.element.output, /gespeicherte Version/);
});
