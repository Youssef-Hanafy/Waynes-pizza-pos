begin;
set local search_path = public, extensions;
select plan(31);

select is((select count(*) from public.permissions where code = 'pos.discount.manage'), 1::bigint, 'manual POS discount permission exists');
select is((select count(*) from public.role_permissions rp join public.roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id where r.code='owner' and p.code='pos.discount.manage'), 1::bigint, 'owner can manage manual discounts');
select is((select count(*) from public.role_permissions rp join public.roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id where r.code='cashier' and p.code='pos.discount.manage'), 0::bigint, 'cashier cannot manage manual discounts');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('48000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase4-owner@test.local','',now(),'{}','{"display_name":"Phase 4 Owner"}'),
  ('48000000-0000-4000-8000-000000000002','00000000-0000-0000-8000-000000000000','authenticated','authenticated','phase4-cashier@test.local','',now(),'{}','{"display_name":"Phase 4 Cashier"}');
update public.profiles set role_id=(select id from public.roles where code='owner') where id='48000000-0000-4000-8000-000000000001';
update public.store_settings set tax_rate_basis_points=625, delivery_fee_cents=300, delivery_postal_codes=array['01606'], test_ordering_enabled=true;
insert into public.menu_categories (id,name,customer_visible) values ('48000000-0000-4000-8000-000000000010','Phase 4 Counter',false);
insert into public.menu_items (id,category_id,name,base_price_cents,customer_visible,pos_visible) values ('48000000-0000-4000-8000-000000000011','48000000-0000-4000-8000-000000000010','Counter Pizza',1600,false,true);

