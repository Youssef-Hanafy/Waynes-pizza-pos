-- Wayne's Pizza POS — Phase 2 only: cart checkout, customers, consent, and test/manual orders.

alter table public.store_settings
  add column pickup_minimum_cents integer not null default 0 check (pickup_minimum_cents >= 0),
  add column delivery_minimum_cents integer not null default 0 check (delivery_minimum_cents >= 0),
  add column delivery_fee_cents integer not null default 0 check (delivery_fee_cents >= 0),
  add column tax_rate_basis_points integer not null default 0 check (tax_rate_basis_points between 0 and 10000),
  add column tips_enabled boolean not null default false,
  add column suggested_tip_percentages smallint[] not null default array[15,20,25]::smallint[],
  add column pickup_prep_minutes integer not null default 25 check (pickup_prep_minutes between 0 and 1440),
  add column delivery_estimate_minutes integer not null default 45 check (delivery_estimate_minutes between 0 and 1440),
  add column delivery_area_text text not null default 'Delivery eligibility is confirmed at checkout.' check (char_length(delivery_area_text) <= 1000),
  add column delivery_postal_codes text[] not null default '{}'::text[],
  add column test_ordering_enabled boolean not null default true;

update public.store_settings
set ordering_instructions = 'Choose pickup or delivery, customize your meal, and place a clearly labeled test/manual order. No card payment is collected.'
where ordering_instructions = 'Choose pickup or delivery to browse the menu. Online checkout arrives in the next approved phase.';

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  first_name text not null check (char_length(first_name) between 1 and 100),
  last_name text not null check (char_length(last_name) between 1 and 100),
  phone_normalized text not null unique check (phone_normalized ~ '^\+1[0-9]{10}$'),
  email_normalized text check (email_normalized is null or char_length(email_normalized) <= 254),
  first_order_at timestamptz,
  last_order_at timestamptz,
  order_count integer not null default 0 check (order_count >= 0),
  lifetime_spend_cents bigint not null default 0 check (lifetime_spend_cents >= 0),
  average_order_value_cents integer not null default 0 check (average_order_value_cents >= 0),
  sms_marketing_opt_in boolean not null default false,
  email_marketing_opt_in boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  label text not null default 'Delivery' check (char_length(label) <= 80),
  address1 text not null check (char_length(address1) between 1 and 200),
  address2 text not null default '' check (char_length(address2) <= 200),
  city text not null check (char_length(city) between 1 and 120),
  state text not null check (char_length(state) between 1 and 80),
  postal_code text not null check (char_length(postal_code) between 1 and 20),
  latitude double precision,
  longitude double precision,
  delivery_instructions text not null default '' check (char_length(delivery_instructions) <= 1000),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.marketing_consents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  channel text not null check (channel in ('sms', 'email')),
  status text not null check (status in ('opted_in', 'opted_out')),
  source text not null check (char_length(source) between 1 and 80),
  consent_text_version text not null check (char_length(consent_text_version) between 1 and 160),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code = upper(code) and code ~ '^[A-Z0-9_-]{2,40}$'),
  description text not null default '' check (char_length(description) <= 500),
  discount_type text not null check (discount_type in ('fixed', 'percent')),
  discount_value integer not null check (discount_value > 0),
  minimum_order_cents integer not null default 0 check (minimum_order_cents >= 0),
  fulfillment_type text check (fulfillment_type is null or fulfillment_type in ('pickup', 'delivery')),
  starts_at timestamptz,
  ends_at timestamptz,
  total_usage_limit integer check (total_usage_limit is null or total_usage_limit > 0),
  uses_count integer not null default 0 check (uses_count >= 0),
  active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check ((discount_type = 'percent' and discount_value <= 10000) or discount_type = 'fixed')
);
create unique index promotions_active_code_idx on public.promotions (code) where archived_at is null;

