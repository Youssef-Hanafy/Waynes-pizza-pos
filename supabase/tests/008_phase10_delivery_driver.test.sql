begin;
set local search_path = public, extensions;
select plan(41);

-- All assertions target this transaction's fixtures, never existing store data.
select ok((select relrowsecurity from pg_class where oid='public.delivery_assignments'::regclass),'delivery assignment ledger enables RLS');
select ok((select count(*)=1 from public.permissions where code='delivery.dispatch'),'delivery dispatch permission exists');
select ok((select count(*)=3 from public.role_permissions role_permission
  join public.roles role on role.id=role_permission.role_id
  join public.permissions permission on permission.id=role_permission.permission_id
  where permission.code='delivery.dispatch' and role.code in ('owner','manager','cashier')),'owner, manager, and cashier can dispatch');
select ok(not exists (select 1 from public.role_permissions role_permission
  join public.roles role on role.id=role_permission.role_id
  join public.permissions permission on permission.id=role_permission.permission_id
  where permission.code='delivery.dispatch' and role.code='driver'),'drivers cannot dispatch');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values
 ('5a000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase10-owner@test.local','',now(),'{}','{"display_name":"Phase 10 Owner"}'),
 ('5a000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase10-driver-a@test.local','',now(),'{}','{"display_name":"Phase 10 Driver A"}'),
 ('5a000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase10-driver-b@test.local','',now(),'{}','{"display_name":"Phase 10 Driver B"}'),
 ('5a000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase10-cashier@test.local','',now(),'{}','{"display_name":"Phase 10 Cashier"}'),
 ('5a000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase10-kitchen@test.local','',now(),'{}','{"display_name":"Phase 10 Kitchen"}');
update public.profiles set role_id=(select id from public.roles where code='owner'),active=true where id='5a000000-0000-4000-8000-000000000001';
update public.profiles set role_id=(select id from public.roles where code='driver'),active=true where id in ('5a000000-0000-4000-8000-000000000002','5a000000-0000-4000-8000-000000000003');
update public.profiles set role_id=(select id from public.roles where code='cashier'),active=true where id='5a000000-0000-4000-8000-000000000004';
update public.profiles set role_id=(select id from public.roles where code='kitchen'),active=true where id='5a000000-0000-4000-8000-000000000005';

update public.store_settings set ordering_open=true,test_ordering_enabled=true,pickup_enabled=true,delivery_enabled=true,
 pickup_minimum_cents=0,delivery_minimum_cents=0,delivery_postal_codes=array['01606'],
 business_hours='{"sunday":{"closed":false,"open":"00:00","close":"24:00"},"monday":{"closed":false,"open":"00:00","close":"24:00"},"tuesday":{"closed":false,"open":"00:00","close":"24:00"},"wednesday":{"closed":false,"open":"00:00","close":"24:00"},"thursday":{"closed":false,"open":"00:00","close":"24:00"},"friday":{"closed":false,"open":"00:00","close":"24:00"},"saturday":{"closed":false,"open":"00:00","close":"24:00"}}';
update public.store_special_hours set closed=false,opens_at='00:00',closes_at='24:00'
 where service_date=(now() at time zone (select timezone from public.store_settings where id))::date and archived_at is null;

insert into public.menu_categories(id,name) values('5a000000-0000-4000-8000-000000000010','Phase 10 Fixture');
insert into public.menu_items(id,category_id,name,base_price_cents,kitchen_route) values
 ('5a000000-0000-4000-8000-000000000011','5a000000-0000-4000-8000-000000000010','Fixture Delivery Pizza',1500,'phase10-test-'||txid_current());