set local role authenticated;
select set_config('request.jwt.claim.sub','48000000-0000-4000-8000-000000000002',true);
select ok(public.wayne_has_permission('pos.access'), 'cashier has POS access');
select is(public.wayne_pos_menu()->0->'items'->0->>'name','Counter Pizza','POS menu includes POS-visible item');
select lives_ok($$select public.wayne_create_pos_order('{
  "idempotency_key":"hosted-phase4-phone-001","customer_mode":"identified","customer_id":"","source":"phone","fulfillment_type":"delivery","payment_method":"cash",
  "first_name":"Pat","last_name":"Customer","phone":"508-555-0144","email":"","address_id":"",
  "address":{"address1":"10 Main St","address2":"","city":"Worcester","state":"MA","postal_code":"01606","delivery_instructions":"Side door"},
  "promo_code":"","manual_discount_type":"","manual_discount_value":0,"manual_discount_reason":"","tip_cents":0,"special_instructions":"Phone order",
  "items":[{"menu_item_id":"48000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"Well done","modifiers":[]}]
}'::jsonb)$$,'cashier can create identified phone delivery');
select is((select source from public.orders where idempotency_key='hosted-phase4-phone-001'),'phone','phone order source is canonical');
select ok((select customer_id is not null from public.orders where idempotency_key='hosted-phase4-phone-001'),'phone order links customer');
select is((select delivery_address_snapshot->>'postal_code' from public.orders where idempotency_key='hosted-phase4-phone-001'),'01606','delivery snapshot persists');
select is((select order_count from public.customers where phone_normalized='+15085550144'),1,'customer order count updates');
select is((select lifetime_spend_cents from public.customers where phone_normalized='+15085550144'),2000::bigint,'customer lifetime spend updates');
select is((select average_order_value_cents from public.customers where phone_normalized='+15085550144'),2000,'customer average order value updates');
select is(jsonb_array_length(public.wayne_pos_customer_search('Pat Customer')),1,'customer search finds name');
select is(jsonb_array_length(public.wayne_pos_customer_search('(508) 555-0144')),1,'customer search finds formatted phone');
select is(jsonb_array_length(public.wayne_pos_customer_search((select order_number from public.orders where idempotency_key='hosted-phase4-phone-001'))),1,'customer search finds order number');
select lives_ok($$select public.wayne_create_pos_order('{
  "idempotency_key":"hosted-phase4-phone-001","customer_mode":"identified","customer_id":"","source":"phone","fulfillment_type":"delivery","payment_method":"cash",
  "first_name":"Changed","last_name":"Payload","phone":"508-555-0999","email":"","address_id":"",
  "address":{"address1":"10 Main St","address2":"","city":"Worcester","state":"MA","postal_code":"01606","delivery_instructions":""},
  "promo_code":"","manual_discount_type":"","manual_discount_value":0,"manual_discount_reason":"","tip_cents":0,"special_instructions":"",
  "items":[{"menu_item_id":"48000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]
}'::jsonb)$$,'duplicate POS submission returns existing order');
select is((select count(*) from public.orders where idempotency_key='hosted-phase4-phone-001'),1::bigint,'duplicate click creates one order');
select lives_ok($$select public.wayne_create_pos_order('{
  "idempotency_key":"hosted-phase4-walkin-01","customer_mode":"walk_in","customer_id":"","source":"pos","fulfillment_type":"pickup","payment_method":"test_manual",
  "first_name":"","last_name":"","phone":"","email":"","address_id":"","address":{"address1":"","address2":"","city":"","state":"","postal_code":"","delivery_instructions":""},
  "promo_code":"","manual_discount_type":"","manual_discount_value":0,"manual_discount_reason":"","tip_cents":0,"special_instructions":"Counter",
  "items":[{"menu_item_id":"48000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]
}'::jsonb)$$,'cashier can create walk-in pickup');
select ok((select customer_id is null from public.orders where idempotency_key='hosted-phase4-walkin-01'),'walk-in stays anonymous');
select is((select source from public.orders where idempotency_key='hosted-phase4-walkin-01'),'pos','walk-in uses POS source');
select throws_ok($$select public.wayne_create_pos_order('{
  "idempotency_key":"hosted-phase4-denied-001","customer_mode":"walk_in","customer_id":"","source":"pos","fulfillment_type":"pickup","payment_method":"test_manual",
  "first_name":"","last_name":"","phone":"","email":"","address_id":"","address":{},"promo_code":"","manual_discount_type":"percent","manual_discount_value":1000,"manual_discount_reason":"Service recovery","tip_cents":0,"special_instructions":"",
  "items":[{"menu_item_id":"48000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]
}'::jsonb)$$,'42501','Manager discount permission required','cashier cannot apply manual discount');

select set_config('request.jwt.claim.sub','48000000-0000-4000-8000-000000000001',true);
select lives_ok($$select public.wayne_create_pos_order('{
  "idempotency_key":"hosted-phase4-owner-disc1","customer_mode":"walk_in","customer_id":"","source":"pos","fulfillment_type":"pickup","payment_method":"test_manual",
  "first_name":"","last_name":"","phone":"","email":"","address_id":"","address":{},"promo_code":"","manual_discount_type":"percent","manual_discount_value":1000,"manual_discount_reason":"Service recovery","tip_cents":0,"special_instructions":"",
  "items":[{"menu_item_id":"48000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]
}'::jsonb)$$,'owner can apply reasoned manual discount');
select is((select discount_cents from public.orders where idempotency_key='hosted-phase4-owner-disc1'),160,'manual percentage discount is authoritative');
select is((select actor_user_id from public.order_events event join public.orders order_row on order_row.id=event.order_id where order_row.idempotency_key='hosted-phase4-owner-disc1' and event.event_type='order.discount_applied'),'48000000-0000-4000-8000-000000000001'::uuid,'discount event records actor');
select is((select metadata->>'reason' from public.order_events event join public.orders order_row on order_row.id=event.order_id where order_row.idempotency_key='hosted-phase4-owner-disc1' and event.event_type='order.discount_applied'),'Service recovery','discount event records reason');
select throws_ok($$select public.wayne_create_pos_order('{
  "idempotency_key":"hosted-phase4-bad-zone-01","customer_mode":"identified","customer_id":"","source":"phone","fulfillment_type":"delivery","payment_method":"test_manual",
  "first_name":"Zone","last_name":"Test","phone":"508-555-0199","email":"","address_id":"","address":{"address1":"1 State St","address2":"","city":"Boston","state":"MA","postal_code":"02110","delivery_instructions":""},
  "promo_code":"","manual_discount_type":"","manual_discount_value":0,"manual_discount_reason":"","tip_cents":0,"special_instructions":"",
  "items":[{"menu_item_id":"48000000-0000-4000-8000-000000000011","variant_id":null,"quantity":1,"special_instructions":"","modifiers":[]}]
}'::jsonb)$$,'P0001','That address is outside the configured delivery area','POS enforces delivery postal codes');

reset role;
set local role anon;
select is(jsonb_array_length(public.wayne_public_menu()),0,'hidden POS-only item is absent from public menu');
select throws_ok($$select public.wayne_pos_menu()$$,'42501','permission denied for function wayne_pos_menu','anonymous cannot open POS menu');
reset role;

select is((select count(*) from public.orders where source in ('phone','pos')),3::bigint,'all successful POS orders share canonical orders table');
select is((select count(*) from public.order_items item join public.orders order_row on order_row.id=item.order_id where order_row.source in ('phone','pos')),3::bigint,'all successful POS orders share canonical order items table');
select is((select count(*) from public.order_events event join public.orders order_row on order_row.id=event.order_id where order_row.source in ('phone','pos') and event.event_type='order.placed'),3::bigint,'all successful POS orders write placed timeline events');

select * from finish();
rollback;
