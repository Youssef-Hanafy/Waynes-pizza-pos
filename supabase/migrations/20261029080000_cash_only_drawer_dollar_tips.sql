-- Owner, 2026-10-12:
--   1. "Make sure the cash register ONLY opens when you're putting cash into
--      it" — selecting Cash and recording the amount handed over kicks the
--      drawer; submitting an order or a card payment does not.  (This
--      replaces 2026-09-23 "every transaction opens the drawer" and
--      2026-10-11 "every ticket sent opens the drawer".)  The No Sale button
--      still opens it on purpose.
--   2. Dollar tip buttons on the customer screen ($1-$5 by default, editable in
--      Admin -> Settings), stored with the other location settings.

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

-- Sending a ticket no longer opens the drawer.
select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$
  perform public.wayne_queue_drawer_kick(created_order_id, case when is_test_order then 'test order submitted' else 'order submitted' end);$o$,
$n$
  -- The drawer opens only when cash is recorded (owner, 2026-10-12).$n$);

drop function public._wayne_patch_function(regprocedure, text, text);

-- Only cash payments open the drawer.
create or replace function public.wayne_payment_opens_drawer()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.status <> 'captured' or (tg_op = 'UPDATE' and old.status = 'captured') then
    return new;
  end if;
  if new.method = 'cash' then
    perform public.wayne_queue_drawer_kick(new.order_id, 'cash payment');
  end if;
  return new;
end;
$$;
revoke all on function public.wayne_payment_opens_drawer() from public, anon, authenticated;

-- Dollar tip buttons for the customer screen.
update public.location_settings
   set configuration = configuration || jsonb_build_object('suggested_tip_amounts_cents', jsonb_build_array(100, 200, 300, 400, 500))
 where not (configuration ? 'suggested_tip_amounts_cents');
