import { currentRelease } from "@/lib/pos/release";
/**
 * Which build of the app the server is running (owner, 2026-10-20: "the
 * system is starting to fight the new changes with the old changes").
 *
 * The POS is one page that never reloads by itself, so after a deploy the
 * counter tablet kept running the old screens against the new server until
 * someone force-closed the app.  The POS asks this every minute and, when it
 * is behind, reloads itself the next time the register is idle
 * (src/stores/use-app-update.ts).  Nothing secret: just the build id.
 */
// Built once per deploy and served as a static file (owner, 2026-10-24: "optimize
// the Vercel compute"): every register asks this every minute, and a static
// answer costs no function time at all.  A new deploy brings its own copy.
export const dynamic = "force-static";

export function GET() {
  return Response.json(currentRelease(), { headers: { "Cache-Control": "no-store, max-age=0" } });
}
