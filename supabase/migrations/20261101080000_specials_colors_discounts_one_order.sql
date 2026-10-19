-- Owner, 2026-10-19:
--   1. Specials: mark menu items as specials; the POS shows them under one
--      "Specials" button and the website lists them on the Offers page.
--   2. A colour per menu item or per category (the items inherit it) so the
--      POS buttons are easy to tell apart.
--   3. A Discount button on the POS (like Open item): $ off, % off, or one of
--      the discounts saved in Admin -> Discounts.
--   4. An order the cashier leaves without pressing a payment or Pay later is
--      not submitted: it is cancelled before anything prints.
--   5. Adding items always goes on the SAME order and the same ticket on the
--      POS, even after it was paid (what is still owed is taken as a second
--      payment on that order), and no extra slip prints.
--   6. Taking payment closes the order: a paid counter / phone pickup order is
--      completed automatically (no "Complete now (skip kitchen)").

create or replace function public._wayne_patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
begin
  if position(new_text in definition) > 0 and position(old_text in new_text) = 0 then
    return; -- already applied
  end if;
  if position(old_text in definition) = 0 then
    raise exception 'Patch for % did not match: %', target, left(old_text, 120);
  end if;
  execute replace(definition, old_text, new_text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1 + 2. Menu: POS colours and specials
-- ---------------------------------------------------------------------------
alter table public.menu_categories add column if not exists pos_color text;
alter table public.menu_items
  add column if not exists pos_color text,
  add column if not exists special boolean not null default false,
  add column if not exists special_note text not null default '',
  add column if not exists special_online boolean not null default true,
  add column if not exists special_ends_on date;

alter table public.menu_categories drop constraint if exists menu_categories_pos_color_check;
alter table public.menu_categories add constraint menu_categories_pos_color_check check (pos_color is null or pos_color ~ '^#[0-9a-f]{6}$');
alter table public.menu_items drop constraint if exists menu_items_pos_color_check;
alter table public.menu_items add constraint menu_items_pos_color_check check (pos_color is null or pos_color ~ '^#[0-9a-f]{6}$');
alter table public.menu_items drop constraint if exists menu_items_special_note_check;
alter table public.menu_items add constraint menu_items_special_note_check check (char_length(special_note) <= 200);

-- The POS menu carries the colour (item's own, else its category's) and whether it is a special today.
select public._wayne_patch_function('public.wayne_pos_menu()'::regprocedure,
$o$'sold_out', item.sold_out, 'featured', item.featured,$o$,
$n$'sold_out', item.sold_out, 'featured', item.featured,
                'pos_color', coalesce(item.pos_color, category.pos_color),
                'special', item.special and (item.special_ends_on is null or item.special_ends_on >= (now() at time zone public.wayne_store_zone())::date),
                'special_note', item.special_note,$n$);
select public._wayne_patch_function('public.wayne_pos_menu()'::regprocedure,
$o$'image_path', category.image_path, 'image_alt', category.image_alt,$o$,
$n$'image_path', category.image_path, 'image_alt', category.image_alt, 'pos_color', category.pos_color,$n$);

-- Specials on the website's Offers page (anyone may read them, like the menu).
create or replace function public.hanafy_public_specials(target_hostname text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', item.id, 'name', item.name, 'description', item.description, 'note', item.special_note,
      'image_path', item.image_path, 'image_alt', item.image_alt,
      'price_cents', coalesce((select min(variant.price_cents) from public.menu_item_variants variant
                                where variant.menu_item_id = item.id and variant.active and variant.archived_at is null), item.base_price_cents),
      'size_count', (select count(*) from public.menu_item_variants variant
                      where variant.menu_item_id = item.id and variant.active and variant.archived_at is null)::integer,
      'ends_on', item.special_ends_on
    ) order by item.sort_order, item.name), '[]'::jsonb)
  from public.hanafy_host_workspace(target_hostname) host
  join public.menu_items item on item.workspace_id = host.workspace_id
  join public.menu_categories category on category.id = item.category_id
  where item.special and item.special_online and item.customer_visible and item.archived_at is null and not item.sold_out
    and category.customer_visible and category.archived_at is null
    and (item.special_ends_on is null or item.special_ends_on >= (now() at time zone public.wayne_store_zone())::date);
