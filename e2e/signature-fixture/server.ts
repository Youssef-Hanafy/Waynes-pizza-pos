import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import postcss, { type Plugin } from "postcss";
// @ts-expect-error The application PostCSS config is JavaScript.
import config from "../../postcss.config.mjs";
const root = process.cwd();
const bundle = await build({ entryPoints: ["e2e/signature-fixture/client.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", alias: {
  "@/lib/pos/refresh-signals": `${root}/e2e/signature-fixture/refresh-signals.ts`,
  "@/stores/app-update": `${root}/e2e/signature-fixture/update.ts`,
  "@/lib/pos/customer-display-client": `${root}/e2e/signature-fixture/transport.ts`,
  "@/stores/customer-display-link": `${root}/e2e/signature-fixture/link.ts`,
  "@/stores/use-app-update": `${root}/e2e/signature-fixture/update.ts`,
  "@": `${root}/src`,
}, define: { "process.env.NODE_ENV": '"production"', "process.env.WAYNE_BUILD_ID": '"fixture-build"', "process.env.WAYNE_COMMIT": '"fixture"', "process.env.WAYNE_BUILT_AT": '"fixture"' } });
const css = await postcss(await Promise.all(config.plugins.map(async (p: string | Plugin) => typeof p === "string" ? (await import(p)).default() : p))).process(readFileSync("src/app/globals.css", "utf8"), { from: `${root}/src/app/globals.css` });
createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
  if (req.url === "/app.css") { res.setHeader("content-type", "text/css"); res.end(css.css); return; }
  res.setHeader("content-type", "text/html"); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
}).listen(4191, "127.0.0.1");
