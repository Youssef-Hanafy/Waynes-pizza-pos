begin;
set local search_path = public, extensions;
select plan(45);

-- All assertions target this transaction's fixtures, never existing store counts.
select ok((select relrowsecurity from pg_class where oid='public.kitchen_tickets'::regclass),'kitchen projection enables RLS');
select ok((select relrowsecurity from pg_class where oid='public.print_jobs'::regclass),'durable print queue enables RLS');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values
 ('4a000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase5-owner@test.local','',now(),'{}','{"display_name":"Phase 5 Owner"}'),
 ('4a000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase5-kitchen@test.local','',now(),'{}','{"display_name":"Phase 5 Kitchen"}'),
 ('4a000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase5-cashier@test.local','',now(),'{}','{"display_name":"Phase 5 Cashier"}');
update public.profiles set role_id=(select id from public.roles where code='owner'),active=true where id='4a000000-0000-4000-8000-000000000001';
update public.profiles set role_id=(select id from public.roles where code='kitchen'),active=true where id='4a000000-0000-4000-8000-000000000002';
update public.profiles set role_id=(select id from public.roles where code='cashier'),active=true where id='4a000000-0000-4000-8000-000000000003';
update public.store_settings set ordering_open=true,test_ordering_enabled=true,pickup_enabled=true,delivery_enabled=true,
 pickup_minimum_cents=0,delivery_minimum_cents=0,delivery_postal_codes=array['01606'],
 business_hours='{"sunday":{"closed":false,"open":"00:00","close":"24:00"},"monday":{"closed":false,"open":"00:00","close":"24:00"},"tuesday":{"closed":false,"open":"00:00","close":"24:00"},"wednesday":{"closed":false,"open":"00:00","close":"24:00"},"thursday":{"closed":false,"open":"00:00","close":"24:00"},"friday":{"closed":false,"open":"00:00","close":"24:00"},"saturday":{"closed":false,"open":"00:00","close":"24:00"}}';
update public.store_special_hours set closed=false,opens_at='00:00',closes_at='24:00'
 where service_date=(now() at time zone (select timezone from public.store_settings where id))::date and archived_at is null;
insert into public.menu_categories(id,name) values('4a000000-0000-4000-8000-000000000010','Phase 5 Fixture');
select set_config('phase5.destination','phase5-test-online-'||txid_current(),true);
insert into public.menu_items(id,category_id,name,base_price_cents,kitchen_route) values
 ('4a000000-0000-4000-8000-000000000011','4a000000-0000-4000-8000-000000000010','Fixture Pizza',1500,current_setting('phase5.destination'));
insert into public.menu_item_variants(id,menu_item_id,name,price_cents) values('4a000000-0000-4000-8000-000000000012','4a000000-0000-4000-8000-000000000011','Large',1800);
insert into public.modifier_groups(id,name,customer_label,min_select,max_select,allow_quantities) values('4a000000-0000-4000-8000-000000000013','Toppings','Toppings',0,3,true);
insert into public.modifier_choices(id,modifier_group_id,name,price_delta_cents) values('4a000000-0000-4000-8000-000000000014','4a000000-0000-4000-8000-000000000013','Pepperoni',150);
insert into public.menu_item_modifier_groups(menu_item_id,modifier_group_id) values('4a000000-0000-4000-8000-000000000011','4a000000-0000-4000-8000-000000000013');
select set_config('phase5.payload',jsonb_build_object(
 'idempotency_key','phase5-hosted-online-'||txid_current(),'fulfillment_type','delivery','first_name','Kitchen','last_name','Fixture','phone','508-555-0155','email','phase5@test.local',
 'sms_opt_in',false,'email_opt_in',false,'tip_cents',0,'promo_code','','special_instructions','Separate sauces',
 'address',jsonb_build_object('address1','93 West Boylston St','address2','','city','Worcester','state','MA','postal_code','01606','delivery_instructions','Private side door'),
 'items','[{"menu_item_id":"4a000000-0000-4000-8000-000000000011","variant_id":"4a000000-0000-4000-8000-000000000012","quantity":2,"special_instructions":"Well done","modifiers":[{"choice_id":"4a000000-0000-4000-8000-000000000014","quantity":1}]}]'::jsonb
)::text,true);
set local role anon;
select throws_ok($$select * from public.kitchen_tickets$$,'42501','permission denied for table kitchen_tickets','anonymous cannot read kitchen tickets');
reset role;
-- Checkout is server-only since the Phase 0-8 remediation; the app calls it as the service role.
set local role service_role;
select lives_ok($$select set_config('phase5.online',public.wayne_create_test_order(current_setting('phase5.payload')::jsonb)::text,true)$$,'online checkout creates a fixture order');
reset role;
select is((select count(*) from public.kitchen_tickets where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid),0::bigint,'ticket is deferred until the complete order transaction');

