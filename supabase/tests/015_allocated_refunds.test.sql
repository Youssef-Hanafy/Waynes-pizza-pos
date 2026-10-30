begin;
set local search_path=public,extensions;
select plan(16);
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
 values('7b000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','refund-owner@test.local','',now(),'{}','{}');
update public.profiles set active=true,role_id=(select id from public.roles where code='owner') where id='7b000000-0000-4000-8000-000000000001';
insert into public.orders(id,order_number,source,fulfillment_type,status,payment_status,payment_method,subtotal_cents,total_cents,tip_cents,customer_name_snapshot,customer_phone_snapshot,pricing_snapshot,idempotency_key,is_test)
 values('7b000000-0000-4000-8000-000000000010','REFUND-PGTAP','pos','delivery','placed','paid','card',2000,2500,500,'Synthetic refund','+15085550100','{}','refund-pgtap-order',true);
insert into public.payments(id,order_id,provider,provider_payment_id,method,amount_cents,status,metadata)
 values('7b000000-0000-4000-8000-000000000020','7b000000-0000-4000-8000-000000000010','stripe','pi_pgtap_refund_original','card',2500,'captured','{"tip_charge_intent":"pi_pgtap_refund_tip","tip_cents":500}');
set local role authenticated;
select set_config('request.jwt.claim.sub','7b000000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.wayne_begin_allocated_refund('{"payment_id":"7b000000-0000-4000-8000-000000000020","order_id":"7b000000-0000-4000-8000-000000000010","amount_cents":2500,"tip_cents":0,"reason":"Synthetic refund","idempotency_key":"refund-pgtap-implicit-tip"}')$$,'22023','That is more than the remaining refundable order amount or tip; select tip explicitly','tip is never refunded implicitly');
select set_config('refund.full',public.wayne_begin_allocated_refund('{"payment_id":"7b000000-0000-4000-8000-000000000020","order_id":"7b000000-0000-4000-8000-000000000010","amount_cents":2500,"tip_cents":500,"reason":"Synthetic refund","idempotency_key":"refund-pgtap-explicit-full"}')::text,true);
select is(jsonb_array_length(current_setting('refund.full')::jsonb->'legs'),2,'full split refund has two durable legs');
select is(current_setting('refund.full')::jsonb#>>'{legs,0,provider_payment_id}','pi_pgtap_refund_original','order refund retains original provider identity');
select is((current_setting('refund.full')::jsonb#>>'{legs,0,amount_cents}')::int,2000,'order leg reserves exactly twenty dollars');
select is(current_setting('refund.full')::jsonb#>>'{legs,1,provider_payment_id}','pi_pgtap_refund_tip','tip refund uses separate provider identity');
select is((current_setting('refund.full')::jsonb#>>'{legs,1,tip_cents}')::int,500,'tip leg reserves exactly five dollars');
select is(public.wayne_begin_allocated_refund('{"payment_id":"7b000000-0000-4000-8000-000000000020","order_id":"7b000000-0000-4000-8000-000000000010","amount_cents":2500,"tip_cents":500,"reason":"Synthetic refund","idempotency_key":"refund-pgtap-explicit-full"}')->>'request_id',current_setting('refund.full')::jsonb->>'request_id','duplicate request returns same durable allocation');
select throws_ok($$select public.wayne_begin_allocated_refund('{"payment_id":"7b000000-0000-4000-8000-000000000020","order_id":"7b000000-0000-4000-8000-000000000010","amount_cents":1,"tip_cents":0,"reason":"Synthetic refund","idempotency_key":"refund-pgtap-over-reserved"}')$$,'22023','That is more than the remaining refundable order amount or tip; select tip explicitly','pending reservations prevent over-refund');
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub','',true);
select lives_ok($$select public.wayne_settle_refund(jsonb_build_object('refund_id',current_setting('refund.full')::jsonb#>>'{legs,0,id}','status','completed','provider_refund_id','re_pgtap_original'))$$,'base receipt settles');
reset role;
select is((select payment_status from public.orders where id='7b000000-0000-4000-8000-000000000010'),'partially_refunded','base-only refund leaves the tip paid');
set local role service_role;
select lives_ok($$select public.wayne_settle_refund(jsonb_build_object('refund_id',current_setting('refund.full')::jsonb#>>'{legs,1,id}','status','completed','provider_refund_id','re_pgtap_tip'))$$,'tip receipt settles');
select is((public.wayne_settle_refund(jsonb_build_object('refund_id',current_setting('refund.full')::jsonb#>>'{legs,1,id}','status','completed','provider_refund_id','re_pgtap_tip'))->>'duplicate')::boolean,true,'duplicate settlement is idempotent');
reset role;
select is((select payment_status from public.orders where id='7b000000-0000-4000-8000-000000000010'),'refunded','all legs required for full refund');
select is((select tip_refunded_cents from public.orders where id='7b000000-0000-4000-8000-000000000010'),500,'tip entitlement reduced exactly once');
select is((select amount_cents from public.payments where id='7b000000-0000-4000-8000-000000000020'),2500,'captured financial history retained');
select is((select count(*) from public.driver_tip_recovery_dues where order_id='7b000000-0000-4000-8000-000000000010'),0::bigint,'unpaid driver tip creates no recovery due');
select * from finish();
rollback;
