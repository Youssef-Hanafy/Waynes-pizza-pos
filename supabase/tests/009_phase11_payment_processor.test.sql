begin;
set local search_path = public, extensions;
select plan(59);

-- All assertions target this transaction's fixtures, never existing store data.
select ok((select relrowsecurity from pg_class where oid='public.payment_provider_settings'::regclass),'provider settings enable RLS');
select ok((select relrowsecurity from pg_class where oid='public.payment_terminals'::regclass),'card readers enable RLS');
select ok((select relrowsecurity from pg_class where oid='public.payment_webhook_events'::regclass),'webhook ledger enables RLS');
select ok(not exists (select 1 from pg_policies where tablename='payment_webhook_events'),'the webhook ledger is server-only: no table policy grants it to anyone');
select ok((select count(*)=1 from public.permissions where code='payments.manage'),'payment management permission exists');
select ok((select count(*)=2 from public.role_permissions rp
  join public.roles role on role.id=rp.role_id join public.permissions p on p.id=rp.permission_id
  where p.code='payments.manage' and role.code in ('owner','manager')),'owner and manager may manage payments');
select ok(not exists (select 1 from public.role_permissions rp
  join public.roles role on role.id=rp.role_id join public.permissions p on p.id=rp.permission_id
  where p.code='payments.manage' and role.code in ('cashier','driver','kitchen')),'counter, kitchen and drivers cannot refund');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values
 ('6a000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase11-owner@test.local','',now(),'{}','{"display_name":"Phase 11 Owner"}'),
 ('6a000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase11-cashier@test.local','',now(),'{}','{"display_name":"Phase 11 Cashier"}');
update public.profiles set role_id=(select id from public.roles where code='owner'),active=true where id='6a000000-0000-4000-8000-000000000001';
update public.profiles set role_id=(select id from public.roles where code='cashier'),active=true where id='6a000000-0000-4000-8000-000000000002';

update public.store_settings set ordering_open=true,test_ordering_enabled=true,pickup_enabled=true,delivery_enabled=true,
 pickup_minimum_cents=0,delivery_minimum_cents=0,tax_rate_basis_points=0,
 business_hours='{"sunday":{"closed":false,"open":"00:00","close":"24:00"},"monday":{"closed":false,"open":"00:00","close":"24:00"},"tuesday":{"closed":false,"open":"00:00","close":"24:00"},"wednesday":{"closed":false,"open":"00:00","close":"24:00"},"thursday":{"closed":false,"open":"00:00","close":"24:00"},"friday":{"closed":false,"open":"00:00","close":"24:00"},"saturday":{"closed":false,"open":"00:00","close":"24:00"}}';
update public.store_special_hours set closed=false,opens_at='00:00',closes_at='24:00'
 where service_date=(now() at time zone (select timezone from public.store_settings where id))::date and archived_at is null;

insert into public.menu_categories(id,name) values('6a000000-0000-4000-8000-000000000010','Phase 11 Fixture');
insert into public.menu_items(id,category_id,name,base_price_cents,kitchen_route) values
 ('6a000000-0000-4000-8000-000000000011','6a000000-0000-4000-8000-000000000010','Fixture Card Pizza',2000,'phase11-test-'||txid_current());

-- ============================================================================
-- Switched off by default: nothing about card payment is live until an owner says so.
-- ============================================================================
select is((public.wayne_payment_checkout_config()->>'online_card_enabled'),'false','card payment is off until it is configured');
select is((public.wayne_payment_checkout_config()->>'application_id'),'','no application id is published while card payment is off');

set local role anon;
select throws_ok($$select * from public.payment_provider_settings$$,'42501','permission denied for table payment_provider_settings','anonymous cannot read provider settings');
select throws_ok($$select * from public.payment_webhook_events$$,'42501','permission denied for table payment_webhook_events','anonymous cannot read the webhook ledger');
select throws_ok($$select public.wayne_begin_payment('{}'::jsonb)$$,'42501','permission denied for function wayne_begin_payment','the browser cannot open a payment directly');
select throws_ok($$select public.wayne_settle_payment('{}'::jsonb)$$,'42501','permission denied for function wayne_settle_payment','the browser cannot settle a payment directly');
select throws_ok($$select public.wayne_create_card_order('{}'::jsonb)$$,'42501','permission denied for function wayne_create_card_order','the browser cannot create a card order directly');
select lives_ok($$select public.wayne_payment_checkout_config()$$,'the storefront may read the non-secret checkout configuration');
reset role;

