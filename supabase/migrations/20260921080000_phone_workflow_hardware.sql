-- Wayne's Pizza POS — phone-line build, Phases 2–5.
--
--   * phone_calls becomes the build sheet's "caller events" table (§15): each
--     ring gets a status, a claim (who is taking it, on which register), a
--     dedupe key and a link to the order it turned into.  One table, not two.
--   * customers can carry more than one phone number (§14), which is what makes
--     the ">1 match → choose the customer" screen (§33) possible.
--   * orders remember the phone line and the call they came from (§11).
--   * pos_hardware_settings holds the store's hardware configuration (§28).
--   * the POS learns about new rings through Supabase Realtime instead of
--     polling (§20, rule 17).

-- ---------------------------------------------------------------------------
-- 0. Permission: hardware settings are an owner job (§27).
-- ---------------------------------------------------------------------------
insert into public.permissions (id, code, description) values
  ('20000000-0000-4000-8000-000000000027', 'hardware.manage', 'Configure caller ID, printers, cash drawer and payment terminal')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
  from public.roles role
  join public.permissions permission on permission.code = 'hardware.manage'
 where role.code = 'owner'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 1. Additional customer phone numbers.
--    A household landline can belong to more than one customer, so the number
--    is deliberately NOT unique here (the primary number on customers still is).
-- ---------------------------------------------------------------------------
create table if not exists public.customer_phones (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  phone_normalized text not null check (phone_normalized ~ '^\+1[0-9]{10}$'),
  label text not null default '' check (char_length(label) <= 40),
  created_at timestamptz not null default now(),
  unique (customer_id, phone_normalized)
);
create index if not exists customer_phones_phone_idx on public.customer_phones (phone_normalized);

alter table public.customer_phones enable row level security;
revoke all on table public.customer_phones from anon, authenticated;
drop policy if exists customer_phones_admin_select on public.customer_phones;
create policy customer_phones_admin_select on public.customer_phones for select to authenticated
  using (public.wayne_has_permission('admin.access'));
grant select on table public.customer_phones to authenticated;

comment on table public.customer_phones is
  'Extra numbers a customer calls from. Caller ID matches the primary number on customers or any number here.';

