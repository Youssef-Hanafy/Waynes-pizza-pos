-- Orders were "cancelling themselves and being recreated with the same names"
-- (owner, 2026-11-01).
--
-- Production record (11/1 #8 David Mita, #17 James Mccarthy, #21 K Williams;
-- 10/31 #8-#10 Sahne, #16 Carol Mitchell): every one was cancelled by the POS
-- close-out — Back from the payment screen cancelled the sent order and the
-- changed ticket was sent again as a NEW order with a new slip number, and
-- leaving the payment screen (e.g. to ring up the customer at the counter)
-- cancelled it outright.
--
-- Now: a ticket taken back from the payment screen carries `replaces_order_id`
-- when it is sent again.  wayne_create_pos_order validates and prices it exactly
-- as before (same customer, address, menu, discount and minimum rules), but writes
-- it into the ORIGINAL order — same order, same order number, same daily slip
-- number — instead of inserting a new one.  Only an order nobody has paid, put a
-- card on, printed or added to may be replaced; anything else is refused and the
-- cashier opens it from Today's Orders instead.  Its held kitchen ticket is rebuilt
-- (nothing had printed), so the kitchen gets ONE slip with the final order.
--
-- Additive: payloads without `replaces_order_id` behave exactly as before.
-- No table changes.  Re-runnable.

-- All patches are applied to the function text together and executed once (an
-- if/else spanning two anchors is not valid half-applied).  Already applied → no-op.
create temporary table _wayne_patches (n serial, old_text text not null, new_text text not null);
create or replace function pg_temp._wayne_patch_function(target regprocedure, old_text text, new_text text)
returns void language sql as $$ insert into _wayne_patches (old_text, new_text) values (old_text, new_text); $$;

-- 1. Variables.
select pg_temp._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  preset_row public.pos_discounts%rowtype;
begin$o$,
$n$  preset_row public.pos_discounts%rowtype;
  -- resend_keeps_same_order (owner, 2026-11-01)
  replace_target uuid := nullif(payload ->> 'replaces_order_id', '')::uuid;
  replaced public.orders%rowtype;
begin$n$);

-- 2. The order being sent again must still be untouched: no payment, no card attempt in
--    progress, nothing printed, nothing added.  Locked for the rest of the transaction.
select pg_temp._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  if existing_order_id is not null then return (select jsonb_build_object('id', id, 'order_number', order_number, 'total_cents', total_cents, 'duplicate', true) from public.orders where id = existing_order_id); end if;
$o$,
$n$  if existing_order_id is not null then return (select jsonb_build_object('id', id, 'order_number', order_number, 'total_cents', total_cents, 'duplicate', true) from public.orders where id = existing_order_id); end if;
  if replace_target is not null then
    select * into replaced from public.orders where id = replace_target for update;
    if not found then raise exception 'That order was not found. Send the ticket as a new order.' using errcode = 'P0002'; end if;
    if replaced.source not in ('pos', 'phone') or replaced.status <> 'placed' or replaced.payment_status <> 'unpaid' or replaced.parent_order_id is not null
       or exists (select 1 from public.payments p where p.order_id = replaced.id and p.status in ('pending', 'authorized', 'captured'))
       or exists (select 1 from public.print_jobs j where j.order_id = replaced.id and j.job_type in ('kitchen_ticket', 'delivery_receipt', 'kitchen_addition') and j.status <> 'pending')
       or exists (select 1 from public.orders child where child.parent_order_id = replaced.id and child.status <> 'cancelled')
    then
      raise exception 'Order #% already has a payment or a printed slip, so it can''t be sent again. Open it from Today''s Orders to change it.', coalesce(replaced.daily_number::text, replaced.order_number) using errcode = 'P0001';
    end if;
  end if;
$n$);

