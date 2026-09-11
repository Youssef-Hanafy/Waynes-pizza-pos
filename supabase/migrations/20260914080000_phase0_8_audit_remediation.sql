-- Wayne's Pizza POS — Phase 0–8 audit remediation (2026-09-11).
--
-- Fixes every database-side finding in the Phase 0–8 audit:
--   DRIFT  Re-assert the Phase 0–5 reliability objects. The hosted project recorded
--          20260909060000/20260909070000 as applied but never received the rate
--          limiter or the overnight-hours functions, so hosted checkout failed closed.
--   H1     Orders can be handed off, sent out for delivery, completed, and cancelled.
--   H4     Immutable audit log for menu, settings, integration, staff, promotion,
--          refund, discount, cancellation, and replay actions.
--   M1     Staff directory + role/active management RPCs; new sign-ups start inactive.
--   M2     Checkout and its rate limiter are reachable only from the server (service role).
--   M3     Hanafy events queue while the destination is paused or not yet configured.
--   M4     Promotion admin permission and per-customer usage limits.
--   M5     Function and table privileges reduced to what each role actually needs.
--   M6/L2  §14 dashboard RPC and local-time order export.
--   L1     pg_net moved out of the public schema.
--   L3     Kitchen board is bounded.
--   L4     Server error capture table.
-- Every statement is idempotent so the migration is safe on a fresh database and on
-- the hosted project in its drifted state.

-- ============================================================================
-- DRIFT: Phase 0–5 reliability objects (from 20260909060000/070000). The limiter is
-- corrected: its parameter shared the name of a table column, so every call raised
-- "column reference client_key is ambiguous" and checkout always failed closed (429).
-- ============================================================================
create table if not exists public.order_request_rate_limits (
  client_key text not null check (char_length(client_key) = 64),
  window_started timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  primary key (client_key, window_started)
);

alter table public.order_request_rate_limits enable row level security;

create or replace function public.wayne_consume_public_order_rate_limit(client_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  request_key constant text := wayne_consume_public_order_rate_limit.client_key;
  active_window timestamptz := date_trunc('hour', now()) + floor(extract(minute from now()) / 5)::integer * interval '5 minutes';
  new_count integer;
begin
  if request_key is null or request_key !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid rate limit key' using errcode = '22023';
  end if;
  -- Keep the fixed-window table bounded without a separate operational job.
  delete from public.order_request_rate_limits
  where window_started < now() - interval '1 day';

  insert into public.order_request_rate_limits (client_key, window_started, request_count)
  values (request_key, active_window, 1)
  on conflict (client_key, window_started) do update
    set request_count = public.order_request_rate_limits.request_count + 1
    where public.order_request_rate_limits.request_count < 8
  returning request_count into strict new_count;

  return true;
exception
  when no_data_found then return false;
end;
$$;

revoke all on table public.order_request_rate_limits from public, anon, authenticated;
revoke all on function public.wayne_consume_public_order_rate_limit(text) from public;
grant execute on function public.wayne_consume_public_order_rate_limit(text) to anon;

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
  yesterday_name text;
  hours jsonb;
  yesterday_hours jsonb;
  special public.store_special_hours%rowtype;
  yesterday_special public.store_special_hours%rowtype;
begin
  select * into settings from public.store_settings where id = true;
  if not settings.ordering_open then return false; end if;

  local_moment := check_at at time zone settings.timezone;
  select * into special
  from public.store_special_hours
  where service_date = local_moment::date and archived_at is null
  limit 1;
  if found then
    if special.closed or special.opens_at is null or special.closes_at is null then return false; end if;
    if special.opens_at <= special.closes_at then
      return local_moment::time >= special.opens_at and local_moment::time < special.closes_at;
    end if;
    return local_moment::time >= special.opens_at;
  end if;

  day_name := (array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[extract(dow from local_moment)::integer + 1];
  yesterday_name := (array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[(extract(dow from local_moment)::integer + 6) % 7 + 1];
  hours := settings.business_hours -> day_name;
  yesterday_hours := settings.business_hours -> yesterday_name;

  if not coalesce((hours ->> 'closed')::boolean, true)
    and (hours ->> 'open') is not null and (hours ->> 'close') is not null then
    if (hours ->> 'open')::time <= (hours ->> 'close')::time
      and local_moment::time >= (hours ->> 'open')::time and local_moment::time < (hours ->> 'close')::time then return true; end if;
    if (hours ->> 'open')::time > (hours ->> 'close')::time
      and local_moment::time >= (hours ->> 'open')::time then return true; end if;
  end if;

  select * into yesterday_special
  from public.store_special_hours
  where service_date = local_moment::date - 1 and archived_at is null
  limit 1;
  if found then
    return not yesterday_special.closed
      and yesterday_special.opens_at is not null
      and yesterday_special.closes_at is not null
      and yesterday_special.opens_at > yesterday_special.closes_at
      and local_moment::time < yesterday_special.closes_at;
  end if;

  return not coalesce((yesterday_hours ->> 'closed')::boolean, true)
    and (yesterday_hours ->> 'open') is not null and (yesterday_hours ->> 'close') is not null
    and (yesterday_hours ->> 'open')::time > (yesterday_hours ->> 'close')::time
    and local_moment::time < (yesterday_hours ->> 'close')::time;
end;
$$;

create or replace function public.wayne_public_store_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select (to_jsonb(settings) - 'created_at' - 'updated_at') || jsonb_build_object(
    'special_hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', special.id,
        'service_date', special.service_date,
        'label', special.label,
        'closed', special.closed,
        'opens_at', special.opens_at,
        'closes_at', special.closes_at,
        'public_note', special.public_note
      ) order by special.service_date)
      from public.store_special_hours special
      where special.archived_at is null and special.service_date >= current_date - 1
    ), '[]'::jsonb)
  )
  from public.store_settings settings
  where id = true;
