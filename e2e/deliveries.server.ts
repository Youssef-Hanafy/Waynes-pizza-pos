import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import postcss, { type Plugin } from "postcss";
// @ts-expect-error The application PostCSS config is JavaScript.
import config from "../postcss.config.mjs";
const bundle = await build({ entryPoints: ["e2e/deliveries-fixture.tsx"], bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const css = await postcss(await Promise.all(config.plugins.map(async (p: string | Plugin) => typeof p === "string" ? (await import(p)).default() : p))).process(readFileSync("src/app/globals.css", "utf8"), { from: `${process.cwd()}/src/app/globals.css` });
createServer((req, res) => {
  if (req.url === "/app.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
  if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
}).listen(3120, "127.0.0.1");
