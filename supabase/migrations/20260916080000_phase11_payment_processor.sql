-- Wayne's Pizza POS — Phase 11: live payment processor infrastructure.
--
-- Master build sheet §20 (payment architecture) and §34 Phase 11.
--
-- Everything a real card payment needs exists here and stays INERT until an owner
-- enters provider credentials and switches card payments on. Nothing is faked: with
-- no provider configured the database refuses to open a card payment at all, and no
-- order can reach a paid state without a settled provider payment.
--
-- Secrets (access token, webhook signature key) live in server environment variables,
-- never in this database and never in the browser. Only the non-secret application and
-- location identifiers the Web Payments SDK needs are stored here.
--
-- Every statement is idempotent so the migration is safe on a fresh database and on
-- the hosted project.

-- ============================================================================
-- Permission: who may configure the processor, refund, void, and reconcile
-- ============================================================================
insert into public.permissions (id, code, description)
values ('20000000-0000-4000-8000-000000000025', 'payments.manage', 'Configure the payment processor and issue refunds or voids')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code = 'payments.manage'
where role.code in ('owner', 'manager')
on conflict do nothing;

-- ============================================================================
-- Provider configuration. Singleton, like store_settings.
-- ============================================================================
create table if not exists public.payment_provider_settings (
  id boolean primary key default true check (id),
  provider text not null default 'none' check (provider in ('none', 'square')),
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  application_id text not null default '' check (char_length(application_id) <= 200),
  location_id text not null default '' check (char_length(location_id) <= 200),
  notification_url text not null default '' check (char_length(notification_url) <= 500),
  online_card_enabled boolean not null default false,
  terminal_card_enabled boolean not null default false,
  -- A switch can only be on when the provider is actually identified. Credentials are
  -- checked by the server at call time; this stops a half-configured switch-on.
  constraint payment_provider_settings_ready check (
    (not online_card_enabled and not terminal_card_enabled)
    or (provider <> 'none' and char_length(btrim(application_id)) > 0 and char_length(btrim(location_id)) > 0)),
  updated_by_user_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.payment_provider_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists payment_provider_settings_set_updated_at on public.payment_provider_settings;
create trigger payment_provider_settings_set_updated_at
before update on public.payment_provider_settings
for each row execute function public.set_updated_at();

-- ============================================================================
-- Card readers. A terminal is registered here before the counter can charge it.
-- ============================================================================
create table if not exists public.payment_terminals (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 120),
  device_id text not null check (char_length(btrim(device_id)) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'disabled')),
  notes text not null default '' check (char_length(notes) <= 500),
  last_used_at timestamptz,
  created_by_user_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists payment_terminals_device_idx on public.payment_terminals(device_id);

drop trigger if exists payment_terminals_set_updated_at on public.payment_terminals;
create trigger payment_terminals_set_updated_at
before update on public.payment_terminals
for each row execute function public.set_updated_at();

-- ============================================================================
-- Webhook ledger. Every notification is stored once, by provider event id, so a
-- duplicate delivery can never be processed twice.
-- ============================================================================
create table if not exists public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (char_length(provider) between 1 and 40),
  event_id text not null check (char_length(event_id) between 1 and 200),
  event_type text not null default '' check (char_length(event_type) <= 200),
  signature_verified boolean not null default false,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  unique (provider, event_id)
);
create index if not exists payment_webhook_events_received_idx on public.payment_webhook_events(received_at desc);

-- ============================================================================
-- The payment and refund ledgers gain everything a real processor needs.
-- ============================================================================
alter table public.payments add column if not exists idempotency_key text;
alter table public.payments add column if not exists provider_status text;
alter table public.payments add column if not exists terminal_checkout_id text;
alter table public.payments add column if not exists terminal_id uuid references public.payment_terminals(id) on delete restrict;
alter table public.payments add column if not exists receipt_url text;
alter table public.payments add column if not exists card_brand text;
alter table public.payments add column if not exists card_last4 text check (card_last4 is null or char_length(card_last4) <= 4);
alter table public.payments add column if not exists failure_reason text;
alter table public.payments add column if not exists created_by_user_id uuid references public.profiles(id) on delete restrict;
alter table public.payments add column if not exists updated_at timestamptz not null default now();
create unique index if not exists payments_idempotency_idx on public.payments(idempotency_key) where idempotency_key is not null;
create index if not exists payments_order_idx on public.payments(order_id, created_at desc);
create index if not exists payments_terminal_checkout_idx on public.payments(terminal_checkout_id) where terminal_checkout_id is not null;

