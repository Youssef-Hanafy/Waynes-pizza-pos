-- POS fixes for the counter (owner, 2026-10-11).
--
-- 1. Rush orders: nothing about the customer is required any more.
--    * A pickup/delivery ticket no longer needs a first name, last name or
--      phone.  With a phone number the customer profile is found or created
--      as before; with no phone the order simply carries no profile.
--    * Delivery needs only the street; city / state / ZIP fall back to the
--      store's own when left blank.
--    * Saving a customer from the POS needs only the phone number.
--      Last names may be blank.
-- 2. Test orders: orders.is_test.  A test order goes through everything
--    (kitchen ticket, receipt, drawer, card reader, cash) but is never linked
--    to a customer profile, never sends anything to the Hanafy CRM, and is left
--    out of every sales report, the dashboard and the drawer's expected cash.
--    wayne_clear_test_orders() deletes them.
-- 3. The cash drawer opens when an order is submitted at the POS, and an
--    "Open drawer" (no sale) button can open it any time
--    (wayne_pos_open_drawer).  Taking cash no longer needs the drawer to be
--    "opened" first: if no register shift is open one is opened automatically
--    at $0.00 (and a register is created if none exists).
--
-- The long POS order function is patched in place (exact text replacements,
-- each one checked) rather than re-typed, so nothing else in it can drift.

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

-- ── Schema ────────────────────────────────────────────────────────────────
alter table public.orders add column if not exists is_test boolean not null default false;
create index if not exists orders_is_test_idx on public.orders (is_test) where is_test;

alter table public.customers drop constraint if exists customers_last_name_check;
alter table public.customers add constraint customers_last_name_check check (char_length(last_name) <= 100);

-- A "no sale" drawer kick belongs to no order.
alter table public.print_jobs alter column order_id drop not null;

-- ── 1 + 2. POS order creation ────────────────────────────────────────────
select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  payment_method_value text := payload ->> 'payment_method';
$o$,
$n$  payment_method_value text := payload ->> 'payment_method';
  is_test_order boolean := coalesce((payload ->> 'is_test')::boolean, false);
$n$);

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$    normalized_phone := public.wayne_normalize_phone(payload ->> 'phone');
    if normalized_phone is null then raise exception 'Enter a valid 10-digit US phone number' using errcode = '22023'; end if;
    if char_length(btrim(coalesce(payload ->> 'first_name', ''))) not between 1 and 100 or char_length(btrim(coalesce(payload ->> 'last_name', ''))) not between 1 and 100 then raise exception 'First and last name are required' using errcode = '22023'; end if;$o$,
$n$    normalized_phone := public.wayne_normalize_phone(payload ->> 'phone');
    -- Nothing is required in a rush; a phone that was typed must still be a real number.
    if normalized_phone is null and char_length(regexp_replace(coalesce(payload ->> 'phone', ''), '[^0-9]', '', 'g')) > 0 then raise exception 'Enter a valid 10-digit phone number, or leave the phone blank' using errcode = '22023'; end if;
    if char_length(btrim(coalesce(payload ->> 'first_name', ''))) > 100 or char_length(btrim(coalesce(payload ->> 'last_name', ''))) > 100 then raise exception 'That name is too long' using errcode = '22023'; end if;$n$);

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$    customer_name := btrim(payload ->> 'first_name') || ' ' || btrim(payload ->> 'last_name');
    supplied_customer_id := nullif(payload ->> 'customer_id', '')::uuid;
    if supplied_customer_id is not null then$o$,
$n$    customer_name := left(coalesce(nullif(btrim(btrim(coalesce(payload ->> 'first_name', '')) || ' ' || btrim(coalesce(payload ->> 'last_name', ''))), ''), case when order_source = 'phone' then 'Phone caller' else 'Customer' end), 200);
    -- No phone (or a test order): no customer profile is found, created or changed.
    supplied_customer_id := case when normalized_phone is null or is_test_order then null else nullif(payload ->> 'customer_id', '')::uuid end;
    if normalized_phone is null or is_test_order then
      created_customer_id := null;
    elsif supplied_customer_id is not null then$n$);

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$    if created_customer_id is null then
      insert into public.customers (first_name, last_name, phone_normalized, email_normalized) values (btrim(payload ->> 'first_name'), btrim(payload ->> 'last_name'), normalized_phone, normalized_email) returning id into created_customer_id;
    else
      update public.customers set first_name = btrim(payload ->> 'first_name'), last_name = btrim(payload ->> 'last_name'), email_normalized$o$,
