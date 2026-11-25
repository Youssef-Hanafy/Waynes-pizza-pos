-- Reserve the exact POS balance before dispatching to Payarc Connect.
-- This migration does not register, enable, or change any merchant's processor.
create or replace function public.wayne_begin_payarc_connect_payment(
  target_connection_id uuid, target_order_id uuid, target_terminal_id uuid, target_location_id uuid,
  terminal_serial text, request_key text, expected_cents integer, split_cents integer, actor_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.payment_connections%rowtype;
  o public.orders%rowtype;
  t public.payment_terminals%rowtype;
  p public.payments%rowtype;
  already_paid integer;
  due integer;
  tip integer;
  tax integer;
  reused boolean := false;
begin
  select * into c from public.payment_connections
  where id = target_connection_id and provider = 'payarc' and status = 'connected'
    and purpose in ('online', 'counter_and_online') and (location_id is null or location_id = target_location_id);
  if not found then raise exception 'Payarc merchant connection is unavailable' using errcode = '22023'; end if;
  if actor_id is null or char_length(request_key) not between 16 and 160
    or terminal_serial !~ '^[0-9]{10}$' then
    raise exception 'Invalid reader request' using errcode = '22023';
  end if;
  select * into o from public.orders where id = target_order_id and workspace_id = c.workspace_id
    and location_id = target_location_id for update;
  if not found or o.is_test or o.status in ('cancelled', 'draft', 'payment_pending') or o.payment_status in ('refunded', 'partially_refunded') then
    raise exception 'Order is not payable' using errcode = '22023';
  end if;
  select * into t from public.payment_terminals where id = target_terminal_id and workspace_id = o.workspace_id
    and location_id = o.location_id and status = 'active' and terminal_type = 'provider_reader'
    and device_id = terminal_serial for update;
  if not found then raise exception 'Card reader is not registered for this location' using errcode = '22023'; end if;

  select * into p from public.payments where idempotency_key = request_key;
  if found then
    if p.order_id <> o.id or p.terminal_id is distinct from t.id or p.metadata->>'entry' is distinct from 'payarc_connect'
      or p.amount_cents <> expected_cents then raise exception 'Reader request changed' using errcode = '40001'; end if;
    reused := true;
  else
    -- A reloaded register can resume the existing attempt with a new browser key.
    select * into p from public.payments where order_id = o.id and terminal_id = t.id
      and status = 'pending' and metadata->>'entry' = 'payarc_connect';
    if found then
      if p.amount_cents <> expected_cents then raise exception 'A reader payment with a different amount is open' using errcode = '40001'; end if;
      reused := true;
    end if;
  end if;

  if not reused then
    already_paid := public.wayne_order_paid_cents(o.id);
    due := o.total_cents - already_paid;
    if expected_cents is null or expected_cents <= 0 or expected_cents > due
      or expected_cents <> coalesce(split_cents, due) then
      raise exception 'The order total changed. Review it before charging.' using errcode = '40001';
    end if;
    if exists (select 1 from public.payments where order_id = o.id and status = 'pending')
      or exists (select 1 from public.payments where terminal_id = t.id and status = 'pending') then
      raise exception 'A payment is already in progress on this order or reader' using errcode = '40001';
    end if;

    tip := case when already_paid = 0 and expected_cents = o.total_cents then o.tip_cents else 0 end;
    tax := case when already_paid = 0 and expected_cents = o.total_cents then o.tax_cents else 0 end;
    p.id := gen_random_uuid();
    insert into public.payments (id, workspace_id, location_id, order_id, terminal_id, provider, method,
      amount_cents, status, idempotency_key, created_by_user_id, metadata)
    values (p.id, o.workspace_id, o.location_id, o.id, t.id, 'payarc', 'card', expected_cents, 'pending', request_key, actor_id,
      jsonb_build_object('entry', 'payarc_connect', 'environment', c.environment, 'payarc_connection_id', c.id,
        'payarc_connect_serial', terminal_serial, 'payarc_connect_ref', right(replace(p.id::text, '-', ''), 16),
        'payarc_connect_tip_cents', tip, 'payarc_connect_tax_cents', tax))
    returning * into p;
    insert into public.order_events (workspace_id, order_id, event_type, actor_user_id, metadata)
    values (o.workspace_id, o.id, 'payment.started', actor_id,
      jsonb_build_object('payment_id', p.id, 'provider', p.provider, 'entry', 'payarc_connect', 'amount_cents', p.amount_cents));
  end if;

  return jsonb_build_object('id', p.id, 'terminal_checkout_id', p.terminal_checkout_id, 'status', p.status,
    'amount_cents', p.amount_cents, 'metadata', p.metadata, 'duplicate', reused);
end $$;

create or replace function public.wayne_settle_payarc_connect_payment(target_payment_id uuid, payload jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  p public.payments%rowtype;
  outcome text := payload->>'status';
  trace_id text := payload->>'trace_id';
begin
  select * into p from public.payments where id = target_payment_id and provider = 'payarc'
    and metadata->>'entry' = 'payarc_connect' for update;
  if not found then raise exception 'Reader payment not found' using errcode = 'P0002'; end if;
  if trace_id is not null and p.terminal_checkout_id is not null and p.terminal_checkout_id <> trace_id then
    raise exception 'Reader transaction identity changed' using errcode = '40001';
  end if;
  if p.status <> 'pending' then return p.status; end if;
  if outcome = 'pending' then
    update public.payments set terminal_checkout_id = coalesce(trace_id, p.terminal_checkout_id) where id = p.id;
    return p.status;
  end if;
  if outcome = 'captured' then
    if nullif(payload->>'charge_id', '') is null or trace_id is null then
      raise exception 'Reader approval is missing its charge identity' using errcode = '22023';
    end if;
    update public.payments set provider_payment_id = payload->>'charge_id' where id = p.id;
  end if;
  update public.payments set terminal_checkout_id = coalesce(trace_id, p.terminal_checkout_id) where id = p.id;
  return public.wayne_settle_payment(jsonb_build_object('payment_id', p.id, 'status', outcome,
    'provider_status', payload->>'provider_status', 'card_brand', payload->>'card_brand', 'card_last4', payload->>'card_last4',
    'failure_reason', payload->>'failure_reason'))->>'status';
end $$;

revoke all on function public.wayne_begin_payarc_connect_payment(uuid, uuid, uuid, uuid, text, text, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.wayne_settle_payarc_connect_payment(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.wayne_begin_payarc_connect_payment(uuid, uuid, uuid, uuid, text, text, integer, integer, uuid) to service_role;
grant execute on function public.wayne_settle_payarc_connect_payment(uuid, jsonb) to service_role;

-- Authenticated staff retain the legacy Stripe settlement path. Payarc Connect
-- outcomes come from its authenticated callback or server-to-server lookup.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.wayne_settle_payment(jsonb)'::regprocedure);
  if position('coalesce(payment_row.metadata ->> ''entry'', ''online'') = ''online''' in definition) = 0 then
    raise exception 'Review the processor settlement permission guard';
  end if;
  definition := replace(definition, 'coalesce(payment_row.metadata ->> ''entry'', ''online'') = ''online''',
    'coalesce(payment_row.metadata ->> ''entry'', ''online'') in (''online'', ''payarc_connect'')');
  execute definition;
end $$;
