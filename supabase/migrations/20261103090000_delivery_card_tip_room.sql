-- Owner, 2026-10-19: "my dad can't add a tip on the card for delivery."
-- Keyed / saved delivery cards are approved for the order only (no Stripe
-- overcapture); at cash-out the saved card is charged once for order + tip
-- (src/lib/payments/tip-capture.ts).  But max_capture_cents was the order
-- amount, so Deliveries / Tips showed "$0.00 room" and hid the tip box.
-- Give them up to $500 of tip room.
create or replace function public.wayne_delivery_card_tip_room()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.method = 'card' and new.status = 'authorized' and new.metadata ->> 'held_for' = 'delivery_tip'
     and coalesce((new.metadata ->> 'max_capture_cents')::integer, 0) <= new.amount_cents then
    new.metadata := new.metadata || jsonb_build_object('max_capture_cents', new.amount_cents + 50000, 'tip_by_recharge', true);
  end if;
  return new;
end;
$$;
drop trigger if exists payments_delivery_card_tip_room on public.payments;
create trigger payments_delivery_card_tip_room before insert or update of status, metadata, amount_cents on public.payments
  for each row execute function public.wayne_delivery_card_tip_room();

update public.payments set metadata = metadata
 where method = 'card' and status = 'authorized' and metadata ->> 'held_for' = 'delivery_tip'
   and coalesce((metadata ->> 'max_capture_cents')::integer, 0) <= amount_cents;
