import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * public/pos-sw.js — old/new switching regression (owner, 2026-10-31).
 * Reproduced in a real browser (e2e/screen-stability-local.spec.ts): with a slow
 * store connection during a deployment, the worker answered every retry with its
 * saved copy of the OLD build, and after two failed attempts the register stayed on
 * the old screens.  The worker must now:
 *   • never open a saved copy older than the newest build known live just because the
 *     server is slow — only when the server cannot be reached at all;
 *   • stage an update target (page + code) on request, refusing a different build;
 *   • let a staged target stand in for a slow server during the update reload.
 */
type Listener = (event: Record<string, unknown>) => void;
const ORIGIN = "https://app.example.com";

function loadWorker(fetchImpl: (request: Request) => Promise<Response>) {
  const listeners: Record<string, Listener[]> = {};
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async put(key: string | Request, response: Response) { store.set(typeof key === "string" ? key : key.url, response); },
        async match(key: string | Request) { return store.get(typeof key === "string" ? key : key.url)?.clone(); },
        async keys() { return [...store.keys()].map((url) => new Request(url)); },
        async delete(key: string | Request) { return store.delete(typeof key === "string" ? key : key.url); },
      };
    },
    async match(key: string, options: { cacheName: string }) { return stores.get(options.cacheName)?.get(key)?.clone(); },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
  };
  const self = { location: { origin: ORIGIN }, addEventListener: (type: string, listener: Listener) => { (listeners[type] ??= []).push(listener); }, skipWaiting: () => undefined, clients: { claim: async () => undefined } };
  const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input instanceof Request ? input : new Request(String(input), init)));
  new Function("self", "caches", "fetch", readFileSync(new URL("../public/pos-sw.js", import.meta.url), "utf8"))(self, caches, fetchSpy);
  const pending: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => { pending.push(promise); };
  return { listeners, stores, fetchSpy, waitUntil, drain: async () => { while (pending.length) await pending.shift(); } };
}
type Worker = ReturnType<typeof loadWorker>;

