begin;
set local search_path = public, extensions;
select plan(24);

select ok((select relrowsecurity from pg_class where oid = 'public.store_settings'::regclass), 'store_settings has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.store_special_hours'::regclass), 'store_special_hours has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.menu_categories'::regclass), 'menu_categories has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.menu_items'::regclass), 'menu_items has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.menu_item_variants'::regclass), 'menu_item_variants has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.modifier_groups'::regclass), 'modifier_groups has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.modifier_choices'::regclass), 'modifier_choices has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.menu_item_modifier_groups'::regclass), 'menu_item_modifier_groups has RLS enabled');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('32000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'phase1-owner@test.local', '', now(), '{}', '{"display_name":"Phase 1 Owner"}'),
  ('32000000-0000-4000-8000-000000000002', '00000000-0000-0000-8000-000000000000', 'authenticated', 'authenticated', 'phase1-cashier@test.local', '', now(), '{}', '{"display_name":"Phase 1 Cashier"}');

update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '32000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', '32000000-0000-4000-8000-000000000001', true);
select ok(public.wayne_has_permission('menu.manage'), 'owner has menu management permission');
select lives_ok($$insert into public.menu_categories (id, name, description, sort_order) values ('42000000-0000-4000-8000-000000000001', 'Pizza', 'Pizza category', 1)$$, 'owner can create category');
select lives_ok($$select public.wayne_create_menu_item('{
  "category_id":"42000000-0000-4000-8000-000000000001",
  "name":"Phase 1 Pizza","description":"Test item","image_path":null,"image_alt":"Pizza",
  "base_price_cents":1200,"tax_category":"prepared_food","included_count_label":"",
  "sold_out":true,"customer_visible":true,"pos_visible":true,"featured":true,"kitchen_route":"pizza",
  "available_days":[0,1,2,3,4,5,6],"available_start":"","available_end":"","sort_order":1,
  "variants":[{"name":"Small","price_cents":1200,"sku":"","sort_order":0},{"name":"Large","price_cents":1800,"sku":"","sort_order":1}],
  "modifier_groups":[{"name":"Toppings","customer_label":"Choose toppings","min_select":0,"max_select":2,"required":false,"allow_quantities":true,"choices":[{"name":"Pepperoni","price_delta_cents":150,"default_selected":false},{"name":"Mushroom","price_delta_cents":100,"default_selected":false}]}]
}'::jsonb)$$, 'owner can create item tree transactionally');
select is((select count(*) from public.menu_item_variants variant join public.menu_items item on item.id = variant.menu_item_id where item.name = 'Phase 1 Pizza' and variant.active), 2::bigint, 'two active variants created');
select is((select count(*) from public.modifier_choices choice join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id join public.menu_item_modifier_groups link on link.modifier_group_id = modifier_group.id join public.menu_items item on item.id = link.menu_item_id where item.name = 'Phase 1 Pizza' and choice.active), 2::bigint, 'two active modifier choices created');
select lives_ok($$insert into public.store_special_hours (service_date, label, closed, public_note) values (current_date + 10, 'Test closure', true, 'Closed for test')$$, 'owner can add special hours');

select set_config('request.jwt.claim.sub', '32000000-0000-4000-8000-000000000002', true);
select ok(not public.wayne_has_permission('menu.manage'), 'cashier lacks menu management permission');
select throws_ok($$select public.wayne_create_menu_item('{}'::jsonb)$$, '42501', 'Menu management permission required', 'cashier cannot call privileged menu RPC');
select is((select count(*) from public.store_settings), 0::bigint, 'cashier cannot see or target website settings');

reset role;
set local role anon;
select is((public.wayne_public_store_settings() ->> 'store_name'), 'Wayne''s Pizza', 'anonymous visitor gets canonical business settings');
select is((public.wayne_public_store_settings() -> 'special_hours' -> 0 ->> 'label'), 'Test closure', 'anonymous visitor gets special hours through public function');
select is((public.wayne_public_menu() -> 0 -> 'items' -> 0 ->> 'name'), 'Phase 1 Pizza', 'anonymous visitor sees public menu item');
select is((public.wayne_public_menu() -> 0 -> 'items' -> 0 ->> 'sold_out')::boolean, true, 'sold-out item remains visible and labeled');
select throws_ok($$insert into public.menu_categories (name) values ('Unauthorized')$$, '42501', 'permission denied for table menu_categories', 'anonymous visitor cannot create category');

reset role;
update public.menu_items set archived_at = now() where name = 'Phase 1 Pizza';
set local role anon;
select is(jsonb_array_length(public.wayne_public_menu() -> 0 -> 'items'), 0, 'archived item disappears from public menu');
reset role;
select is((select count(*) from public.menu_item_variants variant join public.menu_items item on item.id = variant.menu_item_id where item.name = 'Phase 1 Pizza'), 2::bigint, 'archiving retains variants for historical safety');

select * from finish();
rollback;