-- A payment now starts life as 'pending' before the provider answers.
do $$
begin
  alter table public.payments drop constraint if exists payments_status_check;
  alter table public.payments add constraint payments_status_check
    check (status in ('pending', 'authorized', 'captured', 'failed', 'voided'));
end;
$$;

-- A payment now exists before the provider has given it an id. The original
-- constraint was NULLS NOT DISTINCT, so two payments still waiting for an answer
-- collided with each other. Re-created with the default NULLS DISTINCT: provider
-- references stay unique once they exist, and unanswered payments coexist. It stays
-- a full unique constraint so existing ON CONFLICT (provider, provider_payment_id)
-- inference keeps working.
do $$
begin
  alter table public.payments drop constraint if exists payments_provider_provider_payment_id_key;
  alter table public.payments add constraint payments_provider_provider_payment_id_key
    unique (provider, provider_payment_id);
exception when duplicate_table or duplicate_object then null;
end;
$$;

do $$
begin
  alter table public.refunds drop constraint if exists refunds_payment_id_provider_refund_id_key;
  alter table public.refunds add constraint refunds_payment_id_provider_refund_id_key
    unique (payment_id, provider_refund_id);
exception when duplicate_table or duplicate_object then null;
end;
$$;

-- A payment with no provider reference must never claim to be captured.
alter table public.payments drop constraint if exists payments_captured_needs_reference;
alter table public.payments add constraint payments_captured_needs_reference
  check (status <> 'captured' or provider = 'manual' or provider_payment_id is not null);

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at
before update on public.payments
for each row execute function public.set_updated_at();

alter table public.refunds add column if not exists status text not null default 'completed';
alter table public.refunds add column if not exists provider_status text;
alter table public.refunds add column if not exists idempotency_key text;
alter table public.refunds add column if not exists failure_reason text;
alter table public.refunds add column if not exists updated_at timestamptz not null default now();
do $$
begin
  alter table public.refunds drop constraint if exists refunds_status_check;
  alter table public.refunds add constraint refunds_status_check
    check (status in ('pending', 'completed', 'rejected', 'failed'));
end;
$$;
create unique index if not exists refunds_idempotency_idx on public.refunds(idempotency_key) where idempotency_key is not null;

drop trigger if exists refunds_set_updated_at on public.refunds;
create trigger refunds_set_updated_at
before update on public.refunds
for each row execute function public.set_updated_at();

-- ============================================================================
-- Row level security. Configuration is readable by the staff who manage it; the
-- webhook ledger is server-only. Nobody writes any of these tables directly.
-- ============================================================================
alter table public.payment_provider_settings enable row level security;
alter table public.payment_terminals enable row level security;
alter table public.payment_webhook_events enable row level security;

drop policy if exists payment_provider_settings_admin_select on public.payment_provider_settings;
create policy payment_provider_settings_admin_select on public.payment_provider_settings
  for select to authenticated using (public.wayne_has_permission('payments.manage'));

drop policy if exists payment_terminals_staff_select on public.payment_terminals;
create policy payment_terminals_staff_select on public.payment_terminals
  for select to authenticated
  using (public.wayne_has_permission('payments.manage') or public.wayne_has_permission('pos.access'));

revoke all on public.payment_provider_settings, public.payment_terminals, public.payment_webhook_events from anon, authenticated;
grant select on public.payment_provider_settings, public.payment_terminals to authenticated;

-- Configuration changes are audited by the same immutable trigger the rest of the
-- admin surface uses. Nothing sensitive is stored in these tables to leak into it.
drop trigger if exists payment_provider_settings_audit on public.payment_provider_settings;
create trigger payment_provider_settings_audit
after insert or update or delete on public.payment_provider_settings
for each row execute function public.wayne_audit_row_change('', '');

drop trigger if exists payment_terminals_audit on public.payment_terminals;
create trigger payment_terminals_audit
after insert or update or delete on public.payment_terminals
for each row execute function public.wayne_audit_row_change('id', '');

-- ============================================================================
-- What the storefront needs to start a card payment. Non-secret values only.
-- ============================================================================
create or replace function public.wayne_payment_checkout_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'provider', case when settings.online_card_enabled then settings.provider else 'none' end,
    'environment', settings.environment,
    'application_id', case when settings.online_card_enabled then settings.application_id else '' end,
    'location_id', case when settings.online_card_enabled then settings.location_id else '' end,
    'online_card_enabled', settings.online_card_enabled)
  from public.payment_provider_settings settings where settings.id = true;
