import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("customer display reconnect, ownership, delayed tip and failed signature finish checkout once", async ({ browser }) => {
  test.skip(process.env.E2E_RUN_STAGING !== "1", "Requires isolated staging");
  test.setTimeout(180_000);
  expect(process.env.E2E_BASE_URL).toBe("https://waynes-pos-staging.vercel.app");
  const storageState = process.env.E2E_POS_STORAGE_STATE;
  expect(storageState).toBeTruthy();
  const key = `Checkout regression ${randomUUID().slice(0, 8)}`;
  const register = await browser.newContext({ storageState });
  const customer = await browser.newContext({ storageState });
  await register.addInitScript(k => localStorage.setItem("wayne.pos.terminal", k), key);
  await customer.addInitScript(k => localStorage.setItem("wayne-customer-screen-register", k), key);
  const pos = await register.newPage();
  const display = await customer.newPage();
  pos.setDefaultTimeout(15_000); display.setDefaultTimeout(15_000);
  let lastPublish: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
  let dropPublish = false;
  let dropped = 0;
  let successfulPublishes = 0;
  let screenOnline = false;
  let tipCalls = 0;
  let paymentCalls = 0;
  const signatures: string[] = [];
  let releaseTip!: () => void;
  const tipResponseHeld = new Promise<void>(resolve => { releaseTip = resolve; });
  try {
    await pos.route("**/rest/v1/rpc/wayne_display_publish", async route => {
      lastPublish = { url: route.request().url(), headers: route.request().headers(), body: route.request().postDataJSON() };
      if (dropPublish) { dropPublish = false; dropped++; await route.abort("failed"); return; }
      const response = await route.fetch(); screenOnline = (await response.json()).screen_online === true; successfulPublishes++; await route.fulfill({ response });
    });
    await pos.route("**/api/pos/orders/*/tip", async route => {
      tipCalls++; const response = await route.fetch(); await tipResponseHeld; await route.fulfill({ response });
    });
    await pos.route("**/api/pos/test-payment", async route => { paymentCalls++; await route.continue(); });
    await pos.route("**/api/pos/orders/*/signature", async route => {
      signatures.push(route.request().postDataJSON().signature_svg);
      if (signatures.length === 1) { await route.fulfill({ status: 503, json: { error: "Injected signature save unavailable" } }); return; }
      await route.continue();
    });
    await pos.goto("/pos");
    await display.goto("/pos/display");
    await expect(display.getByRole("button", { name: "Tap anywhere to start" })).toBeVisible();
    // Pointerdown starts fullscreen and removes the cover before click completes.
    await display.mouse.click(100, 100);
    await expect(display.getByRole("button", { name: "Tap anywhere to start" })).not.toBeVisible();
    await pos.getByRole("checkbox", { name: /Test order/ }).check();
    await pos.getByRole("button", { name: "Walk-in At the counter", exact: true }).click();
    await pos.getByRole("button", { name: new RegExp(process.env.E2E_MENU_ITEM ?? "Staging Supreme Pizza") }).click();
    const item = pos.getByRole("dialog");
    await item.getByRole("button", { name: /^Add to ticket/ }).click();
    await expect(pos.getByRole("button", { name: /^TEST · Take payment ·/ })).toBeVisible();
    const saved = pos.waitForResponse(r => new URL(r.url()).pathname === "/api/pos/orders" && r.request().method() === "POST");
    await pos.getByRole("button", { name: /^TEST · Take payment ·/ }).click();
    const created = await saved; expect(created.ok()).toBe(true);
    expect(created.request().postDataJSON().is_test).toBe(true);
    await expect(pos.getByText(/Card reader and Key in card are simulated here/)).toBeVisible();
    await expect.poll(() => successfulPublishes).toBeGreaterThan(1);
    await expect.poll(() => screenOnline).toBe(true);
    await pos.getByRole("button", { name: /^Card reader/ }).click();
    await expect(display.getByText("Add a tip?", { exact: true })).toBeVisible();
    await expect(pos.getByText("Waiting for the customer to choose a tip on the screen…")).toBeVisible();

    // A second real publisher takes the same screen; reclaim the still-pending tip.
    expect(lastPublish).not.toBeNull();
    const publish = lastPublish! as { url: string; headers: Record<string, string>; body: Record<string, unknown> };
    const takeover = await pos.request.post(publish.url, { headers: Object.fromEntries(Object.entries(publish.headers).filter(([name]) => ["apikey", "authorization", "content-type"].includes(name))), data: { ...publish.body, publisher: randomUUID(), changed: true, screen_state: { ...(publish.body.screen_state as object), phase: "order", request_id: "" } } });
    expect(takeover.ok()).toBe(true);
    await expect(pos.getByText(/Another register named/)).toBeVisible();
    await pos.getByRole("button", { name: "Show the tip choice on the customer screen again" }).click();
    await expect(display.getByText("Add a tip?", { exact: true })).toBeVisible();
    dropPublish = true;
    await expect.poll(() => dropped).toBe(1);
    await expect(pos.getByText("Waiting for the customer to choose a tip on the screen…")).toBeVisible();
    expect(paymentCalls).toBe(0);
    await display.getByRole("button", { name: "$5", exact: true }).click();
    await expect(pos.getByRole("button", { name: "Saving the tip…" })).toBeDisabled();
    expect(paymentCalls).toBe(0); expect(tipCalls).toBe(1);
    releaseTip();
    await expect(pos.getByText("Waiting for the customer to sign on the screen…")).toBeVisible({ timeout: 30_000 });
    await expect(display.locator("canvas")).toBeVisible();
    const bounds = await display.locator("canvas").boundingBox(); expect(bounds).not.toBeNull();
    await display.mouse.move(bounds!.x + 30, bounds!.y + 35); await display.mouse.down();
    await display.mouse.move(bounds!.x + 170, bounds!.y + 85, { steps: 8 }); await display.mouse.up();
    await display.getByRole("button", { name: /^Done/ }).click();
    await expect(pos.getByRole("alert").filter({ hasText: "Injected signature save unavailable" })).toBeVisible();
    await expect(display.getByText("One moment…", { exact: true })).toBeVisible();
    await expect(display.getByText("Thank you!", { exact: true })).not.toBeVisible();
    expect(paymentCalls).toBe(1);
    await pos.getByRole("button", { name: "Try saving the signature again" }).click();
    await expect(display.getByText("Thank you!", { exact: true })).toBeVisible();
    expect(signatures).toHaveLength(2); expect(signatures[0]).toBe(signatures[1]);
    console.info("CHECKOUT_BROWSER verified ownership/reclaim, dropped heartbeat, delayed tip, signature 503/retry, one payment");
    expect(tipCalls).toBe(1); expect(paymentCalls).toBe(1);
  } catch (error) { await pos.screenshot({ path: test.info().outputPath("register-failure.png") }); throw error; } finally { releaseTip(); await pos.unrouteAll({ behavior: "wait" }); await customer.close(); await register.close(); }
});
