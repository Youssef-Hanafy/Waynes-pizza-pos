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

for (const first of ["Cash", "Key in card"]) test(`${first} then another card keeps the balance open until paid`, async ({ page }) => {
  await page.goto("/");
  await page.getByRole("checkbox").check();
  await page.getByLabel("Split payment amount").fill("10.00");
  await page.getByRole("button", { name: first, exact: false }).click();
  const firstRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().includes(first === "Cash" ? "/api/pos/drawer" : "/api/pos/test-payment"));
  if (first === "Cash") {
    await page.getByRole("button", { name: "Exact", exact: true }).click();
    await page.getByRole("button", { name: /Record cash · change/ }).click();
  } else await page.getByRole("button", { name: /Test card approved/ }).click();
  expect((await firstRequest).postDataJSON().amount_cents).toBe(1000);
  await expect(page.locator("output")).toHaveText("Order open");
  await expect(page.getByText(/\$20.00 remaining/)).toBeVisible();
  await page.getByRole("button", { name: "Remaining balance", exact: true }).click();
  await page.getByRole("button", { name: /Key in card/ }).click();
  const second = page.waitForRequest((request) => request.url().includes("/api/pos/test-payment"));
  await page.getByRole("button", { name: /Test card approved/ }).click();
  expect((await second).postDataJSON().amount_cents).toBe(2000);
  await expect(page.locator("output")).toHaveText("Finished");
});
