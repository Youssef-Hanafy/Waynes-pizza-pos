-- One durable financial operation per held payment, shared by Tips, drivers and cron.
-- Provider work happens OUTSIDE SQL transactions. A lease fences stale workers;
-- immutable provider intent IDs protect money movement even after a lease expires.
create table if not exists public.pos_tip_capture_control (
  singleton boolean primary key default true check (singleton),
  execution_enabled boolean not null default false
);
insert into public.pos_tip_capture_control(singleton) values (true) on conflict do nothing;

create table if not exists public.pos_tip_operations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique references public.payments(id),
  order_id uuid not null references public.orders(id),
  workspace_id uuid not null references public.workspaces(id),
  location_id uuid references public.locations(id),
  original_provider_id text,
  authorized_cents integer not null check (authorized_cents > 0),
  requested_tip_cents integer not null check (requested_tip_cents between 0 and 100000),
  origin text not null,
  state text not null default 'pending' check (state in ('pending','succeeded')),
  plan jsonb,
  replacement_id text unique,
  fallback_to_capture boolean not null default false,
  result jsonb,
  release_pending boolean not null default false,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'succeeded') = (result is not null))
);
create index if not exists pos_tip_operations_recovery_idx on public.pos_tip_operations(updated_at) where state = 'pending' or release_pending;
alter table public.pos_tip_operations enable row level security;
alter table public.pos_tip_capture_control enable row level security;
revoke all on public.pos_tip_operations, public.pos_tip_capture_control from public, anon, authenticated;
grant select on public.pos_tip_operations, public.pos_tip_capture_control to service_role;
-- Operational stop switch: disables NEW external financial calls, not read-back/webhook reconciliation.
grant update(execution_enabled) on public.pos_tip_capture_control to service_role;

-- Upgrade an existing staging coordinator without replacing financial history.
alter table public.pos_tip_operations add column if not exists tip_intent_id text unique;
alter table public.pos_tip_operations add column if not exists tip_result jsonb;
alter table public.pos_tip_operations add column if not exists abandoned_tip_id text;
alter table public.pos_tip_operations add column if not exists original_result jsonb;

