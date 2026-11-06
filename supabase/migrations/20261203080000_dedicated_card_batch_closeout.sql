-- Credit-card day batches are initiated explicitly, independently of cash
-- closeout and report printing. Existing queued payouts keep their identity.
drop trigger if exists closeout_queue_bank_payout on public.day_closeouts;

-- Return the exact batch selected by the queue, including supplementary batches.
create or replace function public.wayne_queue_bank_payout(target_workspace_id uuid,target_location_id uuid,target_day date)
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
  return jsonb_build_object('enabled',true,'queued',batch.id is not null,'added',added,'batch_id',batch.id);
end; $$;

create function public.wayne_close_card_day_batch(target_workspace_id uuid,target_location_id uuid,target_day date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  queued jsonb;
  batch public.closeout_bank_payouts%rowtype;
  counts jsonb;
begin
  -- The existing queue function checks manager permission, store scope, dates,
  -- the enabled control, and globally unique payment/refund membership.
  queued := public.wayne_queue_bank_payout(target_workspace_id,target_location_id,target_day);
  if not coalesce((queued->>'enabled')::boolean,false) or queued ? 'message' then
    return jsonb_build_object('outcome','unavailable','day',target_day,'batch',null,
      'message',coalesce(queued->>'message','Credit card batch closeout is not enabled for this store.'));
  end if;
  select * into batch from public.closeout_bank_payouts
    where workspace_id=target_workspace_id and location_id=target_location_id and business_date=target_day
      and (nullif(queued->>'batch_id','') is null or id=(queued->>'batch_id')::uuid)
    order by created_at desc,id desc limit 1;
  if batch.id is null then
    return jsonb_build_object('outcome','empty','day',target_day,'batch',null,'message','No Stripe card payments or refunds to close out for this date.');
  end if;
  select jsonb_build_object(
    'card_count',count(*) filter(where i.kind='charge'),
    'recorded_card_cents',coalesce(sum(p.amount_cents) filter(where i.kind='charge'),0),
    'refund_count',count(*) filter(where i.kind='refund'),
    'recorded_refund_cents',coalesce(sum(r.amount_cents) filter(where i.kind='refund'),0)) into counts
    from public.closeout_payout_items i
    left join public.payments p on i.kind='charge' and p.id=i.source_id
    left join public.refunds r on i.kind='refund' and r.id=i.source_id
    where i.payout_id=batch.id;
  return jsonb_build_object('outcome',case when coalesce((queued->>'added')::integer,0)>0 then 'queued' else 'existing' end,
    'day',target_day,'batch',jsonb_build_object('id',batch.id,'state',batch.state,'queued_at',batch.created_at,
      'gross_cents',batch.gross_cents,'refund_cents',batch.refund_cents,'fee_cents',batch.fee_cents,'net_cents',batch.net_cents)||counts);
end; $$;
revoke all on function public.wayne_close_card_day_batch(uuid,uuid,date) from public,anon;
grant execute on function public.wayne_close_card_day_batch(uuid,uuid,date) to authenticated,service_role;
