-- Owner, 2026-10-19: "when you add an item it's printing the slip again and
-- making him recall the order — it should be adding to the same slip."
--
-- A counter / phone order's kitchen ticket (and delivery receipt) waited for
-- the payment step for at most 2 minutes.  Going back with "Add more items",
-- or a card that took a few tries, ran past 2 minutes, so the slip printed on
-- its own without the new items and the cashier had to recall the order.
--
-- Now the slip waits until the order is really finished — paid, Pay later or
-- Cash at the door — and prints ONCE with everything on it (the print station
-- builds the ticket from the order at print time).  Leaving the payment screen
-- without any of those cancels the order (wayne_pos_abandon_order), so nothing
-- prints.  30 minutes is only a backstop so an order can never silently miss
-- the kitchen if the register lost power mid-order.

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
$o$  update public.orders set print_hold_until = now() + interval '2 minutes' where id = created_order_id;$o$,
$n$  -- Waits for paid / Pay later / Cash at the door; 30 minutes is only a backstop (owner, 2026-10-19).
  update public.orders set print_hold_until = now() + interval '30 minutes' where id = created_order_id;$n$);

drop function public._wayne_patch_function(regprocedure, text, text);

comment on column public.orders.print_hold_until is
  'Kitchen ticket / delivery receipt wait for the POS payment step (paid, Pay later, Cash at the door) until this time; 30-minute backstop.';
