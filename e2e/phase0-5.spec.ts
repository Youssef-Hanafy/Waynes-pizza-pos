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
  await dialog.getByRole("button", { name: "Add Fresh basil", exact: true }).click();
  await dialog.getByLabel("Item notes").fill(note);
  await dialog.getByRole("button", { name: /^Add to ticket ·/ }).click();
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
  await expect(page).toHaveURL(new RegExp(`/menu\\?fulfillment=${fulfillment}`), { timeout: 30_000 });
  const gate = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Start my order" }) });
  await expect(gate).toBeVisible();
  await gate.getByLabel("First name").fill(name);
  await gate.getByLabel("Last name").fill("Acceptance");
  await gate.getByLabel("Mobile number").fill(phone);
  if (fulfillment === "delivery") {
    await gate.getByLabel("Street address").fill("93 West Boylston St");
    await gate.getByLabel("City", { exact: true }).fill("Worcester");
    await gate.getByLabel("ZIP", { exact: false }).fill("01606");
  }
  await gate.getByRole("button", { name: "Start my order" }).click();
  await expect(gate).not.toBeVisible();
  await addConfiguredItem(page, `${name} item note`);
  await page.getByRole("link", { name: "Continue to checkout" }).click();
  await expect(page).toHaveURL(/\/checkout\?/, { timeout: 30_000 });
  const checkout = page.locator("main form");
  await checkout.getByLabel("First name").fill(name);
  await checkout.getByLabel("Last name").fill("Acceptance");
  await checkout.getByLabel("Phone").fill(phone);
  if (fulfillment === "delivery") {
    await checkout.getByRole("textbox", { name: "Find your delivery address", exact: true }).fill("93 West Boylston St");
    await checkout.getByLabel("City").fill("Worcester");
    await checkout.getByLabel("Postal code").fill("01606");
    await checkout.getByLabel("Delivery instructions (optional)").fill("Use side door");
  }
  const testOrder = page.getByRole("button", { name: "Place test order" });
  const cardOrder = page.getByRole("button", { name: /^Pay \$.*and place order$/ });
  if (await cardOrder.isVisible()) {
    const card = page.locator('[aria-label="Card details"]').frameLocator("iframe").first();
    await card.getByRole("textbox", { name: "Credit or debit card number" }).fill("4242424242424242");
    await card.getByPlaceholder("MM / YY").fill("1230");
    await card.getByPlaceholder("CVC").fill("123");
  }
  const placeOrder = (await cardOrder.isVisible()) ? cardOrder : testOrder;
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
  await expect(owner.getByRole("link", { name: `Open order ${orderNumber}`, exact: true }).getByText(source, { exact: true })).toBeVisible();
}