create sequence public.wayne_order_number_seq start with 1001;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  public_access_token uuid not null default gen_random_uuid() unique,
  order_number text not null unique,
  customer_id uuid references public.customers(id) on delete restrict,
  source text not null check (source in ('online', 'pos', 'phone', 'admin')),
  fulfillment_type text not null check (fulfillment_type in ('pickup', 'delivery')),
  status text not null check (status in ('draft', 'payment_pending', 'placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery', 'completed', 'cancelled')),
  payment_status text not null check (payment_status in ('unpaid', 'authorized', 'paid', 'partially_refunded', 'refunded', 'failed')),
  payment_method text not null check (payment_method in ('test_manual', 'cash', 'card')),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  delivery_fee_cents integer not null default 0 check (delivery_fee_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  tip_cents integer not null default 0 check (tip_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  customer_name_snapshot text not null,
  customer_phone_snapshot text not null,
  customer_email_snapshot text,
  delivery_address_snapshot jsonb,
  special_instructions text not null default '' check (char_length(special_instructions) <= 1500),
  pricing_snapshot jsonb not null check (jsonb_typeof(pricing_snapshot) = 'object'),
  placed_at timestamptz,
  promised_at timestamptz,
  accepted_at timestamptz,
  ready_at timestamptz,
  out_for_delivery_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_by_user_id uuid references public.profiles(id) on delete restrict,
  idempotency_key text not null unique check (char_length(idempotency_key) between 16 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  menu_item_id uuid references public.menu_items(id) on delete restrict,
  variant_id uuid references public.menu_item_variants(id) on delete restrict,
  item_name_snapshot text not null,
  variant_name_snapshot text,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  modifier_unit_total_cents integer not null default 0,
  quantity integer not null check (quantity between 1 and 20),
  line_total_cents integer not null check (line_total_cents >= 0),
  special_instructions text not null default '' check (char_length(special_instructions) <= 500),
  created_at timestamptz not null default now()
);

create table public.order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  modifier_choice_id uuid references public.modifier_choices(id) on delete restrict,
  modifier_group_name_snapshot text not null,
  modifier_name_snapshot text not null,
  price_delta_cents integer not null,
  quantity integer not null check (quantity between 1 and 20),
  created_at timestamptz not null default now()
);

create table public.order_discounts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  promotion_id uuid references public.promotions(id) on delete restrict,
  code_snapshot text not null,
  description_snapshot text not null,
  discount_type_snapshot text not null,
  discount_value_snapshot integer not null,
  amount_cents integer not null check (amount_cents >= 0),
  created_at timestamptz not null default now()
);

