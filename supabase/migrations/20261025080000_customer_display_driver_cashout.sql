-- Customer screen and driver cash-out (owner, 2026-10-11).
--
-- 1. Customer screen: a second tablet at the counter (a Fire tablet) mirrors the
--    ticket a register is ringing up, asks the customer for a tip before a card
--    is run on the reader, and takes their signature afterwards.
-- 2. Card deliveries are HELD, not charged: a card keyed in for a delivery holds
--    the order total + 30% on the card.  At the driver's cash-out the real total
--    with the tip is charged once (one card fee) and the rest of the hold is
--    released.  The capture itself happens on Stripe (server route) just before
--    wayne_pos_driver_cashout records it.
-- 3. Driver cash-out, Thrive-style, from the POS Deliveries tab: send orders out
--    with a driver, then enter each order's tip and cash the driver out.  Cash
--    orders become cash payments in the drawer, the driver's tips are paid out
--    of the drawer, and the screen shows exactly what the driver hands in.

-- ── Shared: the drawer cash goes into ───────────────────────────────────
create or replace function public.wayne_ensure_open_shift()
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_shift_id uuid;
  v_register_id uuid;
begin
  select id into v_shift_id from public.register_shifts where status = 'open' order by opened_at desc limit 1;
  if v_shift_id is not null then return v_shift_id; end if;
  select id into v_register_id from public.registers where active order by created_at limit 1;
  if v_register_id is null then
    insert into public.registers (label, location_note, created_by_user_id) values ('Front counter', 'Counter', auth.uid())
    returning id into v_register_id;
  end if;
  insert into public.register_shifts (register_id, opened_by_user_id, opening_cash_cents)
  values (v_register_id, auth.uid(), 0) returning id into v_shift_id;
  perform public.wayne_write_audit('cash.shift_opened', 'register_shifts', v_shift_id::text,
    'Drawer opened automatically at 0.00', '{}'::jsonb, jsonb_build_object('opening_cash_cents', 0, 'automatic', true));
  return v_shift_id;
end;
$$;
revoke all on function public.wayne_ensure_open_shift() from public, anon, authenticated;

-- ── 1. Customer screen ──────────────────────────────────────────────────
create table if not exists public.pos_customer_displays (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  location_id uuid not null,
  display_key text not null check (char_length(display_key) between 1 and 60),
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  response jsonb not null default '{}'::jsonb check (jsonb_typeof(response) = 'object'),
  published_at timestamptz not null default now(),
  seen_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (location_id, display_key)
);
drop trigger if exists aa_hanafy_assign_legacy_scope on public.pos_customer_displays;
create trigger aa_hanafy_assign_legacy_scope before insert on public.pos_customer_displays
  for each row execute function public.hanafy_assign_legacy_location_scope();
drop trigger if exists zz_hanafy_enforce_tenant_scope on public.pos_customer_displays;
create trigger zz_hanafy_enforce_tenant_scope before insert or update on public.pos_customer_displays
  for each row execute function public.hanafy_enforce_location_scope();
alter table public.pos_customer_displays enable row level security;
revoke all on public.pos_customer_displays from anon, authenticated;

create table if not exists public.order_signatures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  location_id uuid not null,
  order_id uuid not null references public.orders(id) on delete cascade,
  signature_svg text not null check (char_length(signature_svg) between 20 and 200000),
  tip_cents integer not null default 0 check (tip_cents >= 0),
  captured_by_user_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists order_signatures_order_idx on public.order_signatures (order_id);
drop trigger if exists aa_hanafy_assign_legacy_scope on public.order_signatures;
create trigger aa_hanafy_assign_legacy_scope before insert on public.order_signatures
  for each row execute function public.hanafy_assign_legacy_location_scope();
drop trigger if exists zz_hanafy_enforce_tenant_scope on public.order_signatures;
create trigger zz_hanafy_enforce_tenant_scope before insert or update on public.order_signatures
  for each row execute function public.hanafy_enforce_location_scope();
alter table public.order_signatures enable row level security;
revoke all on public.order_signatures from anon, authenticated;

