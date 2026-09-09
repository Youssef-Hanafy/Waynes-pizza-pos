begin;
set local search_path = public, extensions;
select plan(29);

select ok((select relrowsecurity from pg_class where oid = 'public.customers'::regclass), 'customers has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.customer_addresses'::regclass), 'customer_addresses has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.marketing_consents'::regclass), 'marketing_consents has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.promotions'::regclass), 'promotions has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.orders'::regclass), 'orders has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.order_items'::regclass), 'order_items has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.order_item_modifiers'::regclass), 'order_item_modifiers has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.order_discounts'::regclass), 'order_discounts has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.order_events'::regclass), 'order_events has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.order_idempotency'::regclass), 'order_idempotency has RLS');

select is(public.wayne_normalize_phone('(508) 852-6326'), '+15088526326', 'phone is normalized to E.164');

update public.store_settings set
  business_hours = '{"sunday":{"closed":false,"open":"00:00","close":"23:59"},"monday":{"closed":false,"open":"00:00","close":"23:59"},"tuesday":{"closed":false,"open":"00:00","close":"23:59"},"wednesday":{"closed":false,"open":"00:00","close":"23:59"},"thursday":{"closed":false,"open":"00:00","close":"23:59"},"friday":{"closed":false,"open":"00:00","close":"23:59"},"saturday":{"closed":false,"open":"00:00","close":"23:59"}}',
  tax_rate_basis_points = 625,
  delivery_fee_cents = 300,
  tips_enabled = true;
insert into public.menu_categories (id, name) values ('44000000-0000-4000-8000-000000000001', 'Phase 2 Pizza');
insert into public.menu_items (id, category_id, name, description, base_price_cents, tax_category) values ('44000000-0000-4000-8000-000000000002', '44000000-0000-4000-8000-000000000001', 'Snapshot Pizza', 'Original', 1200, 'prepared_food');
insert into public.menu_item_variants (id, menu_item_id, name, price_cents) values ('44000000-0000-4000-8000-000000000003', '44000000-0000-4000-8000-000000000002', 'Large', 1800);
insert into public.modifier_groups (id, name, customer_label, min_select, max_select, allow_quantities) values ('44000000-0000-4000-8000-000000000004', 'Toppings', 'Choose toppings', 0, 3, true);
insert into public.modifier_choices (id, modifier_group_id, name, price_delta_cents) values ('44000000-0000-4000-8000-000000000005', '44000000-0000-4000-8000-000000000004', 'Pepperoni', 150);
insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id) values ('44000000-0000-4000-8000-000000000002', '44000000-0000-4000-8000-000000000004');

