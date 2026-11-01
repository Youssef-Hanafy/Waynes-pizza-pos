import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

type Event = Record<string, unknown>;
function worker(fetchImpl: typeof fetch = vi.fn().mockRejectedValue(new Error("offline"))) {
  const listeners: Record<string, (e: Event) => void> = {};
  const names = new Set(["wayne-pos-v1-pages", "wayne-pos-v1-static", "wayne-pos-v1-meta", "wayne-pos-v0-pages", "orders", "payment-outbox"]);
  const caches = { keys: async () => [...names], delete: async (name: string) => names.delete(name) };
  const self = { location: { origin: "https://app.example.com" }, addEventListener: (name: string, fn: (e: Event) => void) => { listeners[name] = fn; }, skipWaiting: vi.fn(), clients: { claim: vi.fn() } };
  new Function("self", "caches", "fetch", readFileSync(new URL("../public/pos-sw.js", import.meta.url), "utf8"))(self, caches, fetchImpl);
  return { listeners, names, self };
}
function navigate(w: ReturnType<typeof worker>, path = "/pos", mode = "navigate", method = "GET") {
  let response: Promise<Response> | undefined;
  const request = new Request(`https://app.example.com${path}`, { method });
  Object.defineProperty(request, "mode", { value: mode });
  w.listeners.fetch!({ request, respondWith: (r: Promise<Response>) => { response = r; } });
  return response;
}
async function stage(w: ReturnType<typeof worker>, path: string, build = "B") {
  let pending: Promise<void> | undefined;
  const reply = vi.fn();
  w.listeners.message!({ data: { type: "wayne-stage", path, build }, ports: [{ postMessage: reply }], waitUntil: (p: Promise<void>) => { pending = p; } });
  await pending;
  return reply.mock.calls[0]![0];
}
const page = (build = "B") => new Response(`<meta name="wayne-build" content="${build}">current POS`, { headers: { "content-type": "text/html", "x-wayne-server-build": build } });

describe("network-only POS worker", () => {
  it("replaces installed workers and removes only disposable frontend caches", async () => {
    const w = worker(); let pending: Promise<void> | undefined;
    w.listeners.install!({}); expect(w.self.skipWaiting).toHaveBeenCalledOnce();
    w.listeners.activate!({ waitUntil: (p: Promise<void>) => { pending = p; } }); await pending;
    expect([...w.names]).toEqual(["orders", "payment-outbox"]); expect(w.self.clients.claim).toHaveBeenCalledOnce();
  });
  it.each(["/pos", "/pos?wayne_update=B", "/pos?shortcut=1", "/pos/display", "/pos/admin-pin"])("always fetches %s without cache", async path => {
    const fetcher = vi.fn().mockResolvedValue(page()); const w = worker(fetcher);
    expect(await (await navigate(w, path))!.text()).toContain("current POS");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
    expect([...w.names]).toContain("orders");
  });
  it("disconnection/restart shows recovery, never a saved design; reconnect fetches live UI", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page("A")).mockRejectedValueOnce(Error("offline")).mockResolvedValueOnce(page("B"));
    const w = worker(fetcher);
    expect(await (await navigate(w))!.text()).toContain('content="A"');
    const offline = (await navigate(w))!;
    expect(offline.status).toBe(503); expect(offline.headers.get("cache-control")).toBe("no-store");
    expect(await offline.text()).toContain("Can't reach the POS");
    expect(await (await navigate(w))!.text()).toContain('content="B"');
  });
  it.each([401, 403, 404, 500, 503])("preserves server status %s and authentication responses", async status => {
    const w = worker(vi.fn().mockResolvedValue(new Response("server response", { status })));
    expect((await navigate(w))!.status).toBe(status);
  });
  it("never intercepts assets, RSC requests, APIs, mutations, or other sites", () => {
    const w = worker();
    for (const path of ["/_next/static/old.js", "/api/pos/payments", "/login", "/pos-old"]) expect(navigate(w, path)).toBeUndefined();
    expect(navigate(w, "/pos?_rsc=1", "cors")).toBeUndefined();
    expect(navigate(w, "/pos", "navigate", "POST")).toBeUndefined();
    const reply = vi.fn(); w.listeners.fetch!({ request: { url: "https://elsewhere.example/pos", method: "GET", mode: "navigate" }, respondWith: reply }); expect(reply).not.toHaveBeenCalled();
  });
  it("preflight verifies the exact target without keeping an HTML bundle", async () => {
    expect(await stage(worker(vi.fn().mockResolvedValue(page())), "/pos")).toMatchObject({ ok: true, build: "B" });
    expect(await stage(worker(vi.fn().mockResolvedValue(page("A"))), "/pos")).toMatchObject({ ok: false });
    expect(await stage(worker(), "/pos")).toMatchObject({ ok: false });
    for (const path of ["/pos-old", "//evil.example/pos", "https://evil.example/pos"]) expect(await stage(worker(), path)).toMatchObject({ ok: false });
  });
});