$$;

create or replace function public.wayne_admin_payment_console()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('payments.manage') then
    raise exception 'Payment management permission required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(settings) from public.payment_provider_settings settings where settings.id = true),
    'terminals', coalesce((select jsonb_agg(to_jsonb(terminal) order by terminal.created_at) from public.payment_terminals terminal), '[]'::jsonb),
    'counts', jsonb_build_object(
      'pending_payments', (select count(*)::integer from public.payments where status = 'pending'),
      'failed_payments_24h', (select count(*)::integer from public.payments where status = 'failed' and created_at > now() - interval '24 hours'),
      'pending_refunds', (select count(*)::integer from public.refunds where status = 'pending'),
      'unverified_webhooks', (select count(*)::integer from public.payment_webhook_events where not signature_verified),
      'unprocessed_webhooks', (select count(*)::integer from public.payment_webhook_events where processed_at is null)),
    'recent_webhooks', coalesce((
      select jsonb_agg(jsonb_build_object('event_id', event_id, 'event_type', event_type, 'signature_verified', signature_verified,
        'received_at', received_at, 'processed_at', processed_at, 'processing_error', processing_error) order by received_at desc)
      from (select * from public.payment_webhook_events order by received_at desc limit 25) rows), '[]'::jsonb));
end;
$$;

