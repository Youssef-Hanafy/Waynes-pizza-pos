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


test("online extras charge the original card for the added balance without card entry", async ({ page }) => {
  let body: Record<string, unknown> | null = null;
  await page.route("**/original-card", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { payment_status: "captured", amount_cents: 535 } });
  });
  await page.goto("/online-extra");
  const charge = page.getByRole("button", { name: "Charge original card · $5.35", exact: true });
  await expect(charge).toBeDisabled();
  await page.getByRole("checkbox", { name: "Customer approved the added items and $5.35 charge." }).check();
  await charge.click();
  await expect(page.locator("output")).toHaveText("Finished");
  expect(body).toMatchObject({ expected_amount_cents: 535, customer_approved: true });
  expect(body).not.toHaveProperty("source_id");
  expect(body).not.toHaveProperty("card_id");
});

test("a pending original-card charge survives refresh and is checked with the same request", async ({ page }) => {
  const requests: Array<{ idempotency_key: string; expected_amount_cents: number }> = [];
  await page.route("**/original-card", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 2) { await route.fulfill({ status: 403, json: { error: "Sign in again" } }); return; }
    await route.fulfill({ json: { payment_status: requests.length === 1 ? "pending" : "captured", amount_cents: 535 } });
  });
  await page.goto("/online-extra");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Charge original card · $5.35", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check extra charge · $5.35", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cash", exact: false })).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "Check extra charge · $5.35", exact: true }).click();
  await expect(page.getByText("Sign in again", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Check extra charge · $5.35", exact: true }).click();
  await expect(page.locator("output")).toHaveText("Finished");
  expect(requests).toHaveLength(3);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[1]).toEqual(requests[2]);
});


test("online item notes can be saved, edited, and restored from the cart", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wayne-order-details-v1", JSON.stringify({ fulfillment: "pickup", first_name: "Pat", last_name: "Customer", phone: "5085550144" })));
  await page.goto("/menu-notes");
  await page.getByRole("checkbox", { name: /^Pepperoni/ }).check();
  await page.getByLabel("Item notes (optional)").fill("Please add extra cheese");
  await page.getByRole("button", { name: "Add · $10.00", exact: true }).click();
  const lines = await page.evaluate(() => JSON.parse(localStorage.getItem("wayne-cart-v2") ?? "[]"));
  expect(lines[0].special_instructions).toBe("Please add extra cheese");
  await page.reload();
  await page.getByRole("button", { name: "Close item", exact: true }).click();
  await expect(page.getByText("Note: Please add extra cheese", { exact: true })).toBeVisible();
});

test("checkout preserves item notes and submits order notes", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wayne-cart-v2", JSON.stringify([{ line_id: "notes-line", menu_item_id: "7d000000-0000-4000-8000-000000000002", variant_id: null, quantity: 1, special_instructions: "Please add extra cheese", modifiers: [{ choice_id: "7d000000-0000-4000-8000-000000000004", quantity: 1 }] }])));
  let payload: Record<string, unknown> | null = null;
  await page.route("**/api/orders", async (route) => { payload = route.request().postDataJSON(); await route.fulfill({ status: 400, json: { error: "Fixture recorded" } }); });
  await page.goto("/online-notes");
  await expect(page.getByText("Note: Please add extra cheese", { exact: true })).toBeVisible();
  await page.getByLabel("First name").fill("Pat");
  await page.getByLabel("Last name").fill("Customer");
  await page.getByRole("textbox", { name: "Phone", exact: true }).fill("5085550144");
  await page.getByLabel("Order notes (optional)").fill("Call before delivery");
  await page.getByRole("button", { name: /Place/ }).click();
  await expect(page.getByText("Fixture recorded", { exact: true })).toBeVisible();
  expect(payload).toMatchObject({ special_instructions: "Call before delivery", items: [{ special_instructions: "Please add extra cheese" }] });
});

