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
  expected_amount := (op.plan->>case when op.fallback_to_capture then 'fallback_amount_cents' else 'amount_cents' end)::integer;
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
    'provider_payment_id',provider_id,'is_test',test_order);
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
create function public.wayne_settle_stripe_payment(target_workspace_id uuid, payload jsonb)
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
    where t.workspace_id=target_workspace_id and (t.original_provider_id=provider_id or t.replacement_id=provider_id);
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
       or provider_id is distinct from op.original_provider_id and provider_id is distinct from op.replacement_id then
      raise exception 'Stripe operation binding changed' using errcode='40001';
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
