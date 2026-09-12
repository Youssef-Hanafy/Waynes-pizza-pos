begin;
set local search_path = public, extensions;
select plan(61);

-- All assertions target this transaction's fixtures, never existing store data.
select ok((select relrowsecurity from pg_class where oid='public.registers'::regclass),'registers enable RLS');
select ok((select relrowsecurity from pg_class where oid='public.register_shifts'::regclass),'drawers enable RLS');
select ok((select relrowsecurity from pg_class where oid='public.cash_movements'::regclass),'cash movements enable RLS');
select ok((select count(*)=1 from public.permissions where code='cash.manage'),'cash management permission exists');
select ok((select count(*)=2 from public.role_permissions rp
  join public.roles role on role.id=rp.role_id join public.permissions p on p.id=rp.permission_id
  where p.code='cash.manage' and role.code in ('owner','manager')),'owner and manager manage cash');
select ok(not exists (select 1 from public.role_permissions rp
  join public.roles role on role.id=rp.role_id join public.permissions p on p.id=rp.permission_id
  where p.code='cash.manage' and role.code in ('cashier','driver','kitchen')),'the counter cannot manage registers');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values
 ('7a000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase12-owner@test.local','',now(),'{}','{"display_name":"Phase 12 Owner"}'),
 ('7a000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase12-cashier@test.local','',now(),'{}','{"display_name":"Phase 12 Cashier"}'),
 ('7a000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase12-cashier2@test.local','',now(),'{}','{"display_name":"Phase 12 Second Cashier"}');
update public.profiles set role_id=(select id from public.roles where code='owner'),active=true where id='7a000000-0000-4000-8000-000000000001';
update public.profiles set role_id=(select id from public.roles where code='cashier'),active=true where id in ('7a000000-0000-4000-8000-000000000002','7a000000-0000-4000-8000-000000000003');

update public.store_settings set ordering_open=true,test_ordering_enabled=true,pickup_enabled=true,delivery_enabled=true,
 pickup_minimum_cents=0,delivery_minimum_cents=0,tax_rate_basis_points=0,
 business_hours='{"sunday":{"closed":false,"open":"00:00","close":"24:00"},"monday":{"closed":false,"open":"00:00","close":"24:00"},"tuesday":{"closed":false,"open":"00:00","close":"24:00"},"wednesday":{"closed":false,"open":"00:00","close":"24:00"},"thursday":{"closed":false,"open":"00:00","close":"24:00"},"friday":{"closed":false,"open":"00:00","close":"24:00"},"saturday":{"closed":false,"open":"00:00","close":"24:00"}}';
update public.store_special_hours set closed=false,opens_at='00:00',closes_at='24:00'
 where service_date=(now() at time zone (select timezone from public.store_settings where id))::date and archived_at is null;

insert into public.menu_categories(id,name,customer_visible) values('7a000000-0000-4000-8000-000000000010','Phase 12 Fixture',false);
insert into public.menu_items(id,category_id,name,base_price_cents,customer_visible,pos_visible,kitchen_route) values
 ('7a000000-0000-4000-8000-000000000011','7a000000-0000-4000-8000-000000000010','Fixture Cash Pizza',2000,false,true,'phase12-test-'||txid_current());

-- ============================================================================
-- Registers are a manager's job.
-- ============================================================================
set local role anon;
select throws_ok($$select * from public.registers$$,'42501','permission denied for table registers','anonymous cannot read registers');
select throws_ok($$select * from public.register_shifts$$,'42501','permission denied for table register_shifts','anonymous cannot read drawers');
select throws_ok($$select public.wayne_open_shift('{}'::jsonb)$$,'42501','permission denied for function wayne_open_shift','anonymous cannot open a drawer');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.wayne_save_register('{"label":"Sneaky register"}'::jsonb)$$,'42501','Cash management permission required','a cashier cannot create a register');
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.wayne_save_register('{"label":"  "}'::jsonb)$$,'22023','Name the register','a register needs a name');
select lives_ok($$select set_config('phase12.register',public.wayne_save_register('{"label":"Phase 12 Front counter","location_note":"By the door"}'::jsonb)::text,true)$$,'the owner creates a register');
select set_config('phase12.register_id',(current_setting('phase12.register')::jsonb->>'id'),true);
select ok((select count(*)>0 from public.audit_log where entity_type='registers'),'creating a register is audited');
reset role;