update public.menu_items set kitchen_route='phase5-test-pos-'||txid_current() where id='4a000000-0000-4000-8000-000000000011';
set local role authenticated;
select set_config('request.jwt.claim.sub','4a000000-0000-4000-8000-000000000003',true);
select lives_ok($$select set_config('phase5.pos',public.wayne_create_pos_order(current_setting('phase5.payload')::jsonb || jsonb_build_object(
 'idempotency_key','phase5-hosted-pos-'||txid_current(),'source','pos','customer_mode','walk_in','customer_id','','fulfillment_type','pickup','payment_method','test_manual',
 'first_name','','last_name','','phone','','email','','address_id','','manual_discount_type','','manual_discount_value',0,'manual_discount_reason',''
))::text,true)$$,'POS checkout creates a fixture order');
reset role;
-- Flush the same deferred trigger used at commit while preserving test rollback.
set constraints orders_kitchen_sync immediate;
set constraints orders_kitchen_sync deferred;
select is((select payload->>'source' from public.kitchen_tickets where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid),'online','online order reaches kitchen projection');
select is((select payload->>'source' from public.kitchen_tickets where order_id=(current_setting('phase5.pos')::jsonb->>'id')::uuid),'pos','POS order reaches kitchen projection');
select is((select payload->'items'->0->'modifiers'->0->>'name' from public.kitchen_tickets where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid),'Pepperoni','committed online ticket includes nested modifier snapshot');
select is((select payload->'items'->0->'modifiers'->0->>'name' from public.kitchen_tickets where order_id=(current_setting('phase5.pos')::jsonb->>'id')::uuid),'Pepperoni','committed POS ticket includes nested modifier snapshot');
select is((select destination from public.print_jobs where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid),current_setting('phase5.destination'),'route is captured when order items are saved');
select is((select count(*) from public.print_jobs where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid),1::bigint,'one durable print job is created per fixture station');

set local role authenticated;
select set_config('request.jwt.claim.sub','4a000000-0000-4000-8000-000000000002',true);
select is((select count(*) from public.orders where id=(current_setting('phase5.online')::jsonb->>'id')::uuid),0::bigint,'kitchen role cannot read private order row or token');
select ok((select not(payload ?| array['public_access_token','customer_phone','customer_email','delivery_address_snapshot','payment_status']) from public.kitchen_tickets where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid),'kitchen projection omits private customer and payment fields');
select is((select count(*) from public.print_jobs where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid),0::bigint,'kitchen role cannot read print management records');
select is(public.wayne_kitchen_board(),public.wayne_kitchen_board(),'refresh restores the same current board');
select throws_ok($$update public.kitchen_tickets set status='ready'$$,'42501','permission denied for table kitchen_tickets','kitchen cannot bypass transition RPC');
select throws_ok($$select public.wayne_claim_print_job(current_setting('phase5.destination'),'unauthorized-worker')$$,'42501','Print processing permission required','kitchen cannot process print jobs');
select set_config('request.jwt.claim.sub','4a000000-0000-4000-8000-000000000003',true);
select throws_ok($$select public.wayne_kitchen_board()$$,'42501','Kitchen access required','cashier cannot open kitchen board');
select throws_ok($$select public.wayne_kitchen_transition((current_setting('phase5.online')::jsonb->>'id')::uuid,'placed','accepted')$$,'42501','Kitchen access required','cashier cannot perform kitchen transitions');

