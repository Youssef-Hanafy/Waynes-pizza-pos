import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PaymentPrompt } from "../src/app/pos/payments-screen";
import { PosItemDialog } from "../src/app/pos/item-dialog";
import { publicMenuItemSchema } from "../src/lib/menu/schemas";
import { openOrderSchema } from "../src/lib/orders/status";
const id = (n: number) => `7d000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const group = { id: id(3), name: "One Topping Pizza – Topping", customer_label: "Toppings", min_select: 1, max_select: 20, required: true, allow_quantities: true, size_rules: [{ variant_name: "", included_count: 1, max_portions: 20, extra_each_cents: null }], choices: [{ id: id(4), name: "Pepperoni", price_delta_cents: 200, default_selected: false, variant_prices: [] }] };
const item = publicMenuItemSchema.parse({ id: id(2), name: "One Topping Pizza", description: "", image_path: null, image_alt: "", base_price_cents: 1000, included_count_label: "", sold_out: false, featured: false, available_days: [0,1,2,3,4,5,6], available_start: null, available_end: null, variants: [], pos_auto_add: true, modifier_groups: [group, { ...group, id: id(5), name: "Extras", customer_label: "Extras", required: false, min_select: 0, size_rules: [], choices: [{ id: id(6), name: "Croutons", price_delta_cents: 150, default_selected: false, variant_prices: [] }] }] });
const order = openOrderSchema.parse({ id: id(1), order_number: "W000001", daily_number: 1, customer_name: "Split test", fulfillment_type: "pickup", source: "pos", status: "placed", payment_method: "cash", payment_status: "unpaid", total_cents: 3000, paid_cents: 0, placed_at: "2026-11-02T12:00:00Z", promised_at: null, ready_at: null, is_test: true });
function Fixture() {
  const [done, setDone] = useState<unknown>(null);
  if (location.pathname === "/modifiers") return <><PosItemDialog initialLine={null} item={item} onAdd={setDone} onClose={() => {}} /><output>{done ? JSON.stringify(done) : ""}</output></>;
  return <><PaymentPrompt keyedCardConfig={null} onFinished={setDone} onPayLater={() => {}} order={order} stripeReader={false} /><output>{done ? "Finished" : "Order open"}</output></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