for (const tipCents of [500, 0]) test(`PAX Pay sends the total once after the tablet chooses ${tipCents ? "$5" : "No tip"}`, async ({ page, context }) => {
  const readerId = "7d000000-0000-4000-8000-000000000030";
  const paymentId = "7d000000-0000-4000-8000-000000000031";
  let screenState: Record<string, unknown> = {};
  let answer: Record<string, unknown> = {};
  const totalCents = 3000 + tipCents;
  const totalLabel = `$${(totalCents / 100).toFixed(2)}`;
  let readerState: "pending" | "captured" | "voided" = "pending";
  const sales: Array<Record<string, unknown>> = [];
  let finishTipSave: () => void = () => {};
  const tipSaveGate = new Promise<void>((resolve) => { finishTipSave = resolve; });

  await context.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "visible" });
    localStorage.setItem("wayne-customer-screen-register", "Register 1");
  });
  await context.route("**/rest/v1/rpc/wayne_display_*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    const payload = route.request().postDataJSON();
    if (name === "wayne_display_publish") {
      screenState = payload.screen_state;
      await route.fulfill({ json: { screen_online: true, response: answer } });
    } else if (name === "wayne_display_respond") {
      answer = payload.answer;
      await route.fulfill({ json: { accepted: true } });
    } else {
      await route.fulfill({ json: { state: screenState, found: true, register_online: true } });
    }
  });
  await page.route("**/api/pos/terminal", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: [{ id: readerId, label: "PAX A35", payarc_connect: true }] });
    }
    const payload = route.request().postDataJSON();
    if (payload.action === "resume") return route.fulfill({ json: { state: "none" } });
    if (payload.action === "cancel") {
      if (tipCents) return route.fulfill({ status: 409, json: { error: "Payarc has not confirmed the request on this reader. The POS cannot send a cancellation yet." } });
      return route.fulfill({ json: { payment_id: paymentId, state: "pending", reason: "Cancellation requested. Waiting for the reader to confirm." } });
    }
    if (payload.action === "start") sales.push(payload);
    return route.fulfill({ json: { payment_id: paymentId, amount_cents: totalCents, state: readerState } });
  });
  await page.route("**/api/pos/orders/*/tip", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ tip_cents: tipCents });
    await tipSaveGate;
    await route.fulfill({ json: { tip_cents: tipCents, total_cents: totalCents } });
  });

  await page.goto("/reader");
  const tablet = await context.newPage();
  await tablet.goto("/tablet");
  const startCover = tablet.getByRole("button", { name: "Tap anywhere to start" });
  await expect(startCover).toBeVisible();
  await tablet.mouse.click(10, 10);
  await expect(startCover).toBeHidden();
  await page.getByRole("button", { name: /^Card reader/ }).click();
  await page.getByRole("button", { name: "Pay $30.00", exact: true }).click();
  await expect(tablet.getByText("Add a tip?")).toBeVisible();
  expect(sales).toHaveLength(0);
  const saving = page.waitForRequest((request) => request.url().endsWith("/tip"));
  await tablet.getByRole("button", { name: tipCents ? "$5" : "No tip", exact: true }).click();
  await saving;
  await expect(tablet.getByText("Confirming your total…")).toBeVisible();
  expect(sales).toHaveLength(0);
  finishTipSave();

  await expect.poll(() => sales.length).toBe(1);
  expect(sales[0]).toMatchObject({ expected_amount_cents: totalCents, terminal_id: readerId });
  await expect(tablet.getByText(totalLabel, { exact: true })).toBeVisible();
  await expect(page.locator("output")).toHaveText("Order open");
  await page.getByRole("button", { name: "Cancel on reader" }).click();
  if (tipCents) {
    await expect(page.getByRole("alert")).toHaveText("Payarc has not confirmed the request on this reader. The POS cannot send a cancellation yet.");
    readerState = "captured";
    await expect(page.getByText(`Approved · ${totalLabel}`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Skip signature" }).click();
    await expect(page.locator("output")).toHaveText("Finished");
  } else {
    await expect(page.getByText("Cancellation requested. Waiting for the reader to confirm.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    readerState = "voided";
    await expect(page.getByRole("alert")).toHaveText("The reader cancelled the payment.");
    await expect(page.getByRole("button", { name: `Charge ${totalLabel} on the reader` })).toBeEnabled();
    await expect(page.locator("output")).toHaveText("Order open");
  }
  expect(sales).toHaveLength(1);
});
