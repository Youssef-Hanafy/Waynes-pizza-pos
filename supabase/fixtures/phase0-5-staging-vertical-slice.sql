-- ISOLATED STAGING ONLY — never run against production.
--
-- This fixture gives the Phase 0–5 browser acceptance suite one safe,
-- deterministic, customer-visible/POS-visible item with a size and modifiers.
-- It intentionally uses non-production names and zero-value operational
-- settings. The business owner must enter approved real menu and settings data
-- through the admin application before any production launch.

begin;

update public.store_settings
set ordering_open = true,
    pickup_enabled = true,
    delivery_enabled = true,
    test_ordering_enabled = true,
    pickup_minimum_cents = 0,
    delivery_minimum_cents = 0,
    delivery_fee_cents = 0,
    tax_rate_basis_points = 0,
    delivery_postal_codes = '{}'::text[],
    business_hours = '{
      "sunday":{"closed":false,"open":"00:00","close":"23:59"},
      "monday":{"closed":false,"open":"00:00","close":"23:59"},
      "tuesday":{"closed":false,"open":"00:00","close":"23:59"},
      "wednesday":{"closed":false,"open":"00:00","close":"23:59"},
      "thursday":{"closed":false,"open":"00:00","close":"23:59"},
      "friday":{"closed":false,"open":"00:00","close":"23:59"},
      "saturday":{"closed":false,"open":"00:00","close":"23:59"}
    }'::jsonb
where id = true;

insert into public.menu_categories (
  id, name, description, image_alt, sort_order, customer_visible, archived_at
) values (
  '90000000-0000-4000-8000-000000000001',
  'E2E Acceptance',
  'Isolated staging fixtures for automated acceptance checks.',
  'Staging acceptance pizza',
  -1000,
  true,
  null
)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  image_alt = excluded.image_alt,
  sort_order = excluded.sort_order,
  customer_visible = excluded.customer_visible,
  archived_at = null;

insert into public.menu_items (
  id, category_id, name, description, image_alt, base_price_cents,
  tax_category, included_count_label, sold_out, customer_visible, pos_visible,
  featured, kitchen_route, available_days, available_start, available_end,
  sort_order, archived_at
) values (
  '90000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001',
  'Staging Supreme Pizza',
  'Non-production automated acceptance fixture. Do not use as a real menu item.',
  'Staging Supreme Pizza',
  0,
  'prepared_food',
  '',
  false,
  true,
  true,
  false,
  'pizza',
  array[0,1,2,3,4,5,6]::smallint[],
  null,
  null,
  -1000,
  null
)
on conflict (id) do update set
  category_id = excluded.category_id,
  name = excluded.name,
  description = excluded.description,
  image_alt = excluded.image_alt,
  base_price_cents = excluded.base_price_cents,
  sold_out = false,
  customer_visible = true,
  pos_visible = true,
  kitchen_route = excluded.kitchen_route,
  available_days = excluded.available_days,
  available_start = null,
  available_end = null,
  sort_order = excluded.sort_order,
  archived_at = null;

insert into public.menu_item_variants (
  id, menu_item_id, name, price_cents, sku, sort_order, active, archived_at
) values
  ('90000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000002', 'Small', 1200, 'E2E-SMALL', 0, true, null),
  ('90000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000002', 'Large', 1800, 'E2E-LARGE', 1, true, null)
on conflict (id) do update set
  menu_item_id = excluded.menu_item_id,
  name = excluded.name,
  price_cents = excluded.price_cents,
  sku = excluded.sku,
  sort_order = excluded.sort_order,
  active = true,
  archived_at = null;

insert into public.modifier_groups (
  id, name, customer_label, min_select, max_select, required,
  allow_quantities, sort_order, active, archived_at
) values
  ('90000000-0000-4000-8000-000000000005', 'fixture_cheese', 'Cheese', 1, 1, true, false, 0, true, null),
  ('90000000-0000-4000-8000-000000000006', 'fixture_toppings', 'Toppings', 0, 3, false, true, 1, true, null)
on conflict (id) do update set
  name = excluded.name,
  customer_label = excluded.customer_label,
  min_select = excluded.min_select,
  max_select = excluded.max_select,
  required = excluded.required,
  allow_quantities = excluded.allow_quantities,
  sort_order = excluded.sort_order,
  active = true,
  archived_at = null;

insert into public.modifier_choices (
  id, modifier_group_id, name, price_delta_cents, default_selected,
  sort_order, active, archived_at
) values
  ('90000000-0000-4000-8000-000000000007', '90000000-0000-4000-8000-000000000005', 'Mozzarella', 0, true, 0, true, null),
  ('90000000-0000-4000-8000-000000000008', '90000000-0000-4000-8000-000000000006', 'Fresh basil', 100, false, 0, true, null),
  ('90000000-0000-4000-8000-000000000009', '90000000-0000-4000-8000-000000000006', 'Pepperoni', 150, false, 1, true, null)
on conflict (id) do update set
  modifier_group_id = excluded.modifier_group_id,
  name = excluded.name,
  price_delta_cents = excluded.price_delta_cents,
  default_selected = excluded.default_selected,
  sort_order = excluded.sort_order,
  active = true,
  archived_at = null;

insert into public.menu_item_modifier_groups (
  menu_item_id, modifier_group_id, sort_order, active
) values
  ('90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000005', 0, true),
  ('90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000006', 1, true)
on conflict (menu_item_id, modifier_group_id) do update set
  sort_order = excluded.sort_order,
  active = true;

commit;
