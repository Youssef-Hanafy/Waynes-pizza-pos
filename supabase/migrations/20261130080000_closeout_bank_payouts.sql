-- Closeout queues standard Stripe payouts. No historical closeouts are backfilled.
-- Control is server-only and must be bound to a verified merchant and bank first.
create table public.closeout_payout_control (
  location_id uuid primary key,
  workspace_id uuid not null,
  connection_id uuid not null,
  account_id text not null check (account_id like 'acct_%'),
  bank_id text not null check (bank_id like 'ba_%'),
  environment text not null check (environment in ('sandbox','production')),
  start_business_date date not null,
  enabled boolean not null default false,
  worker_url text not null default 'https://app.hanafymedia.com/api/payments/payouts/worker' check (worker_url in ('https://app.hanafymedia.com/api/payments/payouts/worker','https://waynes-pos-staging.vercel.app/api/payments/payouts/worker')),
  created_at timestamptz not null default now(),
  foreign key (location_id,workspace_id) references public.locations(id,workspace_id),
  foreign key (connection_id,workspace_id) references public.payment_connections(id,workspace_id)
);
create table public.closeout_bank_payouts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  location_id uuid not null,
  business_date date not null,
  account_id text not null,
  bank_id text not null,
  connection_id uuid not null references public.payment_connections(id),
  environment text not null check (environment in ('sandbox','production')),
  state text not null default 'waiting' check (state in ('waiting','submitting','pending','in_transit','paid','failed','canceled','review','no_payout')),
  gross_cents bigint,
  refund_cents bigint,
  fee_cents bigint,
  net_cents bigint,
  stripe_payout_id text unique,
  offset_payout_id uuid references public.closeout_bank_payouts(id),
  submitted_at timestamptz,
  arrival_date date,
  message text not null default 'Waiting for card payments to settle.',
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (location_id,workspace_id) references public.locations(id,workspace_id)
);
create table public.closeout_payout_items (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.closeout_bank_payouts(id),
  kind text not null check (kind in ('charge','refund')),
  source_id uuid not null,
  balance_transaction_id text unique,
  transaction_data jsonb,
  unique(kind,source_id)
);
create index closeout_bank_payouts_due on public.closeout_bank_payouts(next_attempt_at) where state in ('waiting','submitting','pending','in_transit','paid');
create index closeout_payout_items_batch on public.closeout_payout_items(payout_id);
alter table public.closeout_payout_control enable row level security;
alter table public.closeout_bank_payouts enable row level security;
alter table public.closeout_payout_items enable row level security;
revoke all on public.closeout_payout_control,public.closeout_bank_payouts,public.closeout_payout_items from public,anon,authenticated;
grant all on public.closeout_payout_control,public.closeout_bank_payouts,public.closeout_payout_items to service_role;

-- Called inside the closeout transaction and by the explicit Store close out action.
create function public.wayne_queue_bank_payout(target_workspace_id uuid,target_location_id uuid,target_day date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  control public.closeout_payout_control%rowtype;
  batch public.closeout_bank_payouts%rowtype;
  zone text;
  candidate record;
  added integer := 0;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'') <> 'service_role' and not public.wayne_has_permission(target_workspace_id,'cash.manage') then
    raise exception 'Only a manager can queue a closeout payout' using errcode='42501';
  end if;
  select * into control from public.closeout_payout_control where location_id=target_location_id and workspace_id=target_workspace_id and enabled for update;
  if not found then return jsonb_build_object('enabled',false,'queued',false); end if;
  select coalesce(nullif(timezone,''),'America/New_York') into zone from public.store_settings where id=true;
  zone := coalesce(zone,'America/New_York');
  if target_day < control.start_business_date or target_day > (now() at time zone zone)::date then
    return jsonb_build_object('enabled',true,'queued',false,'message','This date is outside the bank payout start date.');
  end if;
  select * into batch from public.closeout_bank_payouts
    where location_id=target_location_id and business_date=target_day and state='waiting' and submitted_at is null
      and (lease_until is null or lease_until<now())
    order by created_at desc limit 1 for update;
  for candidate in
    select 'charge'::text kind,p.id source_id from public.payments p join public.orders o on o.id=p.order_id
      where p.workspace_id=target_workspace_id and p.location_id=target_location_id
        and o.workspace_id=target_workspace_id and o.location_id=target_location_id and not o.is_test
        and p.provider='stripe' and p.method='card' and p.status in ('captured','authorized','pending')
        and (coalesce(o.placed_at,o.created_at) at time zone zone)::date=target_day
        and not exists(select 1 from public.closeout_payout_items i where i.kind='charge' and i.source_id=p.id)
    union all
    select 'refund',r.id from public.refunds r join public.payments p on p.id=r.payment_id join public.orders o on o.id=r.order_id
      where r.workspace_id=target_workspace_id and r.location_id=target_location_id
        and p.workspace_id=target_workspace_id and p.provider='stripe' and p.method='card' and not o.is_test
        and r.status in ('completed','pending') and (r.created_at at time zone zone)::date=target_day
        and not exists(select 1 from public.closeout_payout_items i where i.kind='refund' and i.source_id=r.id)
  loop
    if batch.id is null then
      insert into public.closeout_bank_payouts(workspace_id,location_id,business_date,account_id,bank_id,connection_id,environment)
      values(target_workspace_id,target_location_id,target_day,control.account_id,control.bank_id,control.connection_id,control.environment) returning * into batch;
    end if;
    insert into public.closeout_payout_items(payout_id,kind,source_id) values(batch.id,candidate.kind,candidate.source_id) on conflict(kind,source_id) do nothing;
    added := added + 1;
  end loop;
  return jsonb_build_object('enabled',true,'queued',batch.id is not null,'added',added);
