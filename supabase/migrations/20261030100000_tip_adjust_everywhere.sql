-- Tips on every card, added from the signed slip (owner, 2026-10-13).
--
-- Every card — the M2 at the counter, a card keyed in over the phone (pickup
-- or delivery) and online orders — is now AUTHORISED for the order, not
-- charged.  The signed slip comes back with a tip; at night the tips are typed
-- in (POS → Tips, or Deliveries → cash-out for drivers) and each card is
-- captured ONCE for order + tip using Stripe overcapture (up to 50% or $50
-- more, whichever is greater, on Visa / Mastercard / Discover / Amex).
-- Anything still waiting at 4:30 am is charged for the order with no added tip,
-- so no authorisation can ever expire unpaid.
--
--   1. wayne_settle_payment: an authorised card releases an online order to
--      the kitchen (it used to wait for the capture).
--   2. A "tip_slip" print job: every card held for a tip that isn't an online
--      order (those already print one) prints a TIP & SIGNATURE slip.
--   3. wayne_pos_tip_queue(): the cards waiting for a tip.
--   4. wayne_pos_apply_card_tips(captures): records what Stripe captured.
--   5. The nightly safety net (pg_cron → /api/pos/tips/auto with a token
--      kept in the database).

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

-- ── 1. An authorised card releases the order ──────────────────────────────
select public._wayne_patch_function('public.wayne_settle_payment(jsonb)'::regprocedure,
  $o$  elsif next_status in ('failed', 'voided') then$o$,
  $n$  elsif next_status = 'authorized' then
    -- Card approved and held for its tip (owner, 2026-10-13): as good as paid for cooking.
    if order_row.status = 'payment_pending' then
      update public.orders set status = 'placed' where id = order_row.id;
      insert into public.order_events (order_id, event_type, from_status, to_status, metadata)
      values (order_row.id, 'order.placed', 'payment_pending', 'placed', jsonb_build_object('released_by', 'payment_authorized'));
    end if;
  elsif next_status in ('failed', 'voided') then$n$);

-- ── 2. Tip & signature slip for every held card (not online: it has its own) ─
alter table public.print_jobs drop constraint if exists print_jobs_job_type_check;
alter table public.print_jobs add constraint print_jobs_job_type_check
  check (job_type = any (array['kitchen_ticket', 'online_order', 'delivery_receipt', 'receipt_request', 'drawer_kick', 'tip_slip']));

create or replace function public.wayne_payment_queues_tip_slip()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  o public.orders%rowtype;
begin
  if new.status <> 'authorized' or new.method <> 'card' or (tg_op = 'UPDATE' and old.status = 'authorized') then
    return new;
  end if;
  select * into o from public.orders where id = new.order_id;
  if not found or o.source = 'online' then return new; end if;
  insert into public.print_jobs (order_id, destination, job_type, payload, workspace_id, location_id)
  values (o.id, 'receipt', 'tip_slip', jsonb_build_object(
    'order_number', o.order_number, 'customer_name', o.customer_name_snapshot,
    'fulfillment_type', o.fulfillment_type, 'payment_method', 'card'), o.workspace_id, o.location_id)
  on conflict (order_id, destination, job_type) do nothing;
  return new;
end;
$$;
drop trigger if exists payments_queue_tip_slip on public.payments;
create trigger payments_queue_tip_slip after insert or update of status on public.payments
  for each row execute function public.wayne_payment_queues_tip_slip();

-- ── 2b. Deliveries: room for the tip on every held card ───────────────────
-- Cards tapped on the M2 and online cards don't carry max_capture_cents until
-- Stripe is read; the cash-out screen then allows the overcapture limit (50% or
-- $50, whichever is greater).  Stripe's exact limit is applied when charging.
select public._wayne_patch_function('public.wayne_pos_delivery_order_json(uuid)'::regprocedure,
  $o$coalesce((held.metadata ->> 'max_capture_cents')::integer, (held.metadata ->> 'hold_cents')::integer, held.amount_cents)$o$,
  $n$coalesce((held.metadata ->> 'max_capture_cents')::integer, (held.metadata ->> 'hold_cents')::integer, held.amount_cents + greatest(held.amount_cents / 2, 5000))$n$);

-- ── 3. Cards waiting for a tip ────────────────────────────────────────────
create or replace function public.wayne_pos_tip_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  if not (public.wayne_has_permission('cash.manage') or public.wayne_has_permission('pos.access')) then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_data order by row_data.authorized_at)
    from (
      select o.id as order_id, o.order_number, o.customer_name_snapshot as customer_name, o.source, o.fulfillment_type,
        o.total_cents, o.tip_cents as tip_already_cents, o.is_test, coalesce(o.placed_at, o.created_at) as placed_at,
        p.id as payment_id, p.provider, p.amount_cents as authorized_cents, p.card_brand, p.card_last4,
        coalesce(p.authorized_at, p.created_at) as authorized_at,
        coalesce((p.metadata ->> 'max_capture_cents')::integer, p.amount_cents + greatest(p.amount_cents / 2, 5000)) as max_capture_cents,
        coalesce(p.metadata ->> 'reader', p.metadata ->> 'entry', p.metadata ->> 'source', '') as entry,
        exists (select 1 from public.delivery_assignments a
                 where a.order_id = o.id and a.status <> 'released' and a.cashout_id is null) as with_driver
      from public.payments p
      join public.orders o on o.id = p.order_id
      where p.status = 'authorized' and p.method = 'card' and p.provider in ('stripe', 'test')
        and o.status not in ('cancelled', 'draft')
      limit 300
    ) row_data
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.wayne_pos_tip_queue() from public, anon;
grant execute on function public.wayne_pos_tip_queue() to authenticated;