$$;

revoke all on function public.wayne_store_is_open(timestamptz) from public;
grant execute on function public.wayne_store_is_open(timestamptz) to anon, authenticated;
revoke all on function public.wayne_public_store_settings() from public;
grant execute on function public.wayne_public_store_settings() to anon, authenticated;

comment on function public.wayne_store_is_open(timestamptz) is 'Evaluates regular and special business hours in the configured store timezone, including overnight carry-over.';

-- ============================================================================
-- Permissions introduced by this remediation
-- ============================================================================
insert into public.permissions (id, code, description) values
  ('20000000-0000-4000-8000-000000000020', 'orders.manage', 'Hand off, send out, and complete open orders'),
  ('20000000-0000-4000-8000-000000000021', 'orders.cancel', 'Cancel orders with a recorded reason'),
  ('20000000-0000-4000-8000-000000000022', 'audit.view', 'View the audit log and server error history'),
  ('20000000-0000-4000-8000-000000000023', 'promotions.manage', 'Create, edit, pause, and archive promotion codes')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on
  (permission.code = 'orders.manage' and role.code in ('owner', 'manager', 'cashier', 'kitchen'))
  or (permission.code in ('orders.cancel', 'audit.view', 'promotions.manage') and role.code in ('owner', 'manager'))
on conflict do nothing;

-- ============================================================================
-- H4: immutable audit log
-- ============================================================================
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  actor_name text not null default 'System' check (char_length(actor_name) <= 200),
  action text not null check (char_length(action) between 1 and 120),
  entity_type text not null check (char_length(entity_type) between 1 and 80),
  entity_id text check (entity_id is null or char_length(entity_id) <= 200),
  summary text not null default '' check (char_length(summary) <= 500),
  changes jsonb not null default '{}'::jsonb check (jsonb_typeof(changes) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);
create index if not exists audit_log_occurred_idx on public.audit_log (occurred_at desc, id desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id, occurred_at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor_user_id, occurred_at desc);
alter table public.audit_log enable row level security;
drop policy if exists audit_log_view on public.audit_log;
create policy audit_log_view on public.audit_log for select to authenticated
using (public.wayne_has_permission('audit.view'));

create or replace function public.wayne_prevent_audit_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Audit log entries are immutable' using errcode = '42501';
end;
$$;
drop trigger if exists audit_log_immutable on public.audit_log;
create trigger audit_log_immutable before update or delete on public.audit_log
for each row execute function public.wayne_prevent_audit_mutation();
drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate before truncate on public.audit_log
for each statement execute function public.wayne_prevent_audit_mutation();