-- The register sends what the customer should see, and gets back the
-- customer's answer (tip or signature) to the request it is waiting on.
create or replace function public.wayne_display_publish(screen_key text, screen_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_key text := left(btrim(coalesce(screen_key, '')), 60);
  v_state jsonb := coalesce(screen_state, '{}'::jsonb);
  v_row public.pos_customer_displays%rowtype;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if v_key = '' then raise exception 'Name this register first' using errcode = '22023'; end if;
  if jsonb_typeof(v_state) <> 'object' or pg_column_size(v_state) > 60000 then
    raise exception 'Invalid customer screen state' using errcode = '22023';
  end if;
  select * into v_row from public.pos_customer_displays d
   where d.workspace_id = public.hanafy_legacy_workspace_id() and d.display_key = v_key for update;
  if found then
    update public.pos_customer_displays d set
      -- A new request clears the previous answer.
      response = case when coalesce(d.state ->> 'request_id', '') = coalesce(v_state ->> 'request_id', '') then d.response else '{}'::jsonb end,
      state = v_state, published_at = now(), updated_at = now()
     where d.id = v_row.id
    returning * into v_row;
  else
    insert into public.pos_customer_displays (display_key, state) values (v_key, v_state) returning * into v_row;
  end if;
  return jsonb_build_object('response', v_row.response,
    'screen_online', v_row.seen_at is not null and v_row.seen_at > now() - interval '15 seconds');
end;
$$;
revoke all on function public.wayne_display_publish(text, jsonb) from public, anon;
grant execute on function public.wayne_display_publish(text, jsonb) to authenticated;

-- The customer screen polls this.
create or replace function public.wayne_display_read(screen_key text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_row public.pos_customer_displays%rowtype;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  update public.pos_customer_displays d set seen_at = now()
   where d.workspace_id = public.hanafy_legacy_workspace_id() and d.display_key = left(btrim(coalesce(screen_key, '')), 60)
  returning * into v_row;
  if not found then return jsonb_build_object('state', '{}'::jsonb, 'response', '{}'::jsonb, 'found', false); end if;
  return jsonb_build_object('state', v_row.state, 'response', v_row.response, 'found', true,
    'register_online', v_row.published_at > now() - interval '2 minutes');
end;
$$;
revoke all on function public.wayne_display_read(text) from public, anon;
grant execute on function public.wayne_display_read(text) to authenticated;

-- The customer's answer: { request_id, kind: 'tip' | 'signature', tip_cents?, signature_svg? }.
create or replace function public.wayne_display_respond(screen_key text, answer jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_row public.pos_customer_displays%rowtype;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if jsonb_typeof(answer) <> 'object' or pg_column_size(answer) > 210000 then raise exception 'Invalid answer' using errcode = '22023'; end if;
  select * into v_row from public.pos_customer_displays d
   where d.workspace_id = public.hanafy_legacy_workspace_id() and d.display_key = left(btrim(coalesce(screen_key, '')), 60) for update;
  if not found then raise exception 'That register is not sending to a customer screen' using errcode = 'P0002'; end if;
  if coalesce(v_row.state ->> 'request_id', '') = '' or v_row.state ->> 'request_id' <> coalesce(answer ->> 'request_id', '') then
    return jsonb_build_object('accepted', false);
  end if;
  update public.pos_customer_displays d set response = answer, updated_at = now() where d.id = v_row.id;
  return jsonb_build_object('accepted', true);
end;
$$;
revoke all on function public.wayne_display_respond(text, jsonb) from public, anon;
grant execute on function public.wayne_display_respond(text, jsonb) to authenticated;

-- Registers a customer screen can face (sent something in the last day).
create or replace function public.wayne_display_list()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select case when public.wayne_has_permission('pos.access') then coalesce(jsonb_agg(jsonb_build_object(
    'display_key', d.display_key, 'published_at', d.published_at) order by d.published_at desc), '[]'::jsonb) else '[]'::jsonb end
  from public.pos_customer_displays d
  where d.workspace_id = public.hanafy_legacy_workspace_id() and d.published_at > now() - interval '1 day';
$$;
revoke all on function public.wayne_display_list() from public, anon;
grant execute on function public.wayne_display_list() to authenticated;

-- A tip chosen before the card is run (on the customer screen or at the counter).
create or replace function public.wayne_pos_set_tip(target_order_id uuid, tip_amount integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order public.orders%rowtype;
  v_settings public.store_settings%rowtype;
  v_tip integer := greatest(coalesce(tip_amount, 0), 0);
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  select * into v_settings from public.store_settings where id = true;
  select * into v_order from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if v_order.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments p where p.order_id = v_order.id and p.status in ('authorized', 'captured')) then
    raise exception 'A payment is already on this order' using errcode = '22023';
  end if;
  if v_tip > 0 and not v_settings.tips_enabled then raise exception 'Tips are switched off in Admin → Settings' using errcode = '22023'; end if;
  if v_tip > greatest(v_order.subtotal_cents, 100) * 2 then raise exception 'That tip is too high. Check the amount.' using errcode = '22023'; end if;
  update public.orders o set tip_cents = v_tip, total_cents = o.total_cents - o.tip_cents + v_tip where o.id = v_order.id
  returning * into v_order;
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (v_order.id, 'order.tip_set', auth.uid(), jsonb_build_object('tip_cents', v_tip, 'total_cents', v_order.total_cents));
  return jsonb_build_object('tip_cents', v_order.tip_cents, 'total_cents', v_order.total_cents);
end;
$$;
revoke all on function public.wayne_pos_set_tip(uuid, integer) from public, anon;
grant execute on function public.wayne_pos_set_tip(uuid, integer) to authenticated;

create or replace function public.wayne_pos_save_signature(target_order_id uuid, svg text, tip_amount integer default 0)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_id uuid;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if not exists (select 1 from public.orders o where o.id = target_order_id) then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if svg is null or char_length(svg) < 20 or char_length(svg) > 200000 or left(btrim(svg), 4) <> '<svg' then
    raise exception 'Invalid signature' using errcode = '22023';
  end if;
  insert into public.order_signatures (order_id, signature_svg, tip_cents, captured_by_user_id)
  values (target_order_id, svg, greatest(coalesce(tip_amount, 0), 0), auth.uid()) returning id into v_id;
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (target_order_id, 'order.signed', auth.uid(), jsonb_build_object('signature_id', v_id));
  return jsonb_build_object('signature_id', v_id);
end;
$$;
revoke all on function public.wayne_pos_save_signature(uuid, text, integer) from public, anon;
grant execute on function public.wayne_pos_save_signature(uuid, text, integer) to authenticated;

-- ── 2. Held card deliveries ─────────────────────────────────────────────
-- A card held for a delivery counts as paid for the driver: nothing to collect.
create or replace function public.wayne_payment_marks_order_authorized()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.status = 'authorized' and (tg_op = 'INSERT' or old.status is distinct from 'authorized') then
    update public.orders set payment_status = 'authorized', payment_method = 'card'
     where id = new.order_id and payment_status = 'unpaid';
  elsif new.status in ('voided', 'failed') and tg_op = 'UPDATE' and old.status = 'authorized' then
    update public.orders set payment_status = 'unpaid'
     where id = new.order_id and payment_status = 'authorized';
  end if;
  return new;
end;
$$;
revoke all on function public.wayne_payment_marks_order_authorized() from public, anon, authenticated;
drop trigger if exists payments_mark_order_authorized on public.payments;
create trigger payments_mark_order_authorized after insert or update of status on public.payments
  for each row execute function public.wayne_payment_marks_order_authorized();

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.wayne_assign_delivery(uuid, uuid)'::regprocedure);
  if position($o$case when order_row.payment_status = 'paid' then 0 else order_row.total_cents end$o$ in v_def) > 0 then
    execute replace(v_def, $o$case when order_row.payment_status = 'paid' then 0 else order_row.total_cents end$o$,
      $n$case when order_row.payment_status in ('paid', 'authorized') then 0 else order_row.total_cents end$n$);
  end if;
  v_def := pg_get_functiondef('public.wayne_driver_update_delivery(uuid, text, integer, text)'::regprocedure);
  if position($o$amount_due := case when order_row.payment_status = 'paid' then 0 else order_row.total_cents end;$o$ in v_def) > 0 then
    execute replace(v_def, $o$amount_due := case when order_row.payment_status = 'paid' then 0 else order_row.total_cents end;$o$,
      $n$amount_due := case when order_row.payment_status in ('paid', 'authorized') then 0 else order_row.total_cents end;$n$);
  end if;
end $$;

-- ── 3. Driver cash-out ──────────────────────────────────────────────────
alter table public.delivery_assignments add column if not exists tip_cents integer not null default 0 check (tip_cents >= 0);
alter table public.delivery_assignments add column if not exists cashout_id uuid;
alter table public.delivery_assignments add column if not exists cashed_out_at timestamptz;

create table if not exists public.driver_cashouts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  location_id uuid not null,
  driver_id uuid not null references public.profiles(id) on delete restrict,
  shift_id uuid references public.register_shifts(id) on delete set null,
  order_count integer not null default 0,
  cash_orders_cents integer not null default 0,
  cash_tips_cents integer not null default 0,
  card_tips_cents integer not null default 0,
  hand_in_cents integer not null default 0,
  note text not null default '' check (char_length(note) <= 500),
  detail jsonb not null default '[]'::jsonb,
  created_by_user_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists driver_cashouts_driver_idx on public.driver_cashouts (driver_id, created_at desc);
drop trigger if exists aa_hanafy_assign_legacy_scope on public.driver_cashouts;
create trigger aa_hanafy_assign_legacy_scope before insert on public.driver_cashouts
  for each row execute function public.hanafy_assign_legacy_location_scope();
drop trigger if exists zz_hanafy_enforce_tenant_scope on public.driver_cashouts;
create trigger zz_hanafy_enforce_tenant_scope before insert or update on public.driver_cashouts
  for each row execute function public.hanafy_enforce_location_scope();
alter table public.driver_cashouts enable row level security;
revoke all on public.driver_cashouts from anon, authenticated;

-- One delivery order as the POS Deliveries tab shows it.
--   paid_by: card_held (card held, charged with the tip at cash-out)
--            card      (card already charged — tip can't be added)
--            paid      (paid some other way, e.g. online)
--            cash_paid (cash already recorded by the driver's phone)
--            cash      (cash due at the door)
create or replace function public.wayne_pos_delivery_order_json(target_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object(
    'order_id', o.id, 'order_number', o.order_number, 'customer_name', o.customer_name_snapshot,
    'customer_phone', o.customer_phone_snapshot,
    'address', coalesce(o.delivery_address_snapshot ->> 'address1', '') ||
      case when coalesce(o.delivery_address_snapshot ->> 'address2', '') <> '' then ', ' || (o.delivery_address_snapshot ->> 'address2') else '' end,
    'city', coalesce(o.delivery_address_snapshot ->> 'city', ''),
    'status', o.status, 'source', o.source, 'is_test', o.is_test,
    'payment_status', o.payment_status, 'payment_method', o.payment_method,
    'total_cents', o.total_cents, 'tip_cents', o.tip_cents, 'placed_at', o.placed_at, 'promised_at', o.promised_at,
    'paid_by', case
      when held.id is not null then 'card_held'
      when card.id is not null then 'card'
      when cash.id is not null then 'cash_paid'
      when o.payment_status = 'paid' then 'paid'
      else 'cash' end,
    'hold_cents', case when held.id is null then null else coalesce((held.metadata ->> 'hold_cents')::integer, held.amount_cents) end,
    'held_at', held.authorized_at,
    'card_label', case
      when coalesce(held.id, card.id) is null then null
      else btrim(coalesce(initcap(coalesce(held.card_brand, card.card_brand)), 'Card') || coalesce(' •' || coalesce(held.card_last4, card.card_last4), '')) end)
  from public.orders o
  left join lateral (
    select p.* from public.payments p
     where p.order_id = o.id and p.method = 'card' and p.status = 'authorized' and p.provider = 'stripe'
     order by p.created_at desc limit 1) held on true
  left join lateral (
    select p.* from public.payments p
     where p.order_id = o.id and p.method = 'card' and p.status = 'captured'
     order by p.captured_at nulls last limit 1) card on true
  left join lateral (
    select p.* from public.payments p
     where p.order_id = o.id and p.method = 'cash' and p.status = 'captured' limit 1) cash on true
  where o.id = target_order_id;
$$;
revoke all on function public.wayne_pos_delivery_order_json(uuid) from public, anon, authenticated;

-- The whole Deliveries tab: orders waiting to go out, and each driver's run.
create or replace function public.wayne_pos_delivery_board()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  if not public.wayne_has_permission('delivery.dispatch') then raise exception 'Delivery dispatch permission required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'waiting', coalesce((
      select jsonb_agg(public.wayne_pos_delivery_order_json(o.id) order by o.placed_at)
      from public.orders o
      where o.fulfillment_type = 'delivery' and o.status in ('placed', 'accepted', 'in_kitchen', 'ready')
        and o.placed_at > now() - interval '36 hours'
        and not exists (select 1 from public.delivery_assignments a where a.order_id = o.id and a.status <> 'released')), '[]'::jsonb),
    'drivers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id', profile.id,
        'name', coalesce(nullif(profile.display_name, ''), nullif(btrim(coalesce(profile.first_name, '') || ' ' || coalesce(profile.last_name, '')), ''), 'Driver'),
        'last_cashout_at', (select max(c.created_at) from public.driver_cashouts c where c.driver_id = profile.id),
        'orders', coalesce((
          select jsonb_agg(public.wayne_pos_delivery_order_json(a.order_id) || jsonb_build_object(
              'assignment_status', a.status, 'assigned_at', a.assigned_at, 'delivered_at', a.delivered_at,
              'cash_collected_cents', a.cash_collected_cents) order by a.assigned_at)
          from public.delivery_assignments a join public.orders o on o.id = a.order_id
          where a.driver_id = profile.id and a.status <> 'released' and a.cashout_id is null
            and o.status <> 'cancelled' and a.assigned_at > now() - interval '6 days'), '[]'::jsonb))
        order by profile.display_name)
      from public.profiles profile
      where profile.active and exists (
        select 1 from public.roles role
        join public.role_permissions role_permission on role_permission.role_id = role.id
        join public.permissions permission on permission.id = role_permission.permission_id and permission.code = 'driver.access'
        where role.id = profile.role_id and role.active)), '[]'::jsonb));
