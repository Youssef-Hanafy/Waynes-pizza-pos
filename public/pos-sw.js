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
 *
 * v2 (owner, 2026-10-28: "the POS would switch between older and newer
 * versions"): the saved copy is only ever the newest page this register
 * loaded, stamped with when it was saved, and a page opened from it is told so
 * (message "wayne-offline-copy") — the POS shows it and reloads onto the
 * current build the moment the server answers.  A server error page (5xx) is
 * passed through as before, never swapped for the saved copy; only "no answer
 * at all" (no connection, or nothing within 10 s) opens the copy.
 */
// The cache names stay "v1": changing them would throw away the saved copy and the
// app's code files on the update, leaving the register unable to open offline
// until it was opened online again.  WORKER is this worker's own version.
const VERSION = "wayne-pos-v1";
const WORKER = "pos-sw 2 (2026-10-28)";
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

async function page(request, clientId) {
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
      copy.text().then((html) => {
        const headers = new Headers(copy.headers);
        headers.set(SAVED_AT, new Date().toISOString());
        return caches.open(PAGES).then((cache) => cache.put(key, new Response(html, { status: 200, headers })));
      }).catch(() => undefined);
    }
    return response;
  } catch (error) {
    clearTimeout(timer);
    const saved = await caches.match(key, { cacheName: PAGES });
    if (saved) {
      if (clientId) {
        servedOffline.set(clientId, saved.headers.get(SAVED_AT) || "");
        if (servedOffline.size > 20) servedOffline.delete(servedOffline.keys().next().value);
      }
      return saved;
    }
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
  if (request.mode === "navigate" && isPosPage(url)) { event.respondWith(page(request, event.resultingClientId)); return; }
  if (url.pathname.startsWith("/_next/static/")) { event.respondWith(staticFile(request)); return; }
});

// The POS asks once it has started: "was I opened from the saved copy?"
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "wayne-ask-offline" || !event.source) return;
  const id = event.source.id;
  const offline = servedOffline.has(id);
  event.source.postMessage({ type: "wayne-offline-copy", offline, savedAt: offline ? servedOffline.get(id) : "", version: WORKER });
});