$function$;
revoke all on function public.hanafy_public_specials(text) from public;
grant execute on function public.hanafy_public_specials(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Saved POS discounts (Admin -> Discounts) and the POS Discount button
-- ---------------------------------------------------------------------------
create table if not exists public.pos_discounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  location_id uuid not null references public.locations (id),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  discount_type text not null check (discount_type in ('fixed', 'percent')),
  -- fixed: cents; percent: basis points (10% = 1000), same as manual discounts.
  discount_value integer not null check (discount_value > 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_by_user_id uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((discount_type = 'fixed' and discount_value <= 100000) or (discount_type = 'percent' and discount_value <= 10000))
);
drop trigger if exists aa_hanafy_assign_legacy_scope on public.pos_discounts;
create trigger aa_hanafy_assign_legacy_scope before insert on public.pos_discounts
  for each row execute function public.hanafy_assign_legacy_location_scope();
drop trigger if exists zz_hanafy_enforce_tenant_scope on public.pos_discounts;
create trigger zz_hanafy_enforce_tenant_scope before insert or update on public.pos_discounts
  for each row execute function public.hanafy_enforce_location_scope();
drop trigger if exists pos_discounts_set_updated_at on public.pos_discounts;
create trigger pos_discounts_set_updated_at before update on public.pos_discounts
  for each row execute function public.set_updated_at();
-- Read and written only through the functions below.
alter table public.pos_discounts enable row level security;
revoke all on public.pos_discounts from anon, authenticated;

-- The buttons in the POS Discount box.
create or replace function public.wayne_pos_discounts()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'discount_type', d.discount_type, 'discount_value', d.discount_value)
                     order by d.sort_order, d.name)
                     from public.pos_discounts d where d.active and d.archived_at is null), '[]'::jsonb);
end;
$function$;

-- Admin -> Discounts list (switched-off ones too).
create or replace function public.wayne_admin_pos_discounts()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not public.wayne_has_permission('pos.discount.manage') then raise exception 'Discount permission required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'discount_type', d.discount_type, 'discount_value', d.discount_value,
                       'active', d.active, 'sort_order', d.sort_order,
                       'times_used', (select count(*) from public.order_discounts od join public.orders o on o.id = od.order_id
                                       where od.code_snapshot = 'POS DISCOUNT' and od.description_snapshot = d.name and o.status <> 'cancelled')::integer)
                     order by d.sort_order, d.name)
                     from public.pos_discounts d where d.archived_at is null), '[]'::jsonb);
end;
$function$;