create or replace function public.wayne_write_audit(
  action_value text, entity_type_value text, entity_id_value text, summary_value text,
  changes_value jsonb default '{}'::jsonb, metadata_value jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  actor_label text;
begin
  if actor is not null then
    select profile.display_name into actor_label from public.profiles profile where profile.id = actor;
  end if;
  insert into public.audit_log (actor_user_id, actor_name, action, entity_type, entity_id, summary, changes, metadata)
  values (actor, coalesce(actor_label, case when actor is null then 'System' else 'Unknown staff' end),
    action_value, entity_type_value, left(entity_id_value, 200), left(coalesce(summary_value, ''), 500),
    coalesce(changes_value, '{}'::jsonb), coalesce(metadata_value, '{}'::jsonb));
end;
$$;

-- Generic row-change auditor. TG_ARGV[0] = identifying column ('' for singletons),
-- TG_ARGV[1] = text[] of columns whose values must never be written to the log.
create or replace function public.wayne_audit_row_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  old_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  current_row jsonb;
  redacted text[] := coalesce(nullif(tg_argv[1], '')::text[], '{}'::text[]);
  ignored text[] := array['created_at', 'updated_at', 'uses_count'];
  diff jsonb := '{}'::jsonb;
  key text;
  id_value text;
  label text;
  verb text := case tg_op when 'INSERT' then 'Created' when 'UPDATE' then 'Updated' else 'Deleted' end;
begin
  current_row := coalesce(new_row, old_row);
  for key in select jsonb_object_keys(current_row) loop
    continue when key = any(ignored);
    continue when tg_op = 'UPDATE' and (old_row -> key) is not distinct from (new_row -> key);
    if key = any(redacted) then
      diff := diff || jsonb_build_object(key, jsonb_build_object(
        'from', case when old_row ? key and old_row -> key <> 'null'::jsonb then to_jsonb('[redacted]'::text) end,
        'to', case when new_row ? key and new_row -> key <> 'null'::jsonb then to_jsonb('[redacted]'::text) end));
    else
      diff := diff || jsonb_build_object(key, jsonb_build_object('from', old_row -> key, 'to', new_row -> key));
    end if;
  end loop;
  if tg_op = 'UPDATE' and diff = '{}'::jsonb then return null; end if;
  id_value := case when coalesce(tg_argv[0], '') = '' then null else current_row ->> tg_argv[0] end;
  label := coalesce(current_row ->> 'name', current_row ->> 'code', current_row ->> 'display_name', current_row ->> 'label', current_row ->> 'code_snapshot');
  perform public.wayne_write_audit(
    tg_table_name || '.' || lower(tg_op), tg_table_name, id_value,
    verb || ' ' || replace(tg_table_name, '_', ' ') || coalesce(': ' || label, ''),
    diff, '{}'::jsonb);
  return null;
end;
$$;

-- ============================================================================
-- H1: hand-off, out-for-delivery, completion, and cancellation
-- ============================================================================
create or replace function public.wayne_transition_order(target_order_id uuid, expected_status text, next_status text, reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  order_row public.orders%rowtype;
  open_statuses constant text[] := array['placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery'];
  clean_reason text := nullif(btrim(coalesce(reason, '')), '');
  event_metadata jsonb := '{}'::jsonb;
  released integer := 0;
begin
  if next_status is null or next_status not in ('out_for_delivery', 'completed', 'cancelled') then
    raise exception 'Invalid order status change' using errcode = '22023';
  end if;
  if next_status = 'cancelled' then
    if not public.wayne_has_permission('orders.cancel') then raise exception 'Order cancellation permission required' using errcode = '42501'; end if;
    if clean_reason is null or char_length(clean_reason) not between 3 and 500 then raise exception 'A cancellation reason of at least 3 characters is required' using errcode = '22023'; end if;
  elsif not public.wayne_has_permission('orders.manage') then
    raise exception 'Order management permission required' using errcode = '42501';
  end if;

  select * into order_row from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if order_row.status = next_status then return jsonb_build_object('status', order_row.status, 'duplicate', true); end if;
  if expected_status is null or order_row.status <> expected_status then
    raise exception 'Order changed on another screen. Refresh and try again.' using errcode = '40001';
  end if;
  if not (order_row.status = any(open_statuses)) then raise exception 'Only open orders can be changed' using errcode = '22023'; end if;
  if next_status = 'out_for_delivery' and (order_row.fulfillment_type <> 'delivery' or order_row.status <> 'ready') then
    raise exception 'Only ready delivery orders can go out for delivery' using errcode = '22023';
  end if;

  if next_status = 'completed' then
    event_metadata := jsonb_build_object('completed_from', order_row.status, 'skipped_kitchen_steps', order_row.status not in ('ready', 'out_for_delivery'));
  elsif next_status = 'cancelled' then
    -- Give promotion uses back so total and per-customer limits stay truthful.
    update public.promotions promotion set uses_count = greatest(promotion.uses_count - 1, 0)
    from public.order_discounts discount
    where discount.order_id = order_row.id and discount.promotion_id = promotion.id;
    get diagnostics released = row_count;
    event_metadata := jsonb_build_object(
      'reason', clean_reason,
      'payment_status_at_cancel', order_row.payment_status,
      'payment_method', order_row.payment_method,
      'refund_required', order_row.payment_status in ('paid', 'authorized', 'partially_refunded'),
      'promotion_uses_released', released);
  end if;

  update public.orders set
    status = next_status,
    out_for_delivery_at = case when next_status = 'out_for_delivery' then now() else out_for_delivery_at end,
    completed_at = case when next_status = 'completed' then now() else completed_at end,
    cancelled_at = case when next_status = 'cancelled' then now() else cancelled_at end
  where id = order_row.id;

  insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
  values (order_row.id, 'order.' || next_status, order_row.status, next_status, auth.uid(), event_metadata);

  if next_status = 'cancelled' then
    perform public.wayne_write_audit('order.cancelled', 'orders', order_row.id::text,
      'Cancelled order ' || order_row.order_number || ': ' || clean_reason,
      jsonb_build_object('status', jsonb_build_object('from', order_row.status, 'to', 'cancelled')), event_metadata);
  end if;
  return jsonb_build_object('status', next_status, 'duplicate', false);
end;
$$;

comment on function public.wayne_transition_order(uuid, text, text, text) is
  'Counter/kitchen/admin order hand-off. Completion requires orders.manage; cancellation requires orders.cancel and a reason. Emits order.completed / order.cancelled to Hanafy through the outbox trigger.';

-- L3: never render an unbounded kitchen board. Orders left open for more than a day
-- drop off the kitchen screen and are surfaced on the admin dashboard instead.
create or replace function public.wayne_kitchen_board()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('kitchen.access') then raise exception 'Kitchen access required' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(ticket) order by ticket.placed_at, ticket.order_id)
    from (
      select * from public.kitchen_tickets
      where status in ('placed', 'accepted', 'in_kitchen', 'ready') and placed_at > now() - interval '24 hours'
      order by placed_at, order_id
      limit 150
    ) ticket), '[]'::jsonb);
end;
$$;

create or replace function public.wayne_pos_open_orders()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.wayne_has_permission('pos.access') and public.wayne_has_permission('orders.manage')) then
    raise exception 'POS order access required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(open_order) order by open_order.placed_at)
    from (
      select id, order_number, customer_name_snapshot as customer_name, fulfillment_type, source, status,
        payment_method, payment_status, total_cents, placed_at, promised_at, ready_at
      from public.orders
      where status in ('placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery')
        and placed_at > now() - interval '24 hours'
      order by placed_at
      limit 100
    ) open_order), '[]'::jsonb);
