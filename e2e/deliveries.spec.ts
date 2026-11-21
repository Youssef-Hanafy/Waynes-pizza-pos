import { test, expect } from "@playwright/test";
const id = (n: number) => `7d000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("assigns online deliveries and processes saved tips from one screen", async ({ page }) => {
  const now = new Date().toISOString();
  const delivery = { order_id: id(1), order_number: "W001", daily_number: 1, source: "online", status: "placed", customer_name: "Online customer", address: "10 Main St", payment_status: "authorized", payment_method: "card", total_cents: 3000, paid_by: "card_held", hold_cents: 4000, placed_at: now };
  const pickupCard = { order_id: id(2), order_number: "W002", daily_number: 2, customer_name: "Pickup customer", source: "phone", fulfillment_type: "pickup", total_cents: 2000, tip_already_cents: 0, is_test: true, placed_at: now, payment_id: id(12), provider: "stripe", authorized_cents: 2000, card_brand: "visa", card_last4: "4242", authorized_at: now, max_capture_cents: 3000, entry: "pos_keyed_card", with_driver: false };
  let assigned = false, charged = false, cashedOut = false;
  const requests: { url: string; body: unknown }[] = [];
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()).pathname;
    const body = req.method() === "POST" ? req.postDataJSON() : null;
    if (body) requests.push({ url, body });
    let response: unknown = [];
    if (url === "/api/pos/delivery") {
      if (body) { expect(body).toEqual({ action: "send_out", order_id: id(1), driver_id: id(3) }); assigned = true; }
      response = { waiting: assigned ? [] : [delivery], drivers: [{ driver_id: id(3), name: "Dave", clocked_in: true, orders: assigned && !cashedOut ? [{ ...delivery, status: "out_for_delivery" }] : [] }] };
    } else if (url === "/api/pos/tips") {
      if (body) { expect(body).toEqual({ tips: [{ order_id: id(2), tip_cents: 250 }] }); charged = true; response = { charged: 1, tips_cents: 250, charged_order_ids: [id(2)] }; }
      else response = [...(charged ? [] : [pickupCard]), { ...pickupCard, order_id: id(1), payment_id: id(11), fulfillment_type: "delivery", with_driver: assigned }];
    } else if (url === "/api/pos/delivery/cashout") {
      expect(body.tips).toEqual([{ order_id: id(1), tip_cents: 500 }]);
      cashedOut = true;
      response = { cashout_id: id(30), driver_name: "Dave", order_count: 1, cash_orders_cents: 0, cash_tips_cents: 0, card_tips_cents: 500, hand_in_cents: -500, cashed_out_order_ids: [id(1)] };
    }
    await route.fulfill({ json: response });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Deliveries", exact: true })).toBeVisible();
  await expect(page.getByText("Online ·", { exact: false })).toBeVisible();
  const otherCards = page.locator("section").filter({ has: page.getByRole("heading", { name: "Other cards · end-of-day processing" }) });
  await expect(otherCards.getByRole("listitem")).toHaveCount(1);
  await otherCards.getByRole("textbox").fill("2.50");
  await page.getByRole("button", { name: "🚗 Dave", exact: true }).click();
  await page.getByRole("textbox", { name: "Tip for order #1", exact: true }).fill("5.00");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Tip for order #1", exact: true })).toHaveValue("5.00");
  await expect(otherCards.getByRole("textbox")).toHaveValue("2.50");
  await page.getByRole("button", { name: "Cash out Dave", exact: true }).click();
  await page.getByRole("button", { name: "Confirm cash out", exact: true }).click();
  await expect(page.getByText("Pay Dave $5.00", { exact: true })).toBeVisible();
  await otherCards.getByRole("button", { name: "Process 1 card", exact: false }).click();
  await expect(otherCards.getByText("No cards waiting for a tip.", { exact: false })).toBeVisible();
  expect(requests.filter(r => r.url === "/api/pos/tips")).toHaveLength(1);
  await page.screenshot({ path: "test-results/deliveries-combined.png", fullPage: true });
});
