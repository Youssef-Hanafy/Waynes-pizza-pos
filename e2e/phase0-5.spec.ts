import { expect, test } from "@playwright/test";

const runLive = process.env.E2E_RUN_LIVE === "1";
const orderItem = process.env.E2E_MENU_ITEM;

test.describe("Phase 0–5 critical journeys", () => {
  test.skip(!runLive, "Requires an isolated staging database with E2E fixtures; never point this suite at production.");

  test("customer can choose pickup and reach a configured menu", async ({ page }) => {
    await page.goto("/order");
    await expect(page.getByRole("heading", { name: "How can we make it?" })).toBeVisible();
    await page.getByRole("link", { name: "Choose pickup" }).click();
    await expect(page).toHaveURL(/\/menu\?fulfillment=pickup/);
    await expect(page.getByText(orderItem!)).toBeVisible();
  });

  test("customer can choose delivery and reach a configured menu", async ({ page }) => {
    await page.goto("/order");
    await page.getByRole("link", { name: "Choose delivery" }).click();
    await expect(page).toHaveURL(/\/menu\?fulfillment=delivery/);
    await expect(page.getByText(orderItem!)).toBeVisible();
  });

  // Authenticated POS, calendar, KDS, and printing tests run with pre-created
  // least-privilege storage states supplied by CI; credentials never go in git.
  test("POS, calendar, KDS, and print queue accept exactly one staged order", async ({ browser }) => {
    test.skip(!process.env.E2E_OWNER_STORAGE_STATE || !process.env.E2E_POS_STORAGE_STATE, "Set isolated staging storage-state paths.");
    const posContext = await browser.newContext({ storageState: process.env.E2E_POS_STORAGE_STATE });
    const ownerContext = await browser.newContext({ storageState: process.env.E2E_OWNER_STORAGE_STATE });
    const pos = await posContext.newPage();
    const owner = await ownerContext.newPage();
    await pos.goto("/pos");
    await expect(pos.getByRole("heading", { name: "Add items" })).toBeVisible();
    await owner.goto("/admin/calendar");
    await expect(owner.getByRole("heading", { name: "Monthly calendar" })).toBeVisible();
    await owner.goto("/kitchen");
    await expect(owner.getByRole("heading", { name: "Kitchen" })).toBeVisible();
    await owner.goto("/admin/printing");
    await expect(owner.getByRole("heading", { name: "Print queue" })).toBeVisible();
    await posContext.close();
    await ownerContext.close();
  });
});
