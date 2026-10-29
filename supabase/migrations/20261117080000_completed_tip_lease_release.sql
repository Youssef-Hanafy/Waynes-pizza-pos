-- Completed receipts have no worker lease left to release.
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
  if action='release' and op.state='succeeded' and op.lease_token is null then
    return to_jsonb(op); -- completion already released ownership atomically
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