end; $$;
revoke all on function public.wayne_queue_bank_payout(uuid,uuid,date) from public,anon;
grant execute on function public.wayne_queue_bank_payout(uuid,uuid,date) to authenticated,service_role;

create function public.wayne_closeout_queue_bank_payout() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform public.wayne_queue_bank_payout(new.workspace_id,new.location_id,new.business_date);
  return new;
end; $$;
revoke all on function public.wayne_closeout_queue_bank_payout() from public,anon,authenticated;
create trigger closeout_queue_bank_payout after insert or update on public.day_closeouts for each row execute function public.wayne_closeout_queue_bank_payout();

-- A single worker at a time prevents pooled Stripe balance races. A stale worker
-- cannot freeze a plan or write an outcome after another worker takes its lease.
create function public.wayne_claim_bank_payout(worker_token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare batch public.closeout_bank_payouts%rowtype; sources jsonb;
begin
  perform pg_advisory_xact_lock(116503,1);
  if exists(select 1 from public.closeout_bank_payouts where lease_until>now()) then return null; end if;
  select q.* into batch from public.closeout_bank_payouts q join public.closeout_payout_control c on c.location_id=q.location_id
    where c.enabled and c.workspace_id=q.workspace_id and c.account_id=q.account_id and c.bank_id=q.bank_id and c.connection_id=q.connection_id and c.environment=q.environment
      and q.state in ('waiting','submitting','pending','in_transit','paid') and q.next_attempt_at<=now()
      and (q.state<>'paid' or q.submitted_at>now()-interval '7 days')
    order by q.next_attempt_at,q.created_at limit 1 for update of q skip locked;
  if batch.id is null then return null; end if;
  update public.closeout_bank_payouts set lease_token=worker_token,lease_until=now()+interval '2 minutes' where id=batch.id returning * into batch;
  -- Refunds added while the day's cards settle must reduce the unsent batch.
  if batch.submitted_at is null then
    insert into public.closeout_payout_items(payout_id,kind,source_id)
      select batch.id,'refund',r.id from public.refunds r
      where r.workspace_id=batch.workspace_id and r.location_id=batch.location_id and r.status in ('completed','pending')
        and exists(select 1 from public.closeout_payout_items i where i.payout_id=batch.id and i.kind='charge' and i.source_id=r.payment_id)
      on conflict(kind,source_id) do nothing;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'source_id',i.source_id,'transaction',i.transaction_data,
    'provider_id',case when i.kind='charge' then p.provider_payment_id else r.provider_refund_id end,
    'payment_id',case when i.kind='charge' then p.id else r.payment_id end,
    'ledger_status',case when i.kind='charge' then p.status else r.status end,
    'refunded_cents',case when i.kind='charge' then (select coalesce(sum(rr.amount_cents),0) from public.refunds rr where rr.payment_id=p.id and rr.status='completed') else 0 end)), '[]'::jsonb) into sources
    from public.closeout_payout_items i
    left join public.payments p on i.kind='charge' and p.id=i.source_id and p.workspace_id=batch.workspace_id and p.location_id=batch.location_id
    left join public.refunds r on i.kind='refund' and r.id=i.source_id and r.workspace_id=batch.workspace_id and r.location_id=batch.location_id
    where i.payout_id=batch.id;
  return jsonb_build_object('batch',to_jsonb(batch),'items',sources);
