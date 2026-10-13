-- End-of-day close out (owner, 2026-10-13): "a section dedicated for closing
-- out the day, counting all of the cash, expected vs real, card sales,
-- Mastercard, Visa, all of that stuff, including online orders.  Online orders
-- should be totaled but also have their own section in the close out."
--
--   wayne_day_closeout(day)        the whole day in one report (read only)
--   wayne_save_day_closeout(json)  counts the cash, closes the open drawer,
--                                  and keeps the day's close out on file
--
-- Test orders are never counted.  Cancelled orders are listed as voids and
-- left out of sales.

create table if not exists public.day_closeouts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  location_id uuid not null references public.locations (id),
  business_date date not null,
  counted_cash_cents integer not null check (counted_cash_cents >= 0),
  expected_cash_cents integer not null,
  variance_cents integer not null,
  denominations jsonb not null default '{}'::jsonb,
  report jsonb not null,
  note text not null default '',
  closed_by_user_id uuid references public.profiles (id),
  closed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (location_id, business_date)
);

drop trigger if exists aa_hanafy_assign_legacy_scope on public.day_closeouts;
create trigger aa_hanafy_assign_legacy_scope before insert on public.day_closeouts
  for each row execute function public.hanafy_assign_legacy_location_scope();
drop trigger if exists zz_hanafy_enforce_tenant_scope on public.day_closeouts;
create trigger zz_hanafy_enforce_tenant_scope before insert or update on public.day_closeouts
  for each row execute function public.hanafy_enforce_location_scope();

-- Read and written only through the functions below.
alter table public.day_closeouts enable row level security;
revoke all on public.day_closeouts from anon, authenticated;

