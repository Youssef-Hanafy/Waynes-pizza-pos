/* Offline HTML is network-first. Build stamps order cache writes, not response completion time.
 * Keep existing cache namespaces and drafts; a worker activation never reloads a page.
 *
 * 2026-10-31 (Elo switched back to the OLD screens after two quick releases):
 *   • the worker remembers the newest build the register has seen live (high water);
 *   • a saved copy OLDER than that is never opened just because the server is slow —
 *     only when the server genuinely cannot be reached (last-resort offline register);
 *   • before an update reload the page asks the worker to stage the target build
 *     ("wayne-stage"): its page and code are saved first, so the reload — and every
 *     later restart or "Can't reach the POS" retry — opens the NEW build even on a
 *     slow or dropping connection.
 */
const VERSION = "wayne-pos-v1";
const WORKER = "pos-sw 4 (2026-10-31)";
const PAGES = `${VERSION}-pages`;
const STATIC = `${VERSION}-static`;
const META = `${VERSION}-meta`;
const HIGH_WATER_KEY = "/__wayne-pos/high-water";
const MAX_STATIC = 400;
/** A saved copy of the newest known build may stand in after this long. */
const PAGE_TIMEOUT_MS = 10000;
/** The staged target of an update reload may stand in after this long. */
const TARGET_TIMEOUT_MS = 4000;
/** The network attempt is abandoned after this long. */
const NETWORK_LIMIT_MS = 45000;
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
const time = (value) => Date.parse(value || "") || 0;

async function trimStatic() {
  const cache = await caches.open(STATIC);
  const keys = await cache.keys();
  for (let index = 0; index < keys.length - MAX_STATIC; index += 1) await cache.delete(keys[index]);
}

// ---- High water: the newest build this register has seen live ----
let highWaterWrites = Promise.resolve();
async function highWater() {
  try {
    const saved = await (await caches.open(META)).match(HIGH_WATER_KEY);
    return saved ? await saved.json() : null;
  } catch { return null; }
}
function raiseHighWater(build, builtAt) {
  if (!build || !time(builtAt)) return Promise.resolve();
  highWaterWrites = highWaterWrites.catch(() => undefined).then(async () => {
    const current = await highWater();
    if (current && time(current.builtAt) >= time(builtAt)) return;
    await (await caches.open(META)).put(HIGH_WATER_KEY, new Response(JSON.stringify({ build, builtAt }), { headers: { "content-type": "application/json" } }));
  });
  return highWaterWrites;
}

// ---- Saved pages ----
let pageWrites = Promise.resolve();
/** Serialized read/compare/write: a delayed old response must never replace a newer copy. Resolves to the saved build or "". */
function savePage(key, response) {
  const copy = response.clone();
  const save = pageWrites = pageWrites.catch(() => undefined).then(async () => {
    const html = await copy.text();
    const headers = new Headers(copy.headers);
    const htmlBuild = /name="wayne-build" content="([^"]+)"/.exec(html)?.[1];
    const htmlAt = /name="wayne-built-at" content="([^"]+)"/.exec(html)?.[1];
    if (htmlBuild && headers.get("x-wayne-server-build") && htmlBuild !== headers.get("x-wayne-server-build")) return "";
    const builtAt = htmlAt || headers.get("x-wayne-server-built-at") || "";
    const build = htmlBuild || headers.get("x-wayne-server-build") || "";
    await raiseHighWater(build, builtAt);
    const cache = await caches.open(PAGES);
    const previous = await cache.match(key);
    if (time(previous?.headers.get("x-wayne-server-built-at")) > time(builtAt)) return "";
    headers.set("x-wayne-server-built-at", builtAt); headers.set("x-wayne-server-build", build);
    headers.set(SAVED_AT, new Date().toISOString());
    await cache.put(key, new Response(html, { status: 200, headers }));
    return build;
  });
  return save.then((build) => ({ build, html: "" }), () => ({ build: "", html: "" }));
}
function keepable(response, request) {
  const finalUrl = new URL(response.url || request.url);
  // Only a real POS page is kept (never a sign-in redirect or an error page).
  return response.ok && response.status === 200 && !response.redirected && isPosPage(finalUrl) && (response.headers.get("content-type") || "").includes("text/html");
}

function served(clientId, saved, stale) {
  if (!clientId) return;
  servedOffline.set(clientId, { savedAt: saved.headers.get(SAVED_AT) || "", stale });
  if (servedOffline.size > 20) servedOffline.delete(servedOffline.keys().next().value);
}