end;
$$;

-- ============================================================================
-- M3: queue Hanafy events while delivery is paused or not yet configured
-- ============================================================================
alter table public.integration_outbox drop constraint if exists integration_outbox_destination_fkey;
alter table public.integration_outbox drop constraint if exists integration_outbox_destination_check;
alter table public.integration_outbox add constraint integration_outbox_destination_check check (destination = 'hanafy');

create or replace function public.wayne_enqueue_hanafy_event(event_type_value text, data_value jsonb, occurred_at_value timestamptz default now())
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  event_value uuid := gen_random_uuid();
  business_value text;
begin
  -- Always persist the event. Delivery (not capture) is what pausing controls.
  select destination.business_id into business_value from public.integration_destinations destination where destination.id = 'hanafy';
  insert into public.integration_outbox (event_id, destination, event_type, occurred_at, payload)
  values (event_value, 'hanafy', event_type_value, occurred_at_value, jsonb_build_object(
    'event_id', event_value, 'event_type', event_type_value, 'occurred_at', occurred_at_value,
    'source', 'waynes-pos', 'business_id', coalesce(business_value, 'waynes-pizza'), 'version', 1, 'data', data_value));
  return event_value;
end;
$$;

create or replace function public.wayne_claim_hanafy_outbox(worker_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare row_value public.integration_outbox%rowtype;
begin
  -- Paused or unconfigured: leave every event pending (no attempts, no backoff).
  if not exists (select 1 from public.integration_destinations where id = 'hanafy' and active) then
    return null;
  end if;

  select * into row_value from public.integration_outbox
  where destination = 'hanafy'
    and ((status in ('pending','failed') and next_attempt_at <= now())
      or (status = 'processing' and lease_expires_at <= now()))
  order by created_at
  for update skip locked
  limit 1;
  if not found then return null; end if;

  if row_value.status = 'processing' then
    insert into public.integration_delivery_logs(outbox_id, attempt_number, request_status, error_message)
    values (row_value.id, row_value.attempts, 'failed', 'Delivery lease expired before a result was recorded.')
    on conflict (outbox_id, attempt_number) do nothing;
  end if;

  update public.integration_outbox
  set status = 'processing', attempts = attempts + 1, lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '5 minutes', last_error = null,
      http_request_id = null, dispatched_at = null
  where id = row_value.id
  returning * into row_value;
  return to_jsonb(row_value);
end;
$$;

create or replace function public.wayne_replay_hanafy_outbox(outbox_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare row_value public.integration_outbox%rowtype;
begin
  if not public.wayne_has_permission('integrations.manage') then raise exception 'Integration management permission required' using errcode = '42501'; end if;
  update public.integration_outbox set status = 'pending', next_attempt_at = now(), lease_token = null, lease_expires_at = null, last_error = null
  where id = outbox_id and destination = 'hanafy' and status in ('failed', 'delivered')
  returning * into row_value;
  if not found then raise exception 'Replayable integration event not found' using errcode = 'P0002'; end if;
  perform public.wayne_write_audit('integration.event_replayed', 'integration_outbox', row_value.id::text,
    'Replayed Hanafy event ' || row_value.event_type, '{}'::jsonb,
    jsonb_build_object('event_id', row_value.event_id, 'attempts', row_value.attempts));
end;
$$;

create or replace function public.wayne_admin_hanafy_integration()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('integrations.manage') then raise exception 'Integration management permission required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'destination', (select jsonb_build_object('configured', true, 'endpoint_url', endpoint_url, 'business_id', business_id, 'active', active, 'secret_rotates_until', previous_secret_expires_at, 'updated_at', updated_at) from public.integration_destinations where id = 'hanafy'),
    'counts', jsonb_build_object(
      'pending', (select count(*) from public.integration_outbox where status = 'pending'),
      'processing', (select count(*) from public.integration_outbox where status = 'processing'),
      'failed', (select count(*) from public.integration_outbox where status = 'failed'),
      'delivered', (select count(*) from public.integration_outbox where status = 'delivered')),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'event_id', event_id, 'event_type', event_type, 'status', status, 'attempts', attempts, 'last_error', last_error, 'created_at', created_at, 'delivered_at', delivered_at) order by created_at desc) from (select * from public.integration_outbox order by created_at desc limit 50) event_row), '[]'::jsonb));
end;
$$;

-- ============================================================================
-- M4: promotion administration and per-customer limits
-- ============================================================================
alter table public.promotions add column if not exists per_customer_limit integer;
alter table public.promotions drop constraint if exists promotions_per_customer_limit_check;
alter table public.promotions add constraint promotions_per_customer_limit_check check (per_customer_limit is null or per_customer_limit > 0);

drop policy if exists promotions_admin_all on public.promotions;
drop policy if exists promotions_manage_all on public.promotions;
create policy promotions_manage_all on public.promotions for all to authenticated
using (public.wayne_has_permission('promotions.manage'))
with check (public.wayne_has_permission('promotions.manage'));

-- Runs inside both checkout transactions (online and POS). The customer row is already
-- locked by those transactions, so concurrent orders for one customer serialize here.
create or replace function public.wayne_enforce_promotion_customer_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  limit_value integer;
  customer uuid;
  used integer;