end;
$$;
revoke all on function public.wayne_pos_delivery_board() from public, anon;
grant execute on function public.wayne_pos_delivery_board() to authenticated;

-- Hand an order to a driver and send it out the door in one tap.
create or replace function public.wayne_pos_send_out(target_order_id uuid, target_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order public.orders%rowtype;
  v_driver_name text;
begin
  perform public.wayne_assign_delivery(target_order_id, target_driver_id);
  select * into v_order from public.orders where id = target_order_id for update;
  select p.display_name into v_driver_name from public.profiles p where p.id = target_driver_id;
  update public.delivery_assignments a
     set status = 'picked_up', accepted_at = coalesce(a.accepted_at, now()), picked_up_at = coalesce(a.picked_up_at, now())
   where a.order_id = target_order_id and a.driver_id = target_driver_id and a.status in ('assigned', 'accepted');
  if v_order.status in ('placed', 'accepted', 'in_kitchen', 'ready') then
    update public.orders set status = 'out_for_delivery', out_for_delivery_at = now() where id = v_order.id;
    insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
    values (v_order.id, 'order.out_for_delivery', v_order.status, 'out_for_delivery', auth.uid(),
      jsonb_build_object('driver_id', target_driver_id, 'driver_name', v_driver_name, 'via', 'pos_deliveries'));
  end if;
  return jsonb_build_object('sent', true);
end;
$$;
revoke all on function public.wayne_pos_send_out(uuid, uuid) from public, anon;
grant execute on function public.wayne_pos_send_out(uuid, uuid) to authenticated;

-- Take an order back from a driver (wrong driver, the trip was cancelled).
create or replace function public.wayne_pos_unassign(target_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not public.wayne_has_permission('delivery.dispatch') then raise exception 'Delivery dispatch permission required' using errcode = '42501'; end if;
  update public.delivery_assignments a set status = 'released', released_at = now(), release_reason = 'Taken back at the POS'
   where a.order_id = target_order_id and a.status <> 'released' and a.cashout_id is null;
  update public.orders set status = 'ready' where id = target_order_id and status = 'out_for_delivery';
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (target_order_id, 'delivery.released', auth.uid(), jsonb_build_object('via', 'pos_deliveries'));
  return jsonb_build_object('released', true);
end;
$$;
revoke all on function public.wayne_pos_unassign(uuid) from public, anon;
grant execute on function public.wayne_pos_unassign(uuid) to authenticated;

-- Cash the driver out.
--   tips:          [{order_id, tip_cents}] as typed in at the POS.
--   card_captures: the held cards the server has ALREADY charged on Stripe:
--                  [{order_id, payment_id, captured_cents, tip_cents, card_brand, card_last4}]
--   skip_orders:   order ids left out of this cash-out (e.g. a held card that
--                  could not be charged) — they stay on the driver's list.
create or replace function public.wayne_pos_driver_cashout(target_driver_id uuid, tips jsonb, card_captures jsonb, skip_orders jsonb default '[]'::jsonb, cashout_note text default '')
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_driver_name text;
  v_shift_id uuid;
  v_cashout_id uuid := gen_random_uuid();
  v_assignment record;
  v_order public.orders%rowtype;
  v_view jsonb;
  v_tip integer;
  v_capture jsonb;
  v_cash_orders integer := 0;
  v_cash_tips integer := 0;
  v_card_tips integer := 0;
  v_real_tips integer := 0;
  v_count integer := 0;
  v_detail jsonb := '[]'::jsonb;
  v_paid_by text;
  v_line_cash integer;
begin
  if not (public.wayne_has_permission('cash.manage') or public.wayne_has_permission('delivery.dispatch')) then
    raise exception 'Cash management permission required' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(tips, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(card_captures, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(skip_orders, '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid tips' using errcode = '22023';
  end if;
  select coalesce(nullif(p.display_name, ''), 'Driver') into v_driver_name from public.profiles p where p.id = target_driver_id;
  if v_driver_name is null then raise exception 'Driver not found' using errcode = 'P0002'; end if;

  v_shift_id := public.wayne_ensure_open_shift();

  for v_assignment in
    select a.* from public.delivery_assignments a join public.orders ord on ord.id = a.order_id
     where a.driver_id = target_driver_id and a.status <> 'released' and a.cashout_id is null
       and ord.status <> 'cancelled'
       and not (coalesce(skip_orders, '[]'::jsonb) ? a.order_id::text)
     for update of a
  loop
    select * into v_order from public.orders where id = v_assignment.order_id for update;
    v_view := public.wayne_pos_delivery_order_json(v_order.id);
    v_paid_by := v_view ->> 'paid_by';
    v_tip := null;
    select coalesce((t.value ->> 'tip_cents')::integer, 0) into v_tip
      from jsonb_array_elements(coalesce(tips, '[]'::jsonb)) t where t.value ->> 'order_id' = v_order.id::text limit 1;
    v_tip := least(greatest(coalesce(v_tip, 0), 0), 50000);
    v_line_cash := 0;

    if v_paid_by = 'card_held' then
      v_capture := null;
      select c.value into v_capture from jsonb_array_elements(coalesce(card_captures, '[]'::jsonb)) c
       where c.value ->> 'order_id' = v_order.id::text limit 1;
      if v_capture is null then
        raise exception 'The held card on order % was not charged. Try the cash-out again.', v_order.order_number using errcode = '22023';
      end if;
      v_tip := greatest(coalesce((v_capture ->> 'tip_cents')::integer, 0), 0);
      update public.payments p set
        status = 'captured', captured_at = now(), amount_cents = (v_capture ->> 'captured_cents')::integer,
        card_brand = coalesce(nullif(v_capture ->> 'card_brand', ''), p.card_brand),
        card_last4 = coalesce(nullif(left(coalesce(v_capture ->> 'card_last4', ''), 4), ''), p.card_last4),
        metadata = p.metadata || jsonb_build_object('captured_at_cashout', v_cashout_id, 'tip_cents', v_tip)
       where p.id = (v_capture ->> 'payment_id')::uuid and p.order_id = v_order.id;
      v_card_tips := v_card_tips + v_tip;
    elsif v_paid_by = 'cash' then
      -- Cash at the door: the driver brings in the order total and keeps the tip.
      v_line_cash := v_order.total_cents;
      insert into public.payments (order_id, provider, provider_payment_id, method, amount_cents, status, captured_at,
        shift_id, created_by_user_id, metadata)
      values (v_order.id, 'cash_on_delivery', v_assignment.id::text, 'cash', v_order.total_cents + v_tip, 'captured', now(),
        v_shift_id, auth.uid(),
        jsonb_build_object('driver_id', target_driver_id, 'driver_name', v_driver_name, 'assignment_id', v_assignment.id,
          'cashout_id', v_cashout_id, 'tip_cents', v_tip, 'via', 'pos_cashout'))
      on conflict (provider, provider_payment_id) do nothing;
      v_cash_orders := v_cash_orders + v_line_cash;
      v_cash_tips := v_cash_tips + v_tip;
    elsif v_paid_by = 'cash_paid' and v_tip > 0 then
      -- Cash already recorded on the driver's phone: the tip comes on top.
      insert into public.payments (order_id, provider, provider_payment_id, method, amount_cents, status, captured_at,
        shift_id, created_by_user_id, metadata)
      values (v_order.id, 'cash_on_delivery', v_assignment.id::text || ':tip', 'cash', v_tip, 'captured', now(),
        v_shift_id, auth.uid(), jsonb_build_object('kind', 'driver_tip', 'driver_id', target_driver_id, 'cashout_id', v_cashout_id))
      on conflict (provider, provider_payment_id) do nothing;
      v_cash_tips := v_cash_tips + v_tip;
    else
      -- Already charged (card or online): a tip can't be added to that charge.
      v_tip := 0;
    end if;

    if not v_order.is_test then v_real_tips := v_real_tips + v_tip; end if;
    update public.orders o set
      tip_cents = o.tip_cents + v_tip,
      total_cents = o.total_cents + v_tip,
      payment_method = case when v_paid_by = 'cash' then 'cash' when v_paid_by = 'card_held' then 'card' else o.payment_method end,
      payment_status = case when v_paid_by in ('cash', 'card_held') then 'paid' else o.payment_status end
     where o.id = v_order.id;
    if v_order.status <> 'completed' then
      update public.orders set status = 'completed', completed_at = coalesce(completed_at, now()) where id = v_order.id;
      insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
      values (v_order.id, 'order.completed', v_order.status, 'completed', auth.uid(),
        jsonb_build_object('via', 'driver_cashout', 'driver_id', target_driver_id));
    end if;
    update public.delivery_assignments a set
      status = 'delivered', delivered_at = coalesce(a.delivered_at, now()), tip_cents = v_tip,
      cash_collected_cents = case when v_paid_by = 'cash' then v_order.total_cents + v_tip else a.cash_collected_cents end,
      cash_collected_at = case when v_paid_by = 'cash' then now() else a.cash_collected_at end,
      cashout_id = v_cashout_id, cashed_out_at = now()
     where a.id = v_assignment.id;
    insert into public.order_events (order_id, event_type, actor_user_id, metadata)
    values (v_order.id, 'delivery.cashed_out', auth.uid(),
      jsonb_build_object('driver_id', target_driver_id, 'tip_cents', v_tip, 'paid_by', v_paid_by, 'cashout_id', v_cashout_id));

    v_count := v_count + 1;
    v_detail := v_detail || jsonb_build_array(jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
      'paid_by', v_paid_by, 'total_cents', v_order.total_cents + v_tip, 'tip_cents', v_tip, 'cash_cents', v_line_cash));
  end loop;

  if v_count = 0 then raise exception 'This driver has no deliveries to cash out' using errcode = '22023'; end if;

  -- The driver keeps every tip: pay them out of the drawer.
  if v_real_tips > 0 then
    insert into public.cash_movements (shift_id, kind, amount_cents, reason, actor_user_id)
    values (v_shift_id, 'paid_out', v_real_tips, left('Driver tips · ' || v_driver_name, 500), auth.uid());
  end if;

  insert into public.driver_cashouts (id, driver_id, shift_id, order_count, cash_orders_cents, cash_tips_cents, card_tips_cents,
    hand_in_cents, note, detail, created_by_user_id)
  values (v_cashout_id, target_driver_id, v_shift_id, v_count, v_cash_orders, v_cash_tips, v_card_tips,
    v_cash_orders - v_card_tips, left(btrim(coalesce(cashout_note, '')), 500), v_detail, auth.uid());

  perform public.wayne_write_audit('delivery.driver_cashout', 'driver_cashouts', v_cashout_id::text,
    'Cashed out ' || v_driver_name || ': ' || v_count || ' orders, hands in ' || ((v_cash_orders - v_card_tips) / 100.0)::numeric(12,2)::text,
    '{}'::jsonb, jsonb_build_object('driver_id', target_driver_id, 'cash_orders_cents', v_cash_orders, 'cash_tips_cents', v_cash_tips,
      'card_tips_cents', v_card_tips, 'hand_in_cents', v_cash_orders - v_card_tips));

  return jsonb_build_object('cashout_id', v_cashout_id, 'driver_name', v_driver_name, 'order_count', v_count,
    'cash_orders_cents', v_cash_orders, 'cash_tips_cents', v_cash_tips, 'card_tips_cents', v_card_tips,
    'hand_in_cents', v_cash_orders - v_card_tips, 'detail', v_detail);
end;
$$;
revoke all on function public.wayne_pos_driver_cashout(uuid, jsonb, jsonb, jsonb, text) from public, anon;
grant execute on function public.wayne_pos_driver_cashout(uuid, jsonb, jsonb, jsonb, text) to authenticated;
