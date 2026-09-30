-- Keyed-in delivery cards are created by the POS as payment-pending orders. The
-- processor is still the only party that receives card data; this function only
-- prepares the order and payment ledger entry that the server will settle.
create or replace function public.wayne_create_pos_card_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings public.payment_provider_settings%rowtype;
  result jsonb;
  order_id uuid;
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  select * into settings from public.payment_provider_settings where id = true;
  if settings.provider = 'none' or not settings.online_card_enabled then
    raise exception 'Keyed card payment is not switched on' using errcode = 'P0001';
  end if;
  if payload ->> 'source' <> 'phone' or payload ->> 'fulfillment_type' <> 'delivery' then
    raise exception 'Keyed card payment is available for delivery phone orders only' using errcode = '22023';
  end if;

  -- The established POS pricing/customer transaction remains the one source of
  -- truth. It completes inside this same transaction; the deferred kitchen trigger
  -- observes payment_pending at commit and therefore does not print an unpaid card order.
  result := public.wayne_create_pos_order(payload || jsonb_build_object('payment_method', 'test_manual'));
  if coalesce((result ->> 'duplicate')::boolean, false) then return result; end if;
  order_id := (result ->> 'id')::uuid;
  update public.orders set
    status = 'payment_pending',
    payment_method = 'card',
    pricing_snapshot = pricing_snapshot || jsonb_build_object('payment_mode', 'KEYED_CARD', 'payment_provider', settings.provider)
  where id = order_id and status = 'placed';
  insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
  values (order_id, 'order.payment_pending', 'placed', 'payment_pending', auth.uid(),
    jsonb_build_object('provider', settings.provider, 'entry', 'pos_keyed_card'));
  return result;
end;
$$;

revoke all on function public.wayne_create_pos_card_order(jsonb) from public, anon, authenticated;
grant execute on function public.wayne_create_pos_card_order(jsonb) to authenticated;

comment on function public.wayne_create_pos_card_order(jsonb) is
  'Creates a delivery phone order held out of the kitchen until its processor-tokenized keyed card payment settles.';

-- A driver records cash at the door on the delivery screen. Attribute that captured
-- payment to the active register immediately so the expected drawer amount and the
-- closeout include it; a separate manual "driver cash" entry would otherwise count
-- the same money twice. If every drawer is closed, the payment remains visible in the
-- delivery-cash report for manager follow-up rather than being assigned incorrectly.
create or replace function public.wayne_assign_delivery_cash_to_open_shift()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare target_shift_id uuid;
begin
  if new.provider <> 'cash_on_delivery' or new.method <> 'cash' or new.status <> 'captured' or new.shift_id is not null then
    return new;
  end if;
  select id into target_shift_id from public.register_shifts
  where status = 'open'
  order by opened_at desc, id desc
  limit 1;
  if target_shift_id is not null then
    update public.payments set shift_id = target_shift_id,
      metadata = metadata || jsonb_build_object('cash_drawer_attribution', 'automatic', 'shift_id', target_shift_id)
    where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists payments_assign_delivery_cash_shift on public.payments;
create trigger payments_assign_delivery_cash_shift
after insert on public.payments
for each row execute function public.wayne_assign_delivery_cash_to_open_shift();

create or replace function public.wayne_delivery_cash_totals(from_date date, through_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare store_timezone text; window_start timestamptz; window_end timestamptz;
begin
  if not (public.wayne_has_permission('cash.manage') or public.wayne_has_permission('reports.view')) then
    raise exception 'Cash management permission required' using errcode = '42501';
  end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 3660 then
    raise exception 'Invalid report date range' using errcode = '22023';
  end if;
  select timezone into store_timezone from public.store_settings where id = true;
  window_start := from_date::timestamp at time zone store_timezone;
  window_end := (through_date + 1)::timestamp at time zone store_timezone;
  return jsonb_build_object(
    'delivery_cash_collected_cents', coalesce((select sum(amount_cents)::bigint from public.payments
      where provider = 'cash_on_delivery' and method = 'cash' and status = 'captured'
        and captured_at >= window_start and captured_at < window_end), 0),
    'delivery_cash_unassigned_cents', coalesce((select sum(amount_cents)::bigint from public.payments
      where provider = 'cash_on_delivery' and method = 'cash' and status = 'captured' and shift_id is null
        and captured_at >= window_start and captured_at < window_end), 0));
end;
$$;

revoke all on function public.wayne_assign_delivery_cash_to_open_shift() from public, anon, authenticated;
revoke all on function public.wayne_delivery_cash_totals(date, date) from public, anon, authenticated;
grant execute on function public.wayne_delivery_cash_totals(date, date) to authenticated;