create table public.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  event_type text not null check (char_length(event_type) between 1 and 100),
  from_status text,
  to_status text,
  actor_user_id uuid references public.profiles(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create table public.order_idempotency (
  idempotency_key text primary key check (char_length(idempotency_key) between 16 and 160),
  order_id uuid references public.orders(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index customer_addresses_customer_idx on public.customer_addresses(customer_id, created_at desc);
create index marketing_consents_customer_idx on public.marketing_consents(customer_id, occurred_at desc);
create index orders_customer_idx on public.orders(customer_id, created_at desc);
create index orders_placed_idx on public.orders(placed_at desc) where placed_at is not null;
create index order_items_order_idx on public.order_items(order_id);
create index order_item_modifiers_item_idx on public.order_item_modifiers(order_item_id);
create index order_events_order_idx on public.order_events(order_id, created_at);

create trigger customers_set_updated_at before update on public.customers for each row execute function public.set_updated_at();
create trigger customer_addresses_set_updated_at before update on public.customer_addresses for each row execute function public.set_updated_at();
create trigger promotions_set_updated_at before update on public.promotions for each row execute function public.set_updated_at();
create trigger orders_set_updated_at before update on public.orders for each row execute function public.set_updated_at();

alter table public.customers enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.marketing_consents enable row level security;
alter table public.promotions enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_item_modifiers enable row level security;
alter table public.order_discounts enable row level security;
alter table public.order_events enable row level security;
alter table public.order_idempotency enable row level security;

create policy customers_admin_select on public.customers for select to authenticated using (public.wayne_has_permission('admin.access'));
create policy customer_addresses_admin_select on public.customer_addresses for select to authenticated using (public.wayne_has_permission('admin.access'));
create policy marketing_consents_admin_select on public.marketing_consents for select to authenticated using (public.wayne_has_permission('admin.access'));
create policy promotions_admin_all on public.promotions for all to authenticated using (public.wayne_has_permission('settings.manage')) with check (public.wayne_has_permission('settings.manage'));
create policy orders_admin_select on public.orders for select to authenticated using (public.wayne_has_permission('admin.access'));
create policy order_items_admin_select on public.order_items for select to authenticated using (public.wayne_has_permission('admin.access'));
create policy order_item_modifiers_admin_select on public.order_item_modifiers for select to authenticated using (public.wayne_has_permission('admin.access'));
create policy order_discounts_admin_select on public.order_discounts for select to authenticated using (public.wayne_has_permission('admin.access'));
create policy order_events_admin_select on public.order_events for select to authenticated using (public.wayne_has_permission('admin.access'));

create or replace function public.wayne_normalize_phone(raw_phone text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare digits text := regexp_replace(coalesce(raw_phone, ''), '[^0-9]', '', 'g');
begin
  if char_length(digits) = 11 and left(digits, 1) = '1' then digits := substring(digits from 2); end if;
  if char_length(digits) <> 10 then return null; end if;
  return '+1' || digits;
end;
$$;

create or replace function public.wayne_store_is_open(check_at timestamptz default now())
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  settings public.store_settings%rowtype;
  local_moment timestamp;
  day_name text;
  hours jsonb;
  special public.store_special_hours%rowtype;
begin
  select * into settings from public.store_settings where id = true;
  if not settings.ordering_open then return false; end if;
  local_moment := check_at at time zone settings.timezone;
  select * into special from public.store_special_hours where service_date = local_moment::date and archived_at is null limit 1;
  if found then
    if special.closed then return false; end if;
    return local_moment::time >= special.opens_at and local_moment::time < special.closes_at;
  end if;
  day_name := (array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[extract(dow from local_moment)::integer + 1];
  hours := settings.business_hours -> day_name;
  if coalesce((hours ->> 'closed')::boolean, true) then return false; end if;
  return local_moment::time >= (hours ->> 'open')::time and local_moment::time < (hours ->> 'close')::time;
end;
$$;

create or replace function public.wayne_create_test_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings public.store_settings%rowtype;
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  existing_order_id uuid;
  created_order_id uuid;
  order_item_id uuid;
  created_customer_id uuid;
  normalized_phone text;
  normalized_email text;
  customer_name text;
  fulfillment text := payload ->> 'fulfillment_type';
  item_payload jsonb;
  modifier_payload jsonb;
  item_record public.menu_items%rowtype;
  variant_record public.menu_item_variants%rowtype;
  choice_record record;
  group_record record;
  quantity_value integer;
  modifier_quantity integer;
  unit_price integer;
  modifier_total integer;
  line_total integer;
  subtotal integer := 0;
  discount integer := 0;
  delivery_fee integer := 0;
  tax integer := 0;
  tip integer := greatest(coalesce((payload ->> 'tip_cents')::integer, 0), 0);
  total integer;
  promotion_record public.promotions%rowtype;
  address_snapshot jsonb;
  local_moment timestamp;
  current_day integer;
  current_minutes integer;
  start_minutes integer;
  end_minutes integer;
  selection_count integer;
  duplicate_choice_count integer;
begin
  if char_length(request_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;
  insert into public.order_idempotency (idempotency_key) values (request_key) on conflict do nothing;
  select request.order_id into existing_order_id from public.order_idempotency request where request.idempotency_key = request_key for update;
  if existing_order_id is not null then
    return (select jsonb_build_object('id', orders.id, 'public_access_token', orders.public_access_token, 'order_number', orders.order_number, 'total_cents', orders.total_cents, 'duplicate', true) from public.orders where id = existing_order_id);
  end if;

  select * into settings from public.store_settings where id = true;
  if not settings.test_ordering_enabled then raise exception 'Test ordering is disabled' using errcode = 'P0001'; end if;
  if not public.wayne_store_is_open(now()) then raise exception 'Wayne''s Pizza is currently closed for online ordering' using errcode = 'P0001'; end if;
  if fulfillment not in ('pickup', 'delivery') then raise exception 'Choose pickup or delivery' using errcode = '22023'; end if;
  if fulfillment = 'pickup' and not settings.pickup_enabled then raise exception 'Pickup is currently unavailable' using errcode = 'P0001'; end if;
  if fulfillment = 'delivery' and not settings.delivery_enabled then raise exception 'Delivery is currently unavailable' using errcode = 'P0001'; end if;
  if jsonb_typeof(payload -> 'items') <> 'array' or jsonb_array_length(payload -> 'items') = 0 or jsonb_array_length(payload -> 'items') > 50 then raise exception 'Cart must contain between 1 and 50 lines' using errcode = '22023'; end if;

  normalized_phone := public.wayne_normalize_phone(payload ->> 'phone');
  if normalized_phone is null then raise exception 'Enter a valid 10-digit US phone number' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(payload ->> 'first_name', ''))) not between 1 and 100 or char_length(btrim(coalesce(payload ->> 'last_name', ''))) not between 1 and 100 then raise exception 'First and last name are required' using errcode = '22023'; end if;
  normalized_email := nullif(lower(btrim(coalesce(payload ->> 'email', ''))), '');
  if normalized_email is not null and (char_length(normalized_email) > 254 or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
  if coalesce((payload ->> 'email_opt_in')::boolean, false) and normalized_email is null then raise exception 'An email address is required for email deals' using errcode = '22023'; end if;
  customer_name := btrim(payload ->> 'first_name') || ' ' || btrim(payload ->> 'last_name');

  if fulfillment = 'delivery' then
    if char_length(btrim(coalesce(payload #>> '{address,address1}', ''))) = 0 or char_length(btrim(coalesce(payload #>> '{address,city}', ''))) = 0 or char_length(btrim(coalesce(payload #>> '{address,state}', ''))) = 0 or char_length(btrim(coalesce(payload #>> '{address,postal_code}', ''))) = 0 then raise exception 'A complete delivery address is required' using errcode = '22023'; end if;
    address_snapshot := jsonb_build_object(
      'address1', btrim(payload #>> '{address,address1}'), 'address2', btrim(coalesce(payload #>> '{address,address2}', '')),
      'city', btrim(payload #>> '{address,city}'), 'state', upper(btrim(payload #>> '{address,state}')),
      'postal_code', btrim(payload #>> '{address,postal_code}'), 'delivery_instructions', btrim(coalesce(payload #>> '{address,delivery_instructions}', ''))
    );
    if cardinality(settings.delivery_postal_codes) > 0 and not ((address_snapshot ->> 'postal_code') = any(settings.delivery_postal_codes)) then raise exception 'That address is outside the configured delivery area' using errcode = 'P0001'; end if;
  end if;

  local_moment := now() at time zone settings.timezone;
  current_day := extract(dow from local_moment)::integer;
  current_minutes := extract(hour from local_moment)::integer * 60 + extract(minute from local_moment)::integer;

  for item_payload in select value from jsonb_array_elements(payload -> 'items') loop
    quantity_value := coalesce((item_payload ->> 'quantity')::integer, 0);
    if quantity_value not between 1 and 20 then raise exception 'Each cart quantity must be between 1 and 20' using errcode = '22023'; end if;
    select item.* into item_record from public.menu_items item join public.menu_categories category on category.id = item.category_id where item.id = (item_payload ->> 'menu_item_id')::uuid and item.customer_visible and item.archived_at is null and not item.sold_out and category.customer_visible and category.archived_at is null;
    if not found then raise exception 'A cart item is unavailable' using errcode = 'P0001'; end if;

    if item_record.available_start is null then
      if not (current_day = any(item_record.available_days)) then raise exception '% is unavailable right now', item_record.name using errcode = 'P0001'; end if;
    else
      start_minutes := extract(hour from item_record.available_start)::integer * 60 + extract(minute from item_record.available_start)::integer;
      end_minutes := extract(hour from item_record.available_end)::integer * 60 + extract(minute from item_record.available_end)::integer;
      if start_minutes <= end_minutes then
        if not (current_day = any(item_record.available_days) and current_minutes >= start_minutes and current_minutes < end_minutes) then raise exception '% is unavailable right now', item_record.name using errcode = 'P0001'; end if;
      elsif not ((current_minutes >= start_minutes and current_day = any(item_record.available_days)) or (current_minutes < end_minutes and ((current_day + 6) % 7) = any(item_record.available_days))) then
        raise exception '% is unavailable right now', item_record.name using errcode = 'P0001';
      end if;
    end if;

    if exists (select 1 from public.menu_item_variants variant where variant.menu_item_id = item_record.id and variant.active and variant.archived_at is null) then
      if nullif(item_payload ->> 'variant_id', '') is null then raise exception 'Choose a variant for %', item_record.name using errcode = '22023'; end if;
      select * into variant_record from public.menu_item_variants where id = (item_payload ->> 'variant_id')::uuid and menu_item_id = item_record.id and active and archived_at is null;
      if not found then raise exception 'A selected variant is unavailable' using errcode = 'P0001'; end if;
      unit_price := variant_record.price_cents;
    else
      if nullif(item_payload ->> 'variant_id', '') is not null then raise exception 'Invalid variant selection' using errcode = '22023'; end if;
      variant_record := null;
      unit_price := item_record.base_price_cents;
    end if;

    if jsonb_typeof(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) <> 'array' then raise exception 'Invalid modifier selections' using errcode = '22023'; end if;
    select count(*) - count(distinct value ->> 'choice_id') into duplicate_choice_count from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb));
    if duplicate_choice_count > 0 then raise exception 'Duplicate modifier choices are not allowed' using errcode = '22023'; end if;
    modifier_total := 0;
    for modifier_payload in select value from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) loop
      modifier_quantity := coalesce((modifier_payload ->> 'quantity')::integer, 0);
      select choice.id, choice.name, choice.price_delta_cents, modifier_group.id as group_id, modifier_group.name as group_name, modifier_group.allow_quantities
      into choice_record
      from public.modifier_choices choice
      join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id
      join public.menu_item_modifier_groups link on link.modifier_group_id = modifier_group.id
      where choice.id = (modifier_payload ->> 'choice_id')::uuid and link.menu_item_id = item_record.id and link.active and choice.active and choice.archived_at is null and modifier_group.active and modifier_group.archived_at is null;
      if not found then raise exception 'A selected modifier is unavailable' using errcode = 'P0001'; end if;
      if modifier_quantity not between 1 and 20 or (not choice_record.allow_quantities and modifier_quantity <> 1) then raise exception 'Invalid modifier quantity' using errcode = '22023'; end if;
      modifier_total := modifier_total + choice_record.price_delta_cents * modifier_quantity;
    end loop;

    for group_record in select modifier_group.* from public.menu_item_modifier_groups link join public.modifier_groups modifier_group on modifier_group.id = link.modifier_group_id where link.menu_item_id = item_record.id and link.active and modifier_group.active and modifier_group.archived_at is null loop
      select coalesce(sum(case when group_record.allow_quantities then (selected.value ->> 'quantity')::integer else 1 end), 0)::integer into selection_count
      from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) selected
      join public.modifier_choices choice on choice.id = (selected.value ->> 'choice_id')::uuid
      where choice.modifier_group_id = group_record.id;
      if selection_count < group_record.min_select or selection_count > group_record.max_select or (group_record.required and selection_count = 0) then raise exception 'Invalid selections for %', group_record.customer_label using errcode = '22023'; end if;
    end loop;

    line_total := (unit_price + modifier_total) * quantity_value;
    if line_total < 0 then raise exception 'Item price cannot be negative' using errcode = '22023'; end if;
    subtotal := subtotal + line_total;
  end loop;

  if fulfillment = 'pickup' and subtotal < settings.pickup_minimum_cents then raise exception 'Pickup order minimum is not met' using errcode = 'P0001'; end if;
  if fulfillment = 'delivery' and subtotal < settings.delivery_minimum_cents then raise exception 'Delivery order minimum is not met' using errcode = 'P0001'; end if;
  if fulfillment = 'delivery' then delivery_fee := settings.delivery_fee_cents; end if;

  if nullif(upper(btrim(coalesce(payload ->> 'promo_code', ''))), '') is not null then
    select * into promotion_record from public.promotions where code = upper(btrim(payload ->> 'promo_code')) and active and archived_at is null and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()) and (fulfillment_type is null or fulfillment_type = fulfillment) and minimum_order_cents <= subtotal and (total_usage_limit is null or uses_count < total_usage_limit) for update;
    if not found then raise exception 'Promotion code is invalid or unavailable' using errcode = 'P0001'; end if;
    discount := case when promotion_record.discount_type = 'fixed' then least(subtotal, promotion_record.discount_value) else least(subtotal, ((subtotal::bigint * promotion_record.discount_value + 5000) / 10000)::integer) end;
  end if;
  if not settings.tips_enabled then tip := 0; end if;
  if tip > subtotal then raise exception 'Tip amount is too high' using errcode = '22023'; end if;
  tax := (((subtotal - discount + delivery_fee)::bigint * settings.tax_rate_basis_points + 5000) / 10000)::integer;
  total := subtotal - discount + delivery_fee + tax + tip;

  select id into created_customer_id from public.customers where phone_normalized = normalized_phone for update;
  if created_customer_id is null then
    insert into public.customers (first_name, last_name, phone_normalized, email_normalized, sms_marketing_opt_in, email_marketing_opt_in)
    values (btrim(payload ->> 'first_name'), btrim(payload ->> 'last_name'), normalized_phone, normalized_email, coalesce((payload ->> 'sms_opt_in')::boolean, false), coalesce((payload ->> 'email_opt_in')::boolean, false)) returning id into created_customer_id;
  else
    update public.customers set first_name = btrim(payload ->> 'first_name'), last_name = btrim(payload ->> 'last_name'), email_normalized = coalesce(normalized_email, email_normalized), sms_marketing_opt_in = sms_marketing_opt_in or coalesce((payload ->> 'sms_opt_in')::boolean, false), email_marketing_opt_in = email_marketing_opt_in or coalesce((payload ->> 'email_opt_in')::boolean, false) where id = created_customer_id;
  end if;

  if fulfillment = 'delivery' then
    update public.customer_addresses set is_default = false where customer_id = created_customer_id and is_default;
    insert into public.customer_addresses (customer_id, address1, address2, city, state, postal_code, delivery_instructions, is_default)
    values (created_customer_id, address_snapshot ->> 'address1', address_snapshot ->> 'address2', address_snapshot ->> 'city', address_snapshot ->> 'state', address_snapshot ->> 'postal_code', address_snapshot ->> 'delivery_instructions', true);
  end if;
  if coalesce((payload ->> 'sms_opt_in')::boolean, false) then
    insert into public.marketing_consents (customer_id, channel, status, source, consent_text_version, metadata)
    values (created_customer_id, 'sms', 'opted_in', 'online_checkout', 'wayne-checkout-v1', jsonb_build_object('order_idempotency_key', request_key));
  end if;
  if coalesce((payload ->> 'email_opt_in')::boolean, false) then
    insert into public.marketing_consents (customer_id, channel, status, source, consent_text_version, metadata)
    values (created_customer_id, 'email', 'opted_in', 'online_checkout', 'wayne-checkout-v1', jsonb_build_object('order_idempotency_key', request_key));
  end if;

  insert into public.orders (order_number, customer_id, source, fulfillment_type, status, payment_status, payment_method, subtotal_cents, discount_cents, delivery_fee_cents, tax_cents, tip_cents, total_cents, customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, delivery_address_snapshot, special_instructions, pricing_snapshot, placed_at, promised_at, idempotency_key)
  values ('W' || lpad(nextval('public.wayne_order_number_seq')::text, 6, '0'), created_customer_id, 'online', fulfillment, 'placed', 'unpaid', 'test_manual', subtotal, discount, delivery_fee, tax, tip, total, customer_name, normalized_phone, normalized_email, address_snapshot, btrim(coalesce(payload ->> 'special_instructions', '')), jsonb_build_object('tax_rate_basis_points', settings.tax_rate_basis_points, 'pickup_minimum_cents', settings.pickup_minimum_cents, 'delivery_minimum_cents', settings.delivery_minimum_cents, 'delivery_fee_cents', settings.delivery_fee_cents, 'payment_mode', 'TEST / MANUAL'), now(), now() + make_interval(mins => case when fulfillment = 'delivery' then settings.delivery_estimate_minutes else settings.pickup_prep_minutes end), request_key)
  returning id into created_order_id;

  for item_payload in select value from jsonb_array_elements(payload -> 'items') loop
    quantity_value := (item_payload ->> 'quantity')::integer;
    select * into item_record from public.menu_items where id = (item_payload ->> 'menu_item_id')::uuid;
    if nullif(item_payload ->> 'variant_id', '') is not null then select * into variant_record from public.menu_item_variants where id = (item_payload ->> 'variant_id')::uuid; unit_price := variant_record.price_cents; else variant_record := null; unit_price := item_record.base_price_cents; end if;
    modifier_total := 0;
    for modifier_payload in select value from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) loop
      select choice.id, choice.name, choice.price_delta_cents, modifier_group.name as group_name into choice_record from public.modifier_choices choice join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id where choice.id = (modifier_payload ->> 'choice_id')::uuid;
      modifier_total := modifier_total + choice_record.price_delta_cents * (modifier_payload ->> 'quantity')::integer;
    end loop;
    line_total := (unit_price + modifier_total) * quantity_value;
    insert into public.order_items (order_id, menu_item_id, variant_id, item_name_snapshot, variant_name_snapshot, unit_price_cents, modifier_unit_total_cents, quantity, line_total_cents, special_instructions)
    values (created_order_id, item_record.id, variant_record.id, item_record.name, variant_record.name, unit_price, modifier_total, quantity_value, line_total, btrim(coalesce(item_payload ->> 'special_instructions', ''))) returning id into order_item_id;
    for modifier_payload in select value from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) loop
      select choice.id, choice.name, choice.price_delta_cents, modifier_group.name as group_name into choice_record from public.modifier_choices choice join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id where choice.id = (modifier_payload ->> 'choice_id')::uuid;
      insert into public.order_item_modifiers (order_item_id, modifier_choice_id, modifier_group_name_snapshot, modifier_name_snapshot, price_delta_cents, quantity)
      values (order_item_id, choice_record.id, choice_record.group_name, choice_record.name, choice_record.price_delta_cents, (modifier_payload ->> 'quantity')::integer);
    end loop;
  end loop;

  if promotion_record.id is not null then
    update public.promotions set uses_count = uses_count + 1 where id = promotion_record.id;
    insert into public.order_discounts (order_id, promotion_id, code_snapshot, description_snapshot, discount_type_snapshot, discount_value_snapshot, amount_cents) values (created_order_id, promotion_record.id, promotion_record.code, promotion_record.description, promotion_record.discount_type, promotion_record.discount_value, discount);
  end if;
  insert into public.order_events (order_id, event_type, to_status, metadata) values (created_order_id, 'order.placed', 'placed', jsonb_build_object('source', 'online', 'payment_mode', 'TEST / MANUAL'));
  update public.order_idempotency set order_id = created_order_id where idempotency_key = request_key;
  return (select jsonb_build_object('id', orders.id, 'public_access_token', orders.public_access_token, 'order_number', orders.order_number, 'total_cents', orders.total_cents, 'duplicate', false) from public.orders where id = created_order_id);
end;
$$;

create or replace function public.wayne_public_order_status(target_order_id uuid, access_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', order_row.id, 'order_number', order_row.order_number, 'fulfillment_type', order_row.fulfillment_type,
    'status', order_row.status, 'payment_status', order_row.payment_status, 'payment_method', order_row.payment_method,
    'subtotal_cents', order_row.subtotal_cents, 'discount_cents', order_row.discount_cents,
    'delivery_fee_cents', order_row.delivery_fee_cents, 'tax_cents', order_row.tax_cents,
    'tip_cents', order_row.tip_cents, 'total_cents', order_row.total_cents,
    'customer_name', order_row.customer_name_snapshot, 'customer_phone', order_row.customer_phone_snapshot,
    'customer_email', order_row.customer_email_snapshot, 'delivery_address', order_row.delivery_address_snapshot,
    'special_instructions', order_row.special_instructions, 'placed_at', order_row.placed_at, 'promised_at', order_row.promised_at,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', item.id, 'name', item.item_name_snapshot, 'variant_name', item.variant_name_snapshot,
      'unit_price_cents', item.unit_price_cents, 'modifier_unit_total_cents', item.modifier_unit_total_cents,
      'quantity', item.quantity, 'line_total_cents', item.line_total_cents, 'special_instructions', item.special_instructions,
      'modifiers', coalesce((select jsonb_agg(jsonb_build_object('group_name', modifier.modifier_group_name_snapshot, 'name', modifier.modifier_name_snapshot, 'price_delta_cents', modifier.price_delta_cents, 'quantity', modifier.quantity) order by modifier.created_at) from public.order_item_modifiers modifier where modifier.order_item_id = item.id), '[]'::jsonb)
    ) order by item.created_at) from public.order_items item where item.order_id = order_row.id), '[]'::jsonb)
  ) from public.orders order_row where order_row.id = target_order_id and order_row.public_access_token = access_token;
$$;

revoke all on public.customers, public.customer_addresses, public.marketing_consents, public.promotions, public.orders, public.order_items, public.order_item_modifiers, public.order_discounts, public.order_events, public.order_idempotency from anon, authenticated;
grant select on public.customers, public.customer_addresses, public.marketing_consents, public.promotions, public.orders, public.order_items, public.order_item_modifiers, public.order_discounts, public.order_events to authenticated;
grant insert, update on public.promotions to authenticated;

revoke all on function public.wayne_normalize_phone(text) from public;
revoke all on function public.wayne_store_is_open(timestamptz) from public;
revoke all on function public.wayne_create_test_order(jsonb) from public;
revoke all on function public.wayne_public_order_status(uuid, uuid) from public;
grant execute on function public.wayne_create_test_order(jsonb) to anon, authenticated;
grant execute on function public.wayne_public_order_status(uuid, uuid) to anon, authenticated;

comment on table public.orders is 'Canonical permanent orders. Phase 2 uses TEST / MANUAL payment only; rows and snapshots are never hard-deleted.';
comment on function public.wayne_create_test_order(jsonb) is 'Idempotent, server-authoritative Phase 2 test/manual checkout transaction.';
