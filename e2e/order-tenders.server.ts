// Browser-only fixture: real React screens, no credentials or live database.
import { build } from "esbuild";
import { createServer } from "node:http";
const bundle = await build({ entryPoints: ["e2e/order-tenders-fixture.tsx"], bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
createServer((req, res) => {
  if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
}).listen(3118, "127.0.0.1");
