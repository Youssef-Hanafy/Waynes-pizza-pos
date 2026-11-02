import { expect, test } from "@playwright/test";
const id = "00000000-0000-4000-8000-000000000001";
const order = {
 id, order_number: "W1", source: "phone", fulfillment_type: "pickup", status: "placed", payment_status: "unpaid", payment_method: "card", placed_at: null, promised_at: null,
 phone_line: 1, customer_name: "Pat", customer_phone: "5085550144", delivery_address: null, special_instructions: "", subtotal_cents: 1000, discount_cents: 0, delivery_fee_cents: 0, tax_cents: 100, tip_cents: 500, total_cents: 1600, taken_by: null,
};
const doc = { store: { name: "Test", address_line1: "1 Main", city: "Worcester", state: "MA", postal_code: "01606", timezone: "America/New_York" }, order, items: [] };

test("pickup/delivery saves the server order, with address and stable retry identity", async ({ page }) => {
 const requests: Record<string, unknown>[] = [];
 await page.route("**/api/pos/orders/*/print", route => route.fulfill({ json: doc }));
 await page.route("**/api/pos/orders/*/fulfillment", route => {
   const body = route.request().postDataJSON(); requests.push(body);
   return route.fulfill(requests.length === 1 ? { status: 503, json: { error: "Save unavailable" } } : { json: { order_id: id, fulfillment_type: body.fulfillment_type, delivery_address: body.delivery_address, total_cents: 1800, delivery_fee_cents: 200, payment_status: "unpaid", duplicate: false } });
 });
 await page.goto("/fulfillment");
 await page.getByRole("button", { name: "Pickup / delivery", exact: true }).click();
 await page.getByRole("button", { name: "Delivery", exact: true }).click();
 await page.getByLabel("Street address", {exact:true}).fill("10 Main St");
 await page.getByLabel("City", {exact:true}).fill("Worcester");
 await page.getByLabel("ZIP code", {exact:true}).fill("01606");
 await page.getByRole("button", { name: "Save order type" }).click();
 await expect(page.getByRole("alert")).toHaveText("Save unavailable");
 await expect(page.getByText("No change saved", {exact:true})).toBeVisible();
 await page.getByRole("button", { name: "Save order type" }).click();
 await expect(page.getByText("Saved delivery 1800", {exact:true})).toBeVisible();
 expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
 expect(requests[0]).toMatchObject({ expected_fulfillment_type: "pickup", expected_total_cents: 1600, delivery_address: { address1: "10 Main St", city: "Worcester", postal_code: "01606" } });
});

test("a prepaid delivery links to the exact fee refund rather than the full order amount", async ({ page }) => {
 await page.route("**/api/pos/orders/*/print", route => route.fulfill({ json: { ...doc, order: { ...order, fulfillment_type: "delivery", payment_status: "paid", delivery_fee_cents: 200, total_cents: 1800, delivery_address: { address1: "10 Main St", city: "Worcester", state: "MA", postal_code: "01606" } } } }));
 await page.goto("/fulfillment");
 await page.getByRole("button", {name:"Pickup / delivery",exact:true}).click();
 await page.getByRole("button", {name:"Pickup",exact:true}).click();
 await expect(page.getByRole("link", {name:/Refund delivery fee/})).toHaveAttribute("href", `/admin/orders/${id}?refund_amount=2.00&refund_reason=Delivery%20fee%20-%20changed%20to%20pickup`);
});
