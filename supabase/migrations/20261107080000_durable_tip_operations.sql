-- One durable financial operation per held payment, shared by Tips, drivers and cron.
-- Provider work happens OUTSIDE SQL transactions. A lease fences stale workers;
-- immutable provider intent IDs protect money movement even after a lease expires.
create table public.pos_tip_capture_control (
  singleton boolean primary key default true check (singleton),
  execution_enabled boolean not null default true
);
insert into public.pos_tip_capture_control(singleton) values (true);

create table public.pos_tip_operations (
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
create index pos_tip_operations_recovery_idx on public.pos_tip_operations(updated_at) where state = 'pending' or release_pending;
alter table public.pos_tip_operations enable row level security;
alter table public.pos_tip_capture_control enable row level security;
revoke all on public.pos_tip_operations, public.pos_tip_capture_control from public, anon, authenticated;
grant select on public.pos_tip_operations, public.pos_tip_capture_control to service_role;
-- Operational stop switch: disables NEW external financial calls, not read-back/webhook reconciliation.
grant update(execution_enabled) on public.pos_tip_capture_control to service_role;

create function public.wayne_claim_tip_operation(target_payment_id uuid, target_workspace_id uuid, requested_tip integer, worker_token uuid, origin text)
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

create function public.wayne_update_tip_operation(target_operation_id uuid, worker_token uuid, action text, details jsonb default '{}'::jsonb)
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

create function public.wayne_complete_tip_operation(target_operation_id uuid, provider_id text, captured_cents integer, card_brand text default null, card_last4 text default null)
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
  expected_amount := (op.plan->>case when op.fallback_to_capture then 'fallback_amount_cents' else 'amount_cents' end)::integer;
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
    'provider_payment_id',provider_id,'is_test',test_order);
  -- The pointer, amount, order tip and operation receipt commit together. Never
  -- release the authorization based only on an in-memory provider response.
  update public.payments p set provider_payment_id=provider_id,
    metadata=p.metadata || jsonb_build_object('tip_operation_id',op.id) ||
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
create function public.wayne_reconcile_tip_webhook(target_workspace_id uuid, provider_id text, captured_cents integer, card_brand text default null, card_last4 text default null)
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
