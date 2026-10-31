import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Old/new screen switching on the Elo (owner, 2026-10-31) — real browser, real
 * offline worker, real update manager, simulated Vercel deployments.
 * Server: e2e/stability-fixture/server.ts (started by screen-stability-local.config.ts).
 *
 * Production evidence these reproduce (pos_device_events, 2026-10-31 22:12–22:21Z):
 * three production deployments went live within six minutes while the Elo was on the
 * 2026-10-30 build; the Elo's update attempt was followed by 45 minutes of normal work
 * with no update logs at all; in 30 days no register ever logged app.reload or
 * app.update_confirmed.
 */
type Loaded = { build: string; url: string; offline?: boolean; at: number };
type State = { live: { build: string; builtAt: string }; loaded: Loaded[]; logs: { kind: string; message?: string; detail?: Record<string, unknown> }[]; counts: { pos: number } };

const MINUTE = 60_000;
async function control(page: Page, path: string, body: unknown = {}) { const response = await page.request.post(`/__control/${path}`, { data: body }); expect(response.ok()).toBe(true); return response; }
async function state(page: Page): Promise<State> { return (await page.request.get("/__control/state")).json(); }
/** Builds that actually booted, in order, collapsing repeats (a reload onto the same build is not a design change). */
async function designs(page: Page) { const builds = (await state(page)).loaded.filter((entry) => !entry.offline).map((entry) => entry.build); return builds.filter((build, index) => build !== builds[index - 1]); }
async function shown(page: Page) { return page.locator("#design").textContent({ timeout: 2_000 }).catch(() => ""); }
/** Let fake time pass in steps so the real 1 s safety tick and 60 s poll both run. */
async function pass(page: Page, ms: number, step = 15_000) { for (let gone = 0; gone < ms; gone += step) { await page.clock.runFor(Math.min(step, ms - gone)).catch(() => undefined); await page.waitForTimeout(150); } }
async function deploy(page: Page, build: string) { await control(page, "deploy", { build }); }

async function boot(context: BrowserContext, build: string) {
  const page = await context.newPage();
  await control(page, "reset");
  await deploy(page, build);
  await page.clock.install();
  await page.goto("/pos");
  await expect(page.locator("#design")).toHaveText(`design ${build}`);
  // First visit installs the offline worker; the second load is controlled by it and is saved as the offline copy.
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active)), { timeout: 10_000 }).toBe(true);
  await page.reload();
  await expect(page.locator("#design")).toHaveText(`design ${build}`);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await pass(page, 5_000, 1_000);
  return page;
}



test("two consecutive deployments: updates to each newest build once, idle, and never shows an older design again", async ({ context }) => {
  test.setTimeout(240_000);
  const page = await boot(context, "dpl_A");
  await deploy(page, "dpl_B");
  await pass(page, 4 * MINUTE);
  await expect.poll(() => shown(page), { timeout: 30_000 }).toBe("design dpl_B");
  await deploy(page, "dpl_C");
  await pass(page, 4 * MINUTE);
  await expect.poll(() => shown(page), { timeout: 30_000 }).toBe("design dpl_C");
  // Repeated refresh, reconnect and resume after the update: it stays on the newest build.
  for (let i = 0; i < 3; i++) { await page.reload(); await expect(page.locator("#design")).toHaveText("design dpl_C"); }
  await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("wayne:reconnected")); window.dispatchEvent(new PageTransitionEvent("pageshow")); });
  await pass(page, 3 * MINUTE);
  expect(await designs(page)).toEqual(["dpl_A", "dpl_B", "dpl_C"]);
  expect(await shown(page)).toBe("design dpl_C");
});

test("rapid back-to-back deployments (three in six minutes, as on 2026-10-31) cause ONE screen change, straight to the newest", async ({ context }) => {
  test.setTimeout(240_000);
  const page = await boot(context, "dpl_A");
  await deploy(page, "dpl_B");
  await pass(page, MINUTE);
  await deploy(page, "dpl_C");
  await pass(page, MINUTE);
  await deploy(page, "dpl_D");
  await pass(page, 5 * MINUTE);
  await expect.poll(() => shown(page), { timeout: 30_000 }).toBe("design dpl_D");
  expect(await designs(page)).toEqual(["dpl_A", "dpl_D"]);
});