async function page(request, clientId, event) {
  const url = new URL(request.url);
  const key = `${url.origin}${url.pathname}`;
  const target = url.searchParams.get("wayne_update");
  const [saved, newest] = await Promise.all([caches.match(key, { cacheName: PAGES }), highWater()]);
  const savedBuild = saved?.headers.get("x-wayne-server-build") || "";
  const savedAt = time(saved?.headers.get("x-wayne-server-built-at"));
  // The saved copy is the right one to stand in for a slow server only if nothing newer is known.
  const savedIsTarget = Boolean(saved && target && savedBuild === target);
  const savedIsNewest = Boolean(saved && !target && (!newest || savedAt >= time(newest.builtAt)));
  const standIn = savedIsTarget ? TARGET_TIMEOUT_MS : savedIsNewest ? PAGE_TIMEOUT_MS : 0;

  const controller = new AbortController();
  const limit = setTimeout(() => controller.abort(), NETWORK_LIMIT_MS);
  const network = fetch(request, { signal: controller.signal }).then((response) => {
    clearTimeout(limit);
    if (keepable(response, request)) event.waitUntil(savePage(key, response));
    return response;
  }, (error) => { clearTimeout(limit); throw error; });

  if (standIn) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve("late"), standIn); });
    try {
      const first = await Promise.race([network, late]);
      clearTimeout(timer);
      if (first !== "late") return first;
      // Slow server: the saved copy is this same (or the target) build, so the screen is identical.
      event.waitUntil(network.catch(() => undefined));
      served(clientId, saved, false);
      return saved;
    } catch {
      clearTimeout(timer);
      served(clientId, saved, false);
      return saved;
    }
  }
  try {
    return await network;
  } catch (error) {
    // The server cannot be reached at all. An update target never falls back to a different build
    // (the Android shell then retries the plain POS address). A plain open may use an older copy as a
    // last resort so the register can still take orders offline; the page is told it is stale and
    // moves to the live build as soon as the connection is back.
    if (saved && !target) { served(clientId, saved, !savedIsNewest); return saved; }
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

/** Fetch the target build's POS page and every code file it names into the caches. */
async function stage({ path, build, builtAt }) {
  if (typeof path !== "string" || !path.startsWith("/pos") || typeof build !== "string" || !build) return { ok: false, build, reason: "bad request" };
  await raiseHighWater(build, builtAt);
  const url = new URL(path, self.location.origin);
  const key = `${url.origin}${url.pathname}`;
  const controller = new AbortController();
  const limit = setTimeout(() => controller.abort(), 40000);
  try {
    const response = await fetch(url.href, { credentials: "same-origin", cache: "no-store", redirect: "follow", signal: controller.signal, headers: { accept: "text/html", "x-wayne-stage": "1" } });
    if (!keepable(response, new Request(url.href))) return { ok: false, build, reason: `page answered ${response.status}${response.redirected ? " (redirected)" : ""}` };
    const html = await response.clone().text();
    const pageBuild = /name="wayne-build" content="([^"]+)"/.exec(html)?.[1] || response.headers.get("x-wayne-server-build") || "";
    // The alias moved on while staging: the page will see the newer build and settle on it.
    if (pageBuild !== build) return { ok: false, build: pageBuild, reason: "a different build answered" };
    const assets = [...new Set((html.match(/\/_next\/static\/[^"'\\\s)<>]+/g) || []))].slice(0, 250);
    const cache = await caches.open(STATIC);
    for (let index = 0; index < assets.length; index += 6) {
      await Promise.all(assets.slice(index, index + 6).map(async (asset) => {
        const request = new Request(new URL(asset, self.location.origin).href);
        const have = await cache.match(request);
        if (have && validAsset(request, have)) return;
        const file = await fetch(request, { signal: controller.signal });
        if (!file.ok || !validAsset(request, file)) throw new Error(`asset ${file.status}`);
        await cache.put(request, file);
      }));
    }
    await trimStatic();
    const savedPage = await savePage(key, response);
    const kept = await caches.match(key, { cacheName: PAGES });
    if (savedPage.build !== build && kept?.headers.get("x-wayne-server-build") !== build) return { ok: false, build, reason: "page copy not kept" };
    return { ok: true, build };
  } catch (error) {
    return { ok: false, build, reason: String(error && error.message || error).slice(0, 120) };
  } finally { clearTimeout(limit); }
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

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  // The POS asks once it has started: "was I opened from the saved copy?"
  if (data.type === "wayne-ask-offline" && event.source) {
    const id = event.source.id;
    const offline = servedOffline.get(id);
    event.source.postMessage({ type: "wayne-offline-copy", offline: Boolean(offline), stale: Boolean(offline?.stale), savedAt: offline ? offline.savedAt : "", version: WORKER });
    return;
  }
  if (data.type === "wayne-high-water") { event.waitUntil(raiseHighWater(data.build, data.builtAt)); return; }
  if (data.type === "wayne-stage" && event.ports && event.ports[0]) {
    const port = event.ports[0];
    event.waitUntil(stage(data).then((answer) => port.postMessage(answer), (error) => port.postMessage({ ok: false, build: data.build, reason: String(error) })));
  }
});
