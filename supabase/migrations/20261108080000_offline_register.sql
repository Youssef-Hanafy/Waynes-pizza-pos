-- Owner, 2026-10-24: "when the ELO disconnects from the wifi … I want to make
-- sure that even when not connected to wifi it'll work and once it reconnects
-- it'll put everything that happened online."
--
-- The register now keeps taking orders, cash and Stripe M2 cards while it
-- cannot reach the server.  It prints the kitchen ticket (and a delivery's
-- receipt) itself, straight to the printers on the store network, and opens
-- the cash drawer itself.  When the connection is back it sends each order
-- with the same idempotency key, then its payment.  Three things must then
-- NOT happen again on the server:
--
--   1. the kitchen ticket / delivery receipt printing a second time
--      → orders.offline_printed_at, set from the order payload; the print
--        queue skips orders that have it
--   2. the cash drawer popping open when the old cash sale is recorded
--      → the cash payment carries metadata.offline = true; the drawer trigger
--        skips it
--   3. anything else changes: every online order, payment and print path is
--      exactly as before (the new flags are only ever sent by an offline order)

alter table public.orders add column if not exists offline_printed_at timestamptz;
comment on column public.orders.offline_printed_at is
  'Taken while the register was offline: its kitchen ticket (and delivery receipt) printed at the counter, so the print queue never prints it again.';

create or replace function public._wayne_patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
begin
  if position(new_text in definition) > 0 and position(old_text in new_text) = 0 then
    return; -- already applied
  end if;
  if position(old_text in definition) = 0 then
    raise exception 'Patch for % did not match: %', target, left(old_text, 120);
  end if;
  execute replace(definition, old_text, new_text);
end;
$$;

-- 1a. The order remembers it was handled at the counter while offline.
select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  update public.orders set print_hold_until = now() + interval '30 minutes' where id = created_order_id;$o$,
$n$  -- Offline orders (owner, 2026-10-24): the counter already printed the kitchen ticket, so the queue never prints it again.
  update public.orders set
    print_hold_until = case when coalesce((payload ->> 'offline_printed')::boolean, false) then null else now() + interval '30 minutes' end,
    offline_printed_at = case when coalesce((payload ->> 'offline_printed')::boolean, false) then now() end
  where id = created_order_id;
  if nullif(payload ->> 'offline_taken_at', '') is not null then
    insert into public.order_events (order_id, event_type, actor_user_id, metadata)
    values (created_order_id, 'order.taken_offline', auth.uid(), jsonb_build_object(
      'taken_at', payload ->> 'offline_taken_at', 'local_number', payload ->> 'offline_local_number',
      'printed_at_counter', coalesce((payload ->> 'offline_printed')::boolean, false)));
  end if;$n$);

-- 1b. No kitchen ticket job for an order the counter already printed.
select public._wayne_patch_function('public.wayne_sync_kitchen_order(uuid)'::regprocedure,
$o$ if o.status in ('placed','accepted','in_kitchen','ready') then
  for station in$o$,
$n$ if o.status in ('placed','accepted','in_kitchen','ready') and o.offline_printed_at is null then
  for station in$n$);

-- 1c. No automatic delivery receipt either (the counter printed it with the ticket).
select public._wayne_patch_function('public.wayne_queue_online_order_print()'::regprocedure,
$o$  if kind is null then return new; end if;$o$,
$n$  if kind is null or o.offline_printed_at is not null then return new; end if;$n$);

-- 2a. A cash sale taken offline is recorded as such …
select public._wayne_patch_function('public.wayne_take_cash_payment(jsonb)'::regprocedure,
$o$    jsonb_build_object('entry', 'counter', 'register_shift', shift_row.id))
  returning * into created;$o$,
$n$    jsonb_build_object('entry', 'counter', 'register_shift', shift_row.id)
      || case when coalesce((payload ->> 'offline')::boolean, false)
           then jsonb_build_object('offline', true, 'offline_taken_at', nullif(payload ->> 'offline_taken_at', ''))
           else '{}'::jsonb end)
  returning * into created;$n$);

-- 2b. … and does not pop the drawer again (it opened at the sale).
select public._wayne_patch_function('public.wayne_payment_opens_drawer()'::regprocedure,
$o$  if new.method = 'cash' then$o$,
$n$  if new.method = 'cash' and coalesce(new.metadata ->> 'offline', '') <> 'true' then$n$);

drop function public._wayne_patch_function(regprocedure, text, text);

-- 1d. A register that timed out while the server was still saving the order
-- (slow connection) treats it as offline and prints the kitchen ticket itself.
-- When it sends the order again, the server already has it: mark it handled
-- at the counter too, so its queued kitchen ticket / delivery receipt never
-- print a second copy.
create or replace function public._wayne_patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
begin
  if position(new_text in definition) > 0 and position(old_text in new_text) = 0 then
    return; -- already applied
  end if;
  if position(old_text in definition) = 0 then
    raise exception 'Patch for % did not match: %', target, left(old_text, 120);
  end if;
  execute replace(definition, old_text, new_text);
end;
$$;

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  if existing_order_id is not null then return (select$o$,
$n$  if existing_order_id is not null and coalesce((payload ->> 'offline_printed')::boolean, false) then
    update public.print_jobs set status = 'printed', printed_at = now(), last_error = 'Printed at the counter while offline', updated_at = now()
     where order_id = existing_order_id and job_type in ('kitchen_ticket', 'delivery_receipt') and status = 'pending';
    update public.orders set offline_printed_at = coalesce(offline_printed_at, now()), print_hold_until = null where id = existing_order_id;
  end if;
  if existing_order_id is not null then return (select$n$);

drop function public._wayne_patch_function(regprocedure, text, text);
