begin;
set local search_path = public, extensions;
select plan(19);

select is((select count(*) from public.permissions where code = 'orders.view'), 1::bigint, 'orders.view permission exists');
select is((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'owner' and p.code = 'orders.view'), 1::bigint, 'owner receives orders.view');
select is((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'manager' and p.code = 'orders.view'), 1::bigint, 'manager receives orders.view');
select is((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'cashier' and p.code = 'orders.view'), 0::bigint, 'cashier does not receive orders.view');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('46000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'phase3-owner@test.local', '', now(), '{}', '{"display_name":"Phase 3 Owner"}'),
  ('46000000-0000-4000-8000-000000000002', '00000000-0000-0000-8000-000000000000', 'authenticated', 'authenticated', 'phase3-cashier@test.local', '', now(), '{}', '{"display_name":"Phase 3 Cashier"}');
update public.profiles set role_id = (select id from public.roles where code = 'owner') where id = '46000000-0000-4000-8000-000000000001';

insert into public.orders (id, order_number, source, fulfillment_type, status, payment_status, payment_method, subtotal_cents, total_cents, customer_name_snapshot, customer_phone_snapshot, pricing_snapshot, placed_at, idempotency_key)
values
  ('46000000-0000-4000-8000-000000000010', 'W903001', 'online', 'pickup', 'placed', 'unpaid', 'test_manual', 1500, 1500, 'Alice Adams', '+15085550101', '{}', '2026-03-15 16:00:00+00', 'phase3-hosted-order-001'),
  ('46000000-0000-4000-8000-000000000011', 'W903002', 'phone', 'delivery', 'placed', 'unpaid', 'cash', 1700, 2000, 'Bob Baker', '+15085550102', '{}', '2026-03-16 17:00:00+00', 'phase3-hosted-order-002');
insert into public.order_items (id, order_id, item_name_snapshot, unit_price_cents, quantity, line_total_cents) values ('46000000-0000-4000-8000-000000000020', '46000000-0000-4000-8000-000000000010', 'Cheese Pizza', 1500, 1, 1500);
insert into public.order_events (id, order_id, event_type, to_status) values ('46000000-0000-4000-8000-000000000030', '46000000-0000-4000-8000-000000000010', 'order.placed', 'placed');

set local role authenticated;
select set_config('request.jwt.claim.sub', '46000000-0000-4000-8000-000000000001', true);
select ok(public.wayne_has_permission('orders.view'), 'owner has order viewing permission');
select is((public.wayne_admin_orders('W903001') ->> 'total_count')::integer, 1, 'finds by order number');
select is((public.wayne_admin_orders('Alice') ->> 'total_count')::integer, 1, 'finds by customer name without empty phone false-positive');
select is((public.wayne_admin_orders('(508) 555-0101') ->> 'total_count')::integer, 1, 'finds by formatted phone');
select is((public.wayne_admin_orders(null, '2026-03-15', '2026-03-15') ->> 'total_count')::integer, 1, 'filters by Wayne business date');
select is((public.wayne_admin_orders(null, null, null, 'delivery') ->> 'total_count')::integer, 1, 'filters by fulfillment');
select is(jsonb_array_length(public.wayne_admin_order_calendar('2026-03-01')), 2, 'calendar returns two active dates');
select is((select sum((day ->> 'order_count')::integer) from jsonb_array_elements(public.wayne_admin_order_calendar('2026-03-01')) day), 2::bigint, 'calendar order counts match');
select is((select sum((day ->> 'active_total_cents')::integer) from jsonb_array_elements(public.wayne_admin_order_calendar('2026-03-01')) day), 3500::bigint, 'calendar active totals match stored totals');
select is(public.wayne_admin_order_detail('46000000-0000-4000-8000-000000000010') -> 'items' -> 0 ->> 'item_name_snapshot', 'Cheese Pizza', 'detail returns nested item snapshot');
select is(public.wayne_admin_order_detail('46000000-0000-4000-8000-000000000010') -> 'events' -> 0 ->> 'event_type', 'order.placed', 'detail returns timeline event');
select ok(not (public.wayne_admin_order_detail('46000000-0000-4000-8000-000000000010') ? 'public_access_token'), 'detail hides public access token');

select set_config('request.jwt.claim.sub', '46000000-0000-4000-8000-000000000002', true);
select throws_ok($$select public.wayne_admin_orders()$$, '42501', 'Order viewing permission required', 'cashier cannot search orders');
select throws_ok($$select public.wayne_admin_order_calendar('2026-03-01')$$, '42501', 'Order viewing permission required', 'cashier cannot view calendar');
select throws_ok($$select public.wayne_admin_order_detail('46000000-0000-4000-8000-000000000010')$$, '42501', 'Order viewing permission required', 'cashier cannot view order detail');

select * from finish();
rollback;