create or replace function public.wayne_day_closeout(target_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  zone text;
  day date;
  result jsonb;
begin
  if not (public.wayne_has_permission('cash.manage') or public.wayne_has_permission('reports.view')) then
    raise exception 'Manager permission required for the close out' using errcode = '42501';
  end if;
  select coalesce(nullif(timezone, ''), 'America/New_York') into zone from public.store_settings where id = true;
  zone := coalesce(zone, 'America/New_York');
  day := coalesce(target_day, (now() at time zone zone)::date);

  with day_orders as (
    select o.*
      from public.orders o
     where not o.is_test
       and o.status <> 'draft'
       and (coalesce(o.placed_at, o.created_at) at time zone zone)::date = day
  ),
  sold as (select * from day_orders where status <> 'cancelled'),
  paid as (
    -- Money taken on the day's orders: captured, or a card authorised and held for the tip.
    select p.*, o.source as order_source, o.fulfillment_type, o.tip_cents as order_tip_cents,
      case
        when p.method <> 'card' then p.method
        when lower(coalesce(p.card_brand, '')) like '%visa%' then 'visa'
        when lower(coalesce(p.card_brand, '')) like '%master%' then 'mastercard'
        when lower(coalesce(p.card_brand, '')) like '%amex%' or lower(coalesce(p.card_brand, '')) like '%american%' then 'amex'
        when lower(coalesce(p.card_brand, '')) like '%discover%' then 'discover'
        else 'other_card'
      end as brand
      from public.payments p
      join sold o on o.id = p.order_id
     where p.status in ('captured', 'authorized')
  ),
  refunded as (
    select r.*
      from public.refunds r
      join public.orders o on o.id = r.order_id and not o.is_test
     where r.status = 'completed'
       and (r.created_at at time zone zone)::date = day
  ),
  unpaid as (
    select * from sold where payment_status not in ('paid', 'authorized', 'refunded', 'partially_refunded')
  )
  select jsonb_build_object(
    'day', day,
    'timezone', zone,
    'generated_at', now(),
    'sales', (select jsonb_build_object(
        'order_count', count(*),
        'item_count', coalesce((select sum(i.quantity) from public.order_items i join sold s on s.id = i.order_id), 0),
        'subtotal_cents', coalesce(sum(subtotal_cents), 0),
        'discount_cents', coalesce(sum(discount_cents), 0),
        'delivery_fee_cents', coalesce(sum(delivery_fee_cents), 0),
        'tax_cents', coalesce(sum(tax_cents), 0),
        'tip_cents', coalesce(sum(tip_cents), 0),
        'total_cents', coalesce(sum(total_cents), 0),
        'net_sales_cents', coalesce(sum(subtotal_cents - discount_cents), 0),
        'pickup_count', count(*) filter (where fulfillment_type = 'pickup'),
        'delivery_count', count(*) filter (where fulfillment_type = 'delivery'),
        'pickup_total_cents', coalesce(sum(total_cents) filter (where fulfillment_type = 'pickup'), 0),
        'delivery_total_cents', coalesce(sum(total_cents) filter (where fulfillment_type = 'delivery'), 0)
      ) from sold),
    'by_source', (select coalesce(jsonb_object_agg(source, jsonb_build_object('count', n, 'total_cents', cents)), '{}'::jsonb)
        from (select source, count(*) n, sum(total_cents) cents from sold group by source) s),
    'tenders', jsonb_build_object(
      'cash_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'cash'),
      'cash_count', (select count(*) from paid where method = 'cash'),
      'cash_at_counter_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'cash' and provider <> 'cash_on_delivery'),
      'cash_from_drivers_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'cash' and provider = 'cash_on_delivery'),
      'card_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'card'),
      'card_count', (select count(*) from paid where method = 'card'),
      'card_in_store_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'card' and order_source <> 'online'),
      'card_online_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'card' and order_source = 'online'),
      'card_held_for_tip_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'card' and status = 'authorized'),
      'other_cents', (select coalesce(sum(amount_cents), 0) from paid where method not in ('cash', 'card')),
      'card_tips_cents', (select coalesce(sum(order_tip_cents), 0) from (select distinct order_id, order_tip_cents from paid where method = 'card') t),
      'cash_tips_cents', (select coalesce(sum(order_tip_cents), 0) from (select distinct order_id, order_tip_cents from paid where method = 'cash') t)
    ),
    'card_brands', (select coalesce(jsonb_object_agg(brand, jsonb_build_object('count', n, 'cents', cents, 'in_store_cents', store_cents, 'online_cents', online_cents)), '{}'::jsonb)
        from (select brand, count(*) n, sum(amount_cents) cents,
                coalesce(sum(amount_cents) filter (where order_source <> 'online'), 0) store_cents,
                coalesce(sum(amount_cents) filter (where order_source = 'online'), 0) online_cents
                from paid where method = 'card' group by brand) b),
    'online', (select jsonb_build_object(
        'order_count', count(*),
        'pickup_count', count(*) filter (where fulfillment_type = 'pickup'),
        'delivery_count', count(*) filter (where fulfillment_type = 'delivery'),
        'subtotal_cents', coalesce(sum(subtotal_cents), 0),
        'discount_cents', coalesce(sum(discount_cents), 0),
        'delivery_fee_cents', coalesce(sum(delivery_fee_cents), 0),
        'tax_cents', coalesce(sum(tax_cents), 0),
        'tip_cents', coalesce(sum(tip_cents), 0),
        'total_cents', coalesce(sum(total_cents), 0),
        'paid_card_cents', (select coalesce(sum(amount_cents), 0) from paid where order_source = 'online' and method = 'card'),
        'paid_cash_cents', (select coalesce(sum(amount_cents), 0) from paid where order_source = 'online' and method = 'cash'),
        'unpaid_count', (select count(*) from unpaid where source = 'online'),
        'unpaid_cents', (select coalesce(sum(total_cents), 0) from unpaid where source = 'online')
      ) from sold where source = 'online'),
    'in_store', (select jsonb_build_object(
        'order_count', count(*),
        'counter_count', count(*) filter (where source = 'pos'),
        'phone_count', count(*) filter (where source = 'phone'),
        'total_cents', coalesce(sum(total_cents), 0)
      ) from sold where source <> 'online'),
    'refunds', jsonb_build_object(
      'count', (select count(*) from refunded),
      'cents', (select coalesce(sum(amount_cents), 0) from refunded),
      'cash_cents', (select coalesce(sum(r.amount_cents), 0) from refunded r join public.payments p on p.id = r.payment_id where p.method = 'cash')),
    'voids', (select jsonb_build_object('count', count(*), 'total_cents', coalesce(sum(total_cents), 0)) from day_orders where status = 'cancelled'),
    'unpaid', (select jsonb_build_object('count', count(*), 'total_cents', coalesce(sum(total_cents), 0),
        'orders', coalesce(jsonb_agg(jsonb_build_object('id', id, 'order_number', order_number, 'customer_name', customer_name_snapshot,
          'source', source, 'fulfillment_type', fulfillment_type, 'total_cents', total_cents, 'payment_method', payment_method) order by placed_at), '[]'::jsonb))
      from unpaid),
    'drawer', jsonb_build_object(
      'open_shifts', coalesce((select jsonb_agg(jsonb_build_object('id', shift.id, 'register_label', register.label, 'opened_at', shift.opened_at)
          || public.wayne_shift_cash_totals(shift.id) order by shift.opened_at)
        from public.register_shifts shift join public.registers register on register.id = shift.register_id
        where shift.status = 'open'), '[]'::jsonb),
      'closed_today', coalesce((select jsonb_agg(jsonb_build_object('id', shift.id, 'register_label', register.label,
          'opened_at', shift.opened_at, 'closed_at', shift.closed_at, 'opening_cash_cents', shift.opening_cash_cents,
          'expected_cash_cents', shift.expected_cash_cents, 'counted_cash_cents', shift.counted_cash_cents, 'variance_cents', shift.variance_cents) order by shift.closed_at)
        from public.register_shifts shift join public.registers register on register.id = shift.register_id
        where shift.status = 'closed' and (shift.closed_at at time zone zone)::date = day), '[]'::jsonb)),
    'saved', (select to_jsonb(saved) - 'report' - 'workspace_id' - 'location_id' || jsonb_build_object('closed_by_name', profile.display_name)
        from public.day_closeouts saved left join public.profiles profile on profile.id = saved.closed_by_user_id
        where saved.business_date = day order by saved.closed_at desc limit 1)
  ) into result;
  return result;
end;
$function$;

create or replace function public.wayne_save_day_closeout(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  zone text;
  day date;
  counted integer := (payload ->> 'counted_cash_cents')::integer;
  clean_note text := left(btrim(coalesce(payload ->> 'note', '')), 1000);
  open_count integer;
  open_shift uuid;
  closed_shift jsonb;
  expected integer;
  report jsonb;
  saved public.day_closeouts%rowtype;
begin
  if not public.wayne_has_permission('cash.manage') then
    raise exception 'Only a manager can close out the day' using errcode = '42501';
  end if;
  if counted is null or counted < 0 or counted > 10000000 then
    raise exception 'Count the cash before closing out' using errcode = '22023';
  end if;
  select coalesce(nullif(timezone, ''), 'America/New_York') into zone from public.store_settings where id = true;
  zone := coalesce(zone, 'America/New_York');
  day := coalesce(nullif(payload ->> 'business_date', '')::date, (now() at time zone zone)::date);

  -- The counted cash closes the drawer that is still open (one register).
  select count(*), (array_agg(id order by opened_at desc))[1] into open_count, open_shift
    from public.register_shifts where status = 'open';
  if coalesce((payload ->> 'close_drawer')::boolean, true) and open_count = 1 then
    closed_shift := public.wayne_close_shift(jsonb_build_object('shift_id', open_shift, 'counted_cash_cents', counted, 'close_note', clean_note));
    expected := (closed_shift ->> 'expected_cash_cents')::integer;
  elsif open_count > 1 then
    raise exception 'More than one drawer is open. Close the other registers'' drawers first.' using errcode = 'P0001';
  end if;

  report := public.wayne_day_closeout(day);
  if expected is null then
    -- No drawer open: compare with what the drawers closed today expected, or
    -- with the day's cash takings when no drawer was used at all.
    expected := coalesce(
      nullif((select sum((shift ->> 'expected_cash_cents')::integer) from jsonb_array_elements(report #> '{drawer,closed_today}') shift), 0),
      (report #>> '{tenders,cash_cents}')::integer - (report #>> '{refunds,cash_cents}')::integer);
  end if;

  insert into public.day_closeouts (business_date, counted_cash_cents, expected_cash_cents, variance_cents, denominations, report, note, closed_by_user_id, closed_at)
  values (day, counted, expected, counted - expected, coalesce(payload -> 'denominations', '{}'::jsonb), report, clean_note, auth.uid(), now())
  on conflict (location_id, business_date) do update set
    counted_cash_cents = excluded.counted_cash_cents, expected_cash_cents = excluded.expected_cash_cents,
    variance_cents = excluded.variance_cents, denominations = excluded.denominations, report = excluded.report,
    note = excluded.note, closed_by_user_id = excluded.closed_by_user_id, closed_at = excluded.closed_at
  returning * into saved;

  perform public.wayne_write_audit('cash.day_closed', 'day_closeouts', saved.id::text,
    'Closed out ' || day::text || ': counted ' || (counted / 100.0)::numeric(12,2)::text
      || ', expected ' || (expected / 100.0)::numeric(12,2)::text,
    '{}'::jsonb, jsonb_build_object('counted_cash_cents', counted, 'expected_cash_cents', expected, 'variance_cents', counted - expected));

  return to_jsonb(saved) - 'report' - 'workspace_id' - 'location_id';
end;
$function$;

revoke all on function public.wayne_day_closeout(date) from public, anon;
revoke all on function public.wayne_save_day_closeout(jsonb) from public, anon;
grant execute on function public.wayne_day_closeout(date) to authenticated;
grant execute on function public.wayne_save_day_closeout(jsonb) to authenticated;
