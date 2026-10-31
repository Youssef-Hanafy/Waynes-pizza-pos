#!/usr/bin/env node
/**
 * Staging + Stripe sandbox proof for the delivery tip-before-payment release (Issue #5).
 *
 * Run AFTER doing the acceptance on the staging POS (delivery $30 → Key in card → Add tip $5 →
 * approve 4242 4242 4242 4242 → driver cash-out with the Extra box blank):
 *
 *   STAGING_SUPABASE_URL=https://pkjrdvtdygiprmsojdqg.supabase.co \
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY=... STRIPE_SANDBOX_SECRET_KEY=sk_test_... \
 *   node scripts/verify-delivery-tip-staging.mjs <order-id> [expected-order-cents=3000] [expected-phone-tip-cents=500] [expected-extra-tip-cents=0]
 *
 * Stripe search can lag about a minute behind new PaymentIntents; run it a minute after the cash-out.
 * Read-only: it never writes to Supabase or Stripe. It refuses production (Supabase
 * vxpkdmtornkeoedkawkt) and live Stripe keys.
 */
const [orderId, orderArg = "3000", tipArg = "500", extraArg = "0"] = process.argv.slice(2);
const supabaseUrl = process.env.STAGING_SUPABASE_URL ?? "";
const serviceKey = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? "";
const stripeKey = process.env.STRIPE_SANDBOX_SECRET_KEY ?? "";
const fail = (message) => { console.error(`FAIL: ${message}`); process.exitCode = 1; };
if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) { console.error("Usage: node scripts/verify-delivery-tip-staging.mjs <order-id> [order-cents] [phone-tip-cents] [extra-tip-cents]"); process.exit(2); }
if (!supabaseUrl || !serviceKey || !stripeKey) { console.error("Set STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY and STRIPE_SANDBOX_SECRET_KEY."); process.exit(2); }
if (supabaseUrl.includes("vxpkdmtornkeoedkawkt")) { console.error("Refusing: that is the PRODUCTION Supabase project."); process.exit(2); }
if (!stripeKey.startsWith("sk_test_") && !stripeKey.startsWith("rk_test_")) { console.error("Refusing: only a Stripe sandbox (test) key is allowed."); process.exit(2); }

const orderCents = Number(orderArg), phoneTip = Number(tipArg), extraTip = Number(extraArg);
const db = async (path) => {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } });
  if (!response.ok) throw new Error(`Supabase ${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const stripe = async (path) => {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${stripeKey}` } });
  if (!response.ok) throw new Error(`Stripe ${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

const [order] = await db(`orders?id=eq.${orderId}&select=id,order_number,daily_number,fulfillment_type,tip_cents,total_cents,payment_status`);
if (!order) { console.error("Order not found on staging."); process.exit(2); }
const payments = await db(`payments?order_id=eq.${orderId}&select=id,provider,provider_payment_id,status,amount_cents,metadata&order=created_at`);
const assignments = await db(`delivery_assignments?order_id=eq.${orderId}&select=tip_cents,cashout_id,status`);
console.log(`Order ${order.order_number} (#${order.daily_number ?? "?"}) ${order.fulfillment_type}: tip ${dollars(order.tip_cents)}, total ${dollars(order.total_cents)}, ${order.payment_status}`);

const live = payments.filter((p) => p.status === "authorized" || p.status === "captured");
if (live.length !== 1) fail(`expected exactly one authorized/captured payment, found ${live.length}`);
const payment = live[0];
const expectedTotal = orderCents + phoneTip + extraTip;
if (order.tip_cents !== phoneTip + extraTip) fail(`order tip ${dollars(order.tip_cents)} ≠ ${dollars(phoneTip + extraTip)}`);
if (order.total_cents !== expectedTotal) fail(`order total ${dollars(order.total_cents)} ≠ ${dollars(expectedTotal)}`);
if (payment && payment.amount_cents !== expectedTotal) fail(`payment amount ${dollars(payment.amount_cents)} ≠ ${dollars(expectedTotal)}`);
if (payment && (payment.metadata?.tip_included_cents ?? 0) !== phoneTip) fail(`payment tip_included_cents ${payment.metadata?.tip_included_cents} ≠ ${phoneTip}`);

// Every Stripe PaymentIntent created for any payment row of this order.
const intents = [];
for (const row of payments) {
  const found = await stripe(`payment_intents/search?query=${encodeURIComponent(`metadata['wayne_payment_id']:'${row.id}'`)}&limit=20`);
  intents.push(...found.data);
}
const succeeded = intents.filter((pi) => pi.status === "succeeded");
const original = succeeded.find((pi) => pi.metadata?.wayne_tip_only !== "true");
const tipOnly = succeeded.filter((pi) => pi.metadata?.wayne_tip_only === "true");
console.log(`Stripe: ${intents.length} PaymentIntent(s): ${intents.map((pi) => `${pi.id} ${pi.status} ${dollars(pi.amount)} received ${dollars(pi.amount_received)} tip=${pi.metadata?.wayne_tip_cents ?? "-"}`).join("; ")}`);
if (!original) fail("no succeeded original PaymentIntent");
else {
  if (original.amount !== orderCents + phoneTip) fail(`original authorization ${dollars(original.amount)} ≠ ${dollars(orderCents + phoneTip)}`);
  if (original.amount_received !== orderCents + phoneTip) fail(`original captured ${dollars(original.amount_received)} ≠ ${dollars(orderCents + phoneTip)}`);
  if (Number(original.metadata?.wayne_tip_cents ?? 0) !== phoneTip) fail(`Stripe wayne_tip_cents ${original.metadata?.wayne_tip_cents} ≠ ${phoneTip}`);
  const charges = await stripe(`charges?payment_intent=${original.id}&limit=10`);
  if (charges.data.filter((charge) => charge.captured).length !== 1) fail(`original has ${charges.data.length} charge(s); expected one captured charge`);
}
if (tipOnly.length !== (extraTip ? 1 : 0)) fail(`expected ${extraTip ? 1 : 0} separate tip charge(s), found ${tipOnly.length}`);
if (extraTip && tipOnly[0]?.amount_received !== extraTip) fail(`separate tip ${dollars(tipOnly[0]?.amount_received ?? 0)} ≠ ${dollars(extraTip)}`);
const others = intents.filter((pi) => pi.status === "succeeded" || pi.status === "requires_capture").length - (original ? 1 : 0) - tipOnly.length;
if (others !== 0) fail(`${others} other approved/charged PaymentIntent(s) exist for this order`);
const stripeTotal = succeeded.reduce((sum, pi) => sum + pi.amount_received, 0);
if (stripeTotal !== expectedTotal) fail(`Stripe collected ${dollars(stripeTotal)} ≠ ${dollars(expectedTotal)}`);

const assignment = assignments[0];
if (!assignment?.cashout_id) fail("the order has not been cashed out with a driver yet");
else if (assignment.tip_cents !== phoneTip + extraTip) fail(`driver paid ${dollars(assignment.tip_cents)} ≠ ${dollars(phoneTip + extraTip)}`);

console.log(process.exitCode ? "RESULT: FAILED (see above)" : `RESULT: PASS — Stripe collected ${dollars(stripeTotal)} (${dollars(orderCents + phoneTip)} on one PaymentIntent${extraTip ? ` + ${dollars(extraTip)} separate tip` : ""}), order and payment agree, driver paid ${dollars(phoneTip + extraTip)} once.`);
