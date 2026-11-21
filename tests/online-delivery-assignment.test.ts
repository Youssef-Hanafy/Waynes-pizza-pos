import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTipPostgres, ownerId } from "./helpers/tip-postgres";
import { posDeliveryBoardSchema, posCashoutResultSchema } from "@/lib/delivery/pos-board";

let db: Awaited<ReturnType<typeof startTipPostgres>>;
const driverId = randomUUID();
beforeAll(async () => {
  db = await startTipPostgres();
  await db.admin.query("insert into auth.users(id,email) values($1,'online-driver@example.invalid')", [driverId]);
  await db.admin.query(`update public.profiles set active=true, display_name='Online driver', role_id=(select id from public.roles where code='driver') where id=$1`, [driverId]);
}, 180_000);
afterAll(async () => { await db?.stop(); });

async function asOwner(sql: string, params: unknown[] = []) {
  await db.admin.query(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${ownerId}',true)`);
  try {
    const result = await db.admin.query(sql, params);
    await db.admin.query("commit");
    return result.rows[0]?.value;
  } catch (error) {
    await db.admin.query("rollback");
    throw error;
  }
}

it("assigns online and phone deliveries through the same board and pays an online tip once", async () => {
  const onlineId = randomUUID(), phoneId = randomUUID();
  for (const [id, source] of [[onlineId, "online"], [phoneId, "phone"]]) {
    await db.admin.query(`insert into public.orders(id,order_number,source,fulfillment_type,status,payment_status,payment_method,
      customer_name_snapshot,customer_phone_snapshot,delivery_address_snapshot,placed_at,idempotency_key,pricing_snapshot,subtotal_cents,tax_cents,total_cents,tip_cents)
      values($1::uuid,$2,$3,'delivery','placed',$4,'card','Delivery customer','5085550144','{"address1":"10 Main St","city":"Worcester"}',now(),$1::uuid::text,'{}',2700,300,$5,$6)`,
    [id, `ASSIGN-${id.slice(0, 8)}`, source, source === "online" ? "paid" : "unpaid", source === "online" ? 3500 : 3000, source === "online" ? 500 : 0]);
  }
  await db.admin.query(`insert into public.payments(order_id,provider,provider_payment_id,method,amount_cents,status,captured_at)
    values($1,'stripe','pi_online_assignment_test','card',3500,'captured',now())`, [onlineId]);
  let board = posDeliveryBoardSchema.parse(await asOwner("select public.wayne_pos_delivery_board() value"));
  expect(board.waiting.map(order => order.order_id)).toEqual(expect.arrayContaining([onlineId, phoneId]));
  for (const id of [onlineId, phoneId]) {
    await asOwner("select public.wayne_pos_send_out($1,$2) value", [id, driverId]);
  }
  board = posDeliveryBoardSchema.parse(await asOwner("select public.wayne_pos_delivery_board() value"));
  expect(board.waiting.map(order => order.order_id)).not.toContain(onlineId);
  const run = board.drivers.find(driver => driver.driver_id === driverId)!;
  expect(run.orders.map(order => order.order_id)).toEqual(expect.arrayContaining([onlineId, phoneId]));
  expect(run.orders.find(order => order.order_id === onlineId)).toMatchObject({ source: "online", status: "out_for_delivery", tip_cents: 500 });
  // Cash out the paid online order; leave the unpaid phone order for its own payment.
  const result = posCashoutResultSchema.parse(await asOwner(
    "select public.wayne_pos_driver_cashout($1,'[]'::jsonb,'[]'::jsonb,$2::jsonb,'') value", [driverId, JSON.stringify([phoneId])]));
  expect(result).toMatchObject({ order_count: 1, card_tips_cents: 500, hand_in_cents: -500 });
  board = posDeliveryBoardSchema.parse(await asOwner("select public.wayne_pos_delivery_board() value"));
  expect(board.drivers.find(driver => driver.driver_id === driverId)?.orders.map(order => order.order_id)).toEqual([phoneId]);
}, 30_000);