set local role service_role;
select throws_ok(format($$select public.wayne_create_card_order(%L::jsonb)$$, jsonb_build_object(
  'idempotency_key','phase11-disabled-'||txid_current(),'fulfillment_type','pickup','first_name','Card','last_name','Fixture',
  'phone','508-555-0188','email','','sms_opt_in',false,'email_opt_in',false,'tip_cents',0,'promo_code','','special_instructions','',
  'address',jsonb_build_object('address1','','address2','','city','','state','','postal_code','','delivery_instructions',''),
  'items','[{"menu_item_id":"6a000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]'::jsonb)::text),
 'P0001','Card payment is not switched on','a card order is refused while card payment is off');
reset role;

-- A half-configured provider cannot be switched on.
set local role authenticated;
select set_config('request.jwt.claim.sub','6a000000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.wayne_save_payment_settings('{"provider":"square"}'::jsonb)$$,'42501','Payment management permission required','a cashier cannot configure the processor');
select set_config('request.jwt.claim.sub','6a000000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.wayne_save_payment_settings('{"provider":"square","online_card_enabled":true}'::jsonb)$$,'23514','payment_provider_settings_ready','card payment cannot be switched on without application and location ids');
select lives_ok($$select public.wayne_save_payment_settings('{"provider":"square","environment":"sandbox","application_id":"sandbox-sq0idb-test","location_id":"L-TEST","notification_url":"https://waynes.test/api/webhooks/square","online_card_enabled":true,"terminal_card_enabled":true}'::jsonb)$$,'the owner switches card payment on');
select is((public.wayne_payment_checkout_config()->>'application_id'),'sandbox-sq0idb-test','the storefront now receives the application id');
select lives_ok($$select public.wayne_save_payment_terminal('{"label":"Front counter reader","device_id":"9fa747a2-25ff-48ee-b078-04381f7c828f"}'::jsonb)$$,'the owner registers a card reader');
select is((select count(*)::integer from public.payment_terminals where device_id='9fa747a2-25ff-48ee-b078-04381f7c828f'),1,'the reader is stored once');
select ok((select count(*)>0 from public.audit_log where entity_type='payment_terminals'),'registering a reader is audited');
reset role;

-- ============================================================================
-- A card order waits outside the kitchen until the money lands.
-- ============================================================================
set local role service_role;
select set_config('phase11.payload', jsonb_build_object(
  'idempotency_key','phase11-card-'||txid_current(),'fulfillment_type','pickup','first_name','Card','last_name','Fixture',
  'phone','508-555-0188','email','','sms_opt_in',false,'email_opt_in',false,'tip_cents',0,'promo_code','','special_instructions','',
  'address',jsonb_build_object('address1','','address2','','city','','state','','postal_code','','delivery_instructions',''),
  'items','[{"menu_item_id":"6a000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]'::jsonb)::text, true);
select lives_ok($$select set_config('phase11.order',public.wayne_create_card_order(current_setting('phase11.payload')::jsonb)::text,true)$$,'a card order is created');
select set_config('phase11.order_id',(current_setting('phase11.order')::jsonb->>'id'),true);
reset role;
select is((select status from public.orders where id=current_setting('phase11.order_id')::uuid),'payment_pending','the order waits for payment');
select is((select payment_method from public.orders where id=current_setting('phase11.order_id')::uuid),'card','the order is marked as a card order');
set constraints orders_kitchen_sync immediate;
set constraints orders_kitchen_sync deferred;
select is((select count(*)::integer from public.kitchen_tickets where order_id=current_setting('phase11.order_id')::uuid),0,'an unpaid card order never reaches the kitchen');
select is((select count(*)::integer from public.print_jobs where order_id=current_setting('phase11.order_id')::uuid),0,'an unpaid card order never prints');

set local role service_role;
select lives_ok(format($$select set_config('phase11.payment',public.wayne_begin_payment(%L::jsonb)::text,true)$$,
  jsonb_build_object('order_id',current_setting('phase11.order_id'),'idempotency_key','phase11-pay-'||txid_current(),'entry','online')::text),
 'the server opens a pending payment');
select is(((current_setting('phase11.payment')::jsonb)->>'status'),'pending','the payment starts pending, not paid');
select is(((select public.wayne_begin_payment(jsonb_build_object('order_id',current_setting('phase11.order_id'),'idempotency_key','phase11-pay-'||txid_current(),'entry','online')))->>'duplicate'),'true','the same idempotency key never opens a second payment');
select throws_ok(format($$select public.wayne_begin_payment(%L::jsonb)$$,
  jsonb_build_object('order_id',current_setting('phase11.order_id'),'idempotency_key','phase11-second-'||txid_current(),'entry','online')::text),
 '40001','A payment is already open on this order','a second payment cannot be opened on the same order');
reset role;
select is((select payment_status from public.orders where id=current_setting('phase11.order_id')::uuid),'unpaid','opening a payment does not make an order paid');

-- A declined card cancels the order instead of cooking it.
set local role service_role;
select lives_ok(format($$select public.wayne_settle_payment(%L::jsonb)$$,
  jsonb_build_object('payment_id',(current_setting('phase11.payment')::jsonb)->>'payment_id','status','failed','failure_reason','CARD_DECLINED')::text),
 'a declined card settles as failed');
reset role;
select is((select status from public.orders where id=current_setting('phase11.order_id')::uuid),'cancelled','a declined card cancels the unpaid order');
select is((select payment_status from public.orders where id=current_setting('phase11.order_id')::uuid),'unpaid','a declined card never produces a paid order');
set constraints orders_kitchen_sync immediate;
set constraints orders_kitchen_sync deferred;
select is((select count(*)::integer from public.kitchen_tickets where order_id=current_setting('phase11.order_id')::uuid),0,'a declined order still never reaches the kitchen');

-- ============================================================================
-- The happy path: captured money releases the order to the kitchen.
-- ============================================================================
set local role service_role;
select set_config('phase11.payload2', jsonb_build_object(
  'idempotency_key','phase11-card2-'||txid_current(),'fulfillment_type','pickup','first_name','Card','last_name','Success',
  'phone','508-555-0189','email','','sms_opt_in',false,'email_opt_in',false,'tip_cents',0,'promo_code','','special_instructions','',
  'address',jsonb_build_object('address1','','address2','','city','','state','','postal_code','','delivery_instructions',''),
  'items','[{"menu_item_id":"6a000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]'::jsonb)::text, true);
select set_config('phase11.order2',public.wayne_create_card_order(current_setting('phase11.payload2')::jsonb)::text,true);
select set_config('phase11.order2_id',(current_setting('phase11.order2')::jsonb->>'id'),true);
select set_config('phase11.payment2',public.wayne_begin_payment(jsonb_build_object(
  'order_id',current_setting('phase11.order2_id'),'idempotency_key','phase11-pay2-'||txid_current(),'entry','online'))::text,true);
select lives_ok(format($$select public.wayne_settle_payment(%L::jsonb)$$,
  jsonb_build_object('payment_id',(current_setting('phase11.payment2')::jsonb)->>'payment_id','status','captured',
    'provider_payment_id','sq-payment-'||txid_current(),'provider_status','COMPLETED','card_brand','VISA','card_last4','1111',
    'receipt_url','https://squareupsandbox.com/receipt/test')::text),
 'a completed card settles as captured');
select is(((select public.wayne_settle_payment(jsonb_build_object('payment_id',(current_setting('phase11.payment2')::jsonb)->>'payment_id','status','captured')))->>'duplicate'),'true','settling the same payment twice changes nothing');
reset role;
select is((select status from public.orders where id=current_setting('phase11.order2_id')::uuid),'placed','a captured card releases the order');
select is((select payment_status from public.orders where id=current_setting('phase11.order2_id')::uuid),'paid','a captured card marks the order paid');
set constraints orders_kitchen_sync immediate;
set constraints orders_kitchen_sync deferred;
select is((select count(*)::integer from public.kitchen_tickets where order_id=current_setting('phase11.order2_id')::uuid),1,'the paid order reaches the kitchen');
select is((select count(*)::integer from public.order_events where order_id=current_setting('phase11.order2_id')::uuid and event_type='payment.captured'),1,'the capture is on the order timeline');

-- ============================================================================
-- Webhooks are recorded once.
-- ============================================================================
set local role service_role;
select is(((select public.wayne_record_payment_webhook(jsonb_build_object('provider','square','event_id','evt-phase11-'||txid_current(),'event_type','payment.updated','signature_verified',true,'payload','{}'::jsonb)))->>'duplicate'),'false','a new webhook event is stored');
select is(((select public.wayne_record_payment_webhook(jsonb_build_object('provider','square','event_id','evt-phase11-'||txid_current(),'event_type','payment.updated','signature_verified',true,'payload','{}'::jsonb)))->>'duplicate'),'true','a repeated webhook event is ignored');
reset role;

-- ============================================================================
-- Refunds.
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub','6a000000-0000-4000-8000-000000000002',true);
select throws_ok(format($$select public.wayne_begin_refund(%L::jsonb)$$,
  jsonb_build_object('payment_id',(current_setting('phase11.payment2')::jsonb)->>'payment_id','amount_cents',100,'reason','Test refund','idempotency_key','phase11-refund-denied-'||txid_current())::text),
 '42501','Payment management permission required','a cashier cannot refund');
select set_config('request.jwt.claim.sub','6a000000-0000-4000-8000-000000000001',true);
select throws_ok(format($$select public.wayne_begin_refund(%L::jsonb)$$,
  jsonb_build_object('payment_id',(current_setting('phase11.payment2')::jsonb)->>'payment_id','amount_cents',999999,'reason','Too much','idempotency_key','phase11-refund-big-'||txid_current())::text),
 '22023','more than the remaining refundable amount','a refund larger than the payment is refused');
select throws_ok(format($$select public.wayne_begin_refund(%L::jsonb)$$,
  jsonb_build_object('payment_id',(current_setting('phase11.payment2')::jsonb)->>'payment_id','amount_cents',100,'reason','no','idempotency_key','phase11-refund-noreason-'||txid_current())::text),
 '22023','refund reason','a refund without a reason is refused');
select lives_ok(format($$select set_config('phase11.refund',public.wayne_begin_refund(%L::jsonb)::text,true)$$,
  jsonb_build_object('payment_id',(current_setting('phase11.payment2')::jsonb)->>'payment_id','amount_cents',2000,'reason','Customer complaint','idempotency_key','phase11-refund-'||txid_current())::text),
 'the owner opens a refund');
reset role;
select is((select status from public.refunds where id=(current_setting('phase11.refund')::jsonb->>'refund_id')::uuid),'pending','a refund is pending until the provider answers');
select is((select payment_status from public.orders where id=current_setting('phase11.order2_id')::uuid),'paid','a pending refund does not change the order yet');

set local role service_role;
select lives_ok(format($$select public.wayne_settle_refund(%L::jsonb)$$,
  jsonb_build_object('refund_id',current_setting('phase11.refund')::jsonb->>'refund_id','status','completed','provider_refund_id','sq-refund-'||txid_current(),'provider_status','COMPLETED')::text),
 'the provider confirms the refund');
reset role;
select is((select payment_status from public.orders where id=current_setting('phase11.order2_id')::uuid),'refunded','a full refund is reflected on the order');
select is((select count(*)::integer from public.audit_log where entity_id=current_setting('phase11.order2_id') and action='payment.refunded'),1,'the refund is auditable');

-- ============================================================================
-- Abandoned checkout recovery and reconciliation.
-- ============================================================================
set local role service_role;
select set_config('phase11.payload3', jsonb_build_object(
  'idempotency_key','phase11-card3-'||txid_current(),'fulfillment_type','pickup','first_name','Card','last_name','Abandoned',
  'phone','508-555-0190','email','','sms_opt_in',false,'email_opt_in',false,'tip_cents',0,'promo_code','','special_instructions','',
  'address',jsonb_build_object('address1','','address2','','city','','state','','postal_code','','delivery_instructions',''),
  'items','[{"menu_item_id":"6a000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]'::jsonb)::text, true);
select set_config('phase11.order3',public.wayne_create_card_order(current_setting('phase11.payload3')::jsonb)::text,true);
reset role;
update public.orders set created_at = now() - interval '2 hours' where id=(current_setting('phase11.order3')::jsonb->>'id')::uuid;
set local role service_role;
select is(public.wayne_expire_stale_card_orders(30),1,'an abandoned card checkout is swept up');
reset role;
select is((select status from public.orders where id=(current_setting('phase11.order3')::jsonb->>'id')::uuid),'cancelled','the abandoned order is cancelled, not left pending');

set local role authenticated;
select set_config('request.jwt.claim.sub','6a000000-0000-4000-8000-000000000001',true);
select lives_ok($$select public.wayne_payment_reconciliation((now() at time zone 'America/New_York')::date,(now() at time zone 'America/New_York')::date)$$,'reconciliation runs for the owner');
select is(((public.wayne_payment_reconciliation((now() at time zone 'America/New_York')::date,(now() at time zone 'America/New_York')::date))->'totals'->>'captured_count'),'1','reconciliation counts the captured payment');
select set_config('request.jwt.claim.sub','6a000000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.wayne_payment_reconciliation(current_date,current_date)$$,'42501','Payment management permission required','a cashier cannot read payment reconciliation');
reset role;

select * from finish();
rollback;