create or replace function public.wayne_save_payment_settings(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare updated public.payment_provider_settings%rowtype;
begin
  if not public.wayne_has_permission('payments.manage') then
    raise exception 'Payment management permission required' using errcode = '42501';
  end if;
  update public.payment_provider_settings set
    provider = coalesce(nullif(btrim(payload ->> 'provider'), ''), provider),
    environment = coalesce(nullif(btrim(payload ->> 'environment'), ''), environment),
    application_id = btrim(coalesce(payload ->> 'application_id', application_id)),
    location_id = btrim(coalesce(payload ->> 'location_id', location_id)),
    notification_url = btrim(coalesce(payload ->> 'notification_url', notification_url)),
    online_card_enabled = coalesce((payload ->> 'online_card_enabled')::boolean, online_card_enabled),
    terminal_card_enabled = coalesce((payload ->> 'terminal_card_enabled')::boolean, terminal_card_enabled),
    updated_by_user_id = auth.uid()
  where id = true
  returning * into updated;
  return to_jsonb(updated);
end;
$$;

create or replace function public.wayne_save_payment_terminal(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved public.payment_terminals%rowtype; target_id uuid := nullif(payload ->> 'id', '')::uuid;
begin
  if not public.wayne_has_permission('payments.manage') then
    raise exception 'Payment management permission required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(payload ->> 'label', ''))) = 0 then raise exception 'Name the card reader' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(payload ->> 'device_id', ''))) = 0 then raise exception 'Enter the reader device ID' using errcode = '22023'; end if;
  if target_id is null then
    insert into public.payment_terminals (label, device_id, status, notes, created_by_user_id)
    values (btrim(payload ->> 'label'), btrim(payload ->> 'device_id'),
      coalesce(nullif(payload ->> 'status', ''), 'active'), btrim(coalesce(payload ->> 'notes', '')), auth.uid())
    returning * into saved;
  else
    update public.payment_terminals set
      label = btrim(payload ->> 'label'), device_id = btrim(payload ->> 'device_id'),
      status = coalesce(nullif(payload ->> 'status', ''), status), notes = btrim(coalesce(payload ->> 'notes', notes))
    where id = target_id returning * into saved;
    if not found then raise exception 'Card reader not found' using errcode = 'P0002'; end if;
  end if;
  return to_jsonb(saved);
end;
$$;

-- ============================================================================
-- Online card order: created unpaid and held OUT of the kitchen until the card
-- clears. The deferred kitchen trigger sees the final status of this transaction,
-- so a payment_pending order produces no ticket and no print job.
-- ============================================================================
create or replace function public.wayne_create_card_order(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  settings public.payment_provider_settings%rowtype;
  result jsonb;
  created_order_id uuid;
begin
  select * into settings from public.payment_provider_settings where id = true;
  if not settings.online_card_enabled then
    raise exception 'Card payment is not switched on' using errcode = 'P0001';
  end if;
  result := public.wayne_create_test_order(payload);
  created_order_id := (result ->> 'id')::uuid;
  if coalesce((result ->> 'duplicate')::boolean, false) then return result; end if;

  update public.orders set
    status = 'payment_pending',
    payment_method = 'card',
    pricing_snapshot = pricing_snapshot || jsonb_build_object('payment_mode', 'CARD', 'payment_provider', settings.provider)
  where id = created_order_id and status = 'placed';

  insert into public.order_events (order_id, event_type, from_status, to_status, metadata)
  values (created_order_id, 'order.payment_pending', 'placed', 'payment_pending',
    jsonb_build_object('provider', settings.provider, 'environment', settings.environment));

  return result;
end;
$$;

-- ============================================================================
-- Payment lifecycle. begin -> (provider call happens in the app) -> settle.
-- Both halves are idempotent so a retry, a duplicate webhook, or a browser that
-- closed mid-payment all converge on the same single truth.
-- ============================================================================
create or replace function public.wayne_begin_payment(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  order_row public.orders%rowtype;
  existing public.payments%rowtype;
  created public.payments%rowtype;
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  method_value text := coalesce(nullif(payload ->> 'method', ''), 'card');
  settings public.payment_provider_settings%rowtype;
  terminal_row public.payment_terminals%rowtype;
begin
  if char_length(request_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;
  select * into settings from public.payment_provider_settings where id = true;
  if settings.provider = 'none' then raise exception 'No payment provider is configured' using errcode = 'P0001'; end if;

  select * into existing from public.payments where idempotency_key = request_key;
  if found then return jsonb_build_object('payment_id', existing.id, 'status', existing.status, 'duplicate', true); end if;

  select * into order_row from public.orders where id = (payload ->> 'order_id')::uuid for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if order_row.status = 'cancelled' then raise exception 'This order was cancelled' using errcode = '22023'; end if;
  if order_row.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = order_row.id and status in ('pending', 'authorized', 'captured')) then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;

  if nullif(payload ->> 'terminal_id', '') is not null then
    select * into terminal_row from public.payment_terminals where id = (payload ->> 'terminal_id')::uuid and status = 'active';
    if not found then raise exception 'That card reader is not available' using errcode = 'P0002'; end if;
  end if;

  insert into public.payments (order_id, provider, method, amount_cents, status, idempotency_key, terminal_id, created_by_user_id, metadata)
  values (order_row.id, settings.provider, method_value, order_row.total_cents, 'pending', request_key,
    terminal_row.id, auth.uid(),
    jsonb_build_object('environment', settings.environment, 'entry', coalesce(payload ->> 'entry', 'online')))
  returning * into created;

  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (order_row.id, 'payment.started', auth.uid(),
    jsonb_build_object('payment_id', created.id, 'provider', settings.provider, 'amount_cents', created.amount_cents,
      'entry', coalesce(payload ->> 'entry', 'online')));

  return jsonb_build_object('payment_id', created.id, 'status', 'pending', 'duplicate', false,
    'amount_cents', created.amount_cents, 'order_number', order_row.order_number,
    'location_id', settings.location_id, 'device_id', terminal_row.device_id, 'environment', settings.environment);
end;
$$;

create or replace function public.wayne_settle_payment(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  payment_row public.payments%rowtype;
  order_row public.orders%rowtype;
  next_status text := payload ->> 'status';
  released integer := 0;
begin
  if next_status is null or next_status not in ('authorized', 'captured', 'failed', 'voided') then
    raise exception 'Invalid payment outcome' using errcode = '22023';
  end if;

  select * into payment_row from public.payments
  where (nullif(payload ->> 'payment_id', '') is not null and id = (payload ->> 'payment_id')::uuid)
     or (nullif(payload ->> 'provider_payment_id', '') is not null and provider_payment_id = payload ->> 'provider_payment_id')
     or (nullif(payload ->> 'terminal_checkout_id', '') is not null and terminal_checkout_id = payload ->> 'terminal_checkout_id')
  order by created_at desc limit 1 for update;
  if not found then raise exception 'Payment not found' using errcode = 'P0002'; end if;

  -- A settled payment never changes again except captured <- authorized.
  if payment_row.status = next_status
     or (payment_row.status = 'captured' and next_status <> 'voided')
     or payment_row.status in ('failed', 'voided') then
    return jsonb_build_object('payment_id', payment_row.id, 'status', payment_row.status, 'duplicate', true);
  end if;

  select * into order_row from public.orders where id = payment_row.order_id for update;

  update public.payments set
    status = next_status,
    provider_payment_id = coalesce(nullif(payload ->> 'provider_payment_id', ''), provider_payment_id),
    provider_status = coalesce(nullif(payload ->> 'provider_status', ''), provider_status),
    terminal_checkout_id = coalesce(nullif(payload ->> 'terminal_checkout_id', ''), terminal_checkout_id),
    receipt_url = coalesce(nullif(payload ->> 'receipt_url', ''), receipt_url),
    card_brand = coalesce(nullif(payload ->> 'card_brand', ''), card_brand),
    card_last4 = coalesce(right(nullif(payload ->> 'card_last4', ''), 4), card_last4),
    failure_reason = left(coalesce(nullif(payload ->> 'failure_reason', ''), failure_reason), 500),
    amount_cents = coalesce((payload ->> 'amount_cents')::integer, amount_cents),
    authorized_at = case when next_status in ('authorized', 'captured') then coalesce(authorized_at, now()) else authorized_at end,
    captured_at = case when next_status = 'captured' then coalesce(captured_at, now()) else captured_at end,
    failed_at = case when next_status = 'failed' then coalesce(failed_at, now()) else failed_at end,
    metadata = metadata || coalesce(payload -> 'metadata', '{}'::jsonb)
  where id = payment_row.id;

  if next_status = 'captured' then
    -- Money is in. Only now may the order be paid, and only now may it cook.
    update public.orders set
      payment_status = 'paid',
      payment_method = case when payment_row.method = 'card' then 'card' else payment_method end,
      status = case when status = 'payment_pending' then 'placed' else status end
    where id = order_row.id;
    if order_row.status = 'payment_pending' then
      insert into public.order_events (order_id, event_type, from_status, to_status, metadata)
      values (order_row.id, 'order.placed', 'payment_pending', 'placed', jsonb_build_object('released_by', 'payment'));
    end if;
    insert into public.order_events (order_id, event_type, metadata)
    values (order_row.id, 'payment.captured',
      jsonb_build_object('payment_id', payment_row.id, 'provider', payment_row.provider,
        'provider_payment_id', coalesce(nullif(payload ->> 'provider_payment_id', ''), payment_row.provider_payment_id),
        'amount_cents', coalesce((payload ->> 'amount_cents')::integer, payment_row.amount_cents)));
    if payment_row.terminal_id is not null then
      update public.payment_terminals set last_used_at = now() where id = payment_row.terminal_id;
    end if;

  elsif next_status in ('failed', 'voided') then
    insert into public.order_events (order_id, event_type, metadata)
    values (order_row.id, 'payment.' || next_status,
      jsonb_build_object('payment_id', payment_row.id, 'provider', payment_row.provider,
        'reason', nullif(payload ->> 'failure_reason', '')));
    -- An order that only existed to be paid for never becomes a real order.
    if order_row.status = 'payment_pending' then
      update public.promotions promotion set uses_count = greatest(promotion.uses_count - 1, 0)
      from public.order_discounts discount
      where discount.order_id = order_row.id and discount.promotion_id = promotion.id;
      get diagnostics released = row_count;
      update public.orders set status = 'cancelled', cancelled_at = now() where id = order_row.id;
      insert into public.order_events (order_id, event_type, from_status, to_status, metadata)
      values (order_row.id, 'order.cancelled', 'payment_pending', 'cancelled',
        jsonb_build_object('reason', 'Card payment was not completed', 'promotion_uses_released', released));
    end if;
  end if;

  return jsonb_build_object('payment_id', payment_row.id, 'status', next_status, 'duplicate', false);
end;
$$;

-- ============================================================================
-- Webhook intake. Stored once per provider event id; the caller only processes
-- an event the first time it is seen.
-- ============================================================================
create or replace function public.wayne_record_payment_webhook(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare inserted_id uuid;
begin
  insert into public.payment_webhook_events (provider, event_id, event_type, signature_verified, payload)
  values (coalesce(nullif(payload ->> 'provider', ''), 'square'),
    coalesce(nullif(payload ->> 'event_id', ''), gen_random_uuid()::text),
    coalesce(payload ->> 'event_type', ''),
    coalesce((payload ->> 'signature_verified')::boolean, false),
    coalesce(payload -> 'payload', '{}'::jsonb))
  on conflict (provider, event_id) do nothing
  returning id into inserted_id;
  if inserted_id is null then return jsonb_build_object('duplicate', true); end if;
  return jsonb_build_object('duplicate', false, 'id', inserted_id);
end;
$$;

create or replace function public.wayne_finish_payment_webhook(target_id uuid, error_message text default null)
returns void language sql security definer set search_path = '' as $$
  update public.payment_webhook_events
  set processed_at = now(), processing_error = left(error_message, 1000)
  where id = target_id;
$$;

-- ============================================================================
-- Refunds and voids. Permission is checked when staff open the refund; the
-- provider outcome is written back by the server.
-- ============================================================================
create or replace function public.wayne_begin_refund(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  payment_row public.payments%rowtype;
  order_row public.orders%rowtype;
  existing public.refunds%rowtype;
  created public.refunds%rowtype;
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  amount integer := (payload ->> 'amount_cents')::integer;
  clean_reason text := nullif(btrim(coalesce(payload ->> 'reason', '')), '');
  already_refunded integer;
begin
  if not public.wayne_has_permission('payments.manage') then
    raise exception 'Payment management permission required' using errcode = '42501';
  end if;
  if char_length(request_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;
  if clean_reason is null or char_length(clean_reason) not between 3 and 1000 then
    raise exception 'A refund reason of at least 3 characters is required' using errcode = '22023';
  end if;

  select * into existing from public.refunds where idempotency_key = request_key;
  if found then return jsonb_build_object('refund_id', existing.id, 'status', existing.status, 'duplicate', true); end if;

  select * into payment_row from public.payments where id = (payload ->> 'payment_id')::uuid for update;
  if not found then raise exception 'Payment not found' using errcode = 'P0002'; end if;
  if payment_row.status <> 'captured' then raise exception 'Only a captured payment can be refunded' using errcode = '22023'; end if;

  select coalesce(sum(amount_cents), 0)::integer into already_refunded
  from public.refunds where payment_id = payment_row.id and status in ('pending', 'completed');
  if amount is null or amount <= 0 then raise exception 'Enter a refund amount' using errcode = '22023'; end if;
  if amount + already_refunded > payment_row.amount_cents then
    raise exception 'That is more than the remaining refundable amount' using errcode = '22023';
  end if;

  select * into order_row from public.orders where id = payment_row.order_id;

  insert into public.refunds (payment_id, order_id, amount_cents, reason, status, idempotency_key, created_by_user_id)
  values (payment_row.id, payment_row.order_id, amount, clean_reason, 'pending', request_key, auth.uid())
  returning * into created;

  perform public.wayne_write_audit('payment.refund_started', 'orders', payment_row.order_id::text,
    'Started a ' || (amount / 100.0)::numeric(12,2)::text || ' refund on order ' || order_row.order_number || ': ' || clean_reason,
    '{}'::jsonb,
    jsonb_build_object('refund_id', created.id, 'payment_id', payment_row.id, 'amount_cents', amount, 'order_number', order_row.order_number));

  return jsonb_build_object('refund_id', created.id, 'status', 'pending', 'duplicate', false,
    'provider_payment_id', payment_row.provider_payment_id, 'provider', payment_row.provider, 'amount_cents', amount);
end;
$$;

create or replace function public.wayne_settle_refund(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  refund_row public.refunds%rowtype;
  payment_row public.payments%rowtype;
  order_row public.orders%rowtype;
  next_status text := payload ->> 'status';
  refunded integer;
begin
  if next_status is null or next_status not in ('completed', 'rejected', 'failed') then
    raise exception 'Invalid refund outcome' using errcode = '22023';
  end if;
  select * into refund_row from public.refunds where id = (payload ->> 'refund_id')::uuid for update;
  if not found then raise exception 'Refund not found' using errcode = 'P0002'; end if;
  if refund_row.status <> 'pending' then
    return jsonb_build_object('refund_id', refund_row.id, 'status', refund_row.status, 'duplicate', true);
  end if;

  update public.refunds set
    status = next_status,
    provider_refund_id = coalesce(nullif(payload ->> 'provider_refund_id', ''), provider_refund_id),
    provider_status = coalesce(nullif(payload ->> 'provider_status', ''), provider_status),
    failure_reason = left(nullif(payload ->> 'failure_reason', ''), 500)
  where id = refund_row.id;

  select * into payment_row from public.payments where id = refund_row.payment_id;
  select * into order_row from public.orders where id = refund_row.order_id for update;

  if next_status = 'completed' then
    select coalesce(sum(amount_cents), 0)::integer into refunded
    from public.refunds where payment_id = refund_row.payment_id and status = 'completed';
    update public.orders set
      payment_status = case when refunded >= payment_row.amount_cents then 'refunded' else 'partially_refunded' end
    where id = refund_row.order_id;
    insert into public.order_events (order_id, event_type, metadata)
    values (refund_row.order_id, 'payment.refunded',
      jsonb_build_object('refund_id', refund_row.id, 'amount_cents', refund_row.amount_cents,
        'total_refunded_cents', refunded, 'reason', refund_row.reason));
    perform public.wayne_write_audit('payment.refunded', 'orders', refund_row.order_id::text,
      'Refunded ' || (refund_row.amount_cents / 100.0)::numeric(12,2)::text || ' on order ' || order_row.order_number,
      jsonb_build_object('payment_status', jsonb_build_object('from', order_row.payment_status,
        'to', case when refunded >= payment_row.amount_cents then 'refunded' else 'partially_refunded' end)),
      jsonb_build_object('refund_id', refund_row.id, 'order_number', order_row.order_number,
        'amount_cents', refund_row.amount_cents, 'total_refunded_cents', refunded));
  else
    insert into public.order_events (order_id, event_type, metadata)
    values (refund_row.order_id, 'payment.refund_' || next_status,
      jsonb_build_object('refund_id', refund_row.id, 'amount_cents', refund_row.amount_cents,
        'reason', nullif(payload ->> 'failure_reason', '')));
  end if;

  return jsonb_build_object('refund_id', refund_row.id, 'status', next_status, 'duplicate', false);
end;
$$;

-- ============================================================================
-- Browser-close recovery: an order that never got paid for is not left hanging.
-- ============================================================================
create or replace function public.wayne_expire_stale_card_orders(older_than_minutes integer default 30)
returns integer language plpgsql security definer set search_path = '' as $$
declare expired integer := 0; order_row record;
begin
  for order_row in
    select o.id from public.orders o
    where o.status = 'payment_pending'
      and o.created_at < now() - make_interval(mins => greatest(coalesce(older_than_minutes, 30), 5))
      and not exists (select 1 from public.payments p where p.order_id = o.id and p.status in ('authorized', 'captured'))
  loop
    update public.payments set status = 'failed', failed_at = coalesce(failed_at, now()),
      failure_reason = coalesce(failure_reason, 'Abandoned before the card was charged')
    where order_id = order_row.id and status = 'pending';
    update public.promotions promotion set uses_count = greatest(promotion.uses_count - 1, 0)
    from public.order_discounts discount
    where discount.order_id = order_row.id and discount.promotion_id = promotion.id;
    update public.orders set status = 'cancelled', cancelled_at = now() where id = order_row.id;
    insert into public.order_events (order_id, event_type, from_status, to_status, metadata)
    values (order_row.id, 'order.cancelled', 'payment_pending', 'cancelled',
      jsonb_build_object('reason', 'Checkout was abandoned before payment completed'));
    expired := expired + 1;
  end loop;
  return expired;
end;
$$;

-- ============================================================================
-- Reconciliation: everywhere the ledger and the orders disagree.
-- ============================================================================
create or replace function public.wayne_payment_reconciliation(from_date date, through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  store_timezone text;
  window_start timestamptz;
  window_end timestamptz;
begin
  if not (public.wayne_has_permission('payments.manage') or public.wayne_has_permission('reports.view')) then
    raise exception 'Payment management permission required' using errcode = '42501';
  end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 3660 then
    raise exception 'Invalid report date range' using errcode = '22023';
  end if;
  select settings.timezone into store_timezone from public.store_settings settings where settings.id = true;
  window_start := from_date::timestamp at time zone store_timezone;
  window_end := (through_date + 1)::timestamp at time zone store_timezone;

  return (
    with scoped as (
      select p.*, o.order_number, o.status order_status, o.payment_status order_payment_status, o.total_cents order_total_cents
      from public.payments p join public.orders o on o.id = p.order_id
      where p.created_at >= window_start and p.created_at < window_end
    )
    select jsonb_build_object(
      'totals', jsonb_build_object(
        'payment_count', (select count(*)::integer from scoped),
        'captured_count', (select count(*)::integer from scoped where status = 'captured'),
        'captured_cents', (select coalesce(sum(amount_cents), 0)::bigint from scoped where status = 'captured'),
        'failed_count', (select count(*)::integer from scoped where status = 'failed'),
        'pending_count', (select count(*)::integer from scoped where status = 'pending'),
        'refunded_cents', (select coalesce(sum(r.amount_cents), 0)::bigint from public.refunds r
          where r.status = 'completed' and r.created_at >= window_start and r.created_at < window_end)),
      'exceptions', coalesce((
        select jsonb_agg(jsonb_build_object('order_number', order_number, 'issue', issue, 'detail', detail,
          'amount_cents', amount_cents, 'occurred_at', occurred_at) order by occurred_at desc)
        from (
          select order_number, 'Payment stuck pending' issue,
            'Opened ' || round(extract(epoch from (now() - created_at)) / 60)::text || ' minutes ago with no provider answer' detail,
            amount_cents, created_at occurred_at
          from scoped where status = 'pending' and created_at < now() - interval '15 minutes'
          union all
          select order_number, 'Order paid with no captured payment',
            'Order says paid; the ledger has no captured payment', order_total_cents, created_at
          from scoped where order_payment_status = 'paid' and status <> 'captured'
            and not exists (select 1 from scoped inner_payment
              where inner_payment.order_id = scoped.order_id and inner_payment.status = 'captured')
          union all
          select order_number, 'Captured payment on an unpaid order',
            'The provider captured money the order does not show as paid', amount_cents, created_at
          from scoped where status = 'captured' and order_payment_status not in ('paid', 'partially_refunded', 'refunded')
          union all
          select order_number, 'Amount does not match the order',
            'Captured ' || (amount_cents / 100.0)::numeric(12,2)::text || ' against an order total of ' || (order_total_cents / 100.0)::numeric(12,2)::text,
            amount_cents, created_at
          from scoped where status = 'captured' and amount_cents <> order_total_cents
          union all
          select o.order_number, 'Refund stuck pending',
            'Opened ' || round(extract(epoch from (now() - r.created_at)) / 60)::text || ' minutes ago', r.amount_cents, r.created_at
          from public.refunds r join public.orders o on o.id = r.order_id
          where r.status = 'pending' and r.created_at >= window_start and r.created_at < window_end
        ) rows), '[]'::jsonb),
      'webhook_failures', coalesce((
        select jsonb_agg(jsonb_build_object('event_id', event_id, 'event_type', event_type,
          'signature_verified', signature_verified, 'received_at', received_at, 'processing_error', processing_error)
          order by received_at desc)
        from public.payment_webhook_events
        where received_at >= window_start and received_at < window_end
          and (not signature_verified or processing_error is not null)), '[]'::jsonb)));
end;
$$;

-- ============================================================================
-- Privileges. Server-only functions stay server-only.
-- ============================================================================
do $$
declare
  fn text;
  anon_functions constant text[] := array['public.wayne_payment_checkout_config()'];
  staff_functions constant text[] := array[
    'public.wayne_admin_payment_console()',
    'public.wayne_save_payment_settings(jsonb)',
    'public.wayne_save_payment_terminal(jsonb)',
    'public.wayne_begin_refund(jsonb)',
    'public.wayne_payment_reconciliation(date, date)'];
  server_functions constant text[] := array[
    'public.wayne_create_card_order(jsonb)',
    'public.wayne_begin_payment(jsonb)',
    'public.wayne_settle_payment(jsonb)',
    'public.wayne_record_payment_webhook(jsonb)',
    'public.wayne_finish_payment_webhook(uuid, text)',
    'public.wayne_settle_refund(jsonb)',
    'public.wayne_expire_stale_card_orders(integer)'];
  has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  foreach fn in array anon_functions || staff_functions || server_functions loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    if has_service_role then execute format('grant execute on function %s to service_role', fn); end if;
  end loop;
  foreach fn in array anon_functions loop
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
  foreach fn in array staff_functions loop
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- Sweep abandoned card checkouts every five minutes where the platform provides pg_cron.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'wayne-expire-stale-card-orders';
    perform cron.schedule('wayne-expire-stale-card-orders', '*/5 * * * *',
      $job$select public.wayne_expire_stale_card_orders(30);$job$);
  end if;
exception when others then
  raise notice 'pg_cron needs a project administrator; abandoned card checkouts will be swept on demand instead.';
end;
$$;

comment on table public.payment_provider_settings is
  'Non-secret payment provider configuration. Access tokens and webhook signature keys live in server environment variables, never here.';
comment on function public.wayne_settle_payment(jsonb) is
  'Applies a provider outcome to a payment and its order, once. Only a captured payment may mark an order paid, and a failed payment cancels an order that was only waiting to be paid for.';