end; $$;
create function public.wayne_update_bank_payout(target_id uuid,worker_token uuid,action text,details jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare batch public.closeout_bank_payouts%rowtype; carry record;
begin
  select * into batch from public.closeout_bank_payouts where id=target_id for update;
  if batch.id is null or batch.lease_token is distinct from worker_token or batch.lease_until<=now() then raise exception 'Payout lease expired'; end if;
  if action='item' then
    if batch.submitted_at is not null then raise exception 'Payout plan is frozen'; end if;
    update public.closeout_payout_items set transaction_data=details->'transaction',balance_transaction_id=details#>>'{transaction,id}'
      where id=(details->>'item_id')::uuid and payout_id=batch.id;
  elsif action='plan' then
    if batch.submitted_at is not null then raise exception 'Payout plan is already frozen'; end if;
    select coalesce(sum(gross_cents),0) gross,coalesce(sum(refund_cents),0) refunds,coalesce(sum(fee_cents),0) fees,coalesce(sum(net_cents),0) net into carry
      from public.closeout_bank_payouts where workspace_id=batch.workspace_id and account_id=batch.account_id and environment=batch.environment and state='no_payout' and net_cents<0 and offset_payout_id is null;
    if carry.net <> coalesce((details->>'carry_net')::bigint,0) then raise exception 'Refund carry changed; check the plan again'; end if;
    update public.closeout_bank_payouts set offset_payout_id=batch.id where workspace_id=batch.workspace_id and account_id=batch.account_id and environment=batch.environment and state='no_payout' and net_cents<0 and offset_payout_id is null;
    update public.closeout_bank_payouts set state='submitting',submitted_at=now(),gross_cents=(details->>'gross')::bigint+carry.gross,
      refund_cents=(details->>'refunds')::bigint+carry.refunds,fee_cents=(details->>'fees')::bigint+carry.fees,net_cents=(details->>'net')::bigint+carry.net,
      message='Requesting a standard bank payout.',updated_at=now() where id=batch.id;
  elsif action='finish' then
    update public.closeout_bank_payouts set state=coalesce(details->>'state',state),
      stripe_payout_id=coalesce(details->>'payout_id',stripe_payout_id),arrival_date=coalesce((details->>'arrival_date')::date,arrival_date),
      message=left(coalesce(details->>'message',message),500),lease_token=null,lease_until=null,
      next_attempt_at=now()+make_interval(secs=>coalesce((details->>'retry_seconds')::integer,900)),updated_at=now()
      where id=batch.id;
  else raise exception 'Unknown payout update'; end if;
  select * into batch from public.closeout_bank_payouts where id=target_id;
  return to_jsonb(batch);
end; $$;
revoke all on function public.wayne_claim_bank_payout(uuid),public.wayne_update_bank_payout(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.wayne_claim_bank_payout(uuid),public.wayne_update_bank_payout(uuid,uuid,text,jsonb) to service_role;

insert into public.scheduled_job_tokens(name,token) values('closeout_bank_payouts',replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')) on conflict(name) do nothing;
create function public.wayne_call_bank_payout_worker() returns bigint language plpgsql security definer set search_path='' as $$
declare secret text; request_id bigint; target_url text;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return null; end if;
  if not exists(select 1 from public.closeout_payout_control where enabled) then return null; end if;
  select token into secret from public.scheduled_job_tokens where name='closeout_bank_payouts';
  select worker_url into target_url from public.closeout_payout_control where enabled order by created_at limit 1;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)' into request_id
    using target_url,'{}'::jsonb,jsonb_build_object('content-type','application/json','x-wayne-job-token',secret);
  return request_id;
end; $$;
revoke all on function public.wayne_call_bank_payout_worker() from public,anon,authenticated;
do $cron$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('wayne-closeout-bank-payouts','*/5 * * * *','select public.wayne_call_bank_payout_worker();');
  end if;
exception when undefined_table or undefined_function or invalid_schema_name then raise notice 'pg_cron unavailable; schedule the bank payout worker before enabling.';
end $cron$;
