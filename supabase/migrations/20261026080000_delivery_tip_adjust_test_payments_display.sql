-- Counter fixes (owner, 2026-10-11).
--
-- 1. Delivery fee is not taxed.  Delivery is a flat $2.00 with no tax on it;
--    tax is on the food only (subtotal less discount).
-- 2. Delivery card tips — "tip adjust", the way restaurants do it.  A delivery
--    card keyed in over the phone is authorised for the order; the driver
--    brings back the signed slip, the tip is typed in Deliveries and the card
--    is captured ONCE for order + tip (Stripe overcapture).  The most a card
--    can be captured for is kept in payments.metadata.max_capture_cents and
--    shown to the cash-out as hold_cents.
-- 3. Test orders:
--    * never shown in Admin → Calendar, Admin → Orders or the report export;
--    * card payments on a test order are simulated (provider 'test') — the
--      card reader / keyed card / delivery tip flow all behave the same, but
--      no real card is ever charged (wayne_pos_test_card_payment);
--    * the POS open-orders list says which orders are tests.
-- 4. Customer screen flicker: two copies of the POS (e.g. the Fire tablet that
--    opened the POS before switching to the customer screen) were both
--    publishing to "Register 1" every few seconds — one the ticket, the other
--    an empty screen.  Each POS now has its own publisher id and a heartbeat
--    from a different POS no longer overwrites what the screen shows; only a
--    real change does.
--
-- Long functions are patched in place with exact, checked text replacements.

create or replace function public._wayne_patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
begin
  if position(old_text in definition) = 0 then
    if position(new_text in definition) > 0 then return; end if; -- already applied
    raise exception 'Patch for % did not match: %', target, left(old_text, 120);
  end if;
  execute replace(definition, old_text, new_text);
end;
$$;

-- ── 1. No tax on the delivery fee ─────────────────────────────────────────
select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
  $o$tax := (((subtotal - discount + delivery_fee)::bigint * settings.tax_rate_basis_points + 5000) / 10000)::integer;$o$,
  $n$tax := (((subtotal - discount)::bigint * settings.tax_rate_basis_points + 5000) / 10000)::integer; -- delivery fee is not taxed (owner, 2026-10-11)$n$);
select public._wayne_patch_function('public.wayne_create_test_order(jsonb)'::regprocedure,
  $o$tax := (((subtotal - discount + delivery_fee)::bigint * settings.tax_rate_basis_points + 5000) / 10000)::integer;$o$,
  $n$tax := (((subtotal - discount)::bigint * settings.tax_rate_basis_points + 5000) / 10000)::integer; -- delivery fee is not taxed (owner, 2026-10-11)$n$);

-- ── 2. Delivery cards: tip added at capture ───────────────────────────────
select public._wayne_patch_function('public.wayne_pos_delivery_order_json(uuid)'::regprocedure,
  $o$p.method = 'card' and p.status = 'authorized' and p.provider = 'stripe'$o$,
  $n$p.method = 'card' and p.status = 'authorized' and p.provider in ('stripe', 'test')$n$);
select public._wayne_patch_function('public.wayne_pos_delivery_order_json(uuid)'::regprocedure,
  $o$coalesce((held.metadata ->> 'hold_cents')::integer, held.amount_cents)$o$,
  $n$coalesce((held.metadata ->> 'max_capture_cents')::integer, (held.metadata ->> 'hold_cents')::integer, held.amount_cents)$n$);

-- ── 3. Test orders ────────────────────────────────────────────────────────
select public._wayne_patch_function('public.wayne_admin_order_calendar(date)'::regprocedure,
  $o$where order_row.placed_at >= (month_start::timestamp at time zone store_timezone)$o$,
  $n$where not order_row.is_test and order_row.placed_at >= (month_start::timestamp at time zone store_timezone)$n$);
select public._wayne_patch_function('public.wayne_admin_orders(text,date,date,text,text,text,text,integer,integer)'::regprocedure,
  $o$(from_date is null or order_row.placed_at >= (from_date::timestamp at time zone store_timezone))$o$,
  $n$not order_row.is_test and (from_date is null or order_row.placed_at >= (from_date::timestamp at time zone store_timezone))$n$);
select public._wayne_patch_function('public.wayne_report_orders(date,date)'::regprocedure,
  $o$where o.placed_at >= (from_date::timestamp at time zone store_timezone)$o$,
  $n$where not o.is_test and o.placed_at >= (from_date::timestamp at time zone store_timezone)$n$);
select public._wayne_patch_function('public.wayne_pos_open_orders()'::regprocedure,
  $o$payment_method, payment_status, total_cents, placed_at, promised_at, ready_at
      from public.orders$o$,
  $n$payment_method, payment_status, total_cents, placed_at, promised_at, ready_at, is_test
      from public.orders$n$);