$n$    if normalized_phone is null or is_test_order then
      null;
    elsif created_customer_id is null then
      insert into public.customers (first_name, last_name, phone_normalized, email_normalized) values (coalesce(nullif(btrim(coalesce(payload ->> 'first_name', '')), ''), 'Customer'), btrim(coalesce(payload ->> 'last_name', '')), normalized_phone, normalized_email) returning id into created_customer_id;
    else
      -- A blank name on a rushed ticket never wipes the name already on file.
      update public.customers set first_name = coalesce(nullif(btrim(coalesce(payload ->> 'first_name', '')), ''), first_name), last_name = case when btrim(coalesce(payload ->> 'first_name', '')) = '' then last_name else btrim(coalesce(payload ->> 'last_name', '')) end, email_normalized$n$);

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  if fulfillment = 'delivery' then
    address_id := nullif(payload ->> 'address_id', '')::uuid;$o$,
$n$  normalized_phone := coalesce(normalized_phone, '');
  if is_test_order then customer_name := left('TEST · ' || customer_name, 200); end if;
  if fulfillment = 'delivery' then
    address_id := case when created_customer_id is null then null else nullif(payload ->> 'address_id', '')::uuid end;$n$);

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$      if char_length(btrim(coalesce(payload #>> '{address,address1}', ''))) = 0 or char_length(btrim(coalesce(payload #>> '{address,city}', ''))) = 0 or char_length(btrim(coalesce(payload #>> '{address,state}', ''))) = 0 or char_length(btrim(coalesce(payload #>> '{address,postal_code}', ''))) = 0 then raise exception 'A complete delivery address is required' using errcode = '22023'; end if;$o$,
$n$      if char_length(btrim(coalesce(payload #>> '{address,address1}', ''))) = 0 then raise exception 'Enter the street address for the delivery' using errcode = '22023'; end if;$n$);

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$'city', btrim(payload #>> '{address,city}'), 'state', upper(btrim(payload #>> '{address,state}')), 'postal_code', btrim(payload #>> '{address,postal_code}'),$o$,
$n$'city', coalesce(nullif(btrim(coalesce(payload #>> '{address,city}', '')), ''), settings.city, ''), 'state', upper(coalesce(nullif(btrim(coalesce(payload #>> '{address,state}', '')), ''), settings.state, '')), 'postal_code', coalesce(nullif(btrim(coalesce(payload #>> '{address,postal_code}', '')), ''), settings.postal_code, ''),$n$);

-- One step (each patch must leave the function valid on its own).
select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$      insert into public.customer_addresses (customer_id, address1, address2, city, state, postal_code, delivery_instructions, is_default) values (created_customer_id, address_snapshot ->> 'address1', address_snapshot ->> 'address2', address_snapshot ->> 'city', address_snapshot ->> 'state', address_snapshot ->> 'postal_code', address_snapshot ->> 'delivery_instructions', not exists (select 1 from public.customer_addresses where customer_id = created_customer_id)) returning id into address_id;$o$,
$n$      if created_customer_id is not null and (address_snapshot ->> 'city') <> '' and (address_snapshot ->> 'state') <> '' and (address_snapshot ->> 'postal_code') <> '' then
      insert into public.customer_addresses (customer_id, address1, address2, city, state, postal_code, delivery_instructions, is_default) values (created_customer_id, address_snapshot ->> 'address1', address_snapshot ->> 'address2', address_snapshot ->> 'city', address_snapshot ->> 'state', address_snapshot ->> 'postal_code', address_snapshot ->> 'delivery_instructions', not exists (select 1 from public.customer_addresses where customer_id = created_customer_id)) returning id into address_id;
      end if;$n$);

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$if cardinality(settings.delivery_postal_codes) > 0 and not ($o$,
$n$if cardinality(settings.delivery_postal_codes) > 0 and (address_snapshot ->> 'postal_code') <> '' and not ($n$);

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$phone_line, phone_call_id)
  values ($o$,
$n$phone_line, phone_call_id, is_test)
  values ($n$);

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$auth.uid(), request_key, linked_phone_line, linked_call_id)
  returning id into created_order_id;$o$,
$n$auth.uid(), request_key, linked_phone_line, linked_call_id, is_test_order)
  returning id into created_order_id;
  -- Every ticket sent from the counter opens the cash drawer (owner, 2026-10-11).
  perform public.wayne_queue_drawer_kick(created_order_id, case when is_test_order then 'test order submitted' else 'order submitted' end);$n$);

-- Test orders never reach the Hanafy CRM.
select public._wayne_patch_function('public.wayne_outbox_from_order_change()'::regprocedure,
$o$ begin type_value:=$o$,
$n$ begin if new.is_test then return new; end if; type_value:=$n$);

-- ── Saving a customer from the POS: only the phone is needed ─────────────
select public._wayne_patch_function('public.wayne_pos_save_customer(jsonb)'::regprocedure,
$o$  if char_length(first_value) not between 1 and 100 or char_length(last_value) not between 1 and 100 then
    raise exception 'First and last name are required' using errcode = '22023';
  end if;$o$,
$n$  if first_value = '' then
    first_value := coalesce((select first_name from public.customers where id = target_id), 'Customer');
  end if;
  if char_length(first_value) > 100 or char_length(last_value) > 100 then
    raise exception 'That name is too long' using errcode = '22023';
  end if;$n$);

select public._wayne_patch_function('public.wayne_pos_save_customer(jsonb)'::regprocedure,
$o$  if nullif(btrim(coalesce(payload #>> '{address,address1}', '')), '') is not null then
    if char_length(btrim(coalesce(payload #>> '{address,city}', ''))) = 0
       or char_length(btrim(coalesce(payload #>> '{address,state}', ''))) = 0
       or char_length(btrim(coalesce(payload #>> '{address,postal_code}', ''))) = 0 then
      raise exception 'A complete delivery address is required' using errcode = '22023';
    end if;$o$,
$n$  if nullif(btrim(coalesce(payload #>> '{address,address1}', '')), '') is not null then
    -- City / state / ZIP left blank are taken as the store's own.
    payload := jsonb_set(payload, '{address}', (payload -> 'address') || jsonb_build_object(
      'city', coalesce(nullif(btrim(coalesce(payload #>> '{address,city}', '')), ''), (select city from public.store_settings where id = true), ''),
      'state', coalesce(nullif(btrim(coalesce(payload #>> '{address,state}', '')), ''), (select state from public.store_settings where id = true), ''),
      'postal_code', coalesce(nullif(btrim(coalesce(payload #>> '{address,postal_code}', '')), ''), (select postal_code from public.store_settings where id = true), '')));
    if char_length(btrim(coalesce(payload #>> '{address,city}', ''))) = 0
       or char_length(btrim(coalesce(payload #>> '{address,state}', ''))) = 0
       or char_length(btrim(coalesce(payload #>> '{address,postal_code}', ''))) = 0 then
      raise exception 'A complete delivery address is required' using errcode = '22023';
    end if;$n$);

-- ── 3. Cash without "opening" the drawer first ──────────────────────────
select public._wayne_patch_function('public.wayne_take_cash_payment(jsonb)'::regprocedure,
$o$  change integer;
begin$o$,
$n$  change integer;
  auto_register_id uuid;
begin$n$);

select public._wayne_patch_function('public.wayne_take_cash_payment(jsonb)'::regprocedure,
$o$  select * into shift_row from public.register_shifts where id = (payload ->> 'shift_id')::uuid for update;
  if not found then raise exception 'Open a drawer before taking cash' using errcode = 'P0002'; end if;$o$,
$n$  select * into shift_row from public.register_shifts where id = nullif(payload ->> 'shift_id', '')::uuid for update;
  if not found then
    select * into shift_row from public.register_shifts where status = 'open' order by opened_at desc limit 1 for update;
  end if;
  if not found then
    -- No drawer count yet: open one at $0.00 so the sale is never blocked.
    -- The manager can record the real float as a paid-in, or count it at close.
    select id into auto_register_id from public.registers where active order by created_at limit 1;
    if auto_register_id is null then
      insert into public.registers (label, location_note, created_by_user_id) values ('Front counter', 'Counter', auth.uid()) returning id into auto_register_id;
    end if;
    insert into public.register_shifts (register_id, opened_by_user_id, opening_cash_cents)
    values (auto_register_id, auth.uid(), 0) returning * into shift_row;
    perform public.wayne_write_audit('cash.shift_opened', 'register_shifts', shift_row.id::text,
      'Drawer opened automatically at $0.00 to take a cash payment', '{}'::jsonb,
      jsonb_build_object('opening_cash_cents', 0, 'automatic', true));
  end if;$n$);

-- Test-order cash is not real money in the drawer.
select public._wayne_patch_function('public.wayne_shift_cash_totals(uuid)'::regprocedure,
$o$      and payment.method = 'cash' and payment.status = 'captured'),$o$,
$n$      and payment.method = 'cash' and payment.status = 'captured'
      and not exists (select 1 from public.orders test_order where test_order.id = payment.order_id and test_order.is_test)),$n$);

-- ── Reports and dashboard leave test orders out ──────────────────────────
do $$
declare
  fn regprocedure;
begin
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('wayne_admin_dashboard', 'wayne_report_summary', 'wayne_report_items')
  loop
    perform public._wayne_patch_function(fn, $o$o.status <> 'cancelled'$o$, $n$o.status <> 'cancelled' and not o.is_test$n$);
  end loop;
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'wayne_admin_dashboard'
  loop
    perform public._wayne_patch_function(fn, $o$o.status = 'cancelled'$o$, $n$o.status = 'cancelled' and not o.is_test$n$);
    perform public._wayne_patch_function(fn, $o$o.placed_at is not null and o.status not in ('draft', 'cancelled')$o$, $n$o.placed_at is not null and o.status not in ('draft', 'cancelled') and not o.is_test$n$);
  end loop;
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'wayne_report_daily_sales'
  loop
    perform public._wayne_patch_function(fn, $o$and status <> 'cancelled' group by 1$o$, $n$and status <> 'cancelled' and not is_test group by 1$n$);
    perform public._wayne_patch_function(fn, $o$and o.status <> 'cancelled' group by 1$o$, $n$and o.status <> 'cancelled' and not o.is_test group by 1$n$);
  end loop;
end $$;

-- ── Open the drawer with no sale ────────────────────────────────────────
create or replace function public.wayne_pos_open_drawer(reason text default '')
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  created_id uuid;
  why text := left(btrim(coalesce(reason, '')), 200);
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  insert into public.print_jobs (order_id, destination, job_type, payload)
  values (null, 'receipt', 'drawer_kick', jsonb_build_object('order_number', 'NO SALE', 'reason', coalesce(nullif(why, ''), 'no sale')))
  returning id into created_id;
  perform public.wayne_write_audit('cash.drawer_opened', 'print_jobs', created_id::text,
    'Opened the cash drawer (no sale)' || case when why <> '' then ': ' || why else '' end, '{}'::jsonb,
    jsonb_build_object('reason', why));
  return jsonb_build_object('queued', true, 'job_id', created_id);
end;
$$;
revoke all on function public.wayne_pos_open_drawer(text) from public, anon;
grant execute on function public.wayne_pos_open_drawer(text) to authenticated;

-- ── Delete orders (test orders, or the whole test history) ──────────────
-- Internal: removes orders and everything hanging off them.
create or replace function public.wayne_purge_orders(target_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  removed integer;
  touched_customers uuid[];
begin
  if coalesce(cardinality(target_ids), 0) = 0 then return 0; end if;
  select coalesce(array_agg(distinct customer_id) filter (where customer_id is not null), '{}') into touched_customers
    from public.orders where id = any(target_ids);
  delete from public.delivery_assignments where order_id = any(target_ids);
  delete from public.refunds where order_id = any(target_ids);
  delete from public.payments where order_id = any(target_ids);
  delete from public.print_jobs where order_id = any(target_ids);
  delete from public.kitchen_tickets where order_id = any(target_ids);
  delete from public.order_item_modifiers where order_item_id in (select id from public.order_items where order_id = any(target_ids));
  delete from public.order_items where order_id = any(target_ids);
  delete from public.order_discounts where order_id = any(target_ids);
  delete from public.order_events where order_id = any(target_ids);
  delete from public.order_idempotency where order_id = any(target_ids);
  delete from public.orders where id = any(target_ids);
  get diagnostics removed = row_count;
  perform public.wayne_rebuild_customer_metrics(customer_id) from unnest(touched_customers) customer_id;
  return removed;
end;
$$;
revoke all on function public.wayne_purge_orders(uuid[]) from public, anon, authenticated;

create or replace function public.wayne_clear_test_orders()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  removed integer;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  removed := public.wayne_purge_orders(array(select id from public.orders where is_test));
  perform public.wayne_write_audit('orders.test_cleared', 'orders', 'test', 'Deleted ' || removed || ' test orders', '{}'::jsonb, jsonb_build_object('removed', removed));
  return jsonb_build_object('removed', removed);
end;
$$;
revoke all on function public.wayne_clear_test_orders() from public, anon;
grant execute on function public.wayne_clear_test_orders() to authenticated;

drop function public._wayne_patch_function(regprocedure, text, text);