create or replace function public.wayne_save_pos_discount(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  target uuid := nullif(payload ->> 'id', '')::uuid;
  clean_name text := btrim(coalesce(payload ->> 'name', ''));
  kind text := payload ->> 'discount_type';
  amount integer := (payload ->> 'discount_value')::integer;
  saved public.pos_discounts%rowtype;
begin
  if not public.wayne_has_permission('pos.discount.manage') then raise exception 'Discount permission required' using errcode = '42501'; end if;
  if char_length(clean_name) not between 1 and 60 then raise exception 'Name the discount (up to 60 characters)' using errcode = '22023'; end if;
  if kind is null or kind not in ('fixed', 'percent') then raise exception 'Choose dollars off or percent off' using errcode = '22023'; end if;
  if amount is null or amount <= 0 or (kind = 'fixed' and amount > 100000) or (kind = 'percent' and amount > 10000) then
    raise exception 'Enter an amount between $0.01 and $1,000, or a percent between 0.01 and 100' using errcode = '22023';
  end if;
  if target is null then
    insert into public.pos_discounts (name, discount_type, discount_value, active, sort_order, created_by_user_id)
    values (clean_name, kind, amount, coalesce((payload ->> 'active')::boolean, true), coalesce((payload ->> 'sort_order')::integer, 0), auth.uid())
    returning * into saved;
  else
    update public.pos_discounts set name = clean_name, discount_type = kind, discount_value = amount,
      active = coalesce((payload ->> 'active')::boolean, active), sort_order = coalesce((payload ->> 'sort_order')::integer, sort_order)
    where id = target and archived_at is null
    returning * into saved;
    if not found then raise exception 'That discount no longer exists' using errcode = 'P0002'; end if;
  end if;
  perform public.wayne_write_audit(case when target is null then 'pos_discount.created' else 'pos_discount.updated' end, 'pos_discounts', saved.id::text,
    'Saved POS discount ' || saved.name, '{}'::jsonb,
    jsonb_build_object('name', saved.name, 'discount_type', saved.discount_type, 'discount_value', saved.discount_value, 'active', saved.active));
  return jsonb_build_object('id', saved.id);
end;
$function$;

create or replace function public.wayne_archive_pos_discount(target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare saved public.pos_discounts%rowtype;
begin
  if not public.wayne_has_permission('pos.discount.manage') then raise exception 'Discount permission required' using errcode = '42501'; end if;
  update public.pos_discounts set archived_at = now(), active = false where id = target_id and archived_at is null returning * into saved;
  if found then
    perform public.wayne_write_audit('pos_discount.removed', 'pos_discounts', saved.id::text, 'Removed POS discount ' || saved.name, '{}'::jsonb, jsonb_build_object('name', saved.name));
    return jsonb_build_object('removed', true);
  end if;
  return jsonb_build_object('removed', false);
end;
$function$;

revoke all on function public.wayne_pos_discounts() from public, anon;
revoke all on function public.wayne_admin_pos_discounts() from public, anon;
revoke all on function public.wayne_save_pos_discount(jsonb) from public, anon;
revoke all on function public.wayne_archive_pos_discount(uuid) from public, anon;
grant execute on function public.wayne_pos_discounts() to authenticated;
grant execute on function public.wayne_admin_pos_discounts() to authenticated;
grant execute on function public.wayne_save_pos_discount(jsonb) to authenticated;
grant execute on function public.wayne_archive_pos_discount(uuid) to authenticated;

-- A saved discount may be used by any cashier; typing your own $ / % off still needs a manager.
select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  open_name text;
begin$o$,
$n$  open_name text;
  preset_row public.pos_discounts%rowtype;
begin$n$);
select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  if nullif(upper(btrim(coalesce(payload ->> 'promo_code', ''))), '') is not null then
    if manual_type is not null then$o$,
$n$  -- A discount saved in Admin -> Discounts (owner, 2026-10-19): its own amount, never one typed in.
  if nullif(payload ->> 'pos_discount_id', '') is not null then
    select * into preset_row from public.pos_discounts where id = (payload ->> 'pos_discount_id')::uuid and active and archived_at is null;
    if not found then raise exception 'That discount is no longer available. Pick another one.' using errcode = 'P0001'; end if;
    manual_type := preset_row.discount_type; manual_value := preset_row.discount_value; manual_reason := preset_row.name;
  end if;
  if nullif(upper(btrim(coalesce(payload ->> 'promo_code', ''))), '') is not null then
    if manual_type is not null then$n$);
select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$    if not public.wayne_has_permission('pos.discount.manage') then raise exception 'Manager discount permission required' using errcode = '42501'; end if;
    if char_length(manual_reason) < 3 then$o$,
$n$    if preset_row.id is null and not public.wayne_has_permission('pos.discount.manage') then raise exception 'Manager discount permission required' using errcode = '42501'; end if;
    if preset_row.id is null and char_length(manual_reason) < 3 then$n$);
select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$values (created_order_id, null, 'MANUAL', manual_reason,$o$,
$n$values (created_order_id, null, case when preset_row.id is null then 'MANUAL' else 'POS DISCOUNT' end, manual_reason,$n$);

-- ---------------------------------------------------------------------------
-- 5. One order, even after it is paid: payments take what is still owed
-- ---------------------------------------------------------------------------
create or replace function public.wayne_order_paid_cents(target_order_id uuid)
returns integer
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(sum(p.amount_cents), 0)::integer from public.payments p
   where p.order_id = target_order_id and p.status in ('authorized', 'captured');
$function$;
revoke all on function public.wayne_order_paid_cents(uuid) from public, anon;
grant execute on function public.wayne_order_paid_cents(uuid) to authenticated;

-- Card (reader / Stripe / keyed), cash and test cards: the amount is what is still owed.
-- (order_row.total_cents is overwritten in memory with the balance; the order row is never written back from it.)
select public._wayne_patch_function('public.wayne_begin_payment(jsonb)'::regprocedure,
$o$  if order_row.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = order_row.id and status in ('pending', 'authorized', 'captured')) then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;$o$,
$n$  -- Items added after a payment go on the same order (owner, 2026-10-19): charge only what is still owed.
  if order_row.payment_status in ('refunded', 'partially_refunded') then raise exception 'This order was refunded' using errcode = '22023'; end if;
  order_row.total_cents := order_row.total_cents - public.wayne_order_paid_cents(order_row.id);
  if order_row.payment_status = 'paid' or order_row.total_cents <= 0 then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = order_row.id and status = 'pending') then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;$n$);