function navigate(worker: Worker, url: string, clientId = "client") {
  let responded: Promise<Response> | null = null;
  const request = new Request(url, { headers: { accept: "text/html" } });
  Object.defineProperty(request, "mode", { value: "navigate" });
  worker.listeners.fetch![0]!({ request, resultingClientId: clientId, waitUntil: worker.waitUntil, respondWith: (promise: Promise<Response>) => { responded = promise; } });
  return responded! as Promise<Response>;
}
function message(worker: Worker, data: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve) => {
    worker.listeners.message![0]!({ data, ports: [{ postMessage: resolve }], waitUntil: worker.waitUntil, source: { id: "client", postMessage: resolve } });
  });
}
const html = (build: string, builtAt: string, assets: string[] = []) => new Response(
  `<html><head><meta name="wayne-build" content="${build}"><meta name="wayne-built-at" content="${builtAt}"></head><body>${build}${assets.map((a) => `<script src="${a}"></script>`).join("")}</body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8", "x-wayne-server-build": build, "x-wayne-server-built-at": builtAt } });
const js = () => { const r = new Response("console.log(1)", { headers: { "content-type": "text/javascript" } }); Object.defineProperty(r, "type", { value: "basic" }); return r; };
const A_AT = "2026-10-30T13:00:00Z", B_AT = "2026-10-31T22:17:00Z";
const never = () => new Promise<Response>(() => undefined);

afterEach(() => vi.useRealTimers());

describe("offline worker never brings back an older build", () => {
  it("slow server + saved copy OLDER than the known live build: waits for the server instead of opening the old copy", async () => {
    let mode: "A" | "slowB" = "A";
    const worker = loadWorker(async () => (mode === "A" ? html("A", A_AT) : new Promise<Response>((resolve) => setTimeout(() => resolve(html("B", B_AT)), 12_000))));
    await (await navigate(worker, `${ORIGIN}/pos`)).text(); await worker.drain();
    // The page learned B is live (its update manager tells the worker).
    worker.listeners.message![0]!({ data: { type: "wayne-high-water", build: "B", builtAt: B_AT }, waitUntil: worker.waitUntil });
    await worker.drain();
    mode = "slowB";
    vi.useFakeTimers();
    const opened = navigate(worker, `${ORIGIN}/pos`);
    await vi.advanceTimersByTimeAsync(11_000);
    let settled = false; void opened.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // the old copy was NOT served at the 10 s mark
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await (await opened).text()).toContain(">B");
  });

  it("slow server + saved copy IS the newest build: the saved copy still stands in after 10 s (offline register unchanged)", async () => {
    let slow = false;
    const worker = loadWorker(async () => (slow ? never() : html("B", B_AT)));
    await (await navigate(worker, `${ORIGIN}/pos`)).text(); await worker.drain();
    slow = true;
    vi.useFakeTimers();
    const opened = navigate(worker, `${ORIGIN}/pos`);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await (await opened).text()).toContain(">B");
  });

  it("no connection at all + only an older copy: opened as a last resort and flagged stale (orders can still be taken)", async () => {
    let online = true;
    const worker = loadWorker(async () => { if (!online) throw new TypeError("Failed to fetch"); return html("A", A_AT); });
    await (await navigate(worker, `${ORIGIN}/pos`)).text(); await worker.drain();
    worker.listeners.message![0]!({ data: { type: "wayne-high-water", build: "B", builtAt: B_AT }, waitUntil: worker.waitUntil }); await worker.drain();
    online = false;
    expect(await (await navigate(worker, `${ORIGIN}/pos`, "offline-client")).text()).toContain(">A");
    const answer = await new Promise<Record<string, unknown>>((resolve) => worker.listeners.message![0]!({ data: { type: "wayne-ask-offline" }, source: { id: "offline-client", postMessage: resolve } }));
    expect(answer).toMatchObject({ offline: true, stale: true });
  });

  it("an update target never falls back to a different build", async () => {
    let online = true;
    const worker = loadWorker(async () => { if (!online) throw new TypeError("Failed to fetch"); return html("A", A_AT); });
    await (await navigate(worker, `${ORIGIN}/pos`)).text(); await worker.drain();
    online = false;
    await expect(navigate(worker, `${ORIGIN}/pos?wayne_update=B`)).rejects.toThrow();
  });
});

describe("staging the update target", () => {
  it("saves the target page and every code file it names, then the slow update reload opens the staged target after 4 s", async () => {
    let slow = false;
    const worker = loadWorker(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_next/static/")) return js();
      if (slow && !request.headers.get("x-wayne-stage")) return never();
      return url.searchParams.has("x") ? html("A", A_AT) : html("B", B_AT, ["/_next/static/immutable/chunks/b1.js", "/_next/static/immutable/chunks/b2.js"]);
    });
    const answer = await message(worker, { type: "wayne-stage", path: "/pos", build: "B", builtAt: B_AT });
    expect(answer).toEqual({ ok: true, build: "B" });
    const statics = [...(worker.stores.get("wayne-pos-v1-static")?.keys() ?? [])];
    expect(statics).toEqual(expect.arrayContaining([`${ORIGIN}/_next/static/immutable/chunks/b1.js`, `${ORIGIN}/_next/static/immutable/chunks/b2.js`]));
    slow = true;
    vi.useFakeTimers();
    const opened = navigate(worker, `${ORIGIN}/pos?wayne_update=B`);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(await (await opened).text()).toContain(">B");
  });

  it("refuses to stage when the server answers with a different build (alias moved on)", async () => {
    const worker = loadWorker(async () => html("C", "2026-10-31T22:30:00Z"));
    expect(await message(worker, { type: "wayne-stage", path: "/pos", build: "B", builtAt: B_AT })).toMatchObject({ ok: false, build: "C" });
  });

  it("refuses to stage a sign-in redirect or an error page", async () => {
    const worker = loadWorker(async () => new Response("<html>sign in</html>", { status: 500, headers: { "content-type": "text/html" } }));
    expect(await message(worker, { type: "wayne-stage", path: "/pos", build: "B", builtAt: B_AT })).toMatchObject({ ok: false });
    expect(worker.stores.get("wayne-pos-v1-pages")?.size ?? 0).toBe(0);
  });

  it("a missing code file fails the stage (the target would not open offline)", async () => {
    const worker = loadWorker(async (request) => new URL(request.url).pathname.startsWith("/_next/") ? new Response("missing", { status: 404, headers: { "content-type": "text/plain" } }) : html("B", B_AT, ["/_next/static/immutable/chunks/gone.js"]));
    expect(await message(worker, { type: "wayne-stage", path: "/pos", build: "B", builtAt: B_AT })).toMatchObject({ ok: false });
  });

  it("only stages POS pages", async () => {
    const worker = loadWorker(async () => html("B", B_AT));
    expect(await message(worker, { type: "wayne-stage", path: "/admin", build: "B", builtAt: B_AT })).toMatchObject({ ok: false });
  });
});
