import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * public/pos-sw.js (owner, 2026-10-28: the POS "switching between older and
 * newer versions").  The worker must:
 *   • always take the POS page from the server when it answers (any status)
 *   • open the saved copy only when the server can't be reached at all
 *   • tell that page it is the saved copy, with when it was saved
 *   • keep its cache names, so an update never throws the offline copy away
 */
type Listener = (event: Record<string, unknown>) => void;

function loadWorker(fetchImpl: (request: Request) => Promise<Response>) {
  const listeners: Record<string, Listener[]> = {};
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async put(key: string | Request, response: Response) { store.set(typeof key === "string" ? key : key.url, response); },
        async match(key: string | Request) { const hit = store.get(typeof key === "string" ? key : key.url); return hit?.clone(); },
        async keys() { return [...store.keys()].map((url) => new Request(url)); },
        async delete(key: string | Request) { return store.delete(typeof key === "string" ? key : key.url); },
      };
    },
    async match(key: string, options: { cacheName: string }) { return stores.get(options.cacheName)?.get(key)?.clone(); },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
  };
  const self = {
    location: { origin: "https://app.example.com" },
    addEventListener: (type: string, listener: Listener) => { (listeners[type] ??= []).push(listener); },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const source = readFileSync(new URL("../public/pos-sw.js", import.meta.url), "utf8");
  new Function("self", "caches", "fetch", source)(self, caches, fetchImpl);
  return { listeners, stores };
}

async function navigate(worker: ReturnType<typeof loadWorker>, url: string, clientId = "client-1") {
  let responded: Promise<Response> | null = null;
  const request = new Request(url, { headers: { accept: "text/html" } });
  Object.defineProperty(request, "mode", { value: "navigate" });
  worker.listeners.fetch![0]!({ request, resultingClientId: clientId, waitUntil: () => undefined, respondWith: (promise: Promise<Response>) => { responded = promise; } });
  if (!responded) throw new Error("the worker did not answer the POS page");
  return responded as Promise<Response>;
}

async function ask(worker: ReturnType<typeof loadWorker>, clientId: string) {
  let answer: Record<string, unknown> | null = null;
  worker.listeners.message![0]!({ data: { type: "wayne-ask-offline" }, source: { id: clientId, postMessage: (message: Record<string, unknown>) => { answer = message; } } });
  return answer as unknown as { offline: boolean; savedAt: string; version: string };
}

const page = (text: string, status = 200) => new Response(`<html>${text}</html>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("POS offline worker", () => {
  it("online: the server's page, and it is kept as the saved copy (stamped)", async () => {
    const worker = loadWorker(async () => page("build B"));
    const response = await navigate(worker, "https://app.example.com/pos");
    expect(await response.text()).toBe("<html>build B</html>");
    await settle();
    const saved = worker.stores.get("wayne-pos-v1-pages")?.get("https://app.example.com/pos");
    expect(saved).toBeDefined();
    expect(saved!.headers.get("x-wayne-saved-at")).toBeTruthy();
    expect((await ask(worker, "client-1")).offline).toBe(false);
  });

  it("no connection: opens the saved copy and tells the page so", async () => {
    let online = true;
    const worker = loadWorker(async () => { if (!online) throw new TypeError("Failed to fetch"); return page("build B"); });
    await navigate(worker, "https://app.example.com/pos", "first");
    await settle();
    online = false;
    const response = await navigate(worker, "https://app.example.com/pos", "second");
    expect(await response.text()).toBe("<html>build B</html>");
    const answer = await ask(worker, "second");
    expect(answer.offline).toBe(true);
    expect(answer.savedAt).toBeTruthy();
    expect(answer.version).toContain("pos-sw 3");
  });

  it("a server error page is shown as it is — never swapped for an older saved copy", async () => {
    let fail = false;
    const worker = loadWorker(async () => (fail ? page("error", 500) : page("build A")));
    await navigate(worker, "https://app.example.com/pos");
    await settle();
    fail = true;
    const response = await navigate(worker, "https://app.example.com/pos", "third");
    expect(response.status).toBe(500);
    expect((await ask(worker, "third")).offline).toBe(false);
    // …and the error page is not saved over the good copy.
    await settle();
    expect(await worker.stores.get("wayne-pos-v1-pages")!.get("https://app.example.com/pos")!.clone().text()).toBe("<html>build A</html>");
  });

  it("delayed old HTML cannot overwrite the newer offline build", async () => {
    let finishOld!: (response:Response)=>void;
    let calls=0;
    const stamped=(build:string,day:number)=>new Response(`<html>${build}</html>`,{headers:{"content-type":"text/html","x-wayne-server-build":build,"x-wayne-server-built-at":`2026-10-${day}T00:00:00Z`}});
    const worker=loadWorker(async()=>{calls++;if(calls===1)return new Promise<Response>(resolve=>{finishOld=resolve;});return stamped("B",22);});
    const old=navigate(worker,"https://app.example.com/pos");
    await navigate(worker,"https://app.example.com/pos");await settle();
    finishOld(stamped("A",21));await old;await settle();
    expect(await worker.stores.get("wayne-pos-v1-pages")!.get("https://app.example.com/pos")!.clone().text()).toBe("<html>B</html>");
  });

  it("verified target navigation cannot fall back to older offline HTML", async () => {
    let online=true;
    const worker=loadWorker(async()=>{if(!online)throw Error("offline");return new Response("<html>A</html>",{headers:{"content-type":"text/html","x-wayne-server-build":"A"}});});
    await navigate(worker,"https://app.example.com/pos");await settle();online=false;
    await expect(navigate(worker,"https://app.example.com/pos?wayne_update=B")).rejects.toThrow("offline");
  });

  it("never caches HTML masquerading as a JavaScript or CSS asset", async () => {
    const worker=loadWorker(async()=>{const r=page("bad asset");Object.defineProperty(r,"type",{value:"basic"});return r;});
    for(const file of ["chunk.js","layout.css"]){
      let pending!:Promise<Response>;
      worker.listeners.fetch![0]!({waitUntil:()=>undefined,request:new Request(`https://app.example.com/_next/static/${file}?dpl=B`),respondWith:(p:Promise<Response>)=>{pending=p;}});
      await pending;await settle();
    }
    expect(worker.stores.get("wayne-pos-v1-static")?.size).toBe(0);
  });

  it("keeps the v1 cache names, so updating the worker keeps the offline copy", () => {
    const source = readFileSync(new URL("../public/pos-sw.js", import.meta.url), "utf8");
    expect(source).toContain('const VERSION = "wayne-pos-v1";');
  });
});