set local role anon;
select throws_ok($$select * from public.customers$$, '42501', 'permission denied for table customers', 'anonymous cannot read customers');
select throws_ok($$select * from public.orders$$, '42501', 'permission denied for table orders', 'anonymous cannot read orders');
select lives_ok($$select public.wayne_create_test_order('{
  "idempotency_key":"hosted-pickup-key-0001","fulfillment_type":"pickup",
  "first_name":"Phase","last_name":"Customer","phone":"508-555-0111","email":"phase2@example.com",
  "sms_opt_in":true,"email_opt_in":false,"tip_cents":0,"promo_code":"","special_instructions":"Ring bell",
  "address":{"address1":"","address2":"","city":"","state":"","postal_code":"","delivery_instructions":""},
  "items":[{"menu_item_id":"44000000-0000-4000-8000-000000000002","variant_id":"44000000-0000-4000-8000-000000000003","quantity":2,"special_instructions":"Well done","modifiers":[{"choice_id":"44000000-0000-4000-8000-000000000005","quantity":1}]}]
}'::jsonb)$$, 'anonymous checkout can create pickup order through RPC');
reset role;
select is((select count(*) from public.orders where idempotency_key = 'hosted-pickup-key-0001'), 1::bigint, 'pickup order persisted once');

set local role anon;
select lives_ok($$select public.wayne_create_test_order('{
  "idempotency_key":"hosted-pickup-key-0001","fulfillment_type":"pickup",
  "first_name":"Different","last_name":"Payload","phone":"508-555-0999","email":"",
  "sms_opt_in":false,"email_opt_in":false,"tip_cents":0,"promo_code":"","special_instructions":"",
  "address":{"address1":"","address2":"","city":"","state":"","postal_code":"","delivery_instructions":""},
  "items":[{"menu_item_id":"44000000-0000-4000-8000-000000000002","variant_id":"44000000-0000-4000-8000-000000000003","quantity":1,"special_instructions":"","modifiers":[]}]
}'::jsonb)$$, 'duplicate idempotency key returns existing order');
reset role;
select is((select count(*) from public.orders where idempotency_key = 'hosted-pickup-key-0001'), 1::bigint, 'duplicate does not create another order');
select is((select subtotal_cents from public.orders where idempotency_key = 'hosted-pickup-key-0001'), 3900, 'authoritative subtotal includes modifier and quantity');
select is((select tax_cents from public.orders where idempotency_key = 'hosted-pickup-key-0001'), 244, 'tax rounds in integer cents');
select is((select count(*) from public.order_items item join public.orders order_row on order_row.id = item.order_id where order_row.idempotency_key = 'hosted-pickup-key-0001'), 1::bigint, 'order item snapshot persisted');
select is((select count(*) from public.order_events event join public.orders order_row on order_row.id = event.order_id where order_row.idempotency_key = 'hosted-pickup-key-0001'), 1::bigint, 'placed event persisted');
select is((select phone_normalized from public.customers where phone_normalized = '+15085550111'), '+15085550111', 'customer stored under normalized phone');
select is((select count(*) from public.marketing_consents consent join public.customers customer on customer.id = consent.customer_id where customer.phone_normalized = '+15085550111'), 1::bigint, 'only affirmative marketing consent is persisted');
select is((select public.wayne_public_order_status(order_row.id, order_row.public_access_token) ->> 'order_number' from public.orders order_row where order_row.idempotency_key = 'hosted-pickup-key-0001'), (select order_number from public.orders where idempotency_key = 'hosted-pickup-key-0001'), 'private status token returns persisted order');
select is((select public.wayne_public_order_status(order_row.id, '44000000-0000-4000-8000-000000000099') from public.orders order_row where order_row.idempotency_key = 'hosted-pickup-key-0001'), null::jsonb, 'wrong status token reveals nothing');

update public.menu_items set name = 'Changed Current Name' where id = '44000000-0000-4000-8000-000000000002';
select is((select item_name_snapshot from public.order_items item join public.orders order_row on order_row.id = item.order_id where order_row.idempotency_key = 'hosted-pickup-key-0001'), 'Snapshot Pizza', 'old order keeps original item name snapshot');

set local role anon;
select lives_ok($$select public.wayne_create_test_order('{
  "idempotency_key":"hosted-delivery-key-01","fulfillment_type":"delivery",
  "first_name":"Delivery","last_name":"Customer","phone":"508-555-0112","email":"",
  "sms_opt_in":false,"email_opt_in":false,"tip_cents":0,"promo_code":"","special_instructions":"",
  "address":{"address1":"10 Main St","address2":"2A","city":"Worcester","state":"MA","postal_code":"01606","delivery_instructions":"Side door"},
  "items":[{"menu_item_id":"44000000-0000-4000-8000-000000000002","variant_id":"44000000-0000-4000-8000-000000000003","quantity":1,"special_instructions":"","modifiers":[]}]
}'::jsonb)$$, 'anonymous checkout can create delivery order through RPC');
reset role;
select is((select delivery_address_snapshot ->> 'postal_code' from public.orders where idempotency_key = 'hosted-delivery-key-01'), '01606', 'delivery address snapshot persisted');
select is((select delivery_fee_cents from public.orders where idempotency_key = 'hosted-delivery-key-01'), 300, 'configured delivery fee applied');

select * from finish();
rollback;