select set_config('phase10.payload',jsonb_build_object(
 'idempotency_key','phase10-delivery-'||txid_current(),'fulfillment_type','delivery','first_name','Delivery','last_name','Fixture',
 'phone','508-555-0177','email','phase10@test.local','sms_opt_in',false,'email_opt_in',false,'tip_cents',0,'promo_code','','special_instructions','Ring the bell',
 'address',jsonb_build_object('address1','93 West Boylston St','address2','','city','Worcester','state','MA','postal_code','01606','delivery_instructions','Blue door on the side'),
 'items','[{"menu_item_id":"5a000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]'::jsonb
)::text,true);
select lives_ok($$select set_config('phase10.order',public.wayne_create_test_order(current_setting('phase10.payload')::jsonb)::text,true)$$,'delivery fixture order is created');
select set_config('phase10.order_id',(current_setting('phase10.order')::jsonb->>'id'),true);
select set_config('phase10.total',(select total_cents::text from public.orders where id=current_setting('phase10.order_id')::uuid),true);
select set_config('phase10.number',(select order_number from public.orders where id=current_setting('phase10.order_id')::uuid),true);

-- Anonymous and unrelated staff must never read the assignment ledger.
set local role anon;
select throws_ok($$select * from public.delivery_assignments$$,'42501','permission denied for table delivery_assignments','anonymous cannot read delivery assignments');
reset role;