-- ============================================================================
-- Opening a drawer
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000002',true);
select throws_ok(format($$select public.wayne_open_shift(%L::jsonb)$$,
  jsonb_build_object('register_id',current_setting('phase12.register_id'))::text),
 '22023','Count the opening cash','a drawer cannot open without counting the float');
select lives_ok(format($$select set_config('phase12.shift',public.wayne_open_shift(%L::jsonb)::text,true)$$,
  jsonb_build_object('register_id',current_setting('phase12.register_id'),'opening_cash_cents',15000)::text),
 'the cashier opens the drawer with a counted float');
select set_config('phase12.shift_id',(current_setting('phase12.shift')::jsonb->>'id'),true);
select throws_ok(format($$select public.wayne_open_shift(%L::jsonb)$$,
  jsonb_build_object('register_id',current_setting('phase12.register_id'),'opening_cash_cents',10000)::text),
 '40001','already has an open drawer','one register never has two open drawers');
reset role;
select is(((public.wayne_shift_cash_totals(current_setting('phase12.shift_id')::uuid))->>'expected_cash_cents'),'15000','a fresh drawer expects exactly its float');
set local role authenticated;
select is(((public.wayne_pos_drawer()->'shift')->>'id'),current_setting('phase12.shift_id'),'the POS sees the drawer this cashier is on');
reset role;

-- ============================================================================
-- Cash sales. This is the money the drawer is actually holding.
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000002',true);
select set_config('phase12.order', public.wayne_create_pos_order(jsonb_build_object(
  'idempotency_key','phase12-cash-'||txid_current(),'customer_mode','walk_in','customer_id','','source','pos',
  'fulfillment_type','pickup','payment_method','cash','first_name','','last_name','','phone','','email','','address_id','',
  'address',jsonb_build_object('address1','','address2','','city','','state','','postal_code','','delivery_instructions',''),
  'promo_code','','manual_discount_type','','manual_discount_value',0,'manual_discount_reason','','tip_cents',0,'special_instructions','',
  'items','[{"menu_item_id":"7a000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]'::jsonb
))::text,true);
select set_config('phase12.order_id',(current_setting('phase12.order')::jsonb->>'id'),true);

select throws_ok(format($$select public.wayne_take_cash_payment(%L::jsonb)$$,
  jsonb_build_object('order_id',current_setting('phase12.order_id'),'shift_id',current_setting('phase12.shift_id'),
    'idempotency_key','phase12-tender-short-'||txid_current(),'tendered_cents',1000)::text),
 '22023','less than the amount due','cash short of the total is refused');
select throws_ok(format($$select public.wayne_take_cash_payment(%L::jsonb)$$,
  jsonb_build_object('order_id',current_setting('phase12.order_id'),'shift_id',current_setting('phase12.shift_id'),
    'idempotency_key','phase12-tender-huge-'||txid_current(),'tendered_cents',900000)::text),
 '22023','far more cash than the amount due','an obviously mistyped tender is refused');
select lives_ok(format($$select set_config('phase12.payment',public.wayne_take_cash_payment(%L::jsonb)::text,true)$$,
  jsonb_build_object('order_id',current_setting('phase12.order_id'),'shift_id',current_setting('phase12.shift_id'),
    'idempotency_key','phase12-tender-'||txid_current(),'tendered_cents',5000)::text),
 'the cashier takes cash for the order');
