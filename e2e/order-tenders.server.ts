// Browser-only fixture: real React screens, no credentials or live database.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import postcss, { type Plugin } from "postcss";
// @ts-expect-error The application PostCSS config is JavaScript.
import config from "../postcss.config.mjs";
import { createServer } from "node:http";
const fixtureOrigin = JSON.stringify("http://127.0.0.1:3118");
const bundle = await build({
  entryPoints: ["e2e/order-tenders-fixture.tsx"], bundle: true, write: false, loader: { ".css": "empty", ".module.css": "empty" }, platform: "browser", format: "esm", jsx: "automatic",
  define: {
    "process.env": "{}",
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_APP_URL": fixtureOrigin,
    "process.env.NEXT_PUBLIC_SUPABASE_URL": fixtureOrigin,
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": JSON.stringify("order-tenders-fixture-anon-key"),
  },
});
const css = await postcss(await Promise.all(config.plugins.map(async (p: string | Plugin) => typeof p === "string" ? (await import(p)).default() : p))).process(readFileSync("src/app/globals.css", "utf8"), { from: `${process.cwd()}/src/app/globals.css` });
createServer((req, res) => {
  if (req.url === "/app.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
  if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
}).listen(3118, "127.0.0.1");