-- A simulated card on a test order.  Behaves like the real thing — the drawer
-- opens for a reader payment, a delivery card is only authorised and is
-- "captured" with the tip at the driver's cash-out — but no card is charged.
create or replace function public.wayne_pos_test_card_payment(target_order_id uuid, authorize_only boolean, entry text, request_key text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order public.orders%rowtype;
  v_existing public.payments%rowtype;
  v_created public.payments%rowtype;
  v_shift uuid;
  v_key text := btrim(coalesce(request_key, ''));
  v_entry text := case when entry in ('card_reader', 'test_keyed') then entry else 'test_keyed' end;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if char_length(v_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;

  select * into v_existing from public.payments where idempotency_key = v_key;
  if found then
    return jsonb_build_object('payment_id', v_existing.id, 'duplicate', true, 'status', v_existing.status, 'amount_cents', v_existing.amount_cents);
  end if;

  select * into v_order from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if not v_order.is_test then raise exception 'Only a test order can use a test card' using errcode = '22023'; end if;
  if v_order.status in ('cancelled', 'draft') then raise exception 'This order can''t be paid' using errcode = '22023'; end if;
  if v_order.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = v_order.id and status in ('pending', 'authorized', 'captured')) then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;

  select id into v_shift from public.register_shifts where status = 'open' order by opened_at desc limit 1;

  insert into public.payments (order_id, provider, provider_payment_id, method, amount_cents, status, idempotency_key,
    shift_id, card_brand, card_last4, authorized_at, captured_at, created_by_user_id, provider_status, metadata)
  values (v_order.id, 'test', 'test-' || v_key, 'card', v_order.total_cents,
    case when authorize_only then 'authorized' else 'captured' end, v_key, v_shift, 'test', '4242',
    now(), case when authorize_only then null else now() end, auth.uid(),
    case when authorize_only then 'requires_capture' else 'succeeded' end,
    jsonb_build_object('entry', v_entry, 'simulated', true) ||
      case when authorize_only then jsonb_build_object('tip_adjust', true,
        'max_capture_cents', v_order.total_cents + greatest(v_order.total_cents / 2, 5000)) else '{}'::jsonb end)
  returning * into v_created;

  if not authorize_only then
    update public.orders set payment_status = 'paid', payment_method = 'card' where id = v_order.id;
  end if;
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (v_order.id, case when authorize_only then 'payment.authorized' else 'payment.captured' end, auth.uid(),
    jsonb_build_object('payment_id', v_created.id, 'provider', 'test', 'simulated', true, 'amount_cents', v_order.total_cents));

  return jsonb_build_object('payment_id', v_created.id, 'duplicate', false, 'status', v_created.status, 'amount_cents', v_order.total_cents);
end;
$$;
revoke all on function public.wayne_pos_test_card_payment(uuid, boolean, text, text) from public, anon;
grant execute on function public.wayne_pos_test_card_payment(uuid, boolean, text, text) to authenticated;

-- ── 4. Customer screen: one publisher at a time ───────────────────────────
alter table public.pos_customer_displays add column if not exists publisher_id text not null default '';

create or replace function public.wayne_display_publish(screen_key text, screen_state jsonb, publisher text, changed boolean)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_key text := left(btrim(coalesce(screen_key, '')), 60);
  v_state jsonb := coalesce(screen_state, '{}'::jsonb);
  v_publisher text := left(btrim(coalesce(publisher, '')), 80);
  v_row public.pos_customer_displays%rowtype;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if v_key = '' then raise exception 'Name this register first' using errcode = '22023'; end if;
  if jsonb_typeof(v_state) <> 'object' or pg_column_size(v_state) > 60000 then
    raise exception 'Invalid customer screen state' using errcode = '22023';
  end if;
  select * into v_row from public.pos_customer_displays d
   where d.workspace_id = public.hanafy_legacy_workspace_id() and d.display_key = v_key for update;
  if not found then
    insert into public.pos_customer_displays (display_key, state, publisher_id) values (v_key, v_state, v_publisher) returning * into v_row;
  elsif coalesce(changed, true) or v_row.publisher_id = v_publisher or v_row.publisher_id = '' then
    -- A real change (or the same POS's heartbeat) is shown; a different POS's
    -- heartbeat is not, so two registers with the same name can't flicker it.
    update public.pos_customer_displays d set
      response = case when coalesce(d.state ->> 'request_id', '') = coalesce(v_state ->> 'request_id', '') then d.response else '{}'::jsonb end,
      state = v_state, publisher_id = v_publisher, published_at = now(), updated_at = now()
     where d.id = v_row.id
    returning * into v_row;
  end if;
  return jsonb_build_object('response', v_row.response,
    'screen_online', v_row.seen_at is not null and v_row.seen_at > now() - interval '15 seconds',
    'showing', v_row.publisher_id = v_publisher);
end;
$$;
revoke all on function public.wayne_display_publish(text, jsonb, text, boolean) from public, anon;
grant execute on function public.wayne_display_publish(text, jsonb, text, boolean) to authenticated;

drop function public._wayne_patch_function(regprocedure, text, text);
