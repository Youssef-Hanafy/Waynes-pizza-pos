/**
 * Screen-stability fixture server (2026-10-31).
 *
 * Plays the part of the Vercel production alias for the Elo register:
 *   • POST /__control/deploy {build}    — a new deployment goes live (new client bundle,
 *                                          new HTML, new /api/version), like a push to main
 *   • POST /__control/network {...}     — slow the POS document, return 204 for it, or fail it
 *   • GET  /__control/state             — every document that booted (build + URL),
 *                                          device-log events the page sent, request counts
 * It serves the REAL public/pos-sw.js and a client bundle compiled from the REAL
 * src/stores/app-update.ts, so the tests exercise production code paths, not copies.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
type Release = { build: string; commit: string; builtAt: string; contract: number; minimumClient: number; minimumBridge: number };
type Network = { delayMs: number; targetDelayMs: number; mode: "ok" | "no-content-for-target" | "fail-all" };

const bundles = new Map<string, string>(); // chunk file → JS
let live: Release & { chunk: string };
let network: Network = { delayMs: 0, targetDelayMs: 0, mode: "ok" };
const loaded: { build: string; url: string; offline?: boolean; at: number }[] = [];
const logs: { kind: string; message?: string; detail?: Record<string, unknown> }[] = [];
const counts = { pos: 0, version: 0, status: 0 };

async function compile(release: Release) {
  const result = await esbuild({
    entryPoints: [fileURLToPath(new URL("./client.ts", import.meta.url))],
    bundle: true, write: false, format: "iife", platform: "browser", minify: true, logLevel: "error",
    alias: { "@": `${root}src` },
    banner: { js: "window.process=window.process||{env:{}};" },
    define: {
      "process.env.WAYNE_BUILD_ID": JSON.stringify(release.build), "process.env.WAYNE_COMMIT": JSON.stringify(release.commit),
      "process.env.WAYNE_BUILT_AT": JSON.stringify(release.builtAt), "process.env.NODE_ENV": '"production"',
    },
  });
  const js = result.outputFiles[0]!.text;
  const chunk = `${createHash("sha256").update(js).digest("hex").slice(0, 14)}.js`;
  bundles.set(chunk, js);
  return chunk;
}

export async function deploy(build: string, builtAt = new Date().toISOString()) {
  const release: Release = { build, commit: createHash("sha1").update(build).digest("hex"), builtAt, contract: 1, minimumClient: 0, minimumBridge: 1 };
  live = { ...release, chunk: await compile(release) };
  return live;
}

function html(release: typeof live) {
  return `<!doctype html><html><head><meta name="wayne-build" content="${release.build}"><meta name="wayne-built-at" content="${release.builtAt}"><title>POS</title></head>`
    + `<body><h1 id="design">loading</h1><script src="/_next/static/immutable/chunks/${release.chunk}"></script></body></html>`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function body(request: IncomingMessage) { let text = ""; for await (const part of request) text += part; return text; }
function send(response: ServerResponse, status: number, headers: Record<string, string>, content = "") { response.writeHead(status, headers); response.end(content); }
function identity(release: typeof live) { return { "x-wayne-server-build": release.build, "x-wayne-server-built-at": release.builtAt, "x-wayne-server-contract": "1" }; }

export function start(port: number) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const current = live;
    try {
      if (url.pathname === "/__control/deploy") { const { build, builtAt } = JSON.parse(await body(request)); return send(response, 200, { "content-type": "application/json" }, JSON.stringify(await deploy(build, builtAt))); }
      if (url.pathname === "/__control/network") { network = { ...network, ...JSON.parse(await body(request)) }; return send(response, 200, {}, "ok"); }
      if (url.pathname === "/__control/loaded") { loaded.push(JSON.parse(await body(request))); return send(response, 204, {}); }
      if (url.pathname === "/__control/state") return send(response, 200, { "content-type": "application/json" }, JSON.stringify({ live: current, loaded, logs, counts, network }));
      if (url.pathname === "/__control/reset") { loaded.length = 0; logs.length = 0; counts.pos = counts.version = counts.status = 0; network = { delayMs: 0, targetDelayMs: 0, mode: "ok" }; return send(response, 200, {}, "ok"); }
      if (network.mode === "fail-all" && !url.pathname.startsWith("/__control")) { request.socket.destroy(); return; }
      if (url.pathname === "/pos-sw.js") return send(response, 200, { "content-type": "text/javascript", "cache-control": "no-cache, max-age=0, must-revalidate" }, readFileSync(`${root}public/pos-sw.js`, "utf8"));
      if (url.pathname.startsWith("/_next/static/immutable/chunks/")) {
        const js = bundles.get(url.pathname.split("/").pop()!);
        return js ? send(response, 200, { "content-type": "text/javascript", "cache-control": "public,max-age=31536000,immutable" }, js) : send(response, 404, { "content-type": "text/plain" }, "missing");
      }
      if (url.pathname === "/api/version") { counts.version++; return send(response, 200, { "content-type": "application/json", "cache-control": "no-store", ...identity(current) }, JSON.stringify({ build: current.build, commit: current.commit, builtAt: current.builtAt, contract: 1, minimumClient: 0, minimumBridge: 1 })); }
      if (url.pathname === "/api/pos/update-status") { counts.status++; return send(response, 200, { "content-type": "application/json", "cache-control": "no-store", ...identity(current) }, JSON.stringify({ blockers: [], build: current.build })); }
      if (url.pathname === "/api/pos/device-log") { const parsed = JSON.parse(await body(request)) as { events: typeof logs }; logs.push(...parsed.events); return send(response, 200, { "content-type": "application/json", ...identity(current) }, "{\"ok\":true}"); }
      if (url.pathname === "/pos" || url.pathname.startsWith("/pos/")) {
        counts.pos++;
        const target = url.searchParams.has("wayne_update");
        if (target && network.mode === "no-content-for-target") return send(response, 204, identity(current));
        const delay = target ? network.targetDelayMs || network.delayMs : network.delayMs;
        if (delay) await wait(delay);
        // The alias may have moved on while this response was in flight: answer with the build live now.
        return send(response, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0", ...identity(live) }, html(live));
      }
      return send(response, 404, { "content-type": "text/plain" }, "not found");
    } catch (error) { send(response, 500, { "content-type": "text/plain" }, String(error)); }
  });
  return new Promise<typeof server>((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4177);
  await deploy(process.env.FIXTURE_FIRST_BUILD ?? "dpl_A", new Date(Date.now() - 3_600_000).toISOString());
  await start(port);
  console.log(`stability fixture on http://127.0.0.1:${port}`);
}
