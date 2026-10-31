-- Tip before payment on a keyed card (owner, 2026-10-31).
--
-- A delivery customer paying over the phone can add the driver's tip before the
-- card is approved: the POS saves the tip on the order (this function), then
-- wayne_begin_payment opens ONE payment for order + tip ($30 + $5 → $35).
--
-- The amount must be locked from the moment the approval begins.  Until now the
-- tip could still be changed while a payment was 'pending' (approval being
-- created / confirmed), which would leave the order total different from the
-- amount Stripe was asked to approve.  Now a pending payment locks the tip the
-- same way an authorized or captured one already did.  A declined card settles
-- its payment as 'failed', so the tip can be changed again before the next try.
--
-- Only the payment guard is new; the rest is the 2026-10-25 definition unchanged.
-- Re-runnable.
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
  -- Owner, 2026-10-31: once a card approval has started, its amount is locked.
  if exists (select 1 from public.payments p where p.order_id = v_order.id and p.status = 'pending') then
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
