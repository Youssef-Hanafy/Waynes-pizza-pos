import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTipPostgres, ownerId } from "./helpers/tip-postgres";

describe("changing the real order fulfillment", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async () => { db = await startTipPostgres(); await db.admin.query("update public.store_settings set delivery_fee_cents=200,delivery_enabled=true,delivery_postal_codes='{}',delivery_minimum_cents=0,pickup_minimum_cents=0"); }, 180000);
  afterAll(async () => { await db?.stop(); });
  async function order(type = "pickup", payment = "unpaid") {
    const id = randomUUID();
    await db.admin.query(`insert into public.orders(id,order_number,source,fulfillment_type,status,payment_status,payment_method,customer_name_snapshot,customer_phone_snapshot,placed_at,idempotency_key,subtotal_cents,tax_cents,tip_cents,delivery_fee_cents,total_cents,pricing_snapshot)
      values($1,$2,'phone',$3,'placed',$4,'card','Pat','5085550144',now(),$5,1000,100,500,$6,$7,'{}'::jsonb)`, [id, `FF-${id.slice(0,8)}`,type,payment,randomUUID(),type === "delivery" ? 200 : 0,type === "delivery" ? 1800 : 1600]);
    return id;
  }
  const body = (type = "delivery", from = "pickup", total = 1600) => ({ idempotency_key: randomUUID(), fulfillment_type: type, expected_fulfillment_type: from, expected_total_cents: total, customer_name: "Pat", customer_phone: "5085550144", delivery_address: type === "delivery" ? { address1: "10 Main St", address2: "", city: "Worcester", state: "MA", postal_code: "01606", delivery_instructions: "Side door" } : null });
  async function change(id: string, input: object, user = ownerId) {
    await db.admin.query("begin; set local role authenticated");
    await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
    try { const r = await db.admin.query("select public.wayne_pos_change_fulfillment($1,$2::jsonb) value",[id,JSON.stringify(input)]); await db.admin.query("commit"); return r.rows[0].value; }
    catch (error) { await db.admin.query("rollback"); throw error; }
  }
  async function payment(id: string, status = "captured") {
    const p = randomUUID();
    await db.admin.query("insert into public.payments(id,order_id,provider,provider_payment_id,method,status,amount_cents) select $1,id,'stripe',$2,'card',$3,total_cents from public.orders where id=$4", [p,`pi_fulfillment_${p}`,status,id]);
    return p;
  }
  it("switches the same unpaid order both ways with address, fee and tip intact; retry has one event", async () => {
    const id=await order(); const input=body();
    expect(await change(id,input)).toMatchObject({order_id:id,fulfillment_type:"delivery",total_cents:1800,delivery_fee_cents:200,duplicate:false});
    expect(await change(id,input)).toMatchObject({duplicate:true,total_cents:1800});
    expect((await db.admin.query("select count(*)::int n from public.order_events where order_id=$1 and event_type='order.fulfillment_changed'",[id])).rows[0].n).toBe(1);
    expect(await change(id,body("pickup","delivery",1800))).toMatchObject({fulfillment_type:"pickup",delivery_address:null,total_cents:1600});
    expect((await db.admin.query("select tip_cents from public.orders where id=$1",[id])).rows[0].tip_cents).toBe(500);
  });
  it("adds only the delivery fee as a balance on a paid pickup without changing its captured receipt", async () => {
    const id=await order("pickup","paid"); const p=await payment(id);
    expect(await change(id,body())).toMatchObject({payment_status:"unpaid",total_cents:1800});
    const row=(await db.admin.query("select amount_cents,public.wayne_order_paid_cents(order_id) paid from public.payments where id=$1",[p])).rows[0];
    expect(row).toEqual({amount_cents:1600,paid:1600});
  });
  it("does not remove a paid fee until a real refund is recorded, then applies the net paid amount", async () => {
    const id=await order("delivery","paid"); const p=await payment(id); const input=body("pickup","delivery",1800);
    await expect(change(id,input)).rejects.toThrow("Refund the delivery fee");
    await db.admin.query("begin; set local role authenticated");
    await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
    const allocation=(await db.admin.query("select public.wayne_begin_allocated_refund($1::jsonb) value",[JSON.stringify({payment_id:p,order_id:id,amount_cents:200,tip_cents:0,idempotency_key:randomUUID(),reason:"Delivery fee - changed to pickup"})])).rows[0].value;
    await db.admin.query("commit");
    await db.admin.query("select public.wayne_settle_refund($1::jsonb)",[JSON.stringify({refund_id:allocation.legs[0].id,status:"completed",provider_refund_id:`re_fee_${id}`})]);
    expect(await change(id,input)).toMatchObject({fulfillment_type:"pickup",total_cents:1600,payment_status:"paid"});
    expect((await db.admin.query("select amount_cents from public.payments where id=$1",[p])).rows[0].amount_cents).toBe(1800);
    await db.admin.query("begin; set local role authenticated");
    await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
    try {
      const remaining=(await db.admin.query("select public.wayne_begin_allocated_refund($1::jsonb) value",[JSON.stringify({payment_id:p,order_id:id,amount_cents:1600,tip_cents:500,idempotency_key:randomUUID(),reason:"Refund the remaining adjusted order"})])).rows[0].value;
      expect(remaining.legs[0].amount_cents).toBe(1600);
    } finally { await db.admin.query("rollback"); }
  });
  it("rejects incomplete delivery addresses without changing the order", async () => {
    const id=await order(); await expect(change(id,{...body(),delivery_address:null})).rejects.toThrow("street address");
    expect((await db.admin.query("select fulfillment_type from public.orders where id=$1",[id])).rows[0].fulfillment_type).toBe("pickup");
  });
  it("rejects stale order totals", async () => { const id=await order(); await expect(change(id,body("delivery","pickup",1))).rejects.toThrow("another screen"); });
  it("never changes a pending card payment", async () => { const id=await order(); await payment(id,"pending"); await expect(change(id,body())).rejects.toThrow("payment is in progress"); });
  it("does not silently change an existing card approval", async () => { const id=await order(); await payment(id,"authorized"); await expect(change(id,body())).rejects.toThrow("Void its approval"); });
  it("releases an uncollected assigned driver when switching to pickup", async () => {
    const id=await order("delivery");
    await db.admin.query("insert into public.delivery_assignments(order_id,driver_id) values($1,$2)",[id,ownerId]);
    await change(id,body("pickup","delivery",1800));
    expect((await db.admin.query("select status from public.delivery_assignments where order_id=$1",[id])).rows[0].status).toBe("released");
  });
  it("refuses to take an order away from a driver who already picked it up", async () => {
    const id=await order("delivery");
    await db.admin.query("insert into public.delivery_assignments(order_id,driver_id,status,picked_up_at) values($1,$2,'picked_up',now())",[id,ownerId]);
    await expect(change(id,body("pickup","delivery",1800))).rejects.toThrow("already with the driver");
  });
  it("records a confirmed cash fee refund on the open drawer exactly once", async () => {
    const id=await order("delivery","paid"), register=randomUUID(), shift=randomUUID();
    await db.admin.query("update public.orders set payment_method='cash' where id=$1",[id]);
    await db.admin.query("insert into public.registers(id,label) values($1,$2)",[register,`Fulfillment ${register}`]);
    await db.admin.query("insert into public.register_shifts(id,register_id,opened_by_user_id,opening_cash_cents) values($1,$2,$3,5000)",[shift,register,ownerId]);
    await db.admin.query("insert into public.payments(order_id,provider,method,status,amount_cents,shift_id) values($1,'manual','cash','captured',1800,$2)",[id,shift]);
    const input={...body("pickup","delivery",1800),refund_cash:true,refund_shift_id:shift};
    expect(await change(id,input)).toMatchObject({total_cents:1600,payment_status:"paid"});
    expect(await change(id,input)).toMatchObject({duplicate:true});
    expect((await db.admin.query("select count(*)::int n,sum(amount_cents)::int cents from public.refunds where order_id=$1 and status='completed'",[id])).rows[0]).toEqual({n:1,cents:200});
    expect((await db.admin.query("select public.wayne_shift_cash_totals($1) value",[shift])).rows[0].value.expected_cash_cents).toBe(6600);
  });
  it("requires POS authorization", async () => { const id=await order(); await expect(change(id,body(),randomUUID())).rejects.toThrow("POS access"); });
  it("rejects a completed order", async () => { const id=await order(); await db.admin.query("update public.orders set status='completed' where id=$1",[id]); await expect(change(id,body())).rejects.toThrow("active main order"); });
});