select public._wayne_patch_function('public.wayne_take_cash_payment(jsonb)'::regprocedure,
$o$  if order_row.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = order_row.id and status in ('pending', 'authorized', 'captured')) then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;$o$,
$n$  -- Items added after a payment go on the same order (owner, 2026-10-19): take only what is still owed.
  if order_row.payment_status in ('refunded', 'partially_refunded') then raise exception 'This order was refunded' using errcode = '22023'; end if;
  order_row.total_cents := order_row.total_cents - public.wayne_order_paid_cents(order_row.id);
  if order_row.payment_status = 'paid' or order_row.total_cents <= 0 then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = order_row.id and status = 'pending') then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;$n$);
select public._wayne_patch_function('public.wayne_record_card_payment(jsonb)'::regprocedure,
$o$  if order_row.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = order_row.id and status in ('pending', 'authorized', 'captured')) then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;$o$,
$n$  -- Items added after a payment go on the same order (owner, 2026-10-19): record only what is still owed.
  if order_row.payment_status in ('refunded', 'partially_refunded') then raise exception 'This order was refunded' using errcode = '22023'; end if;
  order_row.total_cents := order_row.total_cents - public.wayne_order_paid_cents(order_row.id);
  if order_row.payment_status = 'paid' or order_row.total_cents <= 0 then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = order_row.id and status = 'pending') then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;$n$);
select public._wayne_patch_function('public.wayne_pos_test_card_payment(uuid,boolean,text,text)'::regprocedure,
$o$  if v_order.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = v_order.id and status in ('pending', 'authorized', 'captured')) then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;$o$,
$n$  -- Items added after a payment go on the same order (owner, 2026-10-19): charge only what is still owed.
  if v_order.payment_status in ('refunded', 'partially_refunded') then raise exception 'This order was refunded' using errcode = '22023'; end if;
  v_order.total_cents := v_order.total_cents - public.wayne_order_paid_cents(v_order.id);
  if v_order.payment_status = 'paid' or v_order.total_cents <= 0 then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = v_order.id and status = 'pending') then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;$n$);
-- A captured card marks the order paid only once everything owed is in.
select public._wayne_patch_function('public.wayne_settle_payment(jsonb)'::regprocedure,
$o$      payment_status = 'paid',
      payment_method = case when payment_row.method = 'card' then 'card' else payment_method end,$o$,
$n$      payment_status = case when public.wayne_order_paid_cents(order_row.id) >= order_row.total_cents then 'paid' else 'unpaid' end,
      payment_method = case when payment_row.method = 'card' then 'card' else payment_method end,$n$);

-- The POS lists show what has been paid, so the payment screen asks only for the rest.
select public._wayne_patch_function('public.wayne_pos_open_orders()'::regprocedure,
$o$payment_method, payment_status, total_cents, placed_at,$o$,
$n$payment_method, payment_status, total_cents, public.wayne_order_paid_cents(id) as paid_cents, placed_at,$n$);
select public._wayne_patch_function('public.wayne_pos_day_orders(date)'::regprocedure,
$o$o.tip_cents, o.total_cents,$o$,
$n$o.tip_cents, o.total_cents, public.wayne_order_paid_cents(o.id) as paid_cents,$n$);