-- Drivers cannot dispatch; dispatch permission is required.
set local role authenticated;
select set_config('request.jwt.claim.sub','5a000000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.wayne_delivery_dispatch()$$,'42501','Delivery dispatch permission required','driver cannot open the dispatch board');
select throws_ok(format($$select public.wayne_assign_delivery(%L,%L)$$,current_setting('phase10.order_id'),'5a000000-0000-4000-8000-000000000002'),'42501','Delivery dispatch permission required','driver cannot assign deliveries');
select throws_ok(format($$select public.wayne_driver_update_delivery(%L,'accept')$$,current_setting('phase10.order_id')),'42501','This delivery is not assigned to you','driver cannot act on an unassigned order');

-- The cashier dispatches the order to driver A.
select set_config('request.jwt.claim.sub','5a000000-0000-4000-8000-000000000004',true);
select throws_ok(format($$select public.wayne_assign_delivery(%L,%L)$$,current_setting('phase10.order_id'),'5a000000-0000-4000-8000-000000000005'),'22023','does not have driver access','a kitchen account cannot be assigned a delivery');
select lives_ok(format($$select public.wayne_assign_delivery(%L,%L)$$,current_setting('phase10.order_id'),'5a000000-0000-4000-8000-000000000002'),'dispatch assigns the delivery to driver A');
select is((select status from public.delivery_assignments where order_id=current_setting('phase10.order_id')::uuid and status<>'released'),'assigned','assignment starts in assigned');
select is((select amount_due_cents from public.delivery_assignments where order_id=current_setting('phase10.order_id')::uuid and status<>'released'),
 current_setting('phase10.total')::integer,'amount due at the door is the unpaid order total');
select ok((select (public.wayne_delivery_dispatch()->'orders') @> jsonb_build_array(jsonb_build_object('order_number',current_setting('phase10.number')))),'dispatch board shows the live delivery');

-- Reassignment releases the previous assignment instead of stacking.
select lives_ok(format($$select public.wayne_assign_delivery(%L,%L)$$,current_setting('phase10.order_id'),'5a000000-0000-4000-8000-000000000003'),'dispatch reassigns the delivery to driver B');
select is((select count(*)::integer from public.delivery_assignments where order_id=current_setting('phase10.order_id')::uuid and status='released'),1,'the previous assignment is released');
select is((select count(*)::integer from public.delivery_assignments where order_id=current_setting('phase10.order_id')::uuid and status<>'released'),1,'only one active assignment per order');
select throws_ok(format($$select public.wayne_release_delivery(%L,'no')$$,current_setting('phase10.order_id')),'22023','release reason','releasing requires a reason');
select lives_ok(format($$select public.wayne_assign_delivery(%L,%L)$$,current_setting('phase10.order_id'),'5a000000-0000-4000-8000-000000000002'),'dispatch hands the delivery back to driver A');

-- Driver B must not see or touch another driver's delivery.
select set_config('request.jwt.claim.sub','5a000000-0000-4000-8000-000000000003',true);
select is((select count(*)::integer from public.delivery_assignments where order_id=current_setting('phase10.order_id')::uuid and status<>'released'),0,'a driver cannot read another driver''s assignment');
select throws_ok(format($$select public.wayne_driver_update_delivery(%L,'accept')$$,current_setting('phase10.order_id')),'42501','This delivery is not assigned to you','a driver cannot accept another driver''s delivery');

-- Driver A works the delivery.
select set_config('request.jwt.claim.sub','5a000000-0000-4000-8000-000000000002',true);
select is((select count(*)::integer from public.delivery_assignments where order_id=current_setting('phase10.order_id')::uuid and status<>'released'),1,'a driver reads their own assignment');
select lives_ok(format($$select public.wayne_driver_update_delivery(%L,'accept')$$,current_setting('phase10.order_id')),'driver accepts the assignment');
select is(((select public.wayne_driver_update_delivery(current_setting('phase10.order_id')::uuid,'accept'))->>'duplicate'),'true','accepting twice is a no-op');
select throws_ok(format($$select public.wayne_driver_update_delivery(%L,'picked_up')$$,current_setting('phase10.order_id')),'22023','not marked this order ready','a driver cannot take an order the kitchen has not finished');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','5a000000-0000-4000-8000-000000000001',true);
select lives_ok(format($$select public.wayne_kitchen_transition(%L,'placed','accepted')$$,current_setting('phase10.order_id')),'kitchen accepts the order');
select lives_ok(format($$select public.wayne_kitchen_transition(%L,'accepted','in_kitchen')$$,current_setting('phase10.order_id')),'kitchen starts the order');
select lives_ok(format($$select public.wayne_kitchen_transition(%L,'in_kitchen','ready')$$,current_setting('phase10.order_id')),'kitchen marks the order ready');

select set_config('request.jwt.claim.sub','5a000000-0000-4000-8000-000000000002',true);
select lives_ok(format($$select public.wayne_driver_update_delivery(%L,'picked_up')$$,current_setting('phase10.order_id')),'driver picks the order up');
reset role;
select is((select status from public.orders where id=current_setting('phase10.order_id')::uuid),'out_for_delivery','pickup moves the order out for delivery');
set local role authenticated;
select set_config('request.jwt.claim.sub','5a000000-0000-4000-8000-000000000002',true);
select throws_ok(format($$select public.wayne_driver_update_delivery(%L,'delivered')$$,current_setting('phase10.order_id')),'22023','Record the cash collected','delivery without recording cash is refused while money is owed');
select lives_ok(format($$select public.wayne_driver_update_delivery(%L,'delivered',%s,'Handed to the customer')$$,current_setting('phase10.order_id'),current_setting('phase10.total')),'driver completes the delivery with cash');

reset role;
select is((select status from public.orders where id=current_setting('phase10.order_id')::uuid),'completed','delivery completes the order');
select is((select payment_status from public.orders where id=current_setting('phase10.order_id')::uuid),'paid','cash at the door marks the order paid');
select is((select payment_method from public.orders where id=current_setting('phase10.order_id')::uuid),'cash','the order records how it was actually paid');
select is((select count(*)::integer from public.payments where order_id=current_setting('phase10.order_id')::uuid and method='cash' and provider='cash_on_delivery'),1,'cash collected is written to the payment ledger');
select is((select count(*)::integer from public.audit_log where entity_id=current_setting('phase10.order_id') and action='delivery.delivered'),1,'cash collection is auditable');
select ok((select count(*)>=4 from public.order_events where order_id=current_setting('phase10.order_id')::uuid and event_type like 'delivery.%'),'the delivery timeline is recorded on the order');

-- Owner analytics; a driver may not read them.
set local role authenticated;
select set_config('request.jwt.claim.sub','5a000000-0000-4000-8000-000000000001',true);
select is(((public.wayne_delivery_metrics((now() at time zone 'America/New_York')::date,(now() at time zone 'America/New_York')::date)->'totals'->>'delivered_count')),'1','owner metrics count the delivery');
select ok(((public.wayne_delivery_metrics((now() at time zone 'America/New_York')::date,(now() at time zone 'America/New_York')::date)->'totals'->>'cash_collected_cents')::bigint > 0),'owner metrics report cash collected');
select set_config('request.jwt.claim.sub','5a000000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.wayne_delivery_metrics(current_date,current_date)$$,'42501','Report viewing permission required','a driver cannot read delivery analytics');
reset role;

select * from finish();
rollback;