begin
  if new.promotion_id is null then return new; end if;
  select per_customer_limit into limit_value from public.promotions where id = new.promotion_id;
  if limit_value is null then return new; end if;
  select customer_id into customer from public.orders where id = new.order_id;
  if customer is null then
    raise exception 'Promotion code requires a customer phone number' using errcode = 'P0001';
  end if;
  select count(*) into used
  from public.order_discounts discount join public.orders order_row on order_row.id = discount.order_id
  where discount.promotion_id = new.promotion_id and order_row.customer_id = customer
    and order_row.status <> 'cancelled' and order_row.id <> new.order_id;
  if used >= limit_value then
    raise exception 'Promotion code has already been used the maximum number of times for this customer' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists order_discounts_customer_limit on public.order_discounts;
create trigger order_discounts_customer_limit before insert on public.order_discounts
for each row execute function public.wayne_enforce_promotion_customer_limit();

-- ============================================================================
-- M1: staff management
-- ============================================================================
-- Accounts created outside the owner's staff screen (e.g. an accidental public
-- sign-up) receive no access until an owner activates them.
create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_role_id uuid;
begin
  select id into default_role_id from public.roles where code = 'cashier' and active;
  if default_role_id is null then
    raise exception 'Default cashier role is missing';
  end if;

  insert into public.profiles (id, display_name, first_name, last_name, role_id, active)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email, 'Staff'), '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'first_name', ''),
    coalesce(new.raw_user_meta_data ->> 'last_name', ''),
    default_role_id,
    false
  );
  return new;
end;
$$;

create or replace function public.wayne_admin_staff()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('staff.view') then raise exception 'Staff viewing permission required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', profile.id, 'display_name', profile.display_name, 'first_name', profile.first_name,
        'last_name', profile.last_name, 'email', account.email, 'role', role.code, 'role_name', role.name,
        'active', profile.active, 'created_at', profile.created_at, 'last_sign_in_at', account.last_sign_in_at
      ) order by profile.active desc, role.id, profile.display_name)
      from public.profiles profile
      join public.roles role on role.id = profile.role_id
      left join auth.users account on account.id = profile.id), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', role.code, 'name', role.name, 'description', role.description,
        'permissions', coalesce((select jsonb_agg(permission.code order by permission.code)
          from public.role_permissions link join public.permissions permission on permission.id = link.permission_id
          where link.role_id = role.id), '[]'::jsonb)
      ) order by role.id)
      from public.roles role where role.active), '[]'::jsonb));
end;
$$;