-- ── 4. Record the captures ────────────────────────────────────────────────
-- captures: [{order_id, payment_id, captured_cents, tip_cents, card_brand, card_last4}]
-- tip_cents is the tip ADDED by this capture (on top of any tip already on the order).
-- Safe to repeat: a payment already recorded is skipped.  The Stripe webhook may
-- have marked the payment captured first; the tip is still added here.
create or replace function public.wayne_pos_apply_card_tips(captures jsonb, via text default 'pos_tips')
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  c jsonb;
  v_payment public.payments%rowtype;
  v_order public.orders%rowtype;
  v_tip integer;
  v_captured integer;
  v_done integer := 0;
  v_tips integer := 0;
  v_detail jsonb := '[]'::jsonb;
begin
  if auth.uid() is not null and not (public.wayne_has_permission('cash.manage') or public.wayne_has_permission('delivery.dispatch')) then
    raise exception 'Only a manager can add tips to cards' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(captures, '[]'::jsonb)) <> 'array' then raise exception 'Invalid captures' using errcode = '22023'; end if;

  for c in select value from jsonb_array_elements(captures) loop
    select * into v_payment from public.payments
     where id = (c ->> 'payment_id')::uuid and order_id = (c ->> 'order_id')::uuid for update;
    if not found then continue; end if;
    if coalesce((v_payment.metadata ->> 'tip_capture_applied')::boolean, false) then continue; end if;
    if v_payment.status not in ('authorized', 'captured') then continue; end if;
    v_captured := greatest(coalesce((c ->> 'captured_cents')::integer, v_payment.amount_cents), 1);
    v_tip := least(greatest(coalesce((c ->> 'tip_cents')::integer, 0), 0), 100000);

    update public.payments p set
      status = 'captured', captured_at = coalesce(p.captured_at, now()), amount_cents = v_captured,
      provider_status = case when p.provider = 'stripe' then 'succeeded' else p.provider_status end,
      card_brand = coalesce(nullif(c ->> 'card_brand', ''), p.card_brand),
      card_last4 = coalesce(nullif(left(coalesce(c ->> 'card_last4', ''), 4), ''), p.card_last4),
      metadata = p.metadata || jsonb_build_object('tip_capture_applied', true, 'tip_added_cents', v_tip, 'tip_captured_via', left(coalesce(via, ''), 40), 'tip_captured_at', now())
     where p.id = v_payment.id;

    select * into v_order from public.orders where id = v_payment.order_id for update;
    update public.orders o set
      tip_cents = o.tip_cents + v_tip,
      total_cents = o.total_cents + v_tip,
      payment_status = 'paid', payment_method = 'card',
      status = case when o.status = 'payment_pending' then 'placed' else o.status end
     where o.id = v_order.id;
    insert into public.order_events (order_id, event_type, actor_user_id, metadata)
    values (v_order.id, 'payment.tip_captured', auth.uid(), jsonb_build_object(
      'payment_id', v_payment.id, 'captured_cents', v_captured, 'tip_added_cents', v_tip, 'via', via));

    v_done := v_done + 1;
    if not v_order.is_test then v_tips := v_tips + v_tip; end if;
    v_detail := v_detail || jsonb_build_array(jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
      'captured_cents', v_captured, 'tip_added_cents', v_tip));
  end loop;

  if v_done > 0 then
    perform public.wayne_write_audit('payments.tips_captured', 'payments', 'tips-' || to_char(now(), 'YYYYMMDDHH24MISS'),
      'Charged ' || v_done || ' card(s) with ' || (v_tips / 100.0)::numeric(12,2)::text || ' in added tips',
      '{}'::jsonb, jsonb_build_object('via', via, 'count', v_done, 'tips_cents', v_tips, 'detail', v_detail));
  end if;
  return jsonb_build_object('count', v_done, 'tips_cents', v_tips, 'detail', v_detail);
end;
$$;
revoke all on function public.wayne_pos_apply_card_tips(jsonb, text) from public, anon;
grant execute on function public.wayne_pos_apply_card_tips(jsonb, text) to authenticated, service_role;

-- ── 5. Nightly safety net ─────────────────────────────────────────────────
-- A held card must be captured before its authorisation runs out (a couple
-- of days for a card tapped on the reader).  At 4:30 am (New York) the server
-- charges whatever is still waiting, for the order with no added tip.
create table if not exists public.scheduled_job_tokens (
  name text primary key,
  token text not null,
  created_at timestamptz not null default now()
);
alter table public.scheduled_job_tokens enable row level security;
revoke all on public.scheduled_job_tokens from anon, authenticated;
insert into public.scheduled_job_tokens (name, token)
values ('tip_auto_capture', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create or replace function public.wayne_call_tip_auto_capture()
returns bigint
language plpgsql
security definer
set search_path to ''
as $$
declare
  request_id bigint;
  secret text;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return null; end if;
  select token into secret from public.scheduled_job_tokens where name = 'tip_auto_capture';
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)'
    into request_id
    using 'https://app.hanafymedia.com/api/pos/tips/auto', '{}'::jsonb,
      jsonb_build_object('content-type', 'application/json', 'x-wayne-job-token', secret);
  return request_id;
end;
$$;
revoke all on function public.wayne_call_tip_auto_capture() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'wayne-tip-auto-capture') then
    perform cron.unschedule('wayne-tip-auto-capture');
  end if;
  -- 08:30 UTC = 4:30 am New York in summer (3:30 am in winter).
  perform cron.schedule('wayne-tip-auto-capture', '30 8 * * *', 'select public.wayne_call_tip_auto_capture();');
end;
$cron$;

drop function public._wayne_patch_function(regprocedure, text, text);