create or replace function public.wayne_claim_tip_operation(target_payment_id uuid, target_workspace_id uuid, requested_tip integer, worker_token uuid, origin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.payments%rowtype;
  op public.pos_tip_operations%rowtype;
  enabled boolean;
begin
  if requested_tip is null or requested_tip not between 0 and 100000 or worker_token is null then
    raise exception 'Invalid tip operation' using errcode = '22023';
  end if;
  -- Every coordinator RPC takes this lock first, including webhook completion.
  perform pg_advisory_xact_lock(hashtextextended(target_payment_id::text, 731));
  select * into op from public.pos_tip_operations where payment_id = target_payment_id for update;
  select * into p from public.payments where id = target_payment_id and workspace_id = target_workspace_id for update;
  if not found or p.provider not in ('stripe','test') or p.method <> 'card' then
    raise exception 'Held payment not found in this workspace' using errcode = 'P0002';
  end if;
  select execution_enabled into enabled from public.pos_tip_capture_control where singleton;
  if op.id is null then
    if not coalesce(enabled,false) then return jsonb_build_object('acquired',false,'disabled',true); end if;
    if p.status <> 'authorized' then return jsonb_build_object('acquired',false,'settled',true); end if;
    insert into public.pos_tip_operations(payment_id,order_id,workspace_id,location_id,original_provider_id,authorized_cents,requested_tip_cents,origin)
      values(p.id,p.order_id,p.workspace_id,p.location_id,p.provider_payment_id,p.amount_cents,requested_tip,left(origin,40)) returning * into op;
  end if;
  if op.tip_intent_id is null and nullif(p.metadata->>'tip_charge_intent','') is not null then
    if (p.metadata->>'tip_charge_cents')::integer <> op.requested_tip_cents then
      raise exception 'Existing separate tip must be reconciled at its saved amount' using errcode='22023';
    end if;
    update public.pos_tip_operations set tip_intent_id=p.metadata->>'tip_charge_intent',fallback_to_capture=true where id=op.id returning * into op;
  end if;
  if op.state = 'succeeded' then
    return jsonb_build_object('acquired',true,'execution_enabled',enabled,'operation',to_jsonb(op));
  end if;
  if op.lease_token is not null and op.lease_expires_at > now() and op.lease_token <> worker_token then
    return jsonb_build_object('acquired',false,'busy',true);
  end if;
  update public.pos_tip_operations set lease_token=worker_token, lease_expires_at=now()+interval '90 seconds',
    -- A failed preflight has made no money request: legitimate edits remain possible.
    requested_tip_cents=case when plan is null then requested_tip else requested_tip_cents end, updated_at=now()
    where id=op.id returning * into op;
  return jsonb_build_object('acquired',true,'execution_enabled',enabled,'operation',to_jsonb(op));
end;
$$;

create or replace function public.wayne_update_tip_operation(target_operation_id uuid, worker_token uuid, action text, details jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  op public.pos_tip_operations%rowtype;
  amount integer;
  fallback_amount integer;
begin
  select * into op from public.pos_tip_operations where id=target_operation_id;
  if not found then raise exception 'Tip operation not found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(op.payment_id::text,731));
  select * into op from public.pos_tip_operations where id=target_operation_id for update;
  if action='hold_released' then
    if op.state<>'succeeded' then raise exception 'The replacement is not reconciled' using errcode='22023'; end if;
    update public.pos_tip_operations set release_pending=false,updated_at=now() where id=op.id returning * into op;
    return to_jsonb(op);
  end if;
  if worker_token is null or op.lease_token is distinct from worker_token then
    raise exception 'Tip operation ownership changed; reconcile before retrying' using errcode='40001';
  end if;
  if action='release' then
    update public.pos_tip_operations set lease_token=null,lease_expires_at=null where id=op.id returning * into op;
    return to_jsonb(op);
  end if;
  if op.state <> 'pending' or op.lease_expires_at <= now() then
    raise exception 'Tip operation lease expired; reconcile before retrying' using errcode='40001';
  end if;
  if action='plan' and op.plan is null then
    amount := (details->>'amount_cents')::integer;
    fallback_amount := (details->>'fallback_amount_cents')::integer;
    if details->>'mode' is null or details->>'mode' not in ('capture','replacement','test')
       or amount is null or amount < op.authorized_cents or amount > op.authorized_cents+op.requested_tip_cents
       or fallback_amount is null or fallback_amount < op.authorized_cents or fallback_amount > amount then
      raise exception 'Invalid tip capture plan' using errcode='22023';
    end if;
    update public.pos_tip_operations set plan=details,updated_at=now() where id=op.id returning * into op;
  elsif action='bind' then
    if op.plan->>'mode' is distinct from 'replacement' or nullif(details->>'provider_id','') is null
       or (op.replacement_id is not null and op.replacement_id<>details->>'provider_id') then
      raise exception 'The replacement intent cannot change' using errcode='22023';
    end if;
    update public.pos_tip_operations set replacement_id=details->>'provider_id',updated_at=now() where id=op.id returning * into op;
  elsif action='omit_tip' then
    if op.tip_intent_id is null or details->>'canceled_id' is distinct from op.tip_intent_id or op.tip_result is not null or not op.fallback_to_capture then
      raise exception 'A charged or uncertain tip cannot be omitted' using errcode='22023';
    end if;
    update public.pos_tip_operations set abandoned_tip_id=tip_intent_id,tip_intent_id=null,requested_tip_cents=0,
      plan=plan||jsonb_build_object('amount_cents',authorized_cents,'fallback_amount_cents',authorized_cents),updated_at=now()
      where id=op.id returning * into op;
  elsif action='bind_tip' then
    if not op.fallback_to_capture or nullif(details->>'provider_id','') is null
       or (op.tip_intent_id is not null and op.tip_intent_id<>details->>'provider_id') then
      raise exception 'The tip intent cannot change' using errcode='22023';
    end if;
    update public.pos_tip_operations set tip_intent_id=details->>'provider_id',updated_at=now() where id=op.id returning * into op;
  elsif action='fallback' then
    -- The server may use this ONLY after retrieving a terminal canceled replacement.
    if op.replacement_id is null or details->>'canceled_id' is distinct from op.replacement_id then
      raise exception 'Cancel the replacement before capturing the original' using errcode='22023';
    end if;
    update public.pos_tip_operations set fallback_to_capture=true,updated_at=now() where id=op.id returning * into op;
  elsif action <> 'plan' then
    raise exception 'Invalid tip operation update' using errcode='22023';
  end if;
  return to_jsonb(op);
end;
$$;

create or replace function public.wayne_complete_tip_operation(target_operation_id uuid, provider_id text, captured_cents integer, card_brand text default null, card_last4 text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  op public.pos_tip_operations%rowtype;
  expected_id text;
  expected_amount integer;
  replacement boolean;
  capture jsonb;
  test_order boolean;
  payment public.payments%rowtype;
begin
  select * into op from public.pos_tip_operations where id=target_operation_id;
  if not found then raise exception 'Tip operation not found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(op.payment_id::text,731));
  select * into op from public.pos_tip_operations where id=target_operation_id for update;
  if op.state='succeeded' then
    if provider_id is distinct from op.result->>'provider_payment_id' or captured_cents is distinct from (op.result->>'captured_cents')::integer then
      raise exception 'Conflicting provider result' using errcode='22023';
    end if;
    return op.result;
  end if;
  replacement := op.plan->>'mode'='replacement' and not op.fallback_to_capture;
  expected_id := case when replacement then op.replacement_id else op.original_provider_id end;
  expected_amount := case when op.tip_intent_id is not null then op.authorized_cents+op.requested_tip_cents else (op.plan->>case when op.fallback_to_capture then 'fallback_amount_cents' else 'amount_cents' end)::integer end;
  if op.tip_intent_id is not null and (op.tip_result is null or op.original_result is null) then
    raise exception 'Both split payment legs must be verified' using errcode='22023';
  end if;
  if op.plan is null or provider_id is distinct from expected_id or captured_cents is distinct from expected_amount then
    raise exception 'Provider result does not match the durable tip operation; manual reconciliation required' using errcode='22023';
  end if;
  select * into payment from public.payments where id=op.payment_id for update;
  if coalesce((payment.metadata->>'tip_capture_applied')::boolean,false)
     and (payment.amount_cents <> captured_cents or (payment.metadata->>'tip_added_cents')::integer is distinct from captured_cents-op.authorized_cents) then
    raise exception 'A conflicting tip was already recorded; manual reconciliation required' using errcode='22023';
  end if;
  select is_test into test_order from public.orders where id=op.order_id;
  capture := jsonb_build_object('order_id',op.order_id,'payment_id',op.payment_id,'captured_cents',captured_cents,
    'tip_cents',captured_cents-op.authorized_cents,'card_brand',card_brand,'card_last4',card_last4,
    'provider_payment_id',provider_id,'is_test',test_order,'tip_provider_payment_id',op.tip_intent_id);
  -- The pointer, amount, order tip and operation receipt commit together. Never
  -- release the authorization based only on an in-memory provider response.
  update public.payments p set provider_payment_id=provider_id,
    metadata=p.metadata || jsonb_build_object('tip_operation_id',op.id) ||
      case when op.tip_intent_id is not null then jsonb_build_object('tip_charge_intent',op.tip_intent_id,'tip_charge_cents',op.requested_tip_cents,'tip_charged_separately',true) else '{}'::jsonb end ||
      case when replacement then jsonb_build_object('replaced_intent',op.original_provider_id,'charged_with_tip',true) else '{}'::jsonb end
    where p.id=op.payment_id and p.status in ('authorized','captured');
  if not found then raise exception 'Payment changed; reconcile the provider result' using errcode='40001'; end if;
  perform public.wayne_pos_apply_card_tips(jsonb_build_array(capture), 'durable_tip_operation');
  update public.pos_tip_operations set state='succeeded',result=capture,release_pending=replacement,
    lease_token=null,lease_expires_at=null,updated_at=now() where id=op.id;
  return capture;
end;
$$;

-- Called only AFTER the configured Stripe webhook signature has been verified.
create or replace function public.wayne_reconcile_tip_webhook(target_workspace_id uuid, provider_id text, captured_cents integer, card_brand text default null, card_last4 text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare op public.pos_tip_operations%rowtype;
begin
  select * into op from public.pos_tip_operations
    where workspace_id=target_workspace_id and (replacement_id=provider_id or original_provider_id=provider_id);
  if not found then return false; end if;
  perform public.wayne_complete_tip_operation(op.id,provider_id,captured_cents,card_brand,card_last4);
  return true;
end;
$$;

revoke all on function public.wayne_claim_tip_operation(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
revoke all on function public.wayne_update_tip_operation(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.wayne_complete_tip_operation(uuid,text,integer,text,text) from public,anon,authenticated;
revoke all on function public.wayne_reconcile_tip_webhook(uuid,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.wayne_claim_tip_operation(uuid,uuid,integer,uuid,text) to service_role;
grant execute on function public.wayne_update_tip_operation(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.wayne_complete_tip_operation(uuid,text,integer,text,text) to service_role;
grant execute on function public.wayne_reconcile_tip_webhook(uuid,text,integer,text,text) to service_role;

-- Additive correction only. Requires the reviewed durable coordinator; never
-- silently install this against an incompatible production schema.
do $$ begin
  if to_regclass('public.pos_tip_operations') is null then
    raise exception 'Durable tip coordinator is required before Stripe reconciliation';
  end if;
end $$;

create or replace function public.wayne_complete_tip_operation(target_operation_id uuid, provider_id text, captured_cents integer, card_brand text default null, card_last4 text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  op public.pos_tip_operations%rowtype;
  expected_id text;
  expected_amount integer;
  replacement boolean;
  capture jsonb;
  test_order boolean;
  payment public.payments%rowtype;
begin
  select * into op from public.pos_tip_operations where id=target_operation_id;
  if not found then raise exception 'Tip operation not found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(op.payment_id::text,731));
  select * into op from public.pos_tip_operations where id=target_operation_id for update;
  if op.state='succeeded' then
    if provider_id is distinct from op.result->>'provider_payment_id' or captured_cents is distinct from (op.result->>'captured_cents')::integer then
      raise exception 'Conflicting provider result' using errcode='22023';
    end if;
    return op.result;
  end if;
  replacement := op.plan->>'mode'='replacement' and not op.fallback_to_capture;
  expected_id := case when replacement then op.replacement_id else op.original_provider_id end;
  expected_amount := case when op.tip_intent_id is not null then op.authorized_cents+op.requested_tip_cents else (op.plan->>case when op.fallback_to_capture then 'fallback_amount_cents' else 'amount_cents' end)::integer end;
  if op.tip_intent_id is not null and (op.tip_result is null or op.original_result is null) then
    raise exception 'Both split payment legs must be verified' using errcode='22023';
  end if;
  if op.plan is null or provider_id is distinct from expected_id or captured_cents is distinct from expected_amount then
    raise exception 'Provider result does not match the durable tip operation; manual reconciliation required' using errcode='22023';
  end if;
  select * into payment from public.payments where id=op.payment_id for update;
  if payment.id is null or payment.workspace_id is distinct from op.workspace_id
     or payment.order_id is distinct from op.order_id or payment.provider not in ('stripe','test')
     or payment.method <> 'card' or payment.status not in ('authorized','captured','failed')
     or payment.provider_payment_id is distinct from op.original_provider_id
       and payment.provider_payment_id is distinct from expected_id
     or exists(select 1 from public.refunds r where r.payment_id=payment.id and r.status in ('pending','completed')) then
    raise exception 'Payment identity, ownership or disposition changed; manual reconciliation required' using errcode='40001';
  end if;
  if replacement and payment.status='captured' and payment.provider_payment_id=op.original_provider_id then
    raise exception 'Original authorization may also have been captured; manual reconciliation required' using errcode='40001';
  end if;
  if coalesce((payment.metadata->>'tip_capture_applied')::boolean,false)
     and (payment.amount_cents <> captured_cents or (payment.metadata->>'tip_added_cents')::integer is distinct from captured_cents-op.authorized_cents) then
    raise exception 'A conflicting tip was already recorded; manual reconciliation required' using errcode='22023';
  end if;
  select is_test into test_order from public.orders where id=op.order_id;
  capture := jsonb_build_object('order_id',op.order_id,'payment_id',op.payment_id,'captured_cents',captured_cents,
    'tip_cents',captured_cents-op.authorized_cents,'card_brand',card_brand,'card_last4',card_last4,
    'provider_payment_id',provider_id,'is_test',test_order,'tip_provider_payment_id',op.tip_intent_id);
  -- The pointer, amount, order tip and operation receipt commit together. Never
  -- release the authorization based only on an in-memory provider response.
  if payment.status='failed' then
    insert into public.order_events(order_id,event_type,metadata)
    values(op.order_id,'payment.reconciled',jsonb_build_object('payment_id',payment.id,'operation_id',op.id,
      'previous_status',payment.status,'previous_provider_status',payment.provider_status,
      'previous_amount_cents',payment.amount_cents,'previous_provider_id',payment.provider_payment_id,
      'provider_id',provider_id,'captured_cents',captured_cents));
  end if;
  update public.payments p set provider_payment_id=provider_id,
    -- This is inside the receipt transaction. Keep failure timestamps/reasons
    -- and events; repair only the disposition justified by the saved receipt.
    status=case when p.status='failed' then 'authorized' else p.status end,
    metadata=p.metadata || jsonb_build_object('tip_operation_id',op.id) ||
      case when op.tip_intent_id is not null then jsonb_build_object('tip_charge_intent',op.tip_intent_id,'tip_charge_cents',op.requested_tip_cents,'tip_charged_separately',true) else '{}'::jsonb end ||
      case when replacement then jsonb_build_object('replaced_intent',op.original_provider_id,'charged_with_tip',true) else '{}'::jsonb end
    where p.id=op.payment_id and p.status in ('authorized','captured','failed');
  if not found then raise exception 'Payment changed; reconcile the provider result' using errcode='40001'; end if;
  perform public.wayne_pos_apply_card_tips(jsonb_build_array(capture), 'durable_tip_operation');
  update public.pos_tip_operations set state='succeeded',result=capture,release_pending=replacement,
    lease_token=null,lease_expires_at=null,updated_at=now() where id=op.id;
  return capture;
end;
$$;

-- Webhook-only entry point. The server must read Stripe with the verified
-- connection's credentials first. Snapshots and arbitrary payment IDs cannot
-- bypass provider/workspace ownership or the coordinator's payment lock.
create or replace function public.wayne_settle_stripe_payment(target_workspace_id uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  p public.payments%rowtype;
  op public.pos_tip_operations%rowtype;
  selected_payment_id uuid;
  provider_id text := nullif(payload->>'provider_payment_id','');
  outcome text := payload->>'status';
  amount integer := (payload->>'amount_cents')::integer;
  capture jsonb;
begin
  if target_workspace_id is null or provider_id is null or outcome is null
     or outcome not in ('authorized','captured','failed','voided') then
    raise exception 'Invalid scoped Stripe outcome' using errcode='22023';
  end if;
  if outcome in ('authorized','captured') and (amount is null or amount<=0) then
    raise exception 'Stripe outcome requires a positive amount' using errcode='22023';
  end if;
  select * into op from public.pos_tip_operations t
    where t.workspace_id=target_workspace_id and (t.original_provider_id=provider_id or t.replacement_id=provider_id or t.tip_intent_id=provider_id);
  if op.id is not null then selected_payment_id:=op.payment_id;
  else
    select t.id into selected_payment_id from public.payments t
      where t.workspace_id=target_workspace_id and t.provider='stripe' and t.provider_payment_id=provider_id;
  end if;
  if selected_payment_id is null then return jsonb_build_object('ignored',true); end if;
  perform pg_advisory_xact_lock(hashtextextended(selected_payment_id::text,731));
  select * into op from public.pos_tip_operations t where t.payment_id=selected_payment_id for update;
  select * into p from public.payments t where t.id=selected_payment_id for update;
  if p.workspace_id is distinct from target_workspace_id or p.provider<>'stripe' then
    return jsonb_build_object('ignored',true);
  end if;
  -- Recheck bindings under the lock: another worker may have moved the pointer
  -- or bound a prepared replacement while the authoritative GET was in flight.
  if op.id is not null then
    if op.workspace_id is distinct from target_workspace_id or op.order_id is distinct from p.order_id
       or provider_id is distinct from op.original_provider_id and provider_id is distinct from op.replacement_id and provider_id is distinct from op.tip_intent_id then
      raise exception 'Stripe operation binding changed' using errcode='40001';
    end if;
    if outcome='captured' and op.tip_intent_id is not null then
      capture:=public.wayne_record_tip_leg(op.id,provider_id,amount,payload->>'card_brand',payload->>'card_last4');
      return jsonb_build_object('reconciled',true,'receipt',capture);
    end if;
    if outcome='captured' then
      capture:=public.wayne_complete_tip_operation(op.id,provider_id,amount,payload->>'card_brand',payload->>'card_last4');
      return jsonb_build_object('reconciled',true,'receipt',capture);
    end if;
    -- Negative/readback notifications cannot undo a reserved or completed
    -- financial operation. Its worker checks the saved provider identities.
    return jsonb_build_object('deferred',true,'operation_id',op.id);
  end if;
  if p.provider_payment_id is distinct from provider_id then return jsonb_build_object('ignored',true); end if;
  if outcome='captured' and (coalesce((payload->>'tip_adjust')::boolean,false)
      or coalesce((p.metadata->>'tip_adjust')::boolean,false)) then
    return jsonb_build_object('deferred',true);
  end if;
  -- A stale GET can finish after a newer GET. Stripe's captured/canceled
  -- outcomes do not reverse, and an authorized intent cannot decline back to
  -- requires_payment_method. Refund/void workflows keep their own paths.
  if p.status in ('captured','voided') then
    if p.status='captured' and outcome='captured' and amount<>p.amount_cents then
      raise exception 'Conflicting captured Stripe amount' using errcode='22023';
    end if;
    return jsonb_build_object('duplicate',true);
  end if;
  if p.status='authorized' and outcome='failed' then return jsonb_build_object('stale',true); end if;
  if p.status='failed' and outcome in ('authorized','captured') then
    if exists(select 1 from public.refunds r where r.payment_id=p.id and r.status in ('pending','completed')) then
      raise exception 'Refund disposition requires manual reconciliation' using errcode='40001';
    end if;
    insert into public.order_events(order_id,event_type,metadata)
      values(p.order_id,'payment.reconciled',jsonb_build_object('payment_id',p.id,
        'previous_status',p.status,'previous_provider_status',p.provider_status,'previous_amount_cents',p.amount_cents,
        'provider_id',provider_id,'authoritative_status',outcome));
    update public.payments set status='pending' where id=p.id;
  end if;
  -- Reuse existing order/tender/audit semantics; never forward caller-supplied
  -- payment_id/checkout_id selectors to the legacy OR-based lookup.
  return public.wayne_settle_payment((payload-array['payment_id','provider_payment_id','terminal_checkout_id']::text[]) ||
    jsonb_build_object('payment_id',p.id,
      'metadata',jsonb_build_object('source','stripe_authoritative_webhook')));
end;
$$;
revoke all on function public.wayne_settle_stripe_payment(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wayne_settle_stripe_payment(uuid,jsonb) to service_role;

-- A split receipt exists only after authoritative readback of BOTH bound legs.
create or replace function public.wayne_record_tip_leg(target_operation_id uuid, provider_id text, captured_cents integer, card_brand text default null, card_last4 text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op public.pos_tip_operations%rowtype; answer jsonb;
begin
  select * into op from public.pos_tip_operations where id=target_operation_id;
  if not found then raise exception 'Tip operation not found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(op.payment_id::text,731));
  select * into op from public.pos_tip_operations where id=target_operation_id for update;
  if op.tip_intent_id is null or not op.fallback_to_capture then raise exception 'No bound split payment' using errcode='22023'; end if;
  answer:=jsonb_build_object('provider_id',provider_id,'amount_cents',captured_cents,'card_brand',card_brand,'card_last4',card_last4);
  if provider_id=op.tip_intent_id and captured_cents=op.requested_tip_cents then
    update public.pos_tip_operations set tip_result=answer,updated_at=now() where id=op.id;
  elsif provider_id=op.original_provider_id and captured_cents=op.authorized_cents then
    update public.pos_tip_operations set original_result=answer,updated_at=now() where id=op.id;
  else raise exception 'Split payment identity or amount mismatch' using errcode='22023'; end if;
  select * into op from public.pos_tip_operations where id=target_operation_id;
  if op.tip_result is null or op.original_result is null then return null; end if;
  return public.wayne_complete_tip_operation(op.id,op.original_provider_id,op.authorized_cents+op.requested_tip_cents,card_brand,card_last4);
end;
$$;
revoke all on function public.wayne_record_tip_leg(uuid,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.wayne_record_tip_leg(uuid,text,integer,text,text) to service_role;

-- Adoption never charges: it freezes a prior release's saved replacement and
-- authoritative amount under the same lock used by every coordinator worker.
create or replace function public.wayne_adopt_legacy_tip_operation(target_payment_id uuid,target_workspace_id uuid,provider_id text,captured_cents integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.payments%rowtype; op public.pos_tip_operations%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_payment_id::text,731));
  select * into op from public.pos_tip_operations where payment_id=target_payment_id;
  if found then
    if op.workspace_id<>target_workspace_id then raise exception 'Workspace mismatch' using errcode='42501'; end if;
    return op.id;
  end if;
  select * into p from public.payments where id=target_payment_id and workspace_id=target_workspace_id for update;
  if not found or p.provider<>'stripe' or p.method<>'card' or p.status not in ('authorized','failed')
     or p.provider_payment_id is distinct from provider_id or p.metadata->>'charged_with_tip' is distinct from 'true'
     or nullif(p.metadata->>'replaced_intent','') is null or captured_cents<p.amount_cents or captured_cents>p.amount_cents+100000 then
    raise exception 'Legacy replacement identity or amount requires review' using errcode='22023';
  end if;
  insert into public.pos_tip_operations(payment_id,order_id,workspace_id,location_id,original_provider_id,authorized_cents,requested_tip_cents,origin,plan,replacement_id)
  values(p.id,p.order_id,p.workspace_id,p.location_id,p.metadata->>'replaced_intent',p.amount_cents,captured_cents-p.amount_cents,'legacy_adoption',
    jsonb_build_object('mode','replacement','amount_cents',captured_cents,'fallback_amount_cents',p.amount_cents),provider_id) returning * into op;
  return op.id;
end;
$$;
revoke all on function public.wayne_adopt_legacy_tip_operation(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.wayne_adopt_legacy_tip_operation(uuid,uuid,text,integer) to service_role;