select set_config('request.jwt.claim.sub','4a000000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.wayne_kitchen_transition((current_setting('phase5.online')::jsonb->>'id')::uuid,'placed','ready')$$,'22023','Invalid kitchen transition','kitchen cannot skip Accept and Start');
select is(public.wayne_kitchen_transition((current_setting('phase5.online')::jsonb->>'id')::uuid,'placed','accepted')->>'status','accepted','owner can accept order');
select is(public.wayne_kitchen_transition((current_setting('phase5.online')::jsonb->>'id')::uuid,'placed','accepted')->>'duplicate','true','duplicate Accept is idempotent');
select set_config('request.jwt.claim.sub','4a000000-0000-4000-8000-000000000002',true);
select is(public.wayne_kitchen_transition((current_setting('phase5.online')::jsonb->>'id')::uuid,'accepted','in_kitchen')->>'status','in_kitchen','kitchen staff can start order');
select throws_ok($$select public.wayne_kitchen_transition((current_setting('phase5.online')::jsonb->>'id')::uuid,'placed','accepted')$$,'40001','Order changed on another screen. Refresh the kitchen.','stale screen cannot overwrite newer status');
select is(public.wayne_kitchen_transition((current_setting('phase5.online')::jsonb->>'id')::uuid,'in_kitchen','ready')->>'status','ready','kitchen staff can mark ready');
reset role;
set constraints orders_kitchen_sync immediate;
set constraints orders_kitchen_sync deferred;
select ok((select accepted_at is not null and in_kitchen_at is not null and ready_at is not null from public.orders where id=(current_setting('phase5.online')::jsonb->>'id')::uuid),'all workflow timestamps persist');
select is((select count(*) from public.order_events where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid and event_type in ('order.accepted','order.in_kitchen','order.ready')),3::bigint,'exactly one event persists per transition');
select is((select status from public.kitchen_tickets where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid),'ready','refreshed projection preserves ready status');
select is((select count(*) from public.print_jobs where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid),1::bigint,'status transitions do not duplicate print jobs');

set local role authenticated;
select set_config('request.jwt.claim.sub','4a000000-0000-4000-8000-000000000001',true);
select set_config('phase5.lease',public.wayne_claim_print_job(current_setting('phase5.destination'),'phase5-worker')::text,true);
select is(current_setting('phase5.lease')::jsonb->>'status','processing','claim atomically leases the pending job');
select is(public.wayne_claim_print_job(current_setting('phase5.destination'),'other-worker'),null::jsonb,'another worker cannot claim the same job');
select throws_ok($$select public.wayne_finish_print_job((current_setting('phase5.lease')::jsonb->>'id')::uuid,'4a000000-0000-4000-8000-000000000099',true)$$,'40001','Stale print lease','wrong lease token cannot acknowledge a job');
select lives_ok($$select public.wayne_finish_print_job((current_setting('phase5.lease')::jsonb->>'id')::uuid,(current_setting('phase5.lease')::jsonb->>'lease_token')::uuid,false,'Printer offline before submission')$$,'offline print failure is durably recorded');
select is((select status from public.print_jobs where id=(current_setting('phase5.lease')::jsonb->>'id')::uuid),'failed','failed job remains visible');
select is((select status from public.orders where id=(current_setting('phase5.online')::jsonb->>'id')::uuid),'ready','printer failure preserves order and workflow state');
select lives_ok($$select public.wayne_retry_print_job((current_setting('phase5.lease')::jsonb->>'id')::uuid,'Device reconnected and queue inspected')$$,'owner can explicitly retry failed print job');
select is((select metadata->>'reason' from public.order_events where order_id=(current_setting('phase5.online')::jsonb->>'id')::uuid and event_type='print.retry_requested'),'Device reconnected and queue inspected','retry is audited with reason');
select set_config('phase5.retried',public.wayne_claim_print_job(current_setting('phase5.destination'),'phase5-worker')::text,true);
select is((current_setting('phase5.retried')::jsonb->>'attempts')::integer,2,'retry increments attempt count');
reset role;
update public.print_jobs set lease_expires_at=now()-interval '1 second' where id=(current_setting('phase5.retried')::jsonb->>'id')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub','4a000000-0000-4000-8000-000000000001',true);
select is(public.wayne_claim_print_job(current_setting('phase5.destination'),'reconnected-worker'),null::jsonb,'expired lease is not silently reprinted');
select throws_ok($$select public.wayne_finish_print_job((current_setting('phase5.retried')::jsonb->>'id')::uuid,(current_setting('phase5.retried')::jsonb->>'lease_token')::uuid,true)$$,'40001','Expired print lease','expired worker cannot acknowledge a job');
select lives_ok($$select public.wayne_retry_print_job((current_setting('phase5.retried')::jsonb->>'id')::uuid,'Inspected printer: ticket did not print')$$,'expired job can be retried after staff inspection');
select set_config('phase5.final_lease',public.wayne_claim_print_job(current_setting('phase5.destination'),'phase5-worker')::text,true);
select throws_ok($$select public.wayne_finish_print_job((current_setting('phase5.retried')::jsonb->>'id')::uuid,(current_setting('phase5.retried')::jsonb->>'lease_token')::uuid,true)$$,'40001','Stale print lease','old worker cannot acknowledge a newer lease');
select lives_ok($$select public.wayne_finish_print_job((current_setting('phase5.final_lease')::jsonb->>'id')::uuid,(current_setting('phase5.final_lease')::jsonb->>'lease_token')::uuid,true)$$,'current worker can acknowledge successful output');
select is((select status from public.print_jobs where id=(current_setting('phase5.final_lease')::jsonb->>'id')::uuid),'printed','successful print acknowledgement persists');

reset role;
select * from finish();
rollback;
