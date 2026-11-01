/* Network-only POS document loader. Keep this URL/scope to replace installed
 * legacy workers; unregistering alone would leave their cached pages behind.
 * Never cache executable POS documents or substitute a previous deployment.
 * Activation removes only disposable Wayne frontend caches, never operational
 * localStorage, IndexedDB, cookies, drafts, or payment records. */
const WORKER = "pos-sw 5 (network-only)";
const PAGE_TIMEOUT_MS = 45000;

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (/^wayne-pos-.*-(pages|static|meta)$/.test(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

function isPosPage(url) {
  return url.pathname === "/pos" || url.pathname.startsWith("/pos/");
}

function recovery() {
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>POS connection recovery</title></head>
<body><main><h1>Can't reach the POS</h1><p>Check the connection, then try again. Saved register work has been kept on this device.</p><a href="/pos">Try again now</a></main>
<script>setTimeout(function(){location.reload()},10000);addEventListener('online',function(){location.reload()})</script></body></html>`, {
    status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

async function networkPage(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    return await fetch(request, { cache: "no-store", signal: controller.signal });
  } catch {
    return recovery();
  } finally { clearTimeout(timer); }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && isPosPage(url)) event.respondWith(networkPage(request));
});

// Compatibility with the single safe-update manager and already running clients.
// Preflight verifies the target is reachable; it never saves an executable copy.
async function stage({ path, build }) {
  if (typeof path !== "string" || typeof build !== "string" || !build) return { ok: false, reason: "bad request" };
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin || !isPosPage(url)) return { ok: false, reason: "bad path" };
  const response = await networkPage(new Request(url.href, { credentials: "same-origin", headers: { accept: "text/html" } }));
  if (!response.ok || response.redirected || !(response.headers.get("content-type") || "").includes("text/html")) return { ok: false, build, reason: "target page unavailable" };
  const html = await response.text();
  const pageBuild = /name="wayne-build" content="([^"]+)"/.exec(html)?.[1];
  const serverBuild = response.headers.get("x-wayne-server-build");
  return { ok: pageBuild === build && serverBuild === build, build: pageBuild, reason: "target identity check" };
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "wayne-ask-offline" && event.source) {
    event.source.postMessage({ type: "wayne-offline-copy", offline: false, stale: false, savedAt: "", version: WORKER });
  }
  if (event.data?.type === "wayne-stage" && event.ports?.[0]) {
    const port = event.ports[0];
    event.waitUntil(stage(event.data).then(answer => port.postMessage(answer), () => port.postMessage({ ok: false, reason: "preflight failed" })));
  }
});