select is(((current_setting('phase12.payment')::jsonb)->>'change_cents'),'3000','change due is worked out from the tender');
select is(((select public.wayne_take_cash_payment(jsonb_build_object('order_id',current_setting('phase12.order_id'),'shift_id',current_setting('phase12.shift_id'),'idempotency_key','phase12-tender-'||txid_current(),'tendered_cents',5000)))->>'duplicate'),'true','the same tender is never taken twice');
reset role;
select is((select payment_status from public.orders where id=current_setting('phase12.order_id')::uuid),'paid','taking cash marks the order paid');
select is((select payment_method from public.orders where id=current_setting('phase12.order_id')::uuid),'cash','the order records that it was paid in cash');
select is((select amount_cents from public.payments where order_id=current_setting('phase12.order_id')::uuid),2000,'the ledger records the amount due, not the tender');
select is((select shift_id from public.payments where order_id=current_setting('phase12.order_id')::uuid),current_setting('phase12.shift_id')::uuid,'the payment is tied to the drawer it passed through');
select is(((public.wayne_shift_cash_totals(current_setting('phase12.shift_id')::uuid))->>'expected_cash_cents'),'17000','the drawer now expects the float plus the sale');
select is((select count(*)::integer from public.audit_log where action='cash.payment_taken'),1,'taking cash is audited');

-- ============================================================================
-- Paid-ins, paid-outs and drops
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000002',true);
select throws_ok(format($$select public.wayne_record_cash_movement(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'kind','paid_out','amount_cents',500,'reason','')::text),
 '22023','reason of at least 3 characters','no cash moves without a reason');
select throws_ok(format($$select public.wayne_record_cash_movement(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'kind','paid_out','amount_cents',0,'reason','Napkins')::text),
 '22023','greater than zero','a zero movement is refused');
select throws_ok(format($$select public.wayne_record_cash_movement(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'kind','paid_out','amount_cents',99000,'reason','Emptying the till')::text),
 '22023','more cash than the drawer is holding','cash cannot leave a drawer that does not hold it');
select lives_ok(format($$select public.wayne_record_cash_movement(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'kind','paid_out','amount_cents',1200,'reason','Napkins from the corner shop')::text),
 'a paid-out is recorded');
select lives_ok(format($$select public.wayne_record_cash_movement(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'kind','paid_in','amount_cents',500,'reason','Change brought from the safe')::text),
 'a paid-in is recorded');
select lives_ok(format($$select public.wayne_record_cash_movement(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'kind','driver_cash','amount_cents',2500,'reason','Driver handed in delivery cash')::text),
 'driver cash handed in is recorded');
select lives_ok(format($$select public.wayne_record_cash_movement(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'kind','drop','amount_cents',1000,'reason','Dropped to the safe')::text),
 'a safe drop is recorded');
reset role;
select is(((public.wayne_shift_cash_totals(current_setting('phase12.shift_id')::uuid))->>'expected_cash_cents'),'17800','every movement changes what the drawer should hold');
set local role authenticated;
reset role;
select is((select count(*)::integer from public.audit_log where action in ('cash.paid_in','cash.paid_out','cash.drop','cash.driver_cash')),4,'every cash movement is audited');
set local role authenticated;

-- A second cashier must not touch this drawer.
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000003',true);
select throws_ok(format($$select public.wayne_record_cash_movement(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'kind','paid_out','amount_cents',500,'reason','Helping myself')::text),
 '42501','Only the person on this drawer or a manager','another cashier cannot move cash in someone else''s drawer');
select is((select count(*)::integer from public.register_shifts where id=current_setting('phase12.shift_id')::uuid),0,'another cashier cannot even see the drawer');
select throws_ok(format($$select public.wayne_close_shift(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'counted_cash_cents',17800)::text),
 '42501','Only the person on this drawer or a manager','another cashier cannot close it either');
reset role;

