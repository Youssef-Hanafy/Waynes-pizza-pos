/*
 * Wayne's POS — keeps the register screen available with no connection
 * (owner, 2026-10-24: "even when not connected to wifi it'll work and once it
 * reconnects it'll put everything that happened online").
 *
 * Only for the POS pages (registered with scope /pos):
 *   • the POS page itself: always fetched from the server first, exactly as
 *     before; the last good copy is kept, and shown only when the server
 *     can't be reached at all — so it is never an older build while online
 *   • the app's code files (/_next/static/…, which never change under the
 *     same name): kept once loaded, so the page can start offline
 * Everything else (orders, payments, the API) always goes to the server.
 * Tickets taken offline are kept by the page itself and sent when it is back.
 */
const VERSION = "wayne-pos-v1";
const PAGES = `${VERSION}-pages`;
const STATIC = `${VERSION}-static`;
const MAX_STATIC = 400;
const PAGE_TIMEOUT_MS = 10000;

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

async function page(request) {
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
      caches.open(PAGES).then((cache) => cache.put(key, copy)).catch(() => undefined);
    }
    return response;
  } catch (error) {
    clearTimeout(timer);
    const saved = await caches.match(key, { cacheName: PAGES });
    if (saved) return saved;
    throw error;
  }
}

async function staticFile(request) {
  const cache = await caches.open(STATIC);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    cache.put(request, response.clone()).then(trimStatic).catch(() => undefined);
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
  if (request.mode === "navigate" && isPosPage(url)) { event.respondWith(page(request)); return; }
  if (url.pathname.startsWith("/_next/static/")) { event.respondWith(staticFile(request)); return; }
});