create or replace function public.wayne_admin_update_staff(target_profile_id uuid, role_code text, active_value boolean, display_name_value text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  target public.profiles%rowtype;
  new_role public.roles%rowtype;
  current_role_code text;
  remaining_owners integer;
  clean_name text := nullif(btrim(coalesce(display_name_value, '')), '');
begin
  if not public.wayne_has_permission('staff.manage') then raise exception 'Staff management permission required' using errcode = '42501'; end if;
  if active_value is null then raise exception 'Choose whether the account is active' using errcode = '22023'; end if;
  if clean_name is not null and char_length(clean_name) > 120 then raise exception 'Display name must be 120 characters or fewer' using errcode = '22023'; end if;
  -- Serialize owner changes so two owners cannot demote each other at the same time.
  perform 1 from public.profiles profile join public.roles role on role.id = profile.role_id where role.code = 'owner' for update of profile;
  select * into target from public.profiles where id = target_profile_id for update;
  if not found then raise exception 'Staff member not found' using errcode = 'P0002'; end if;
  select * into new_role from public.roles where code = role_code and active;
  if not found then raise exception 'Unknown role' using errcode = '22023'; end if;
  select code into current_role_code from public.roles where id = target.role_id;
  if target.id = auth.uid() and (new_role.code <> current_role_code or not active_value) then
    raise exception 'You cannot change your own role or deactivate your own account' using errcode = '22023';
  end if;
  if current_role_code = 'owner' and target.active and (new_role.code <> 'owner' or not active_value) then
    select count(*) into remaining_owners from public.profiles profile join public.roles role on role.id = profile.role_id
    where role.code = 'owner' and profile.active and profile.id <> target.id;
    if remaining_owners = 0 then raise exception 'At least one active owner is required' using errcode = '22023'; end if;
  end if;
  update public.profiles set role_id = new_role.id, active = active_value, display_name = coalesce(clean_name, display_name)
  where id = target.id;
  return jsonb_build_object('id', target.id, 'role', new_role.code, 'active', active_value);
end;
$$;

-- Account creation and password resets happen through the Auth admin API on the
-- server; this records who performed them.
create or replace function public.wayne_record_staff_account_event(target_profile_id uuid, event_type text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_name text;
begin
  if not public.wayne_has_permission('staff.manage') then raise exception 'Staff management permission required' using errcode = '42501'; end if;
  if event_type not in ('staff.account_created', 'staff.password_reset') then raise exception 'Unknown staff account event' using errcode = '22023'; end if;
  select display_name into target_name from public.profiles where id = target_profile_id;
  if target_name is null then raise exception 'Staff member not found' using errcode = 'P0002'; end if;
  perform public.wayne_write_audit(event_type, 'profiles', target_profile_id::text,
    case event_type when 'staff.account_created' then 'Created staff account: ' else 'Reset password: ' end || target_name,
    '{}'::jsonb, '{}'::jsonb);
end;
$$;

-- ============================================================================
-- M6: §14 owner dashboard (business-day ranges in the store timezone)
-- ============================================================================
create or replace function public.wayne_admin_dashboard(from_date date, through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  store_timezone text;
  start_at timestamptz;
  end_at timestamptz;
begin
  if not public.wayne_has_permission('reports.view') then raise exception 'Report viewing permission required' using errcode = '42501'; end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 400 then
    raise exception 'Invalid dashboard date range' using errcode = '22023';
  end if;
  select settings.timezone into store_timezone from public.store_settings settings where settings.id = true;
  start_at := from_date::timestamp at time zone store_timezone;
  end_at := (through_date + 1)::timestamp at time zone store_timezone;

  return (
    with scoped as (
      select * from public.orders o where o.placed_at >= start_at and o.placed_at < end_at and o.status <> 'cancelled'
    ), cancelled as (
      select count(*)::integer order_count, coalesce(sum(total_cents), 0)::bigint total_cents
      from public.orders o where o.placed_at >= start_at and o.placed_at < end_at and o.status = 'cancelled'
    ), scoped_refunds as (
      select r.* from public.refunds r join public.orders o on o.id = r.order_id
      where r.created_at >= start_at and r.created_at < end_at and o.status <> 'cancelled'
    ), first_orders as (
      select o.customer_id, min(o.placed_at) first_placed_at
      from public.orders o
      where o.customer_id in (select customer_id from scoped where customer_id is not null)
        and o.placed_at is not null and o.status not in ('draft', 'cancelled')
      group by o.customer_id
    ), customer_orders as (
      select s.id, s.customer_id, case when f.first_placed_at >= start_at then 'new' else 'returning' end as kind
      from scoped s join first_orders f on f.customer_id = s.customer_id
    )
    select jsonb_build_object(
      'timezone', store_timezone,
      'from_date', from_date,
      'through_date', through_date,
      'order_count', (select count(*)::integer from scoped),
      'item_sales_cents', (select coalesce(sum(subtotal_cents), 0)::bigint from scoped),
      'gross_sales_cents', (select coalesce(sum(subtotal_cents + delivery_fee_cents + tax_cents + tip_cents), 0)::bigint from scoped),
      'discount_cents', (select coalesce(sum(discount_cents), 0)::bigint from scoped),
      'refund_cents', (select coalesce(sum(amount_cents), 0)::bigint from scoped_refunds),
      'net_sales_cents', (select coalesce(sum(total_cents), 0)::bigint from scoped) - (select coalesce(sum(amount_cents), 0)::bigint from scoped_refunds),
      'tax_cents', (select coalesce(sum(tax_cents), 0)::bigint from scoped),
      'tip_cents', (select coalesce(sum(tip_cents), 0)::bigint from scoped),
      'delivery_fee_cents', (select coalesce(sum(delivery_fee_cents), 0)::bigint from scoped),
      'average_order_cents', (select coalesce(round(avg(total_cents)), 0)::bigint from scoped),
      'cancelled_count', (select order_count from cancelled),
      'cancelled_cents', (select total_cents from cancelled),
      'fulfillment_rows', coalesce((select jsonb_agg(jsonb_build_object('key', fulfillment_type, 'order_count', c, 'total_cents', t) order by fulfillment_type) from (select fulfillment_type, count(*)::integer c, sum(total_cents)::bigint t from scoped group by fulfillment_type) x), '[]'::jsonb),
      'source_rows', coalesce((select jsonb_agg(jsonb_build_object('key', source, 'order_count', c, 'total_cents', t) order by source) from (select source, count(*)::integer c, sum(total_cents)::bigint t from scoped group by source) x), '[]'::jsonb),
      'payment_rows', coalesce((select jsonb_agg(jsonb_build_object('key', payment_method, 'order_count', c, 'total_cents', t) order by payment_method) from (select payment_method, count(*)::integer c, sum(total_cents)::bigint t from scoped group by payment_method) x), '[]'::jsonb),
      'hourly', (select jsonb_agg(jsonb_build_object('hour', hour_value, 'order_count', coalesce(c, 0), 'sales_cents', coalesce(t, 0)) order by hour_value)
        from generate_series(0, 23) hour_value
        left join (select extract(hour from placed_at at time zone store_timezone)::integer h, count(*)::integer c, sum(total_cents)::bigint t from scoped group by 1) x on x.h = hour_value),
      'top_items', coalesce((select jsonb_agg(jsonb_build_object('item_name', item_name, 'quantity', quantity, 'sales_cents', sales_cents) order by quantity desc, sales_cents desc, item_name)
        from (select item.item_name_snapshot item_name, sum(item.quantity)::integer quantity, sum(item.line_total_cents)::bigint sales_cents
          from public.order_items item join scoped on scoped.id = item.order_id
          group by item.item_name_snapshot order by 2 desc, 3 desc, 1 limit 10) x), '[]'::jsonb),
      'recent_orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.placed_at desc)
        from (select id, order_number, customer_name_snapshot customer_name, status, fulfillment_type, source, payment_method, total_cents, placed_at
          from public.orders o where o.placed_at >= start_at and o.placed_at < end_at order by o.placed_at desc limit 10) x), '[]'::jsonb),
      'customer_mix', jsonb_build_object(
        'new_customers', (select count(distinct customer_id)::integer from customer_orders where kind = 'new'),
        'returning_customers', (select count(distinct customer_id)::integer from customer_orders where kind = 'returning'),
        'new_customer_orders', (select count(*)::integer from customer_orders where kind = 'new'),
        'returning_customer_orders', (select count(*)::integer from customer_orders where kind = 'returning'),
        'guest_orders', (select count(*)::integer from scoped where customer_id is null))
    ));
end;
$$;

-- H3: what the owner still has to configure before going live, plus live operational
-- exceptions that need attention.
create or replace function public.wayne_admin_setup_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('admin.access') then raise exception 'Administration access required' using errcode = '42501'; end if;
  return (select jsonb_build_object(
    'category_count', (select count(*)::integer from public.menu_categories where archived_at is null),
    'menu_item_count', (select count(*)::integer from public.menu_items where archived_at is null),
    'visible_menu_item_count', (select count(*)::integer from public.menu_items where archived_at is null and customer_visible),
    'tax_rate_basis_points', settings.tax_rate_basis_points,
    'pickup_enabled', settings.pickup_enabled,
    'delivery_enabled', settings.delivery_enabled,
    'delivery_postal_code_count', cardinality(settings.delivery_postal_codes),
    'delivery_fee_cents', settings.delivery_fee_cents,
    'delivery_minimum_cents', settings.delivery_minimum_cents,
    'ordering_open', settings.ordering_open,
    'test_ordering_enabled', settings.test_ordering_enabled,
    'public_phone_set', char_length(btrim(settings.public_phone)) > 0,
    'hanafy_configured', exists (select 1 from public.integration_destinations where id = 'hanafy'),
    'hanafy_active', exists (select 1 from public.integration_destinations where id = 'hanafy' and active),
    'hanafy_failed_count', (select count(*)::integer from public.integration_outbox where status = 'failed'),
    'hanafy_queued_count', (select count(*)::integer from public.integration_outbox where status = 'pending'),
    'active_staff_count', (select count(*)::integer from public.profiles where active),
    'pending_staff_count', (select count(*)::integer from public.profiles where not active),
    'open_order_count', (select count(*)::integer from public.orders where status in ('placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery')),
    'stale_open_order_count', (select count(*)::integer from public.orders where status in ('placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery') and placed_at < now() - interval '24 hours'),
    'failed_print_job_count', (select count(*)::integer from public.print_jobs where status = 'failed'),
    'active_promotion_count', (select count(*)::integer from public.promotions where active and archived_at is null and (ends_at is null or ends_at > now()))
  ) from public.store_settings settings where settings.id = true);
end;
$$;

-- L2: exports carry the Wayne's business date and local wall-clock time as well as
-- the unambiguous UTC instant.
create or replace function public.wayne_report_orders(from_date date, through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare store_timezone text;
begin
  if not public.wayne_has_permission('reports.view') then raise exception 'Report viewing permission required' using errcode = '42501'; end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 3660 then raise exception 'Invalid report date range' using errcode = '22023'; end if;
  select settings.timezone into store_timezone from public.store_settings settings where settings.id = true;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'order_number', o.order_number, 'placed_at', o.placed_at,
      'business_date', to_char(o.placed_at at time zone store_timezone, 'YYYY-MM-DD'),
      'placed_at_local', to_char(o.placed_at at time zone store_timezone, 'YYYY-MM-DD HH24:MI:SS'),
      'source', o.source, 'fulfillment_type', o.fulfillment_type, 'status', o.status,
      'payment_method', o.payment_method, 'discount_cents', o.discount_cents, 'total_cents', o.total_cents
    ) order by o.placed_at, o.order_number)
    from public.orders o
    where o.placed_at >= (from_date::timestamp at time zone store_timezone)
      and o.placed_at < ((through_date + 1)::timestamp at time zone store_timezone)
      and o.status <> 'cancelled'), '[]'::jsonb);
