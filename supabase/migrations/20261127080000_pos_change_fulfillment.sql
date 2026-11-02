-- Net money received, so a delivery fee actually refunded before conversion
-- cannot count as still paid on the changed order. Processor receipts stay gross.
create or replace function public.wayne_order_paid_cents(target_order_id uuid)
returns integer language sql stable security definer set search_path='' as $$
  select greatest(0,coalesce((select sum(p.amount_cents) from public.payments p
    where p.order_id=target_order_id and p.status in ('authorized','captured')),0)
    -coalesce((select sum(r.amount_cents) from public.refunds r where r.order_id=target_order_id and r.status='completed'),0))::integer;
$$;

-- Change the fulfillment of the SAME order atomically. Existing payments are
-- never retried. Fee increases become an outstanding balance; fee reductions
-- on paid orders require an actual ledger refund before changing the total.
create or replace function public.wayne_pos_change_fulfillment(target_order_id uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype;
  settings public.store_settings%rowtype;
  requested text := payload ->> 'fulfillment_type';
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  address jsonb := payload -> 'delivery_address';
  previous_order uuid;
  fee integer;
  previous_type text;
  paid integer;
  revised_total integer;
  duplicate boolean := false;
  cash_payment public.payments%rowtype;
  cash_shift public.register_shifts%rowtype;
  cash_refund uuid;
  refund_due integer;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode='42501'; end if;
  select * into o from public.orders where id=target_order_id for update;
  if not found or not coalesce(public.hanafy_can_access_workspace_data(o.workspace_id,array['pos.access']),false) then
    raise exception 'Order not found or not allowed' using errcode='42501';
  end if;
  if requested not in ('pickup','delivery') or requested is null or char_length(request_key) not between 16 and 160 then
    raise exception 'Invalid order type change' using errcode='22023';
  end if;
  insert into public.order_idempotency(idempotency_key) values(request_key) on conflict do nothing;
  select order_id into previous_order from public.order_idempotency where idempotency_key=request_key for update;
  if previous_order is not null then
    if previous_order<>o.id then raise exception 'This request belongs to another order' using errcode='22023'; end if;
    if not exists(select 1 from public.order_events where order_id=o.id and event_type='order.fulfillment_changed'
      and metadata ->> 'idempotency_key'=request_key and metadata ->> 'to'=requested) then
      raise exception 'This request was already used for a different change' using errcode='22023';
    end if;
    duplicate := true;
  else
    if o.fulfillment_type is distinct from payload ->> 'expected_fulfillment_type'
       or o.total_cents is distinct from (payload ->> 'expected_total_cents')::integer then
      raise exception 'This order changed on another screen. Reopen it before saving.' using errcode='40001';
    end if;
    if o.status in ('completed','cancelled','draft','payment_pending') or o.parent_order_id is not null then
      raise exception 'Only an active main order can switch pickup or delivery' using errcode='22023';
    end if;
    if o.payment_status='refunded' then raise exception 'A fully refunded order cannot change type' using errcode='22023'; end if;
    if exists(select 1 from public.payments where order_id=o.id and status='pending') then
      raise exception 'A card payment is in progress. Finish or cancel it first.' using errcode='40001';
    end if;
    if exists(select 1 from public.delivery_assignments where order_id=o.id and status<>'released'
      and (status in ('picked_up','delivered') or cash_collected_cents>0 or cashout_id is not null)) then
      raise exception 'This delivery is already with the driver or cashed out. Finish its delivery first.' using errcode='22023';
    end if;
    select * into settings from public.store_settings where id=true;
    if o.workspace_id<>public.hanafy_legacy_workspace_id() then raise exception 'This register cannot change that workspace order' using errcode='42501'; end if;
    if requested='delivery' then
      if not settings.delivery_enabled then raise exception 'Delivery is switched off' using errcode='22023'; end if;
      if btrim(coalesce(payload ->> 'customer_name',o.customer_name_snapshot,''))='' or
        char_length(public.wayne_normalize_phone(coalesce(payload ->> 'customer_phone',o.customer_phone_snapshot,'')))<10 then
        raise exception 'Enter the customer name and phone number for delivery' using errcode='22023';
      end if;
      if address is null or jsonb_typeof(address)<>'object' or btrim(coalesce(address ->> 'address1',''))=''
        or btrim(coalesce(address ->> 'city',''))='' or btrim(coalesce(address ->> 'state',''))='' then
        raise exception 'Enter a street address, city and state for delivery' using errcode='22023';
      end if;
      if pg_column_size(address)>8000 then raise exception 'Delivery address is too long' using errcode='22023'; end if;
      if cardinality(settings.delivery_postal_codes)>0 and coalesce(address ->> 'postal_code','')<>''
        and not ((address ->> 'postal_code')=any(settings.delivery_postal_codes)) then
        raise exception 'That address is outside the configured delivery area' using errcode='22023';
      end if;
      if o.subtotal_cents<settings.delivery_minimum_cents then raise exception 'Delivery order minimum is not met' using errcode='22023'; end if;
      if exists(select 1 from public.order_items i join public.menu_items m on m.id=i.menu_item_id
        where i.order_id=o.id and m.special) then
        raise exception 'Specials are pickup only. Remove the special before switching to delivery.' using errcode='22023';
      end if;
    elsif o.subtotal_cents<settings.pickup_minimum_cents then
      raise exception 'Pickup order minimum is not met' using errcode='22023';
    end if;
    if exists(select 1 from public.order_discounts d join public.promotions p on p.id=d.promotion_id
      where d.order_id=o.id and p.fulfillment_type is not null and p.fulfillment_type<>requested) then
      raise exception 'This order has a discount restricted to its current pickup/delivery type' using errcode='22023';
    end if;
    fee := case when requested=o.fulfillment_type then o.delivery_fee_cents when requested='delivery' then settings.delivery_fee_cents else 0 end;
    revised_total := o.total_cents-o.delivery_fee_cents+fee;
    paid := public.wayne_order_paid_cents(o.id);
    if paid>revised_total and coalesce((payload ->> 'refund_cash')::boolean,false) then
      if not public.wayne_has_permission('payments.manage') then raise exception 'A manager must record this cash refund' using errcode='42501'; end if;
      refund_due := paid-revised_total;
      if refund_due>o.delivery_fee_cents or requested<>'pickup' then raise exception 'Only the delivery fee can be refunded here' using errcode='22023'; end if;
      select * into cash_shift from public.register_shifts where id=(payload ->> 'refund_shift_id')::uuid for update;
      if not found or cash_shift.status<>'open' or cash_shift.workspace_id<>o.workspace_id
        or (cash_shift.opened_by_user_id<>auth.uid() and not public.wayne_has_permission('cash.manage')) then
        raise exception 'Use your open cash drawer to return the delivery fee' using errcode='42501';
      end if;
      if (public.wayne_shift_cash_totals(cash_shift.id) ->> 'expected_cash_cents')::integer<refund_due then
        raise exception 'The drawer does not hold enough cash for this refund' using errcode='22023';
      end if;
      select p.* into cash_payment from public.payments p where p.order_id=o.id and p.status='captured' and p.method='cash'
        and p.amount_cents-coalesce((select sum(r.amount_cents) from public.refunds r where r.payment_id=p.id and r.status in ('pending','completed')),0)>=refund_due
        order by p.created_at desc limit 1 for update;
      if not found then raise exception 'This fee was not paid in cash. Refund it to the original card.' using errcode='22023'; end if;
      insert into public.refunds(payment_id,order_id,workspace_id,location_id,shift_id,amount_cents,tip_cents,reason,status,idempotency_key,created_by_user_id)
        values(cash_payment.id,o.id,o.workspace_id,o.location_id,cash_shift.id,refund_due,0,'Delivery fee - changed to pickup','pending',request_key || '-fee-refund',auth.uid()) returning id into cash_refund;
      perform public.wayne_settle_refund(jsonb_build_object('refund_id',cash_refund,'status','completed','provider_status','cash_returned'));
      paid := public.wayne_order_paid_cents(o.id);
    end if;
    if paid>revised_total then
      raise exception 'Refund the delivery fee of % before saving pickup. Use Refund delivery fee, then return here and save.',
        to_char((paid-revised_total)/100.0,'FM$999,990.00') using errcode='22023';
    end if;
    if exists(select 1 from public.payments where order_id=o.id and status='authorized') and fee<>o.delivery_fee_cents then
      raise exception 'This card is approved but not captured. Void its approval in the order payment details, then change the type and take the corrected total.' using errcode='22023';
    end if;
    previous_type := o.fulfillment_type;
    if requested='pickup' then
      update public.delivery_assignments set status='released',released_at=now(),release_reason='Changed to pickup'
        where order_id=o.id and status in ('assigned','accepted');
    end if;
    update public.orders set fulfillment_type=requested,
      customer_name_snapshot=left(btrim(coalesce(payload ->> 'customer_name',o.customer_name_snapshot)),200),
      customer_phone_snapshot=public.wayne_normalize_phone(coalesce(payload ->> 'customer_phone',o.customer_phone_snapshot)),
      delivery_address_snapshot=case when requested='delivery' then address else null end,
      delivery_fee_cents=fee, total_cents=revised_total,
      payment_status=case when paid>0 and paid>=revised_total then 'paid' when paid>0 then 'unpaid' else o.payment_status end,
      status=case when o.status='out_for_delivery' then 'ready' else o.status end,
      out_for_delivery_at=case when o.status='out_for_delivery' then null else o.out_for_delivery_at end
      where id=o.id returning * into o;
    -- Pending/reprinted kitchen tickets and live boards read the changed order.
    update public.kitchen_tickets kt set payload=kt.payload || jsonb_build_object('fulfillment_type',o.fulfillment_type,
      'delivery_address',o.delivery_address_snapshot,'total_cents',o.total_cents),updated_at=now() where order_id=o.id;
    insert into public.order_events(order_id,event_type,actor_user_id,metadata)
      values(o.id,'order.fulfillment_changed',auth.uid(),jsonb_build_object('from',previous_type,'to',requested,
        'delivery_fee_cents',fee,'total_cents',o.total_cents,'paid_cents',paid,'idempotency_key',request_key));
    update public.order_idempotency set order_id=o.id where idempotency_key=request_key;
  end if;
  return jsonb_build_object('order_id',o.id,'fulfillment_type',o.fulfillment_type,'delivery_address',o.delivery_address_snapshot,
    'delivery_fee_cents',o.delivery_fee_cents,'total_cents',o.total_cents,'payment_status',o.payment_status,'duplicate',duplicate);
end;
$$;
revoke all on function public.wayne_pos_change_fulfillment(uuid,jsonb) from public,anon;
grant execute on function public.wayne_pos_change_fulfillment(uuid,jsonb) to authenticated;

-- A recorded delivery-fee refund can reduce the order price while the captured
-- receipt remains gross. The remaining refundable allocation still follows the
-- existing Stripe workflow, including its single-payment and tip checks.
do $$ declare definition text; replacement text; begin
  definition := pg_get_functiondef('public.wayne_begin_allocated_refund(jsonb)'::regprocedure);
  replacement := replace(definition,
    'if p.amount_cents<>o.total_cents or exists',
    'if (p.amount_cents<>o.total_cents and p.amount_cents-coalesce((select sum(r.amount_cents) from public.refunds r where r.payment_id=p.id and r.status=''completed''),0)<>o.total_cents) or exists');
  if replacement=definition then raise exception 'Review allocated refund binding before fulfillment migration'; end if;
  execute replacement;
end $$;

-- The editor previews the saved fee and tip, including after a type change.
do $$ declare definition text; replacement text; begin
  definition := pg_get_functiondef('public.wayne_pos_order_lines(uuid)'::regprocedure);
  replacement := replace(definition,
    '''discount_cents'', main.discount_cents, ''source''',
    '''discount_cents'', main.discount_cents, ''delivery_fee_cents'', main.delivery_fee_cents, ''tip_cents'', main.tip_cents, ''source''');
  if replacement=definition then raise exception 'Review order editor snapshot before fulfillment migration'; end if;
  execute replacement;
end $$;
