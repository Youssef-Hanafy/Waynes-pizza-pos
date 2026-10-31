-- Verification fixes for the delivery tip-before-payment release (2026-10-31, on top of
-- 20261122080000).  Re-runnable; changes no data.
--
-- 1. wayne_pos_set_tip: while an approval is pending, re-sending the SAME tip is a no-op
--    answer instead of an error.  The POS always re-sends the tip on screen before asking
--    for the approval, so after a lost answer the retry was refused by its own lock.
--    A DIFFERENT tip is still refused while the approval is pending.
--
-- 2. wayne_begin_allocated_refund: a delivery card can now hold the phone tip inside the
--    original approval AND an extra tip charged on its own.  The tip leg used to go
--    entirely to the separate charge (e.g. $8.00 against a $3.00 charge, which Stripe
--    refuses).  The separate charge now refunds at most what it charged; the rest of the
--    tip comes off the original.  With no phone tip the legs are exactly as before.

create or replace function public.wayne_pos_set_tip(target_order_id uuid, tip_amount integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order public.orders%rowtype;
  v_settings public.store_settings%rowtype;
  v_tip integer := greatest(coalesce(tip_amount, 0), 0);
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  select * into v_settings from public.store_settings where id = true;
  select * into v_order from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if v_order.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments p where p.order_id = v_order.id and p.status in ('authorized', 'captured')) then
    raise exception 'A payment is already on this order' using errcode = '22023';
  end if;
  -- Owner, 2026-10-31: once a card approval has started, its amount is locked.  Re-sending the
  -- SAME tip (a register retrying after a lost answer) changes nothing and is answered as is.
  if exists (select 1 from public.payments p where p.order_id = v_order.id and p.status = 'pending') then
    if v_tip = v_order.tip_cents then
      return jsonb_build_object('tip_cents', v_order.tip_cents, 'total_cents', v_order.total_cents);
    end if;
    raise exception 'A card payment is being processed for this order, so its amount is locked. Check the card before changing the tip.' using errcode = '22023';
  end if;
  if v_tip > 0 and not v_settings.tips_enabled then raise exception 'Tips are switched off in Admin → Settings' using errcode = '22023'; end if;
  if v_tip > greatest(v_order.subtotal_cents, 100) * 2 then raise exception 'That tip is too high. Check the amount.' using errcode = '22023'; end if;
  update public.orders o set tip_cents = v_tip, total_cents = o.total_cents - o.tip_cents + v_tip where o.id = v_order.id
  returning * into v_order;
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (v_order.id, 'order.tip_set', auth.uid(), jsonb_build_object('tip_cents', v_tip, 'total_cents', v_order.total_cents));
  return jsonb_build_object('tip_cents', v_order.tip_cents, 'total_cents', v_order.total_cents);
end;
$$;
revoke all on function public.wayne_pos_set_tip(uuid, integer) from public, anon;
grant execute on function public.wayne_pos_set_tip(uuid, integer) to authenticated;