test("slow store network after a deployment never brings the OLD design back (offline-copy rollback)", async ({ context }) => {
  test.setTimeout(240_000);
  const page = await boot(context, "dpl_A");
  // The store's connection is slow (slower than the worker's 10 s page timeout) when a deployment goes live.
  await control(page, "network", { delayMs: 12_000, targetDelayMs: 12_000 });
  await deploy(page, "dpl_B");
  await pass(page, 4 * MINUTE);
  await page.waitForTimeout(25_000);
  // The Android shell's "Can't reach the POS" page retries the plain POS address, as does an app restart.
  for (let i = 0; i < 2; i++) { await page.goto("/pos", { timeout: 60_000 }).catch(() => undefined); await page.waitForTimeout(1_000); }
  await control(page, "network", { delayMs: 0, targetDelayMs: 0 });
  await pass(page, 4 * MINUTE);
  if (process.env.STABILITY_DEBUG) console.log("SEQUENCE", JSON.stringify((await state(page)).loaded.map((l) => `${l.build}${l.offline ? " (saved copy)" : ""} ${l.url.replace(/^.*\/pos/, "/pos")}`)), await page.evaluate(() => sessionStorage.getItem("wayne.pos.update-journal.v1")));
  await expect.poll(() => shown(page), { timeout: 40_000 }).toBe("design dpl_B");
  const seen = await designs(page);
  // A may only appear before B. Once B has booted, A must never boot again.
  expect(seen.slice(seen.indexOf("dpl_B"))).not.toContain("dpl_A");
  expect(seen).toEqual(["dpl_A", "dpl_B"]);
});

test("an update reload that does not leave the page (navigation answered 204) recovers instead of silently stopping updates", async ({ context }) => {
  test.setTimeout(300_000);
  const page = await boot(context, "dpl_A");
  await control(page, "network", { mode: "no-content-for-target" });
  await deploy(page, "dpl_B");
  await pass(page, 6 * MINUTE);
  expect(await shown(page)).toBe("design dpl_A");
  // Bounded: two attempts, then it keeps working on its current build (no reload loop).
  const attempts = (await state(page)).logs.filter((log) => log.kind === "app.reload").length;
  expect(attempts).toBe(2);
  expect((await state(page)).logs.map((log) => log.kind)).toEqual(expect.arrayContaining(["app.reload_stalled", "app.update_blocked"]));
  await pass(page, 10 * MINUTE, 60_000);
  expect((await state(page)).logs.filter((log) => log.kind === "app.reload").length).toBe(2);
  // The connection problem is fixed: after the 30-minute hold it updates by itself.
  await control(page, "network", { mode: "ok" });
  await pass(page, 25 * MINUTE, 60_000);
  await expect.poll(() => shown(page), { timeout: 30_000 }).toBe("design dpl_B");
  expect(await designs(page)).toEqual(["dpl_A", "dpl_B"]);
});

test("an open order holds the update for as long as it stays open; idle register then updates once", async ({ context }) => {
  test.setTimeout(240_000);
  const page = await boot(context, "dpl_A");
  await page.evaluate(() => { window.__fixture.busy = true; });
  await deploy(page, "dpl_B");
  await pass(page, 8 * MINUTE);
  expect(await shown(page)).toBe("design dpl_A");
  expect(await designs(page)).toEqual(["dpl_A"]);
  await page.evaluate(() => { window.__fixture.busy = false; });
  await pass(page, 2 * MINUTE);
  await expect.poll(() => shown(page), { timeout: 30_000 }).toBe("design dpl_B");
  expect(await designs(page)).toEqual(["dpl_A", "dpl_B"]);
});

test("each update leaves a durable trail: reload and confirmation reach the server log", async ({ context }) => {
  test.setTimeout(180_000);
  const page = await boot(context, "dpl_A");
  await deploy(page, "dpl_B");
  await pass(page, 4 * MINUTE);
  await expect.poll(() => shown(page), { timeout: 30_000 }).toBe("design dpl_B");
  await pass(page, 30_000, 5_000);
  await expect.poll(async () => (await state(page)).logs.map((log) => log.kind), { timeout: 30_000 }).toEqual(expect.arrayContaining(["app.reload", "app.update_confirmed"]));
});