end;
$$;

-- ============================================================================
-- L4: server error capture (written by the Next.js server with the service role)
-- ============================================================================
create table if not exists public.app_error_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  digest text check (digest is null or char_length(digest) <= 200),
  route_path text check (route_path is null or char_length(route_path) <= 500),
  route_type text check (route_type is null or char_length(route_type) <= 40),
  request_path text check (request_path is null or char_length(request_path) <= 1000),
  method text check (method is null or char_length(method) <= 16),
  message text not null default '' check (char_length(message) <= 2000),
  stack text check (stack is null or char_length(stack) <= 8000)
);
create index if not exists app_error_events_occurred_idx on public.app_error_events (occurred_at desc);
alter table public.app_error_events enable row level security;
drop policy if exists app_error_events_view on public.app_error_events;
create policy app_error_events_view on public.app_error_events for select to authenticated
using (public.wayne_has_permission('audit.view'));

create or replace function public.wayne_prune_app_error_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.app_error_events where occurred_at < now() - interval '90 days';
  return null;
end;
$$;
drop trigger if exists app_error_events_prune on public.app_error_events;
create trigger app_error_events_prune after insert on public.app_error_events
for each statement execute function public.wayne_prune_app_error_events();

-- ============================================================================
-- H4: attach auditing to every owner-sensitive table (§22 audit-required actions)
-- ============================================================================
do $$
declare
  target record;
