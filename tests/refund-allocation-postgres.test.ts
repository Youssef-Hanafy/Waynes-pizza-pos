import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTipPostgres, ownerId } from "./helpers/tip-postgres";

describe("allocated refunds on real PostgreSQL", () => {
 let db: Awaited<ReturnType<typeof startTipPostgres>>;
 beforeAll(async()=>{db=await startTipPostgres();},120000);
 afterEach(async()=>{await db.closeTestClients();});
 afterAll(async()=>{await db?.stop();});
 async function fixture(split=true) {
  const f=await db.fixture();
  await db.admin.query("update public.orders set tip_cents=500,total_cents=$2,payment_status='paid',fulfillment_type='delivery' where id=$1",[f.orderId,f.amount+500]);
  await db.admin.query("update public.payments set status='captured',amount_cents=$2,metadata=$3 where id=$1",[f.paymentId,f.amount+500,JSON.stringify({tip_cents:500,...(split?{tip_charge_intent:'pi_tip_'+f.paymentId,tip_charge_cents:500}:{})})]);
  return f;
 }
 async function begin(f: Awaited<ReturnType<typeof fixture>>, amount: number, tip=0, key=randomUUID(), client=db.admin) {
  await client.query("begin; set local role authenticated"); await client.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
  try {const r=(await client.query("select public.wayne_begin_allocated_refund($1) value",[JSON.stringify({payment_id:f.paymentId,order_id:f.orderId,amount_cents:amount,tip_cents:tip,reason:'Synthetic refund',idempotency_key:key})])).rows[0].value;await client.query('commit');return r;}
  catch(e){await client.query('rollback');throw e;}
 }
 async function settle(id:string,status='completed') {
  const {api}=await db.service();const result=await api.rpc('wayne_settle_refund',{payload:{refund_id:id,status,provider_refund_id:'re_'+id,provider_status:status==='completed'?'succeeded':status}});
  if(result.error)throw Error(result.error.message);return result.data;
 }
 it('refunds a held original authorization only after capture; authorization uses void instead',async()=>{
  const f=await db.fixture();await expect(begin(f,100)).rejects.toThrow('Only a captured Stripe');
 });
 it('keeps order-first partial refunds on the original intent and preserves the tip',async()=>{
  const f=await fixture();const r=await begin(f,700);expect(r.legs).toHaveLength(1);expect(r.legs[0]).toMatchObject({provider_payment_id:f.originalId,amount_cents:700,tip_cents:0});
  await settle(r.legs[0].id);expect((await db.admin.query('select tip_cents,tip_refunded_cents,payment_status from public.orders where id=$1',[f.orderId])).rows[0]).toEqual({tip_cents:500,tip_refunded_cents:0,payment_status:'partially_refunded'});
 });
 it('refuses implicit tip refunds or amounts beyond the remaining base',async()=>{
  const f=await fixture();await expect(begin(f,f.amount+500)).rejects.toThrow('select tip explicitly');
  await begin(f,f.amount);await expect(begin(f,1)).rejects.toThrow('remaining refundable');
 });
 it('allocates a full split refund across original and separate tip with exact totals',async()=>{
  const f=await fixture();const r=await begin(f,f.amount+500,500);expect(r.legs.map((r:{amount_cents:number})=>r.amount_cents)).toEqual([f.amount,500]);
  expect(r.legs[1].provider_payment_id).toBe('pi_tip_'+f.paymentId);
  await settle(r.legs[0].id);await settle(r.legs[1].id);await settle(r.legs[1].id);
  const o=(await db.admin.query('select tip_cents,tip_refunded_cents,payment_status,total_cents from public.orders where id=$1',[f.orderId])).rows[0];
  expect(o).toEqual({tip_cents:500,tip_refunded_cents:500,payment_status:'refunded',total_cents:f.amount+500});
 });
 it('supports explicit partial tip-only refunds without changing captured history',async()=>{
  const f=await fixture();const r=await begin(f,200,200);expect(r.legs).toHaveLength(1);expect(r.legs[0].provider_payment_id).toBe('pi_tip_'+f.paymentId);await settle(r.legs[0].id);
  expect((await db.admin.query('select amount_cents from public.payments where id=$1',[f.paymentId])).rows[0].amount_cents).toBe(f.amount+500);
 });
 it('uses a single intent for replacement/full charges while retaining explicit tip allocation',async()=>{
  const f=await fixture(false);const r=await begin(f,f.amount+500,500);expect(r.legs).toHaveLength(1);expect(r.legs[0].tip_cents).toBe(500);await settle(r.legs[0].id);
 });
 it('returns the same leg IDs on duplicate requests and rejects changed allocation',async()=>{
  const f=await fixture();const key=randomUUID();const first=await begin(f,100,0,key);expect((await begin(f,100,0,key)).legs[0].id).toBe(first.legs[0].id);await expect(begin(f,200,0,key)).rejects.toThrow('different request');
 });
 it('serializes competing reservations on separate connections without over-refunding',async()=>{
  const f=await fixture();const a=await db.connect(),b=await db.connect();const r=await Promise.allSettled([begin(f,f.amount,0,randomUUID(),a),begin(f,f.amount,0,randomUUID(),b)]);expect(r.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(r.filter(r=>r.status==='rejected')).toHaveLength(1);
 });
 it('retains completed base refund if a tip leg fails and only releases the failed reservation',async()=>{
  const f=await fixture();const r=await begin(f,f.amount+500,500);await settle(r.legs[0].id);await settle(r.legs[1].id,'failed');const next=await begin(f,500,500);expect(next.legs).toHaveLength(1);await expect(begin(f,1)).rejects.toThrow('remaining refundable');
 });
 async function cashout(f:Awaited<ReturnType<typeof fixture>>) {
  await db.admin.query('insert into public.delivery_assignments(order_id,driver_id,status) values($1,$2,\'assigned\')',[f.orderId,ownerId]);
  await db.admin.query("begin; set local role authenticated"); await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
  try {const r=(await db.admin.query("select public.wayne_pos_driver_cashout($1,'[]','[]') value",[ownerId])).rows[0].value;await db.admin.query('commit');return r;}catch(e){await db.admin.query('rollback');throw e;}
 }
 it('subtracts refunded tips before cashout and creates no driver recovery due',async()=>{
  const f=await fixture();const r=await begin(f,200,200);await settle(r.legs[0].id);const c=await cashout(f);expect(c.card_tips_cents).toBe(300);
  expect((await db.admin.query('select count(*)::int n from public.driver_tip_recovery_dues where order_id=$1',[f.orderId])).rows[0].n).toBe(0);
 });
 it('records paid driver tip recovery once without altering the original cashout or inventing cash receipts',async()=>{
  const f=await fixture();await cashout(f);const before=(await db.admin.query('select count(*)::int n from public.cash_movements')).rows[0].n;
  const r=await begin(f,500,500);await settle(r.legs[0].id);await settle(r.legs[0].id);
  expect((await db.admin.query('select amount_cents from public.driver_tip_recovery_dues where order_id=$1',[f.orderId])).rows).toEqual([{amount_cents:500}]);
  expect((await db.admin.query('select tip_cents from public.delivery_assignments where order_id=$1',[f.orderId])).rows[0].tip_cents).toBe(500);
  expect((await db.admin.query('select count(*)::int n from public.cash_movements')).rows[0].n).toBe(before);
 });
 it('serializes tip refund against driver cashout with exactly the net entitlement',async()=>{
  const f=await fixture();const r=await begin(f,200,200);await Promise.all([cashout(f),settle(r.legs[0].id)]);
  const assigned=(await db.admin.query('select tip_cents from public.delivery_assignments where order_id=$1',[f.orderId])).rows[0].tip_cents;
  const due=(await db.admin.query('select coalesce(sum(amount_cents),0)::int n from public.driver_tip_recovery_dues where order_id=$1',[f.orderId])).rows[0].n;
  expect(assigned-due).toBe(300);
 });
 it('prevents legacy Stripe refunds from bypassing explicit allocation',async()=>{
  const f=await fixture();const c=await db.connect();await c.query("begin;set local role authenticated");await c.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
  await expect(c.query("select public.wayne_begin_refund($1)",[JSON.stringify({payment_id:f.paymentId,amount_cents:100,reason:'Synthetic refund',idempotency_key:randomUUID()})])).rejects.toThrow('allocated Stripe refund');await c.query('rollback');
 });
 it('does not let a cashier allocate refunds',async()=>{
  const f=await fixture();const cashier=randomUUID();await db.admin.query("insert into auth.users(id,email) values($1,'refund-cashier@test.invalid')",[cashier]);
  const c=await db.connect();await c.query('begin;set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[cashier]);
  await expect(c.query('select public.wayne_begin_allocated_refund($1)',[JSON.stringify({payment_id:f.paymentId,order_id:f.orderId,amount_cents:100,reason:'Synthetic refund',idempotency_key:randomUUID()})])).rejects.toThrow('Payment management permission required');await c.query('rollback');
 });
 it('does not expose refund records for another workspace',async()=>{
  const c=await db.connect();await c.query('begin;set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
  await expect(c.query('select public.wayne_order_refund_requests($1)',[randomUUID()])).rejects.toThrow('Payment management permission required');await c.query('rollback');
 });
 it('keeps owner closeout tip entitlement net of explicit tip refunds',async()=>{
  const f=await fixture();await db.admin.query("update public.orders set fulfillment_type='pickup' where id=$1",[f.orderId]);
  async function ownerTips(){const c=await db.connect();await c.query('begin;set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);const r=(await c.query("select (public.wayne_day_closeout((now() at time zone 'America/New_York')::date)#>>'{tip_payout,owner_card_tips_cents}')::int value")).rows[0].value;await c.query('rollback');return r;}
  const before=await ownerTips();const r=await begin(f,200,200);await settle(r.legs[0].id);
  expect(await ownerTips()).toBe(before-200);
 });
 async function prepareVoid(f:Awaited<ReturnType<typeof db.fixture>>,orderId=f.orderId){
  const c=await db.connect();await c.query('begin;set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
  try {const r=(await c.query('select public.wayne_prepare_payment_void($1,$2) value',[f.paymentId,orderId])).rows[0].value;await c.query('commit');return r;}catch(e){await c.query('rollback');throw e;}
 }
 it('binds authorization voids to their actual order and intent',async()=>{
  const f=await db.fixture();await expect(prepareVoid(f,randomUUID())).rejects.toThrow('not allowed');expect(await prepareVoid(f)).toMatchObject({provider_payment_id:f.originalId,duplicate:false});
  const api=(await db.service()).api;expect((await api.rpc('wayne_finish_payment_void',{target_payment_id:f.paymentId,provider_id:'pi_someone_else'})).error).not.toBeNull();
  expect((await api.rpc('wayne_finish_payment_void',{target_payment_id:f.paymentId,provider_id:f.originalId})).error).toBeNull();expect((await prepareVoid(f)).duplicate).toBe(true);
 });
 it('blocks tip capture after a durable void reservation',async()=>{
  const f=await db.fixture();await prepareVoid(f);const api=(await db.service()).api;const r=await api.rpc('wayne_claim_tip_operation',{target_payment_id:f.paymentId,target_workspace_id:'40000000-0000-4000-8000-000000000001',requested_tip:500,worker_token:randomUUID(),origin:'void-race'});expect(r.error).toBeNull();expect(r.data).toMatchObject({acquired:false,busy:true});
 });
 it('blocks voids once a tip operation has claimed the authorization',async()=>{
  const f=await db.fixture();await db.admin.query('update public.pos_tip_capture_control set execution_enabled=true');const api=(await db.service()).api;const r=await api.rpc('wayne_claim_tip_operation',{target_payment_id:f.paymentId,target_workspace_id:'40000000-0000-4000-8000-000000000001',requested_tip:500,worker_token:randomUUID(),origin:'void-race'});expect(r.error).toBeNull();await expect(prepareVoid(f)).rejects.toThrow('existing tip operation');
 });
 it('allows only one winner when void and tip capture race across PostgreSQL sessions',async()=>{
  const f=await db.fixture();await db.admin.query('update public.pos_tip_capture_control set execution_enabled=true');const api=(await db.service()).api;
  const [voided,claimed]=await Promise.allSettled([prepareVoid(f),api.rpc('wayne_claim_tip_operation',{target_payment_id:f.paymentId,target_workspace_id:'40000000-0000-4000-8000-000000000001',requested_tip:500,worker_token:randomUUID(),origin:'void-race'})]);
  const voidWon=voided.status==='fulfilled';const tipWon=claimed.status==='fulfilled'&&Boolean((claimed.value.data as {acquired?:boolean})?.acquired);expect(Number(voidWon)+Number(tipWon)).toBe(1);
 });
 it('preserves completed refunds, recovery dues and capture control on migration reapplication',async()=>{
  const before=(await db.admin.query('select count(*)::int n from public.refunds')).rows[0].n;
  await db.admin.query('update public.pos_tip_capture_control set execution_enabled=false');
  await db.admin.query(await readFile('supabase/migrations/20261120080000_allocated_stripe_refunds.sql','utf8'));
  expect((await db.admin.query('select count(*)::int n from public.refunds')).rows[0].n).toBe(before);
  expect((await db.admin.query('select execution_enabled from public.pos_tip_capture_control')).rows[0].execution_enabled).toBe(false);
 });
});