-- ============================================================================
-- Closing the drawer
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000002',true);
select throws_ok(format($$select public.wayne_close_shift(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'))::text),
 '22023','Count the drawer','a drawer cannot close without a count');
select throws_ok(format($$select public.wayne_close_shift(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'counted_cash_cents',16000)::text),
 '22023','Explain the difference','a drawer out by more than five dollars must be explained');
select lives_ok(format($$select set_config('phase12.closed',public.wayne_close_shift(%L::jsonb)::text,true)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'counted_cash_cents',17750,'close_note','Fifty cents short, miscount on change')::text),
 'the cashier closes the drawer with a count and a note');
reset role;
select is((select status from public.register_shifts where id=current_setting('phase12.shift_id')::uuid),'closed','the drawer is closed');
select is((select expected_cash_cents from public.register_shifts where id=current_setting('phase12.shift_id')::uuid),17800,'expected cash is derived, not typed');
select is((select counted_cash_cents from public.register_shifts where id=current_setting('phase12.shift_id')::uuid),17750,'the counted cash is kept');
select is((select variance_cents from public.register_shifts where id=current_setting('phase12.shift_id')::uuid),-50,'the variance is the difference, and it is negative when short');
select is((select cash_sales_cents from public.register_shifts where id=current_setting('phase12.shift_id')::uuid),2000,'cash sales are snapshotted at close');
select is((select paid_out_cents from public.register_shifts where id=current_setting('phase12.shift_id')::uuid),2200,'paid-outs and drops are snapshotted together');
select is((select count(*)::integer from public.audit_log where action='cash.shift_closed'),1,'closing a drawer is audited');

set local role authenticated;
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000002',true);
select is(((select public.wayne_close_shift(jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'counted_cash_cents',17750)))->>'duplicate'),'true','closing a closed drawer changes nothing');
select throws_ok(format($$select public.wayne_record_cash_movement(%L::jsonb)$$,
  jsonb_build_object('shift_id',current_setting('phase12.shift_id'),'kind','paid_in','amount_cents',100,'reason','Too late')::text),
 '22023','already closed','no cash moves in a closed drawer');
select throws_ok(format($$select public.wayne_take_cash_payment(%L::jsonb)$$,
  jsonb_build_object('order_id',current_setting('phase12.order_id'),'shift_id',current_setting('phase12.shift_id'),
    'idempotency_key','phase12-after-close-'||txid_current(),'tendered_cents',2000)::text),
 '22023','already closed','no cash is taken into a closed drawer');
-- The register is free again once its drawer is closed.
select lives_ok(format($$select public.wayne_open_shift(%L::jsonb)$$,
  jsonb_build_object('register_id',current_setting('phase12.register_id'),'opening_cash_cents',15000)::text),
 'the register can be opened again for the next shift');
reset role;

-- ============================================================================
-- Closeout report
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000001',true);
select lives_ok($$select public.wayne_cash_closeout((now() at time zone 'America/New_York')::date,(now() at time zone 'America/New_York')::date)$$,'the owner reads the closeout report');
select is(((public.wayne_cash_closeout((now() at time zone 'America/New_York')::date,(now() at time zone 'America/New_York')::date))->'totals'->>'shift_count'),'2','the closeout counts every drawer of the day');
select is(((public.wayne_cash_closeout((now() at time zone 'America/New_York')::date,(now() at time zone 'America/New_York')::date))->'totals'->>'variance_cents'),'-50','the closeout totals the variance');
select is(((public.wayne_cash_closeout((now() at time zone 'America/New_York')::date,(now() at time zone 'America/New_York')::date))->'totals'->>'short_count'),'1','the closeout counts short drawers');
select ok((jsonb_array_length((public.wayne_cash_closeout((now() at time zone 'America/New_York')::date,(now() at time zone 'America/New_York')::date))->'movements') = 4),'the closeout lists every cash movement with its reason');
select set_config('request.jwt.claim.sub','7a000000-0000-4000-8000-000000000003',true);
select throws_ok($$select public.wayne_cash_closeout(current_date,current_date)$$,'42501','Cash management permission required','a cashier cannot read the closeout report');
reset role;

select * from finish();
rollback;
