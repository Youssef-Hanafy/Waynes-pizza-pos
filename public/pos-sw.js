/* Offline HTML is network-first. Build stamps order cache writes, not response completion time.
 * Keep existing cache namespaces and drafts; a worker activation never reloads a page.
 */
const VERSION = "wayne-pos-v1";
const WORKER = "pos-sw 3 (2026-10-30)";
const PAGES = `${VERSION}-pages`;
const STATIC = `${VERSION}-static`;
const MAX_STATIC = 400;
const PAGE_TIMEOUT_MS = 10000;
const SAVED_AT = "x-wayne-saved-at";
// Pages (client ids) this worker opened from the saved copy, and when that copy was saved.
const servedOffline = new Map();

self.addEventListener("install", () => { self.skipWaiting(); });

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("wayne-pos-") && !name.startsWith(VERSION)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

function isPosPage(url) {
  return url.pathname === "/pos" || url.pathname.startsWith("/pos/");
}

async function trimStatic() {
  const cache = await caches.open(STATIC);
  const keys = await cache.keys();
  for (let index = 0; index < keys.length - MAX_STATIC; index += 1) await cache.delete(keys[index]);
}

let pageWrites = Promise.resolve();
async function page(request, clientId, event) {
  const url = new URL(request.url);
  const key = `${url.origin}${url.pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    // Only a real POS page is kept (never a sign-in redirect or an error page).
    const finalUrl = new URL(response.url || request.url);
    if (response.ok && !response.redirected && isPosPage(finalUrl) && (response.headers.get("content-type") || "").includes("text/html")) {
      const copy = response.clone();
      // Serialize read/compare/write: a delayed old response must never replace a newer copy.
      const save = pageWrites = pageWrites.catch(() => undefined).then(async () => {
        const html = await copy.text();
        const headers = new Headers(copy.headers);
        const htmlBuild = /name="wayne-build" content="([^"]+)"/.exec(html)?.[1];
        const htmlAt = /name="wayne-built-at" content="([^"]+)"/.exec(html)?.[1];
        if (htmlBuild && headers.get("x-wayne-server-build") && htmlBuild !== headers.get("x-wayne-server-build")) return;
        const builtAt = htmlAt || headers.get("x-wayne-server-built-at") || "";
        const build = htmlBuild || headers.get("x-wayne-server-build") || "";
        const cache = await caches.open(PAGES);
        const previous = await cache.match(key);
        if ((Date.parse(previous?.headers.get("x-wayne-server-built-at") || "") || 0) > (Date.parse(builtAt) || 0)) return;
        headers.set("x-wayne-server-built-at",builtAt); headers.set("x-wayne-server-build",build);
        headers.set(SAVED_AT, new Date().toISOString());
        await cache.put(key, new Response(html, { status: 200, headers }));
      });
      event.waitUntil(save.catch(() => undefined));
    }
    return response;
  } catch (error) {
    clearTimeout(timer);
    const saved = await caches.match(key, { cacheName: PAGES });
    // A requested verified update must never silently fall back to an older build.
    if (saved && (!url.searchParams.has("wayne_update") || saved.headers.get("x-wayne-server-build") === url.searchParams.get("wayne_update"))) {
      if (clientId) {
        servedOffline.set(clientId, saved.headers.get(SAVED_AT) || "");
        if (servedOffline.size > 20) servedOffline.delete(servedOffline.keys().next().value);
      }
      return saved;
    }
    throw error;
  }
}

function validAsset(request,response) {
 const mime = response.headers.get("content-type") || "";
 return new URL(request.url).pathname.endsWith(".css") ? mime.includes("text/css") : new URL(request.url).pathname.endsWith(".js") ? /javascript/.test(mime) : !mime.includes("text/html");
}
async function staticFile(request,event) {
  const cache = await caches.open(STATIC);
  const saved = await cache.match(request);
  if (saved && validAsset(request,saved)) return saved;
  if (saved) await cache.delete(request);
  const response = await fetch(request);
  if (response.ok && response.type === "basic" && validAsset(request,response)) {
    event.waitUntil(cache.put(request, response.clone()).then(trimStatic).catch(() => undefined));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Server-component refreshes (?_rsc / RSC header) always go to the server.
  if (url.searchParams.has("_rsc") || request.headers.get("RSC") === "1") return;
  if (request.mode === "navigate" && isPosPage(url)) { event.respondWith(page(request, event.resultingClientId, event)); return; }
  if (url.pathname.startsWith("/_next/static/")) { event.respondWith(staticFile(request,event)); return; }
});

// The POS asks once it has started: "was I opened from the saved copy?"
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "wayne-ask-offline" || !event.source) return;
  const id = event.source.id;
  const offline = servedOffline.has(id);
  event.source.postMessage({ type: "wayne-offline-copy", offline, savedAt: offline ? servedOffline.get(id) : "", version: WORKER });
});
