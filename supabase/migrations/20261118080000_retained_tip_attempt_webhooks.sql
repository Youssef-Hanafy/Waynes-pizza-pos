-- Retain canceled separate-tip attempt identities in webhook ownership checks.
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
    where t.workspace_id=target_workspace_id and (t.original_provider_id=provider_id or t.replacement_id=provider_id or t.tip_intent_id=provider_id or t.abandoned_tip_id=provider_id);
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
       or provider_id is distinct from op.original_provider_id and provider_id is distinct from op.replacement_id and provider_id is distinct from op.tip_intent_id and provider_id is distinct from op.abandoned_tip_id then
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