-- Add items: always the same order, no add-on, no extra kitchen slip.
create or replace function public.wayne_pos_add_items(target_order_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  note text := left(btrim(coalesce(payload ->> 'special_instructions', '')), 500);
  existing_order_id uuid;
  main public.orders%rowtype;
  settings public.store_settings%rowtype;
  rate integer;
  added integer;
  new_subtotal integer;
  new_discount integer := 0;
  new_tax integer;
  new_total integer;
  paid integer;
  owes boolean;
  result_row public.orders%rowtype;
  before_ids uuid[];
  new_ids uuid[];
  discount_row record;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if char_length(request_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;
  if jsonb_typeof(payload -> 'items') is distinct from 'array' or jsonb_array_length(payload -> 'items') = 0 then
    raise exception 'Add at least one item' using errcode = '22023';
  end if;

  insert into public.order_idempotency (idempotency_key) values (request_key) on conflict do nothing;
  select request.order_id into existing_order_id from public.order_idempotency request where request.idempotency_key = request_key for update;
  if existing_order_id is not null then
    return (select jsonb_build_object('order_id', o.id, 'mode', 'merged', 'order_number', o.order_number, 'daily_number', o.daily_number,
      'total_cents', o.total_cents, 'paid_cents', public.wayne_order_paid_cents(o.id), 'payment_status', o.payment_status, 'duplicate', true)
      from public.orders o where o.id = existing_order_id);
  end if;

  select * into main from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  -- An add-on made before 2026-10-19 adds to the order it belongs to.
  if main.parent_order_id is not null then
    select * into main from public.orders where id = main.parent_order_id for update;
  end if;
  if main.status in ('cancelled', 'draft', 'payment_pending') then raise exception 'This order can''t take more items' using errcode = '22023'; end if;
  if main.payment_status in ('refunded', 'partially_refunded') then raise exception 'This order was refunded — start a new order instead' using errcode = '22023'; end if;
  if exists (select 1 from public.payments p where p.order_id = main.id and p.status = 'pending') then
    raise exception 'A card payment is in progress on this order. Finish or cancel it first.' using errcode = '40001';
  end if;
  select * into settings from public.store_settings where id = true;
  rate := coalesce((main.pricing_snapshot ->> 'tax_rate_basis_points')::integer, settings.tax_rate_basis_points, 0);

  select coalesce(array_agg(id), '{}') into before_ids from public.order_items where order_id = main.id;
  added := public.wayne_pos_insert_items(main.id, payload -> 'items');
  select coalesce(sum(line_total_cents), 0)::integer into new_subtotal from public.order_items where order_id = main.id;
  for discount_row in select * from public.order_discounts where order_id = main.id loop
    -- Same rule as when the order was placed: "fixed" is cents, anything else is basis points of the subtotal.
    discount_row.amount_cents := case
      when discount_row.discount_type_snapshot = 'fixed' then least(new_subtotal, coalesce(discount_row.discount_value_snapshot, discount_row.amount_cents))
      else least(new_subtotal, ((new_subtotal::bigint * discount_row.discount_value_snapshot + 5000) / 10000)::integer) end;
    new_discount := new_discount + discount_row.amount_cents;
    update public.order_discounts set amount_cents = discount_row.amount_cents where id = discount_row.id;
  end loop;
  new_discount := least(new_discount, new_subtotal);
  new_tax := (((new_subtotal - new_discount)::bigint * rate + 5000) / 10000)::integer;
  new_total := new_subtotal - new_discount + main.delivery_fee_cents + new_tax + main.tip_cents;
  paid := public.wayne_order_paid_cents(main.id);
  -- Already paid (or the card is held): the order owes the difference, and a closed order reopens until it is paid.
  owes := paid > 0 and new_total > paid;
  update public.orders o set
    subtotal_cents = new_subtotal, discount_cents = new_discount, tax_cents = new_tax, total_cents = new_total,
    payment_status = case when owes then 'unpaid' else o.payment_status end,
    status = case when owes and o.status = 'completed' then 'placed' else o.status end,
    completed_at = case when owes and o.status = 'completed' then null else o.completed_at end,
    special_instructions = case when note = '' then o.special_instructions else left(btrim(o.special_instructions || case when o.special_instructions = '' then '' else ' · ' end || 'ADDED: ' || note), 1500) end
   where o.id = main.id
  returning * into result_row;
  select coalesce(array_agg(id), '{}') into new_ids from public.order_items where order_id = main.id and not (id = any(before_ids));

  -- No extra slip (owner, 2026-10-19): a kitchen ticket still waiting to print
  -- prints the whole order; one already printed is reprinted by hand from the order.
  -- The kitchen screen shows the whole order.
  update public.kitchen_tickets kt set payload = kt.payload || jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'name', i.item_name_snapshot, 'variant', i.variant_name_snapshot, 'quantity', i.quantity,
      'instructions', i.special_instructions, 'station', coalesce(i.kitchen_route_snapshot, 'kitchen'),
      'modifiers', coalesce((select jsonb_agg(jsonb_build_object('name', m.modifier_name_snapshot, 'group', m.modifier_group_name_snapshot, 'quantity', m.quantity) order by m.created_at, m.id)
        from public.order_item_modifiers m where m.order_item_id = i.id), '[]'::jsonb)) order by i.created_at, i.id)
      from public.order_items i where i.order_id = main.id), '[]'::jsonb)), updated_at = now()
   where kt.order_id = main.id;

  if main.status = 'completed' and owes then
    insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
    values (main.id, 'order.reopened', 'completed', 'placed', auth.uid(), jsonb_build_object('reason', 'items added after payment'));
  end if;
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (main.id, 'order.items_added', auth.uid(), jsonb_build_object('added_cents', added, 'item_ids', to_jsonb(new_ids), 'total_cents', result_row.total_cents,
    'paid_cents', paid, 'idempotency_key', request_key));
  update public.order_idempotency set order_id = main.id where idempotency_key = request_key;
  return jsonb_build_object('order_id', main.id, 'mode', 'merged', 'order_number', main.order_number, 'daily_number', main.daily_number,
    'added_cents', added, 'total_cents', result_row.total_cents, 'paid_cents', paid, 'payment_status', result_row.payment_status, 'duplicate', false);