create or replace function public.wayne_begin_allocated_refund(payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 p public.payments%rowtype; o public.orders%rowtype; req public.payment_refund_requests%rowtype;
 amount integer := (payload->>'amount_cents')::integer;
 tip integer := coalesce((payload->>'tip_cents')::integer,0);
 request_key text := btrim(coalesce(payload->>'idempotency_key',''));
 why text := btrim(coalesce(payload->>'reason',''));
 total_tip integer; used_base integer; used_tip integer; split_id text; base integer;
 split_cap integer; split_used integer; split_part integer; original_part integer;
begin
 if not public.wayne_has_permission('payments.manage') then raise exception 'Payment management permission required' using errcode='42501'; end if;
 select * into p from public.payments where id=(payload->>'payment_id')::uuid for update;
 if not found or not public.hanafy_can_access_workspace_data(p.workspace_id,array['payments.manage']) then raise exception 'Payment not found or not allowed' using errcode='42501'; end if;
 select * into o from public.orders where id=p.order_id for update;
 if nullif(payload->>'order_id','')::uuid is distinct from p.order_id then raise exception 'Payment does not belong to this order' using errcode='22023'; end if;
 if p.provider<>'stripe' or p.status<>'captured' or p.provider_payment_id is null then raise exception 'Only a captured Stripe payment can be refunded' using errcode='22023'; end if;
 if amount is null or amount<=0 or amount>10000000 or tip<0 or tip>amount or char_length(request_key) not between 16 and 160 or char_length(why) not between 3 and 1000 then raise exception 'Invalid refund allocation' using errcode='22023'; end if;
 select * into req from public.payment_refund_requests where idempotency_key=request_key;
 if found then
  if req.payment_id<>p.id or req.amount_cents<>amount or req.tip_cents<>tip or req.reason<>why then raise exception 'Refund key already used for a different request' using errcode='22023'; end if;
 else
  if exists(select 1 from public.refunds where payment_id=p.id and status in ('pending','completed') and allocation_request_id is null) then raise exception 'Existing refunds require allocation review before another refund' using errcode='22023'; end if;
  if exists(select 1 from public.pos_tip_operations where payment_id=p.id and (state='pending' or release_pending)) then raise exception 'Reconcile the payment operation before refunding' using errcode='40001'; end if;
  if p.amount_cents<>o.total_cents or exists(select 1 from public.payments other where other.order_id=o.id and other.id<>p.id and other.status='captured') then raise exception 'Multiple or mismatched payment receipts require allocation review' using errcode='22023'; end if;
  total_tip := o.tip_cents;
  split_id := nullif(p.metadata->>'tip_charge_intent','');
  if total_tip<0 or total_tip>p.amount_cents or (split_id is not null and split_id=p.provider_payment_id) then raise exception 'Payment allocation requires review' using errcode='22023'; end if;
  select coalesce(sum(amount_cents-coalesce(tip_cents,0)),0),coalesce(sum(tip_cents),0) into used_base,used_tip
   from public.refunds where payment_id=p.id and status in ('pending','completed');
  base := amount-tip;
  if base>p.amount_cents-total_tip-used_base or tip>total_tip-used_tip then raise exception 'That is more than the remaining refundable order amount or tip; select tip explicitly' using errcode='22023'; end if;
  insert into public.payment_refund_requests(payment_id,workspace_id,order_id,idempotency_key,amount_cents,tip_cents,reason,created_by_user_id)
   values(p.id,p.workspace_id,p.order_id,request_key,amount,tip,why,auth.uid()) returning * into req;
  if split_id is null then
   insert into public.refunds(payment_id,order_id,workspace_id,amount_cents,reason,status,idempotency_key,created_by_user_id,allocation_request_id,provider_payment_id,tip_cents)
    values(p.id,p.order_id,p.workspace_id,amount,why,'pending','refund-leg-'||req.id,auth.uid(),req.id,p.provider_payment_id,tip);
  else
   -- Owner, 2026-10-31: a delivery card can hold a tip taken on the phone INSIDE the original
   -- approval and an extra tip charged on its own.  The separate charge can only refund what it
   -- charged (tip_charge_cents); any further tip comes back off the original charge.  Without a
   -- phone tip split_cap equals the whole tip, so the legs are exactly as before.
   split_cap := coalesce(nullif(p.metadata->>'tip_charge_cents','')::integer, total_tip);
   select coalesce(sum(amount_cents),0) into split_used from public.refunds
    where payment_id=p.id and provider_payment_id=split_id and status in ('pending','completed');
   split_part := least(tip, greatest(split_cap-split_used,0));
   original_part := amount-split_part;
   if original_part>0 then
    insert into public.refunds(payment_id,order_id,workspace_id,amount_cents,reason,status,idempotency_key,created_by_user_id,allocation_request_id,provider_payment_id,tip_cents)
     values(p.id,p.order_id,p.workspace_id,original_part,why,'pending','refund-base-'||req.id,auth.uid(),req.id,p.provider_payment_id,tip-split_part);
   end if;
   if split_part>0 then
    insert into public.refunds(payment_id,order_id,workspace_id,amount_cents,reason,status,idempotency_key,created_by_user_id,allocation_request_id,provider_payment_id,tip_cents)
     values(p.id,p.order_id,p.workspace_id,split_part,why,'pending','refund-tip-'||req.id,auth.uid(),req.id,split_id,split_part);
   end if;
  end if;
  perform public.wayne_write_audit('payment.refund_allocated','orders',o.id::text,'Refund allocated; tip explicitly selected','{}',jsonb_build_object('request_id',req.id,'amount_cents',amount,'tip_cents',tip));
 end if;
 return jsonb_build_object('request_id',req.id,'legs',(select jsonb_agg(to_jsonb(r) order by r.tip_cents,r.id) from public.refunds r where r.allocation_request_id=req.id));
end $$;
revoke all on function public.wayne_begin_allocated_refund(jsonb) from public,anon;
grant execute on function public.wayne_begin_allocated_refund(jsonb) to authenticated;
