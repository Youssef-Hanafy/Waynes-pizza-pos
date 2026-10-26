-- Owner, 2026-10-26:
--   1. "when adding items to a slip it prints" (reverses 2026-10-19): items
--      added to an order whose kitchen ticket already printed now print on
--      their own kitchen slip, marked ADDED; an order edited in other ways
--      (items taken off, quantities or options changed) reprints whole,
--      marked UPDATED.  A ticket still waiting to print just prints the whole
--      order once, as before.
--   2. "remove that whole [W000…] number system overall for the POS … a
--      traditional order number system 1, 2, 3": every list the POS shows
--      now carries the day's number (daily_number) next to the internal one.

create or replace function public.wayne_queue_kitchen_change(target_order_id uuid, added_item_ids uuid[], whole_order boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  o public.orders%rowtype;
  station text;
  ids uuid[];
  job public.print_jobs%rowtype;
  next_payload jsonb;
begin
  select * into o from public.orders where id = target_order_id;
  if not found then return; end if;
  -- Only once the first kitchen ticket is out (or the counter printed it while offline).
  if o.offline_printed_at is null and not exists (
    select 1 from public.print_jobs pj where pj.order_id = o.id and pj.job_type = 'kitchen_ticket' and pj.status in ('printed', 'processing')
  ) then
    return;
  end if;
  if not whole_order and coalesce(cardinality(added_item_ids), 0) = 0 then return; end if;

  for station in
    select distinct coalesce(i.kitchen_route_snapshot, 'kitchen') from public.order_items i
     where i.order_id = o.id and (whole_order or i.id = any(added_item_ids))
  loop
    select coalesce(array_agg(i.id), '{}') into ids from public.order_items i
     where i.order_id = o.id and coalesce(i.kitchen_route_snapshot, 'kitchen') = station and i.id = any(coalesce(added_item_ids, '{}'));
    select * into job from public.print_jobs where order_id = o.id and destination = station and job_type = 'kitchen_addition' for update;
    if found and job.status = 'pending' then
      -- Not printed yet: fold this change into the slip that is waiting.
      next_payload := case
        when whole_order or job.payload ->> 'mode' = 'updated' then jsonb_build_object('order_number', o.order_number, 'mode', 'updated', 'item_ids', '[]'::jsonb)
        else jsonb_build_object('order_number', o.order_number, 'mode', 'added', 'item_ids',
          coalesce((select jsonb_agg(distinct value) from (
            select value from jsonb_array_elements(coalesce(job.payload -> 'item_ids', '[]'::jsonb))
            union all select to_jsonb(id) from unnest(ids) id) merged), '[]'::jsonb)) end;
      update public.print_jobs set payload = next_payload, updated_at = now() where id = job.id;
    else
      next_payload := jsonb_build_object('order_number', o.order_number, 'mode', case when whole_order then 'updated' else 'added' end,
        'item_ids', case when whole_order then '[]'::jsonb else to_jsonb(ids) end);
      if found then
        update public.print_jobs set status = 'pending', attempts = 0, lease_token = null, lease_expires_at = null,
          claimed_by = null, worker_id = null, last_error = null, printed_at = null,
          payload = next_payload, created_at = now(), updated_at = now()
         where id = job.id;
      else
        insert into public.print_jobs (order_id, destination, job_type, payload) values (o.id, station, 'kitchen_addition', next_payload);
      end if;
    end if;
  end loop;
end;
$$;
revoke all on function public.wayne_queue_kitchen_change(uuid, uuid[], boolean) from public, anon, authenticated;

create or replace function public._wayne_patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
begin
  if position(new_text in definition) > 0 then
    return; -- already applied
  end if;
  if position(old_text in definition) = 0 then
    raise exception 'Patch for % did not match: %', target, left(old_text, 120);
  end if;
  execute replace(definition, old_text, new_text);
end;
$$;

-- Add items: the added items print (owner, 2026-10-26).
select public._wayne_patch_function('public.wayne_pos_add_items(uuid,jsonb)'::regprocedure,
$o$  if main.status = 'completed' and owes then$o$,
$n$  perform public.wayne_queue_kitchen_change(main.id, new_ids, false); -- added items print on a kitchen slip (owner, 2026-10-26)
  if main.status = 'completed' and owes then$n$);

-- Edit: added items print; anything taken off or changed reprints the whole order as UPDATED.
select public._wayne_patch_function('public.wayne_pos_edit_items(uuid,jsonb)'::regprocedure,
$o$  if main.status = 'completed' and owes then$o$,
$n$  perform public.wayne_queue_kitchen_change(main.id, new_ids, cardinality(removed_ids) > 0 or changed > 0); -- the kitchen gets a slip for every change (owner, 2026-10-26)
  if main.status = 'completed' and owes then$n$);

drop function public._wayne_patch_function(regprocedure, text, text);

-- The day's number on every list the POS shows (owner, 2026-10-26).
do $$
declare
  fn text;
  definition text;
  patched text;
begin
  foreach fn in array array[
    'wayne_delivery_order_payload', 'wayne_driver_board', 'wayne_phone_board', 'wayne_phone_call_json', 'wayne_pos_apply_card_tips',
    'wayne_pos_customer_orders', 'wayne_pos_delivery_order_json', 'wayne_pos_driver_cashout', 'wayne_day_closeout', 'wayne_sync_kitchen_order'
  ] loop
    for definition in select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = fn loop
      continue when definition ~ '''daily_number''';
      patched := regexp_replace(definition, '''order_number''(\s*),(\s*)(\w+\.)?order_number', '''order_number''\1,\2\3order_number, ''daily_number'', \3daily_number', 'g');
      if patched = definition then raise exception 'No order number found in %', fn; end if;
      execute patched;
    end loop;
  end loop;
end;
$$;

do $$
declare
  definition text := pg_get_functiondef('public.wayne_pos_tip_queue()'::regprocedure);
begin
  if position('o.daily_number' in definition) = 0 then
    if position('select o.id as order_id, o.order_number,' in definition) = 0 then raise exception 'Tip queue did not match'; end if;
    execute replace(definition, 'select o.id as order_id, o.order_number,', 'select o.id as order_id, o.order_number, o.daily_number,');
  end if;
end;
$$;