end;
$function$;
revoke all on function public.wayne_pos_add_items(uuid, jsonb) from public, anon;
grant execute on function public.wayne_pos_add_items(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Paid = closed for counter and phone pickups
-- ---------------------------------------------------------------------------
create or replace function public.wayne_close_order_on_payment()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid'
     and new.source in ('pos', 'phone') and new.fulfillment_type = 'pickup'
     and new.status in ('placed', 'accepted', 'in_kitchen', 'ready') then
    update public.orders set status = 'completed', completed_at = now() where id = new.id and status = new.status;
    if found then
      insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
      values (new.id, 'order.completed', new.status, 'completed', auth.uid(),
        jsonb_build_object('completed_from', new.status, 'closed_on_payment', true, 'skipped_kitchen_steps', new.status <> 'ready'));
    end if;
  end if;
  return new;
end;
$function$;
drop trigger if exists orders_close_on_payment on public.orders;
create trigger orders_close_on_payment after update of payment_status on public.orders
  for each row execute function public.wayne_close_order_on_payment();

-- ---------------------------------------------------------------------------
-- 4. Left without a payment or Pay later: the order was never submitted
-- ---------------------------------------------------------------------------
create or replace function public.wayne_pos_abandon_order(target_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  o public.orders%rowtype;
  released integer := 0;
  reason_text constant text := 'Not submitted — the cashier left the payment screen without taking payment or pressing Pay later';
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  select * into o from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if o.status = 'cancelled' then return jsonb_build_object('cancelled', true, 'duplicate', true); end if;
  -- Only a ticket just sent from the POS that nobody has paid, printed or added to since.
  if o.source not in ('pos', 'phone') or o.status <> 'placed' or o.payment_status <> 'unpaid' or o.parent_order_id is not null
     or o.placed_at < now() - interval '30 minutes'
     or exists (select 1 from public.payments p where p.order_id = o.id and p.status in ('pending', 'authorized', 'captured'))
     or exists (select 1 from public.print_jobs j where j.order_id = o.id and j.job_type in ('kitchen_ticket', 'delivery_receipt', 'kitchen_addition') and j.status <> 'pending')
     or exists (select 1 from public.orders child where child.parent_order_id = o.id and child.status <> 'cancelled')
  then
    return jsonb_build_object('cancelled', false);
  end if;

  update public.promotions promotion set uses_count = greatest(promotion.uses_count - 1, 0)
  from public.order_discounts discount
  where discount.order_id = o.id and discount.promotion_id = promotion.id;
  get diagnostics released = row_count;
  -- Nothing prints for it.
  delete from public.print_jobs where order_id = o.id and status = 'pending';
  update public.orders set status = 'cancelled', cancelled_at = now(), print_hold_until = null where id = o.id;
  insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
  values (o.id, 'order.cancelled', 'placed', 'cancelled', auth.uid(),
    jsonb_build_object('reason', reason_text, 'not_submitted', true, 'payment_status_at_cancel', 'unpaid', 'refund_required', false, 'promotion_uses_released', released));
  perform public.wayne_write_audit('order.not_submitted', 'orders', o.id::text, 'Order ' || o.order_number || ' not submitted: ' || reason_text,
    jsonb_build_object('status', jsonb_build_object('from', 'placed', 'to', 'cancelled')), jsonb_build_object('order_number', o.order_number));
  return jsonb_build_object('cancelled', true, 'duplicate', false);
end;
$function$;
revoke all on function public.wayne_pos_abandon_order(uuid) from public, anon;
grant execute on function public.wayne_pos_abandon_order(uuid) to authenticated;

drop function public._wayne_patch_function(regprocedure, text, text);
