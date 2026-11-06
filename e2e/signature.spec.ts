import { expect, test, type Page } from "@playwright/test";

async function sign(page: Page) {
  const box = await page.locator("canvas").boundingBox();
  await page.mouse.move(box!.x + 30, box!.y + 30);
  await page.mouse.down();
  await page.mouse.move(box!.x + 160, box!.y + 70, { steps: 8 });
  await page.mouse.up();
}

test("Done preserves the signature through a failed send and resends the same ink", async ({ page }) => {
  const answers: Array<{ signature_svg: string }> = [];
  await page.route("**/fixture/read", route => route.fulfill({ json: { found: true, register_online: true, state: { phase: "sign", request_id: "sign-1" } } }));
  await page.route("**/fixture/respond", route => {
    answers.push(route.request().postDataJSON());
    return route.fulfill({ status: answers.length === 1 ? 503 : 200, json: {} });
  });
  await page.goto("/");
  await page.mouse.click(10, 10);
  await sign(page);
  await page.getByRole("button", { name: /^Done/ }).click();
  await expect(page.getByText("That didn't go through. Please tap again.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Done/ })).toBeEnabled();
  await page.waitForTimeout(1100); // A successful poll must not erase the send error.
  await expect(page.getByText("That didn't go through. Please tap again.")).toBeVisible();
  await page.getByRole("button", { name: /^Done/ }).click();
  await expect(page.getByText("One moment…", { exact: true })).toBeVisible();
  expect(answers).toHaveLength(2);
  expect(answers[1].signature_svg).toBe(answers[0].signature_svg);
});

test("a new signature request resets ink and Done even without a phase change", async ({ page }) => {
  let request = "sign-1";
  await page.route("**/fixture/read", route => route.fulfill({ json: { found: true, register_online: true, state: { phase: "sign", request_id: request } } }));
  await page.goto("/");
  await page.mouse.click(10, 10);
  await sign(page);
  request = "sign-2";
  await expect(page.getByRole("button", { name: /^Done/ })).toBeDisabled();
});

test("register refresh during signature save keeps the request and finishes once", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { asks: 0, thanks: 0 });
    window.addEventListener("fixture:ask", () => { (window as unknown as { asks: number }).asks++; });
    window.addEventListener("fixture:thanks", () => { (window as unknown as { thanks: number }).thanks++; });
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let saves = 0;
  await page.route("**/api/pos/orders/*/signature", async route => { saves++; await held; await route.fulfill({ json: { saved: true } }); });
  await page.goto("/register");
  await expect.poll(() => page.evaluate(() => (window as unknown as { asks: number }).asks)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:answer", { detail: { signature_svg: '<svg><path d="M1 1L2 2"/></svg>' } })));
  await expect(page.getByText("Saving the signature…", { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:refresh")));
  release();
  await expect(page.getByText("Revision 1 · Finished 2")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { asks: number }).asks)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { thanks: number }).thanks)).toBe(1);
  expect(saves).toBe(1);
});

for (const automatic of [false, true]) {
  test(`${automatic ? "automatic signature submission" : "Done"} sends once and waits for register confirmation`, async ({ page }) => {
    let phase = "sign";
    let sends = 0;
    await page.route("**/fixture/read", route => route.fulfill({ json: { found: true, register_online: true, state: { phase, request_id: "sign-1" } } }));
    await page.route("**/fixture/respond", route => { sends++; return route.fulfill({ json: {} }); });
    await page.goto("/");
    await page.mouse.click(10, 10);
    await sign(page);
    if (!automatic) await page.getByRole("button", { name: /^Done/ }).click();
    await expect(page.getByText("One moment…", { exact: true })).toBeVisible();
    await expect(page.getByText("Thank you!", { exact: true })).not.toBeVisible();
    phase = "thanks";
    await expect(page.getByText("Thank you!", { exact: true })).toBeVisible();
    expect(sends).toBe(1);
  });
}


test("live display events refresh immediately, avoid idle polling, and recover after disconnect", async ({ page }) => {
  let phase = "idle", reads = 0;
  await page.clock.install();
  await page.route("**/fixture/read", route => { reads++; return route.fulfill({ json: { found: true, register_online: true, state: { phase, request_id: "event-tip" } } }); });
  await page.goto("/");
  await expect(page.getByText("Welcome to", { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:connection", { detail: true })));
  await expect.poll(() => reads).toBeGreaterThan(1);
  const initial = reads;
  await page.clock.runFor(20_000);
  expect(reads).toBe(initial);
  phase = "tip";
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:display")));
  await expect(page.getByText("Add a tip?", { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:connection", { detail: false })));
  const disconnected = reads;
  phase = "thanks";
  await page.clock.runFor(1800);
  await expect(page.getByText("Thank you!", { exact: true })).toBeVisible();
  expect(reads).toBeGreaterThan(disconnected);
});

test("menu notifications wait through checkout and do not overwrite activity started during a fetch", async ({ page }) => {
  await page.clock.install();
  let reads = 0, hold = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/pos/runtime", async route => {
    reads++;
    if (hold) await held;
    await route.fulfill({ json: { build: "fixture-build", data: { workspaceName: `Menu revision ${reads}` } } });
  });
  await page.goto("/runtime");
  await expect(page.getByText("Original menu")).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event("fixture:busy")); window.dispatchEvent(new Event("fixture:runtime")); });
  await page.clock.runFor(5000);
  expect(reads).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:idle")));
  await page.clock.runFor(1000);
  await expect(page.getByText("Menu revision 1")).toBeVisible();
  await page.clock.runFor(300_000);
  expect(reads).toBe(1); // normal fallback is fifteen minutes
  hold = true;
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:runtime")));
  await page.clock.runFor(1000);
  await expect.poll(() => reads).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:busy")));
  release();
  await page.waitForTimeout(50);
  await expect(page.getByText("Menu revision 1")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:idle")));
  await page.clock.runFor(15_000);
  await expect(page.getByText("Menu revision 3")).toBeVisible();
});