-- Every customer a normalized number belongs to, most recent regular first.
create or replace function public.wayne_phone_matches(normalized text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select customer.id
    from public.customers customer
   where normalized is not null
     and customer.removed_at is null
     and (customer.phone_normalized = normalized
          or exists (select 1 from public.customer_phones extra
                      where extra.customer_id = customer.id and extra.phone_normalized = normalized))
   order by customer.last_order_at desc nulls last, customer.created_at
   limit 10;
$$;
revoke all on function public.wayne_phone_matches(text) from public, anon, authenticated;

-- The customer as every POS screen draws it: identity, numbers, addresses and
-- the order history numbers the phone detail card shows (§8).
create or replace function public.wayne_pos_customer_json(target_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', customer.id, 'first_name', customer.first_name, 'last_name', customer.last_name,
    'phone', customer.phone_normalized, 'email', customer.email_normalized,
    'first_order_at', customer.first_order_at, 'last_order_at', customer.last_order_at,
    'order_count', customer.order_count, 'lifetime_spend_cents', customer.lifetime_spend_cents,
    'average_order_value_cents', customer.average_order_value_cents,
    'notes', customer.notes,
    'phones', coalesce((select jsonb_agg(jsonb_build_object('phone', extra.phone_normalized, 'label', extra.label) order by extra.created_at)
                          from public.customer_phones extra where extra.customer_id = customer.id), '[]'::jsonb),
    'addresses', coalesce((select jsonb_agg(to_jsonb(address) - 'customer_id' - 'latitude' - 'longitude' order by address.is_default desc, address.updated_at desc)
                             from public.customer_addresses address where address.customer_id = customer.id), '[]'::jsonb)
  )
  from public.customers customer
  where customer.id = target_customer_id;
$$;
revoke all on function public.wayne_pos_customer_json(uuid) from public, anon, authenticated;

-- POS customer search (§14: phone, name, address, email, customer ID): now also
-- searches extra numbers and street addresses, and no longer returns
-- erased customers (the admin list was fixed in hide_removed_customers; the
-- POS search was missed).
create or replace function public.wayne_pos_customer_search(search_text text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := btrim(coalesce(search_text, ''));
  phone_search text := regexp_replace(coalesce(search_text, ''), '[^0-9]', '', 'g');
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if char_length(normalized_search) < 2 then return '[]'::jsonb; end if;
  if char_length(phone_search) = 11 and left(phone_search, 1) = '1' then phone_search := substring(phone_search from 2); end if;
  return coalesce((
    select jsonb_agg(public.wayne_pos_customer_json(matches.id) order by matches.last_order_at desc nulls last, matches.display_name)
      from (
        select customer.id, customer.last_order_at, customer.first_name || ' ' || customer.last_name display_name
          from public.customers customer
         where customer.removed_at is null
           and (customer.first_name || ' ' || customer.last_name ilike '%' || normalized_search || '%'
             or (char_length(phone_search) >= 3 and (customer.phone_normalized like '%' || phone_search || '%'
                   or exists (select 1 from public.customer_phones extra where extra.customer_id = customer.id and extra.phone_normalized like '%' || phone_search || '%')))
             or (customer.email_normalized is not null and customer.email_normalized ilike '%' || normalized_search || '%')
             or (char_length(normalized_search) >= 3 and exists (select 1 from public.customer_addresses address
                   where address.customer_id = customer.id and address.address1 ilike '%' || normalized_search || '%'))
             or customer.id::text = normalized_search
             or exists (select 1 from public.orders order_row where order_row.customer_id = customer.id and order_row.order_number ilike '%' || normalized_search || '%'))
         order by customer.last_order_at desc nulls last
         limit 20
      ) matches
  ), '[]'::jsonb);
end;
$$;

-- A customer's recent orders, for the POS customer screen and phone detail.
create or replace function public.wayne_pos_customer_orders(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(entry order by placed desc)
      from (
        select order_row.placed_at placed, jsonb_build_object(
          'id', order_row.id, 'order_number', order_row.order_number, 'placed_at', order_row.placed_at,
          'status', order_row.status, 'source', order_row.source, 'fulfillment_type', order_row.fulfillment_type,
          'total_cents', order_row.total_cents, 'phone_line', order_row.phone_line,
          'items', coalesce((select string_agg(item.quantity || '× ' || item.item_name_snapshot
                                               || coalesce(' (' || nullif(item.variant_name_snapshot, '') || ')', ''), ', ' order by item.created_at)
                               from public.order_items item where item.order_id = order_row.id), '')
        ) entry
          from public.orders order_row
         where order_row.customer_id = target_customer_id
           and order_row.placed_at is not null
         order by order_row.placed_at desc
         limit 15
      ) recent
  ), '[]'::jsonb);
end;
$$;

-- Create or update a customer from the POS (§14, §8 "Create customer + start order").
-- Caller ID alone never creates a customer (§33): this only runs when a person
-- presses the button with a name typed in.
create or replace function public.wayne_pos_save_customer(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_id uuid := nullif(payload ->> 'customer_id', '')::uuid;
  first_value text := btrim(coalesce(payload ->> 'first_name', ''));
  last_value text := btrim(coalesce(payload ->> 'last_name', ''));
  phone_value text := public.wayne_normalize_phone(payload ->> 'phone');
  email_value text := nullif(lower(btrim(coalesce(payload ->> 'email', ''))), '');
  extra_value text := public.wayne_normalize_phone(payload ->> 'extra_phone');
  owner_id uuid;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if char_length(first_value) not between 1 and 100 or char_length(last_value) not between 1 and 100 then
    raise exception 'First and last name are required' using errcode = '22023';
  end if;
  if phone_value is null then raise exception 'Enter a valid 10-digit US phone number' using errcode = '22023'; end if;
  if email_value is not null and (char_length(email_value) > 254 or email_value !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;

  select id into owner_id from public.customers where phone_normalized = phone_value;
  if target_id is null then
    if owner_id is not null then
      raise exception 'A customer with that phone number already exists' using errcode = '23505';
    end if;
    insert into public.customers (first_name, last_name, phone_normalized, email_normalized)
    values (first_value, last_value, phone_value, email_value)
    returning id into target_id;
  else
    if not exists (select 1 from public.customers where id = target_id and removed_at is null) then
      raise exception 'That customer was not found' using errcode = 'P0002';
    end if;
    if owner_id is not null and owner_id <> target_id then
      raise exception 'A customer with that phone number already exists' using errcode = '23505';
    end if;
    update public.customers
       set first_name = first_value, last_name = last_value, phone_normalized = phone_value,
           email_normalized = coalesce(email_value, email_normalized), updated_at = now()
     where id = target_id;
  end if;

  if extra_value is not null and extra_value <> phone_value then
    insert into public.customer_phones (customer_id, phone_normalized, label)
    values (target_id, extra_value, left(btrim(coalesce(payload ->> 'extra_phone_label', '')), 40))
    on conflict (customer_id, phone_normalized) do nothing;
  end if;

  if nullif(btrim(coalesce(payload #>> '{address,address1}', '')), '') is not null then
    if char_length(btrim(coalesce(payload #>> '{address,city}', ''))) = 0
       or char_length(btrim(coalesce(payload #>> '{address,state}', ''))) = 0
       or char_length(btrim(coalesce(payload #>> '{address,postal_code}', ''))) = 0 then
      raise exception 'A complete delivery address is required' using errcode = '22023';
    end if;
    insert into public.customer_addresses (customer_id, address1, address2, city, state, postal_code, delivery_instructions, is_default)
    values (target_id,
      left(btrim(payload #>> '{address,address1}'), 200),
      left(btrim(coalesce(payload #>> '{address,address2}', '')), 200),
      left(btrim(payload #>> '{address,city}'), 120),
      upper(left(btrim(payload #>> '{address,state}'), 80)),
      left(btrim(payload #>> '{address,postal_code}'), 20),
      left(btrim(coalesce(payload #>> '{address,delivery_instructions}', '')), 1000),
      not exists (select 1 from public.customer_addresses where customer_id = target_id));
  end if;

  return public.wayne_pos_customer_json(target_id);
end;
$$;

revoke all on function public.wayne_pos_customer_orders(uuid) from public, anon;
revoke all on function public.wayne_pos_save_customer(jsonb) from public, anon;
grant execute on function public.wayne_pos_customer_orders(uuid) to authenticated;
grant execute on function public.wayne_pos_save_customer(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Hardware settings (§28, §50, §64).  One row.  Nothing here is a secret:
--    listening to local UDP needs no credential (§50).
-- ---------------------------------------------------------------------------
create table if not exists public.pos_hardware_settings (
  id boolean primary key default true check (id),
  caller_id_provider text not null default 'simulated' check (caller_id_provider in ('simulated', 'cloud', 'android_native')),
  caller_device_model text not null default 'CallerID.com Whozz Calling? Basic POS 2 Ethernet' check (char_length(caller_device_model) <= 120),
  caller_line_count smallint not null default 2 check (caller_line_count between 1 and 8),
  caller_udp_port integer not null default 3520 check (caller_udp_port between 1 and 65535),
  caller_bind_address text not null default '0.0.0.0' check (char_length(caller_bind_address) <= 64),
  caller_device_ip text not null default '' check (char_length(caller_device_ip) <= 64),
  call_expire_minutes integer not null default 10 check (call_expire_minutes between 1 and 240),
  simulator_enabled boolean not null default true,
  receipt_printer jsonb not null default '{}'::jsonb check (jsonb_typeof(receipt_printer) = 'object'),
  kitchen_printers jsonb not null default '[]'::jsonb check (jsonb_typeof(kitchen_printers) = 'array'),
  cash_drawer jsonb not null default '{}'::jsonb check (jsonb_typeof(cash_drawer) = 'object'),
  payment_terminal_mode text not null default 'manual_external' check (payment_terminal_mode in ('manual_external', 'integrated')),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.pos_hardware_settings (id) values (true) on conflict (id) do nothing;

alter table public.pos_hardware_settings enable row level security;
revoke all on table public.pos_hardware_settings from anon, authenticated;

create or replace function public.wayne_pos_hardware_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.wayne_has_permission('pos.access') or public.wayne_has_permission('hardware.manage')) then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  return (select to_jsonb(settings) - 'id' - 'updated_by' from public.pos_hardware_settings settings where id);
end;
$$;

create or replace function public.wayne_update_hardware_settings(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_row jsonb;
  after_row jsonb;
begin
  if not public.wayne_has_permission('hardware.manage') then
    raise exception 'Hardware settings need the owner' using errcode = '42501';
  end if;
  select to_jsonb(settings) into before_row from public.pos_hardware_settings settings where id;
  update public.pos_hardware_settings set
    caller_id_provider = coalesce(payload ->> 'caller_id_provider', caller_id_provider),
    caller_device_model = coalesce(left(btrim(payload ->> 'caller_device_model'), 120), caller_device_model),
    caller_line_count = coalesce((payload ->> 'caller_line_count')::smallint, caller_line_count),
    caller_udp_port = coalesce((payload ->> 'caller_udp_port')::integer, caller_udp_port),
    caller_bind_address = coalesce(left(btrim(payload ->> 'caller_bind_address'), 64), caller_bind_address),
    caller_device_ip = coalesce(left(btrim(payload ->> 'caller_device_ip'), 64), caller_device_ip),
    call_expire_minutes = coalesce((payload ->> 'call_expire_minutes')::integer, call_expire_minutes),
    simulator_enabled = coalesce((payload ->> 'simulator_enabled')::boolean, simulator_enabled),
    receipt_printer = coalesce(payload -> 'receipt_printer', receipt_printer),
    kitchen_printers = coalesce(payload -> 'kitchen_printers', kitchen_printers),
    cash_drawer = coalesce(payload -> 'cash_drawer', cash_drawer),
    payment_terminal_mode = coalesce(payload ->> 'payment_terminal_mode', payment_terminal_mode),
    updated_at = now(),
    updated_by = auth.uid()
  where id;
  -- Phone lines follow the configured count, so the POS always shows exactly
  -- the lines that are wired into the box.
  if payload ? 'caller_line_count' then
    insert into public.store_phone_lines (line_number, label)
    select series, 'Line ' || series from generate_series(1, (payload ->> 'caller_line_count')::integer) series
    on conflict (line_number) do nothing;
    update public.store_phone_lines
       set active = line_number <= (payload ->> 'caller_line_count')::integer, updated_at = now();
  end if;
  select to_jsonb(settings) into after_row from public.pos_hardware_settings settings where id;
  perform public.wayne_write_audit('hardware.settings_updated', 'pos_hardware_settings', 'store',
    'Hardware settings changed', jsonb_build_object('before', before_row - 'updated_at' - 'updated_by', 'after', after_row - 'updated_at' - 'updated_by'));
  return after_row - 'id' - 'updated_by';
end;
$$;

revoke all on function public.wayne_pos_hardware_settings() from public, anon;
revoke all on function public.wayne_update_hardware_settings(jsonb) from public, anon;
grant execute on function public.wayne_pos_hardware_settings() to authenticated;
grant execute on function public.wayne_update_hardware_settings(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. phone_calls becomes the caller-event table (§15).
-- ---------------------------------------------------------------------------
alter table public.phone_calls
  add column if not exists event_key text,
  add column if not exists device_id text not null default '' check (char_length(device_id) <= 80),
  add column if not exists status text not null default 'incoming'
    check (status in ('incoming', 'selected', 'order_started', 'dismissed', 'expired', 'completed')),
  add column if not exists simulated boolean not null default false,
  add column if not exists match_count integer not null default 0 check (match_count >= 0),
  add column if not exists selected_at timestamptz,
  add column if not exists dismissed_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists claimed_by uuid references public.profiles(id) on delete set null,
  add column if not exists claimed_terminal text not null default '' check (char_length(claimed_terminal) <= 60),
  add column if not exists claimed_at timestamptz,
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now(),
  -- When the call last became live on its line: the ring itself, or a reopen
  -- from recent calls.  Expiry and "newest on the line" are measured from here.
  add column if not exists surfaced_at timestamptz;

update public.phone_calls set event_key = id::text where event_key is null;
update public.phone_calls set surfaced_at = started_at where surfaced_at is null;
alter table public.phone_calls alter column surfaced_at set default now();
alter table public.phone_calls alter column surfaced_at set not null;
alter table public.phone_calls alter column event_key set default gen_random_uuid()::text;
alter table public.phone_calls alter column event_key set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'phone_calls_event_key_check') then
    alter table public.phone_calls add constraint phone_calls_event_key_check check (char_length(event_key) between 1 and 120);
  end if;
end $$;
create unique index if not exists phone_calls_event_key_idx on public.phone_calls (event_key);
create index if not exists phone_calls_status_idx on public.phone_calls (status, started_at desc);
create index if not exists phone_calls_number_idx on public.phone_calls (caller_number, started_at desc);
create index if not exists phone_calls_order_idx on public.phone_calls (order_id) where order_id is not null;

-- Staff with POS access may read calls, which is what lets Supabase Realtime
-- tell every register that a line rang (§20, §22) instead of each one polling.
-- The anon key still sees nothing.
grant select on table public.phone_calls to authenticated;
drop policy if exists phone_calls_pos_read on public.phone_calls;
create policy phone_calls_pos_read on public.phone_calls for select to authenticated
  using (public.wayne_has_permission('pos.access'));

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'phone_calls') then
    alter publication supabase_realtime add table public.phone_calls;
  end if;
end $$;

-- orders ← the line and the call they came from (§11).
alter table public.orders
  add column if not exists phone_line smallint check (phone_line is null or phone_line between 1 and 8),
  add column if not exists phone_call_id uuid references public.phone_calls(id) on delete set null;
create index if not exists orders_phone_call_idx on public.orders (phone_call_id) where phone_call_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Recording a ring (hardware bridge and in-store providers share one path).
-- ---------------------------------------------------------------------------
create or replace function public.wayne_phone_call_json(target_call_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', call_row.id,
    'event_key', call_row.event_key,
    'line_number', call_row.line_number,
    'device_id', call_row.device_id,
    'caller_number', call_row.caller_number,
    'caller_number_raw', call_row.caller_number_raw,
    'caller_name', call_row.caller_name,
    'started_at', call_row.started_at,
    'surfaced_at', call_row.surfaced_at,
    'ended_at', call_row.ended_at,
    'status', call_row.status,
    'simulated', call_row.simulated,
    'customer_id', call_row.customer_id,
    'claimed_by_id', call_row.claimed_by,
    'claimed_by_name', claimer.display_name,
    'claimed_terminal', call_row.claimed_terminal,
    'claimed_at', call_row.claimed_at,
    'order_id', call_row.order_id,
    'order_number', order_row.order_number,
    'matches', coalesce((select jsonb_agg(public.wayne_pos_customer_json(match_id))
                           from public.wayne_phone_matches(call_row.caller_number) match_id), '[]'::jsonb)
  )
  from public.phone_calls call_row
  left join public.profiles claimer on claimer.id = call_row.claimed_by
  left join public.orders order_row on order_row.id = call_row.order_id
  where call_row.id = target_call_id;
$$;
revoke all on function public.wayne_phone_call_json(uuid) from public, anon, authenticated;

create or replace function public.wayne_record_phone_call(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  line smallint := coalesce((payload ->> 'line_number')::smallint, 1);
  raw_number text := btrim(coalesce(payload ->> 'caller_number', ''));
  normalized text := public.wayne_normalize_phone(raw_number);
  event_kind text := coalesce(nullif(btrim(payload ->> 'event'), ''), 'start');
  occurred timestamptz := coalesce((payload ->> 'occurred_at')::timestamptz, now());
  key_value text := nullif(left(btrim(coalesce(payload ->> 'event_key', '')), 120), '');
  device_value text := left(btrim(coalesce(payload ->> 'device_id', payload ->> 'unit_number', '')), 80);
  direction_value text := case when coalesce(payload ->> 'direction', 'inbound') = 'outbound' then 'outbound' else 'inbound' end;
  matched_ids uuid[];
  call_row public.phone_calls;
begin
  if line < 1 or line > 8 then
    raise exception 'Unknown phone line %', line using errcode = '22023';
  end if;

  -- "End of call" closes the ring that is already open on that line rather than
  -- opening a second one, so the POS never shows the same call twice.  The card
  -- itself stays: an order is often still being keyed after the caller hangs up.
  if event_kind = 'end' then
    update public.phone_calls
       set ended_at = occurred, updated_at = now()
     where id = (
       select id from public.phone_calls
        where line_number = line and ended_at is null
        order by started_at desc limit 1
     )
    returning * into call_row;
    return jsonb_build_object('ok', true, 'call_id', call_row.id, 'event', 'end');
  end if;

  -- Deduplicate conservatively (§17).  The same event key is always the same
  -- event.  Without a key, a repeat of the same number on the same line from
  -- the same device within ten seconds, while that ring is still open, is the
  -- box repeating itself — a customer who hangs up and calls back produces an
  -- end record first, so their second call is never swallowed.
  if key_value is not null then
    select * into call_row from public.phone_calls where event_key = key_value;
  end if;
  if call_row.id is null then
    select * into call_row
      from public.phone_calls
     where line_number = line
       and direction = direction_value
       and caller_number_raw = left(raw_number, 40)
       and device_id = device_value
       and ended_at is null
       and started_at between occurred - interval '10 seconds' and occurred + interval '10 seconds'
     order by started_at desc
     limit 1;
  end if;
  if call_row.id is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'call_id', call_row.id, 'event', 'start',
      'line_number', call_row.line_number, 'caller_number', call_row.caller_number, 'matched', call_row.customer_id is not null);
  end if;

  select array_agg(match_id) into matched_ids from public.wayne_phone_matches(normalized) match_id;

  insert into public.phone_calls (
    event_key, line_number, unit_number, device_id, direction, caller_number_raw, caller_number,
    caller_name, customer_id, match_count, started_at, surfaced_at, raw_record, simulated, status
  ) values (
    coalesce(key_value, gen_random_uuid()::text),
    line,
    left(coalesce(payload ->> 'unit_number', ''), 20),
    device_value,
    direction_value,
    left(raw_number, 40),
    normalized,
    left(coalesce(payload ->> 'caller_name', ''), 80),
    -- Only an unambiguous match is attached automatically (§33).
    case when coalesce(array_length(matched_ids, 1), 0) = 1 then matched_ids[1] end,
    coalesce(array_length(matched_ids, 1), 0),
    occurred,
    greatest(occurred, now() - interval '1 minute'),
    left(coalesce(payload ->> 'raw_record', ''), 400),
    coalesce((payload ->> 'simulated')::boolean, false),
    -- An outbound call the staff placed is logged, never popped.
    case when direction_value = 'outbound' then 'completed' else 'incoming' end
  )
  returning * into call_row;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'call_id', call_row.id,
    'event', 'start',
    'line_number', call_row.line_number,
    'caller_number', call_row.caller_number,
    'matched', call_row.customer_id is not null
  );
end;
$$;

-- In-store providers (the simulator now, the Android app later) report rings
-- with the signed-in cashier's session instead of the bridge token.
create or replace function public.wayne_pos_record_call(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  source_value text := coalesce(payload ->> 'source', 'simulated');
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if source_value not in ('simulated', 'android_native') then raise exception 'Unknown caller ID source' using errcode = '22023'; end if;
  if source_value = 'simulated' and not coalesce((select simulator_enabled from public.pos_hardware_settings where id), false) then
    raise exception 'The caller ID simulator is switched off' using errcode = 'P0001';
  end if;
  result := public.wayne_record_phone_call(
    (payload - 'source' - 'simulated') || jsonb_build_object('simulated', source_value = 'simulated', 'direction', 'inbound'));
  if (result ->> 'call_id') is null then return result; end if;
  return result || jsonb_build_object('call', public.wayne_phone_call_json((result ->> 'call_id')::uuid));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The phone board: every line's live call plus recent history (§7, §35).
-- ---------------------------------------------------------------------------
create or replace function public.wayne_phone_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  expire_minutes integer := coalesce((select call_expire_minutes from public.pos_hardware_settings where id), 10);
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'expire_minutes', expire_minutes,
    'server_time', now(),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'line_number', phone_line.line_number,
        'label', coalesce(nullif(phone_line.label, ''), 'Line ' || phone_line.line_number),
        'phone_number', phone_line.phone_number,
        -- A line carries one call at a time, so only its newest ring counts: a
        -- new ring replaces an older unanswered one, and once the newest is
        -- dismissed or finished the line is free.
        'call', (
          select public.wayne_phone_call_json(newest.id)
            from (
              select call_row.id, call_row.status, call_row.surfaced_at
                from public.phone_calls call_row
               where call_row.line_number = phone_line.line_number
                 and call_row.direction = 'inbound'
               order by call_row.surfaced_at desc, call_row.started_at desc
               limit 1
            ) newest
           where (newest.status in ('incoming', 'selected') and newest.surfaced_at > now() - make_interval(mins => expire_minutes))
              or (newest.status = 'order_started' and newest.surfaced_at > now() - interval '4 hours')
        )
      ) order by phone_line.line_number)
        from public.store_phone_lines phone_line
       where phone_line.active
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(entry order by started desc)
        from (
          select call_row.started_at started, jsonb_build_object(
            'id', call_row.id, 'event_key', call_row.event_key, 'line_number', call_row.line_number,
            'caller_number', call_row.caller_number, 'caller_number_raw', call_row.caller_number_raw,
            'caller_name', call_row.caller_name, 'started_at', call_row.started_at,
            'status', call_row.status, 'simulated', call_row.simulated,
            'customer_name', nullif(btrim(coalesce(customer.first_name, '') || ' ' || coalesce(customer.last_name, '')), ''),
            'order_id', call_row.order_id, 'order_number', order_row.order_number
          ) entry
            from public.phone_calls call_row
            left join public.customers customer on customer.id = call_row.customer_id
            left join public.orders order_row on order_row.id = call_row.order_id
           where call_row.direction = 'inbound'
             and call_row.started_at > now() - interval '12 hours'
           order by call_row.started_at desc
           limit 30
        ) recent
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Call actions: claim / release / start order / dismiss / expire / reopen
--    (§22, §32, §34).  A claim is the lock that stops two registers starting
--    two orders from one ring.
-- ---------------------------------------------------------------------------
create or replace function public.wayne_phone_call_action(target_call_id uuid, action text, terminal text default '', force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.phone_calls;
  me uuid := auth.uid();
  terminal_value text := left(btrim(coalesce(terminal, '')), 60);
  held_by_other boolean;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if action not in ('claim', 'release', 'start_order', 'dismiss', 'expire', 'reopen', 'complete') then
    raise exception 'Unknown call action' using errcode = '22023';
  end if;
  select * into call_row from public.phone_calls where id = target_call_id for update;
  if not found then raise exception 'That call was not found' using errcode = 'P0002'; end if;

  held_by_other := call_row.claimed_by is not null and call_row.claimed_by <> me
    and call_row.status in ('selected', 'order_started');

  if held_by_other and not force and action in ('claim', 'start_order', 'dismiss', 'release') then
    return jsonb_build_object('ok', false, 'reason', 'claimed', 'call', public.wayne_phone_call_json(call_row.id));
  end if;

  if action = 'claim' then
    if call_row.status in ('dismissed', 'expired', 'completed') then
      return jsonb_build_object('ok', false, 'reason', 'closed', 'call', public.wayne_phone_call_json(call_row.id));
    end if;
    update public.phone_calls set claimed_by = me, claimed_terminal = terminal_value, claimed_at = now(),
      status = case when status = 'incoming' then 'selected' else status end,
      selected_at = coalesce(selected_at, now()), updated_at = now()
     where id = call_row.id;
  elsif action = 'release' then
    update public.phone_calls set claimed_by = null, claimed_terminal = '', claimed_at = null,
      -- Letting go of a call (or clearing the ticket started from it) puts it
      -- back on the line for anyone to take.
      status = case when status in ('selected', 'order_started') and order_id is null then 'incoming' else status end, updated_at = now()
     where id = call_row.id;
  elsif action = 'start_order' then
    if call_row.status in ('completed') then
      return jsonb_build_object('ok', false, 'reason', 'closed', 'call', public.wayne_phone_call_json(call_row.id));
    end if;
    update public.phone_calls set claimed_by = me, claimed_terminal = terminal_value, claimed_at = now(),
      status = 'order_started', selected_at = coalesce(selected_at, now()), updated_at = now()
     where id = call_row.id;
  elsif action = 'dismiss' then
    update public.phone_calls set status = 'dismissed', dismissed_at = now(),
      claimed_by = null, claimed_terminal = '', claimed_at = null, updated_at = now()
     where id = call_row.id and status <> 'completed';
  elsif action = 'expire' then
    update public.phone_calls set status = 'expired', updated_at = now()
     where id = call_row.id and status in ('incoming', 'selected');
  elsif action = 'reopen' then
    update public.phone_calls set status = 'incoming', dismissed_at = null, surfaced_at = now(),
      claimed_by = null, claimed_terminal = '', claimed_at = null, updated_at = now()
     where id = call_row.id and status in ('dismissed', 'expired');
  elsif action = 'complete' then
    update public.phone_calls set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
     where id = call_row.id;
  end if;

  return jsonb_build_object('ok', true, 'call', public.wayne_phone_call_json(call_row.id));
end;
$$;

revoke all on function public.wayne_pos_record_call(jsonb) from public, anon;
revoke all on function public.wayne_phone_board() from public, anon;
revoke all on function public.wayne_phone_call_action(uuid, text, text, boolean) from public, anon;
grant execute on function public.wayne_pos_record_call(jsonb) to authenticated;
grant execute on function public.wayne_phone_board() to authenticated;
grant execute on function public.wayne_phone_call_action(uuid, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. POS orders carry the call (§9, §11, §32).  Targeted edits on the live
--    definition, the same way included_toppings did it: each must match once.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.phone_replace_once(source text, find text, replacement text, label text)
returns text
language plpgsql
as $$
declare
  occurrences integer := (length(source) - length(replace(source, find, ''))) / length(find);
begin
  if occurrences <> 1 then
    raise exception 'phone workflow migration: expected exactly one "%" in %, found %', find, label, occurrences;
  end if;
  return replace(source, find, replacement);
end;
$$;

do $patch$
declare
  fn text := 'public.wayne_create_pos_order(jsonb)';
  src text;
begin
  src := pg_get_functiondef(fn::regprocedure);

  src := pg_temp.phone_replace_once(src,
    '  duplicate_choice_count integer;',
    '  duplicate_choice_count integer;
  linked_call_id uuid;
  linked_call_line smallint;
  linked_phone_line smallint;', fn);

  -- A phone caller who does not want a profile is still a phone order (§8
  -- "Start order without profile"); only pickup is possible without an address.
  src := pg_temp.phone_replace_once(src,
    'if customer_mode = ''walk_in'' and (order_source <> ''pos'' or fulfillment <> ''pickup'') then raise exception ''Walk-in orders must be POS pickup orders'' using errcode = ''22023''; end if;',
    'if customer_mode = ''walk_in'' and fulfillment <> ''pickup'' then raise exception ''Orders without a customer profile must be pickup orders'' using errcode = ''22023''; end if;', fn);

  src := pg_temp.phone_replace_once(src,
    'if jsonb_typeof(payload -> ''items'') <> ''array''',
    'linked_call_id := case when order_source = ''phone'' then nullif(payload ->> ''phone_call_id'', '''')::uuid end;
  linked_phone_line := case when order_source = ''phone'' then nullif(payload ->> ''phone_line'', '''')::smallint end;
  if linked_call_id is not null then
    select line_number into linked_call_line from public.phone_calls where id = linked_call_id;
    if not found then linked_call_id := null; end if;
    linked_phone_line := coalesce(linked_phone_line, linked_call_line);
  end if;
  if linked_phone_line is not null and linked_phone_line not between 1 and 8 then raise exception ''Choose a valid phone line'' using errcode = ''22023''; end if;
  if jsonb_typeof(payload -> ''items'') <> ''array''', fn);

  src := pg_temp.phone_replace_once(src,
    'customer_name := ''Walk-in''; normalized_phone := ''''; normalized_email := null;',
    'customer_name := left(coalesce(nullif(btrim(btrim(coalesce(payload ->> ''first_name'', '''')) || '' '' || btrim(coalesce(payload ->> ''last_name'', ''''))), ''''), case when order_source = ''phone'' then ''Phone caller'' else ''Walk-in'' end), 200);
    normalized_phone := coalesce(case when order_source = ''phone'' then public.wayne_normalize_phone(payload ->> ''phone'') end, '''');
    normalized_email := null;', fn);

  -- A customer matched through one of their extra numbers is still that customer.
  src := pg_temp.phone_replace_once(src,
    'where id = supplied_customer_id and phone_normalized = normalized_phone for update;',
    'where id = supplied_customer_id and (phone_normalized = normalized_phone or exists (select 1 from public.customer_phones extra where extra.customer_id = supplied_customer_id and extra.phone_normalized = normalized_phone)) for update;', fn);

  src := pg_temp.phone_replace_once(src,
    'created_by_user_id, idempotency_key)',
    'created_by_user_id, idempotency_key, phone_line, phone_call_id)', fn);
  src := pg_temp.phone_replace_once(src,
    'auth.uid(), request_key)',
    'auth.uid(), request_key, linked_phone_line, linked_call_id)', fn);

  -- Placing the order closes the call it came from (§34.9).
  src := pg_temp.phone_replace_once(src,
    'returning id into created_order_id;',
    'returning id into created_order_id;
  if linked_call_id is not null then
    update public.phone_calls
       set order_id = created_order_id, status = ''completed'', completed_at = now(),
           customer_id = coalesce(created_customer_id, customer_id), updated_at = now()
     where id = linked_call_id;
  end if;', fn);

  execute src;
end;
$patch$;

-- The Phase 16 board and panel keep working until the new POS is deployed.
comment on function public.wayne_phone_line_board() is
  'Phase 16 phone panel (superseded by wayne_phone_board; kept so the previous deploy keeps working).';
comment on function public.wayne_phone_board() is
  'POS phone screen: each active line''s live call with customer matches and claim, plus the last 12 hours of calls.';
comment on function public.wayne_phone_call_action(uuid, text, text, boolean) is
  'Claim / release / start_order / dismiss / expire / reopen / complete for one call. Claims are the multi-register lock.';
