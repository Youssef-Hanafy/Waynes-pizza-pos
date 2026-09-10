import { expect, test, type Browser, type Page } from "@playwright/test";

const runStaging = process.env.E2E_RUN_STAGING === "1";
const menuItem = process.env.E2E_MENU_ITEM ?? "Staging Supreme Pizza";
const ownerStorageState = process.env.E2E_OWNER_STORAGE_STATE;
const posStorageState = process.env.E2E_POS_STORAGE_STATE;
const runId = String(Date.now() % 10_000_000).padStart(7, "0");

function phoneFor(offset: number) {
  return `508${String((Number(runId) + offset) % 10_000_000).padStart(7, "0")}`;
}

async function addConfiguredItem(page: Page, note: string) {
  const card = page.locator("article").filter({
    has: page.getByRole("heading", { name: menuItem, exact: true }),
  });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Customize & add" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: menuItem })).toBeVisible();
  await dialog.getByLabel("Fresh basil").check();
  await dialog.getByLabel("Item instructions").fill(note);
  await dialog.getByRole("button", { name: /^Add ·/ }).click();
  await expect(page.getByText("Fresh basil").last()).toBeVisible();
  await expect(page.getByText(`Note: ${note}`)).toBeVisible();
}

async function addPosItem(page: Page, note: string) {
  await page.getByRole("button", { name: new RegExp(menuItem) }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Fresh basil").check();
  await dialog.getByLabel("Item notes").fill(note);
  await dialog.getByRole("button", { name: /^Add ·/ }).click();
  await expect(page.getByText("Fresh basil").last()).toBeVisible();
  await expect(page.getByText(`Note: ${note}`)).toBeVisible();
}

async function placeOnlineOrder(
  page: Page,
  fulfillment: "pickup" | "delivery",
  name: string,
  phone: string,
) {
  await page.goto("/order");
  await page.getByRole("link", { name: `Choose ${fulfillment}` }).click();
  await expect(page).toHaveURL(new RegExp(`/menu\\?fulfillment=${fulfillment}`));
  await addConfiguredItem(page, `${name} item note`);
  await page.getByRole("link", { name: "Continue to checkout" }).click();
  await page.getByLabel("First name").fill(name);
  await page.getByLabel("Last name").fill("Acceptance");
  await page.getByLabel("Phone").fill(phone);
  if (fulfillment === "delivery") {
    await page.getByLabel("Street address").fill("93 West Boylston St");
    await page.getByLabel("City").fill("Worcester");
    await page.getByLabel("Postal code").fill("01606");
    await page.getByLabel("Delivery instructions (optional)").fill("Use side door");
  }
  const placeOrder = page.getByRole("button", { name: "Place test order" });
  // Two click events exercise the browser-side retry key. The authoritative
  // database transaction must still create exactly one order.
  await Promise.all([
    page.waitForURL(/\/order\/[^/?]+\?token=/),
    placeOrder.dblclick(),
  ]);
  await expect(page.getByText("Order saved")).toBeVisible();
  const confirmation = await page
    .locator("p")
    .filter({ hasText: /Order W\d+ is placed/ })
    .textContent();
  const orderNumber = confirmation?.match(/W\d+/)?.[0];
  expect(orderNumber).toBeTruthy();
  return orderNumber!;
}

async function openOwnerContext(browser: Browser) {
  return browser.newContext({ storageState: ownerStorageState! });
}

async function assertExactlyOneOrderForPhone(
  owner: Page,
  phone: string,
  orderNumber: string,
  source: "Online" | "Phone",
) {
  // `/admin/orders` is backed by the server-authorized `wayne_admin_orders`
  // database projection. Its total is an authoritative count, unlike a
  // client-side DOM count or an order-confirmation redirect.
  await owner.goto(`/admin/orders?q=${phone}`);
  await expect(owner.getByRole("heading", { name: "1 order", exact: true })).toBeVisible();
  await expect(owner.getByText(orderNumber, { exact: true })).toHaveCount(1);
  await expect(owner.getByText(source, { exact: true })).toBeVisible();
}

test.describe("Phase 0–5 staging vertical slice", () => {
  test.skip(
    !runStaging,
    "Set E2E_RUN_STAGING=1 only for an isolated staging environment; this suite must never target production.",
  );

  test.beforeAll(() => {
    expect(ownerStorageState, "E2E_OWNER_STORAGE_STATE is required").toBeTruthy();
    expect(posStorageState, "E2E_POS_STORAGE_STATE is required").toBeTruthy();
    expect(menuItem, "E2E_MENU_ITEM is required").toBeTruthy();
  });

  test("creates, reconciles, and operates one online and POS order for each core path", async ({ browser, page }) => {
    test.setTimeout(90_000);
    const pickupPhone = phoneFor(1);
    const deliveryPhone = phoneFor(2);
    const phoneOrderPhone = phoneFor(3);

    const pickupOrder = await placeOnlineOrder(page, "pickup", `E2E Pickup ${runId}`, pickupPhone);
    const deliveryOrder = await placeOnlineOrder(page, "delivery", `E2E Delivery ${runId}`, deliveryPhone);

    const posContext = await browser.newContext({ storageState: posStorageState! });
    const pos = await posContext.newPage();
    await pos.goto("/pos");
    await expect(pos.getByRole("heading", { name: "Add items" })).toBeVisible();
    await addPosItem(pos, `E2E walk-in ${runId}`);
    await pos.getByRole("button", { name: "Submit order" }).click();
    const walkInOrder = await pos.locator("h1").textContent();
    expect(walkInOrder).toMatch(/^W\d+$/);
    if (!walkInOrder) throw new Error("POS walk-in confirmation is missing its order number.");

    await pos.getByRole("button", { name: "Start new ticket" }).click();
    await pos.getByRole("button", { name: "Phone" }).click();
    await pos.getByLabel("First name").fill(`E2E Phone ${runId}`);
    await pos.getByLabel("Last name").fill("Acceptance");
    await pos.getByLabel("Phone").fill(phoneOrderPhone);
    await pos.getByRole("button", { name: "Delivery" }).click();
    await pos.getByLabel("Address").fill("93 West Boylston St");
    await pos.getByLabel("City").fill("Worcester");
    await pos.getByLabel("ZIP").fill("01606");
    await addPosItem(pos, `E2E phone ${runId}`);
    await pos.getByRole("button", { name: "Submit order" }).click();
    const phoneOrder = await pos.locator("h1").textContent();
    expect(phoneOrder).toMatch(/^W\d+$/);
    if (!phoneOrder) throw new Error("POS phone confirmation is missing its order number.");
    await posContext.close();

    const ownerContext = await openOwnerContext(browser);
    const owner = await ownerContext.newPage();
    await assertExactlyOneOrderForPhone(owner, pickupPhone, pickupOrder, "Online");
    await assertExactlyOneOrderForPhone(owner, phoneOrderPhone, phoneOrder, "Phone");

    await owner.goto("/admin/calendar");
    const today = owner.getByRole("link", { name: /today/i });
    await expect(today).toBeVisible();
    await today.click();
    await expect(owner.getByText(pickupOrder, { exact: true })).toBeVisible();
    await expect(owner.getByText(deliveryOrder, { exact: true })).toBeVisible();
    await expect(owner.getByText(walkInOrder, { exact: true })).toBeVisible();
    await expect(owner.getByText(phoneOrder, { exact: true })).toBeVisible();

    await owner.goto("/kitchen");
    await expect(owner.getByRole("status")).toContainText(/Live|Reconnecting/);
    const pickupTicket = owner.locator("article").filter({
      has: owner.getByRole("heading", { name: pickupOrder, exact: true }),
    });
    await expect(pickupTicket).toContainText("Fresh basil");
    await expect(pickupTicket).toContainText(`E2E Pickup ${runId} item note`);
    await owner.reload();
    await expect(owner.getByRole("heading", { name: pickupOrder, exact: true })).toBeVisible();
    await pickupTicket.getByRole("button", { name: "Accept order" }).click();
    await pickupTicket.getByRole("button", { name: "Start cooking" }).click();
    await pickupTicket.getByRole("button", { name: "Mark ready" }).click();
    await expect(pickupTicket).toContainText("Ready at the counter");

    await owner.goto("/admin/printing");
    await expect(owner.getByText(pickupOrder, { exact: true })).toBeVisible();
    await expect(owner.getByText(deliveryOrder, { exact: true })).toBeVisible();
    await expect(owner.getByText(walkInOrder, { exact: true })).toBeVisible();
    await expect(owner.getByText(phoneOrder, { exact: true })).toBeVisible();
    await ownerContext.close();
  });
});