begin
  for target in select * from (values
    ('menu_categories', 'id', ''), ('menu_items', 'id', ''), ('menu_item_variants', 'id', ''),
    ('modifier_groups', 'id', ''), ('modifier_choices', 'id', ''), ('menu_item_modifier_groups', 'menu_item_id', ''),
    ('store_settings', '', ''), ('store_special_hours', 'id', ''), ('promotions', 'id', ''),
    ('customer_segments', 'id', ''), ('profiles', 'id', ''), ('roles', 'id', ''), ('role_permissions', 'role_id', ''),
    ('integration_destinations', 'id', '{signing_secret,previous_signing_secret}'), ('refunds', 'id', '')
  ) as audited(table_name, id_column, redacted_columns) loop
    execute format('drop trigger if exists %I on public.%I', target.table_name || '_audit', target.table_name);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.wayne_audit_row_change(%L, %L)',
      target.table_name || '_audit', target.table_name, target.id_column, target.redacted_columns);
  end loop;
end;
$$;

-- Manual (non-promotion) POS discounts are an audit-required action.
drop trigger if exists order_discounts_manual_audit on public.order_discounts;
create trigger order_discounts_manual_audit after insert on public.order_discounts
for each row when (new.promotion_id is null)
execute function public.wayne_audit_row_change('order_id', '');

-- ============================================================================
-- M2 + M5: least-privilege grants
-- ============================================================================
-- Tables: Supabase's default privileges had granted anon/authenticated full DML
-- (and TRUNCATE, which RLS does not cover) on tables created after Phase 5,
-- including integration_destinations, whose signing secret managers could read.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.menu_categories, public.menu_items, public.menu_item_variants, public.modifier_groups,
  public.modifier_choices, public.menu_item_modifier_groups, public.store_special_hours to anon;

grant select on
  public.roles, public.permissions, public.role_permissions, public.profiles,
  public.menu_categories, public.menu_items, public.menu_item_variants, public.modifier_groups,
  public.modifier_choices, public.menu_item_modifier_groups, public.store_settings, public.store_special_hours,
  public.customers, public.customer_addresses, public.marketing_consents, public.promotions,
  public.orders, public.order_items, public.order_item_modifiers, public.order_discounts, public.order_events,
  public.kitchen_tickets, public.print_jobs, public.payments, public.refunds,
  public.customer_segments, public.customer_segment_memberships, public.customer_events, public.customer_segment_evaluation_runs,
  public.integration_outbox, public.integration_delivery_logs, public.audit_log, public.app_error_events
to authenticated;
grant insert, update on public.menu_categories, public.menu_items, public.store_special_hours, public.promotions to authenticated;
grant update on public.store_settings to authenticated;

-- Functions: nothing is callable by default. Browsers may call only the public
-- storefront functions; signed-in staff may call only RPCs that check permissions
-- internally; checkout, its rate limiter, and outbox workers are server-only.
do $$
declare
  fn record;
  anon_allowed constant text[] := array[
    'wayne_public_menu', 'wayne_public_store_settings', 'wayne_public_order_status', 'wayne_store_is_open',
    -- Referenced by the anon menu RLS policies; returns false without a session.
    'wayne_has_permission'];
  staff_allowed constant text[] := array[
    'wayne_my_access', 'wayne_has_role', 'wayne_normalize_phone', 'wayne_segment_rules_are_valid',
    'wayne_admin_customer_detail', 'wayne_admin_customer_segments', 'wayne_admin_customers',
    'wayne_admin_hanafy_integration', 'wayne_configure_hanafy_integration', 'wayne_replay_hanafy_outbox',
    'wayne_admin_order_calendar', 'wayne_admin_order_detail', 'wayne_admin_orders',
    'wayne_admin_dashboard', 'wayne_admin_setup_status',
    'wayne_admin_staff', 'wayne_admin_update_staff', 'wayne_record_staff_account_event',
    'wayne_claim_print_job', 'wayne_finish_print_job', 'wayne_retry_print_job',
    'wayne_create_menu_item', 'wayne_update_menu_item',
    'wayne_create_pos_order', 'wayne_pos_customer_search', 'wayne_pos_menu', 'wayne_pos_open_orders',
    'wayne_kitchen_board', 'wayne_kitchen_transition', 'wayne_transition_order',
    'wayne_report_daily_sales', 'wayne_report_items', 'wayne_report_orders', 'wayne_report_summary',
    'wayne_run_nightly_inactivity_evaluator', 'wayne_save_customer_segment'];
  has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  for fn in
    select p.oid::regprocedure as signature, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
    if fn.proname = any(anon_allowed) then
      execute format('grant execute on function %s to anon, authenticated', fn.signature);
    elsif fn.proname = any(staff_allowed) then
      execute format('grant execute on function %s to authenticated', fn.signature);
    end if;
    if has_service_role then
      execute format('grant execute on function %s to service_role', fn.signature);
    end if;
  end loop;
end;
$$;

-- Future objects start closed; each migration must grant deliberately.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ============================================================================
-- L1: pg_net belongs in the extensions schema, not public
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_net' and n.nspname = 'public') then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
exception when others then
  raise notice 'pg_net could not be moved out of public: %', sqlerrm;
end;
$$;

-- ============================================================================
-- Realtime: completed and cancelled orders leave the kitchen screens immediately
-- (kitchen_tickets is already published); nothing else needs publishing.
-- ============================================================================
comment on table public.audit_log is 'Immutable §22 audit trail. Written only by SECURITY DEFINER triggers/functions; readable with audit.view.';
comment on table public.app_error_events is 'Server-side errors captured by src/instrumentation.ts. Pruned after 90 days.';