-- 3. Write into the original order instead of inserting a new one.
select pg_temp._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  insert into public.orders (order_number, customer_id,$o$,
$n$  if replace_target is not null then
    -- What the ticket said before is replaced in full; a promotion it used is given back first.
    update public.promotions promotion set uses_count = greatest(promotion.uses_count - 1, 0)
      from public.order_discounts old_discount
     where old_discount.order_id = replace_target and old_discount.promotion_id = promotion.id;
    delete from public.order_discounts old_row where old_row.order_id = replace_target;
    delete from public.order_item_modifiers old_row where old_row.order_item_id in (select old_item.id from public.order_items old_item where old_item.order_id = replace_target);
    delete from public.order_items old_row where old_row.order_id = replace_target;
    update public.orders target_row set
      customer_id = created_customer_id, source = order_source, fulfillment_type = fulfillment, payment_method = payment_method_value,
      subtotal_cents = subtotal, discount_cents = discount, delivery_fee_cents = delivery_fee, tax_cents = tax, tip_cents = tip, total_cents = total,
      customer_name_snapshot = customer_name, customer_phone_snapshot = normalized_phone, customer_email_snapshot = normalized_email,
      delivery_address_snapshot = address_snapshot, special_instructions = btrim(coalesce(payload ->> 'special_instructions', '')),
      pricing_snapshot = jsonb_build_object('tax_rate_basis_points', settings.tax_rate_basis_points, 'pickup_minimum_cents', settings.pickup_minimum_cents, 'delivery_minimum_cents', settings.delivery_minimum_cents, 'delivery_fee_cents', settings.delivery_fee_cents, 'payment_mode', case when payment_method_value = 'cash' then 'CASH DESIGNATION / UNPAID' else 'TEST / MANUAL' end),
      promised_at = now() + make_interval(mins => case when fulfillment = 'delivery' then settings.delivery_estimate_minutes else settings.pickup_prep_minutes end),
      idempotency_key = request_key, phone_line = coalesce(linked_phone_line, replaced.phone_line), phone_call_id = coalesce(linked_call_id, replaced.phone_call_id),
      is_test = is_test_order
     where target_row.id = replace_target
    returning target_row.id into created_order_id;
  else
  insert into public.orders (order_number, customer_id,$n$);

select pg_temp._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  returning id into created_order_id;
$o$,
$n$  returning id into created_order_id;
  end if;
$n$);

-- 4. The kitchen ticket (still held — nothing printed) is rebuilt from the order as sent
--    now, so the kitchen screen and the one slip show the final ticket.  Logged as a resend.
select pg_temp._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  insert into public.order_events (order_id, event_type, to_status, actor_user_id, metadata) values (created_order_id, 'order.placed', 'placed', auth.uid(), jsonb_build_object('source', order_source, 'payment_mode', payment_method_value));$o$,
$n$  if replace_target is not null then
    delete from public.print_jobs held_job where held_job.order_id = created_order_id and held_job.status = 'pending' and held_job.job_type = 'kitchen_ticket';
    delete from public.kitchen_tickets old_ticket where old_ticket.order_id = created_order_id;
    perform public.wayne_sync_kitchen_order(created_order_id);
    insert into public.order_events (order_id, event_type, actor_user_id, metadata)
    values (created_order_id, 'order.changed_before_payment', auth.uid(), jsonb_build_object('source', order_source, 'payment_mode', payment_method_value,
      'previous_total_cents', replaced.total_cents, 'total_cents', total, 'previous_fulfillment', replaced.fulfillment_type, 'fulfillment', fulfillment, 'idempotency_key', request_key));
  else
  insert into public.order_events (order_id, event_type, to_status, actor_user_id, metadata) values (created_order_id, 'order.placed', 'placed', auth.uid(), jsonb_build_object('source', order_source, 'payment_mode', payment_method_value));
  end if;$n$);

-- 5. The answer says which order it went to and its slip number (unchanged on a resend).
select pg_temp._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  return (select jsonb_build_object('id', id, 'order_number', order_number, 'total_cents', total_cents, 'duplicate', false) from public.orders where id = created_order_id);$o$,
$n$  return (select jsonb_build_object('id', id, 'order_number', order_number, 'total_cents', total_cents, 'duplicate', false, 'replaced', replace_target is not null, 'daily_number', daily_number) from public.orders where id = created_order_id);$n$);

do $$
declare
  definition text := pg_get_functiondef('public.wayne_create_pos_order(jsonb)'::regprocedure);
  patch record;
begin
  if position('resend_keeps_same_order' in definition) > 0 then return; end if; -- already applied
  for patch in select * from _wayne_patches order by n loop
    if position(patch.old_text in definition) = 0 then raise exception 'Patch % for wayne_create_pos_order did not match: %', patch.n, left(patch.old_text, 120); end if;
    definition := replace(definition, patch.old_text, patch.new_text);
  end loop;
  execute definition;
end;
$$;

drop table _wayne_patches;
