/** Loopback-only render harness. Real POS/CSS; synthetic data, no production credentials. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import postcss, { type Plugin } from 'postcss';
// @ts-expect-error The application PostCSS config is JavaScript.
import config from '../../postcss.config.mjs';
const bundle = await build({entryPoints:['e2e/ui-fixture/client.tsx'],bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',banner:{js:'window.process={env:{}};'},alias:{'@':`${process.cwd()}/src`},define:{'process.env.NODE_ENV':'"production"','process.env.WAYNE_BUILD_ID':'"audit_A"','process.env.WAYNE_COMMIT':'"086c5d6"','process.env.WAYNE_BUILT_AT':'"2026-11-01T00:00:00Z"'},logLevel:'warning'});
const css = await postcss(await Promise.all(config.plugins.map(async (p: string | Plugin) => typeof p === 'string' ? (await import(p)).default() : p))).process(readFileSync('src/app/globals.css','utf8'),{from:`${process.cwd()}/src/app/globals.css`});
createServer((req,res)=>{
  if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
  if(req.url==='/app.css'){res.setHeader('content-type','text/css');res.end(css.css);return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
}).listen(4188,'127.0.0.1',()=>console.log('UI fixture http://127.0.0.1:4188'));
