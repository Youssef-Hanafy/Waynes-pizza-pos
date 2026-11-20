import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname === "/api/pos/terminal" ? [] : url.pathname === "/api/pos/drawer" && route.request().method() === "GET" ? { registers: [], shift: null } : url.pathname === "/api/pos/test-payment" ? { payment_status: "captured" } : { saved: true, result: { change_cents: 0 }, screen_online: false };
    await route.fulfill({ json: body });
  });
});

test("modifier name taps add paid extras without a second Extras section or auto-closing", async ({ page }) => {
  await page.goto("/modifiers");
  await page.getByRole("button", { name: "Pepperoni", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add to ticket · $10.00", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "✓ Pepperoni", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add to ticket · $12.00", exact: true })).toBeVisible();
  await expect(page.getByText("Extras", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Croutons", exact: true }).click();
  await page.getByRole("button", { name: "Add to ticket · $13.50", exact: true }).click();
  await expect(page.locator("output")).toContainText('"quantity":2');
});

for (const [first, second] of [["Cash", "Cash"], ["Cash", "Key in card"], ["Key in card", "Cash"], ["Key in card", "Key in card"]]) test(`${first} then ${second}: enter an amount and pay without split controls`, async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText("Split payment", { exact: false })).toHaveCount(0);
  for (const [index, method] of [first, second].entries()) {
    await page.getByRole("button", { name: method, exact: false }).click();
    await page.getByLabel(method === "Cash" ? "Cash amount" : "Card amount", { exact: true }).fill(index === 0 ? "10.00" : "20.00");
    const response = page.waitForRequest((request) => request.method() === "POST" && request.url().includes(method === "Cash" ? "/api/pos/drawer" : "/api/pos/test-payment"));
    await page.getByRole("button", { name: index === 0 ? "Pay $10.00" : "Pay $20.00", exact: true }).click();
    if (method !== "Cash") await page.getByRole("button", { name: /Test card approved/ }).click();
    expect((await response).postDataJSON().amount_cents).toBe(index === 0 ? 1000 : undefined);
    if (index === 0) {
      await expect(page.locator("output")).toHaveText("Order open");
      await expect(page.getByText(/\$20.00 remaining/)).toBeVisible();
      // The same method is immediately ready for the next amount.
      await expect(page.getByLabel(method === "Cash" ? "Cash amount" : "Card amount", { exact: true })).toBeVisible();
    }
  }
  await expect(page.locator("output")).toHaveText("Finished");
});

test("cash keypad accepts a smaller amount, then pays the rest with change", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Cash/ }).click();
  for (const digit of ["1", "0", "0", "0"]) await page.getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Pay $10.00", exact: true }).click();
  await expect(page.getByText(/\$20.00 remaining/)).toBeVisible();
  await page.getByLabel("Cash amount", { exact: true }).fill("25.00");
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/pos/drawer"));
  await page.getByRole("button", { name: "Pay $20.00 · change $5.00", exact: true }).click();
  expect((await request).postDataJSON().tendered_cents).toBe(2500);
  await expect(page.locator("output")).toHaveText("Finished");
});

test("card reader waits for the typed amount and refuses an amount above the balance", async ({ page }) => {
  let payments = 0;
  page.on("request", (request) => { if (request.url().includes("/api/pos/test-payment")) payments++; });
  await page.goto("/");
  await page.getByRole("button", { name: /Card reader/ }).click();
  expect(payments).toBe(0);
  await expect(page.getByRole("button", { name: "Pay", exact: true })).toBeDisabled();
  await page.getByLabel("Card amount", { exact: true }).fill("40.00");
  await expect(page.getByRole("button", { name: "Pay", exact: true })).toBeDisabled();
  await page.getByLabel("Card amount", { exact: true }).fill("10.00");
  await page.getByRole("button", { name: "Pay $10.00", exact: true }).click();
  await page.getByRole("button", { name: /Test card approved/ }).click();
  await expect(page.getByText(/\$20.00 remaining/)).toBeVisible();
  expect(payments).toBe(1);
});

for (const viewport of [{ width: 1024, height: 600 }, { width: 1280, height: 800 }]) test(`Payarc fields and charge button fit without scrolling at ${viewport.width}x${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const stripeRequests: string[] = [];
  page.on("request", request => { if (/stripe/i.test(request.url())) stripeRequests.push(request.url()); });
  await page.route("https://testportal.payarc.net/js/iframeprocess.js", route => route.fulfill({ contentType: "application/javascript", body: `
    function initPayarcTokenizer(clientId, settings) {
      for (const id of ['number', 'expiry', 'cvv', 'zip']) {
        const frame = document.createElement('iframe');
        frame.srcdoc = '<label style="font:14px Arial">' + id + '<input style="box-sizing:border-box;width:100%;height:44px;font-size:16px" aria-label="' + id + '"></label>';
        document.getElementById(id).appendChild(frame);
      }
    }
  ` }));
  await page.goto("/payarc");
  await page.getByRole("button", { name: /Key in card/ }).click();
  await page.getByLabel("Card amount", { exact: true }).fill("30.00");
  await page.getByRole("button", { name: "Pay $30.00", exact: true }).click();
  const charge = page.getByRole("button", { name: "Charge $30.00", exact: true });
  await expect(charge).toBeEnabled();
  const frame = page.frameLocator('iframe[title="Secure Payarc card details"]');
  await expect(frame.locator('#fields iframe')).toHaveCount(4);
  const bounds = await charge.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewport.height);
  expect(stripeRequests).toEqual([]);
  await page.screenshot({ path: `test-results/payarc-pos-${viewport.width}.png` });
});
