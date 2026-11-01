import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_RELOADS_PER_HOUR, SETTLE_MS, STALL_MS } from "../src/lib/pos/update-manager";

/**
 * Release guard for the Elo's old/new screen switching (owner, 2026-10-31:
 * "the fix must protect future deployments, not just today's version").
 *
 * The screen-stability work has been undone by later changes before.  These checks
 * run in CI on every push and pull request (.github/workflows/pos-release.yml), so a
 * change that reintroduces a second reload path, a router refresh in the register,
 * an un-staged reload, a cached POS page or a weaker settle/cap fails the build
 * instead of reaching the store.  If one of these must change, change it here on
 * purpose, with the reason, in the same commit.
 */
const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) files(path, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}
const source = files("src").map((path) => ({ path: relative(root, join(root, path)), text: read(path) }));

describe("screen stability invariants", () => {
  it("exactly one code path reloads the register: the update manager's verified idle reload", () => {
    const reloads = source.filter((f) => /location\.reload\s*\(/.test(f.text)).map((f) => f.path);
    expect(reloads).toEqual(["src/stores/app-update.ts"]);
    const managers = source.filter((f) => /new UpdateManager\s*\(/.test(f.text)).map((f) => f.path);
    expect(managers).toEqual(["src/stores/app-update.ts"]);
  });

  it("the register never hard-navigates itself onto another build (no router.refresh / location assignment in POS code)", () => {
    const pos = source.filter((f) => f.path.startsWith("src/app/pos/") || f.path.startsWith("src/stores/"));
    expect(pos.filter((f) => /router\.refresh\s*\(/.test(f.text)).map((f) => f.path)).toEqual([]);
    expect(pos.filter((f) => /location\.(href\s*=[^=]|assign\s*\(|replace\s*\()/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("update policy keeps its settle window, hourly cap and stall recovery", () => {
    expect(SETTLE_MS).toBeGreaterThanOrEqual(60_000);
    expect(MAX_RELOADS_PER_HOUR).toBeLessThanOrEqual(3);
    expect(STALL_MS).toBeGreaterThan(0);
    const app = read("src/stores/app-update.ts");
    expect(app).toMatch(/stage:\s*stageTarget/);
    expect(app).toMatch(/log:\s*\(kind,\s*detail\)\s*=>\s*logDevice/);
    expect(app).toMatch(/manager\?\.resume\(/);
    const manager = read("src/lib/pos/update-manager.ts");
    // Staging and logging happen before the reload, never after it.
    expect(manager.indexOf("this.d.stage")).toBeLessThan(manager.indexOf("this.d.reload(verified.build)"));
    expect(manager.indexOf('this.log("app.reload"')).toBeLessThan(manager.indexOf("this.d.reload(verified.build)"));
  });

  it("lifecycle diagnostics are written durably before a reload can drop them", () => {
    const log = read("src/lib/pos/device-log.ts");
    expect(log).toContain('kind.startsWith("app.")');
    expect(log).toContain("wayne.pos.device-log-outbox.v1");
    expect(read("src/stores/app-update.ts")).toContain("flushDeviceOutbox()");
  });

  it("the worker cannot resurrect cached frontend documents or assets", () => {
    const worker = read("public/pos-sw.js");
    expect(worker).not.toMatch(/caches\.(match|open)|cache\.(put|match)/);
    expect(worker).toContain('cache: "no-store"');
    expect(worker).toContain('"wayne-stage"');
    expect(worker).not.toMatch(/\.navigate\s*\(|matchAll\s*\(/);
    expect(read("src/app/pos/pos-app.tsx")).toContain('updateViaCache: "none"');
    expect(read("android/app/src/main/java/com/waynespizza/pos/MainActivity.java")).toContain('WebSettings.LOAD_NO_CACHE');
  });

  it("POS HTML and the worker script are never cached; every deploy stamps its identity", () => {
    const config = read("next.config.ts");
    expect(config).toMatch(/deploymentId:\s*buildId/);
    expect(config).toMatch(/source:\s*"\/pos\/:path\*",\s*headers:\s*\[\{\s*key:\s*"Cache-Control",\s*value:\s*"no-store/);
    expect(config).toMatch(/source:\s*"\/pos-sw\.js",\s*headers:\s*\[\{\s*key:\s*"Cache-Control",\s*value:\s*"no-cache/);
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain('name="wayne-build"');
    expect(layout).toContain('name="wayne-built-at"');
    expect(read("src/app/api/version/route.ts")).toMatch(/no-store/);
    for (const page of ["src/app/pos/pos-app.tsx", "src/app/pos/display/customer-screen.tsx"]) expect(read(page)).toMatch(/useAppUpdate\(/);
  });

  it("production promotion still goes through the release guard that rejects older builds", () => {
    expect(JSON.parse(read("vercel.json")).ignoreCommand).toBe("bash scripts/vercel-ignore-build.sh");
    expect(read("scripts/vercel-ignore-build.sh")).toContain("node scripts/verify-release.mjs --build-guard");
  });

  it("the Android shell never restores an old WebView page or reloads on resume", () => {
    const activity = read("android/app/src/main/java/com/waynespizza/pos/MainActivity.java");
    expect(activity).not.toMatch(/restoreState\s*\(/);
    expect(activity).not.toMatch(/onResume[\s\S]{0,400}\.reload\s*\(/);
  });

  it("CI runs the real-browser deployment-transition suite", () => {
    const workflow = read(".github/workflows/pos-release.yml");
    expect(workflow).toContain("e2e/screen-stability-local.config.ts");
  });
});