test.describe("Phase 0–5 staging vertical slice", () => {
  test.skip(
    !runStaging,
    "Set E2E_RUN_STAGING=1 only for an isolated staging environment; this suite must never target production.",
  );

  test.beforeAll(() => {
    expect(new URL(process.env.E2E_BASE_URL ?? "https://waynes-pos-staging.vercel.app").hostname).toBe("waynes-pos-staging.vercel.app");
    expect(ownerStorageState, "E2E_OWNER_STORAGE_STATE is required").toBeTruthy();
    expect(posStorageState, "E2E_POS_STORAGE_STATE is required").toBeTruthy();
    expect(menuItem, "E2E_MENU_ITEM is required").toBeTruthy();
  });

  test("creates, reconciles, and operates one online and POS order for each core path", async ({ browser, page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);
    // Dismiss the actual rewards dialog through its normal close control.
    await page.addLocatorHandler(page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Close", exact: true }) }), async (dialog) => {
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    });
    const pickupPhone = phoneFor(1);
    const deliveryPhone = phoneFor(2);
    const phoneOrderPhone = phoneFor(3);

    const pickupOrder = await placeOnlineOrder(page, "pickup", `E2E Pickup ${runId}`, pickupPhone);
    const deliveryOrder = await placeOnlineOrder(page, "delivery", `E2E Delivery ${runId}`, deliveryPhone);

    const posContext = await browser.newContext({ storageState: posStorageState! });
    const pos = await posContext.newPage();
    await pos.goto("/pos");
    pos.setDefaultTimeout(15_000);
    await pos.getByRole("button", { name: /Walk-in/ }).click();
    await addPosItem(pos, `E2E walk-in ${runId}`);
    const walkInResponse = pos.waitForResponse((response) => new URL(response.url()).pathname === "/api/pos/orders" && response.request().method() === "POST");
    await pos.getByRole("button", { name: /^Take payment ·/ }).click();
    const walkInSaved = await (await walkInResponse).json();
    const walkInOrder = walkInSaved.order_number as string;
    expect(walkInOrder).toMatch(/^W\d+$/);
    await expect(pos.getByRole("region", { name: "Take payment" })).toContainText(`Order #${walkInSaved.daily_number}`);
    // Exercise a real cash ledger entry through the ordinary drawer workflow.
    await pos.getByRole("button", { name: /^Cash Change shown$/ }).click();
    await pos.getByRole("button", { name: "Exact", exact: true }).click();
    await pos.getByRole("button", { name: /^Record cash · change/ }).click();
    await expect(pos.getByText(/paid cash · CHANGE DUE/)).toBeVisible();

    await pos.getByLabel("First name").fill(`E2E Phone ${runId}`);
    await pos.getByLabel("Last name").fill("Acceptance");
    await pos.getByLabel("Phone", { exact: true }).fill(phoneOrderPhone);
    await pos.getByRole("button", { name: /^Delivery \+/ }).click();
    await pos.getByRole("combobox", { name: "Street address", exact: true }).fill("93 West Boylston St");
    await pos.getByLabel("City", { exact: true }).fill("Worcester");
    await pos.getByLabel("ZIP", { exact: true }).fill("01606");
    await pos.getByRole("button", { name: "Continue to take order →", exact: true }).click();
    await addPosItem(pos, `E2E phone ${runId}`);
    const phoneResponse = pos.waitForResponse((response) => new URL(response.url()).pathname === "/api/pos/orders" && response.request().method() === "POST");
    await pos.getByRole("button", { name: /^Take payment ·/ }).click();
    const phoneSaved = await (await phoneResponse).json();
    const phoneOrder = phoneSaved.order_number as string;
    expect(phoneOrder).toMatch(/^W\d+$/);
    await expect(pos.getByRole("region", { name: "Take payment" })).toContainText(`Order #${phoneSaved.daily_number}`);
    await pos.getByRole("button", { name: /^Cash at the door/ }).click();
    await posContext.close();

    const ownerContext = await openOwnerContext(browser);
    const owner = await ownerContext.newPage();
    await assertExactlyOneOrderForPhone(owner, pickupPhone, pickupOrder, "Online");
    await assertExactlyOneOrderForPhone(owner, phoneOrderPhone, phoneOrder, "Phone");

    await owner.goto("/admin/calendar");
    const today = owner.locator('a[aria-current="date"]:visible');
    await expect(today).toBeVisible();
    await today.click();
    await expect(owner.getByText(pickupOrder, { exact: true })).toBeVisible();
    await expect(owner.getByText(deliveryOrder, { exact: true })).toBeVisible();
    await expect(owner.getByText(walkInOrder, { exact: true })).toBeVisible();
    await expect(owner.getByText(phoneOrder, { exact: true })).toBeVisible();

    await owner.goto("/kitchen");
    await expect(owner.getByRole("status")).toContainText(/Live|Reconnecting/);
    await owner.getByRole("button", { name: /^All tickets/ }).click();
    const pickupTicket = owner.locator("article").filter({ hasText: `E2E Pickup ${runId} item note` });
    await expect(pickupTicket).toContainText("Fresh basil");
    await expect(pickupTicket).toContainText(`E2E Pickup ${runId} item note`);
    await owner.reload();
    await owner.getByRole("button", { name: /^All tickets/ }).click();
    await expect(pickupTicket.getByRole("heading", { name: /^#\d+$/ })).toBeVisible();
    await pickupTicket.getByRole("button", { name: "Accept order" }).click();
    await pickupTicket.getByRole("button", { name: "Start cooking" }).click();
    await pickupTicket.getByRole("button", { name: "Mark ready" }).click();
    await expect(pickupTicket).toContainText("Ready at the counter", { timeout: 15_000 });

    await owner.goto("/admin/printing");
    await expect(owner.getByText(pickupOrder, { exact: true }).first()).toBeVisible();
    await expect(owner.getByText(deliveryOrder, { exact: true }).first()).toBeVisible();
    await expect(owner.getByText(walkInOrder, { exact: true }).first()).toBeVisible();
    await expect(owner.getByText(phoneOrder, { exact: true }).first()).toBeVisible();
    await ownerContext.close();
  });

  test("refunds both split legs only with an explicit tip and records driver recovery due", async ({ browser }) => {
    test.setTimeout(90_000);
    const orderId = process.env.E2E_REFUND_ORDER_ID;
    expect(orderId, "E2E_REFUND_ORDER_ID must name the prepared synthetic paid-driver refund fixture").toBeTruthy();
    const context = await browser.newContext({ storageState: ownerStorageState! });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(`/admin/orders/${orderId}`);
      await page.getByRole("textbox", { name: "Total refund", exact: true }).fill("18.00");
      await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Synthetic browser split refund");
      await page.getByRole("button", { name: "Refund", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "select tip explicitly" })).toBeVisible();
      await page.getByRole("textbox", { name: "Total refund", exact: true }).fill("18.00");
      await page.getByRole("textbox", { name: "Tip included in refund (explicit amount)", exact: true }).fill("5.00");
      await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Synthetic browser split refund");
      await page.getByRole("button", { name: "Refund", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Refund sent" })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Driver tip recovery due: $5.00" })).toBeVisible();
      await expect(page.getByText("Refunded $25.00", { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Total refund", exact: true })).toHaveCount(0);
    } finally { await context.close(); }
  });
});
