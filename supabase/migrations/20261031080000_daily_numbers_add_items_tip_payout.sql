-- POS 2026-10-13 (owner): daily ticket numbers (1, 2, 3 … each day), add items
-- to an order already sent (Today's Orders → Add items), kitchen "added" tickets,
-- and the close out's tip payout (tips are not store income).

-- ---------------------------------------------------------------------------
-- 1. Daily ticket numbers.  W001052 stays the order's permanent number; the
--    slips, screens and the kitchen say #1, #2, #3 … starting again each day.
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists daily_number integer,
  add column if not exists business_day date,
  add column if not exists parent_order_id uuid references public.orders(id) on delete restrict;
create index if not exists orders_parent_order_idx on public.orders (parent_order_id) where parent_order_id is not null;
create index if not exists orders_business_day_idx on public.orders (workspace_id, business_day);

create table if not exists public.order_day_counters (
  workspace_id uuid not null,
  business_day date not null,
  last_number integer not null default 0,
  primary key (workspace_id, business_day)
);
alter table public.order_day_counters enable row level security;
revoke all on public.order_day_counters from anon, authenticated;

create or replace function public.wayne_store_zone()
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce((select nullif(timezone, '') from public.store_settings where id = true), 'America/New_York');
$function$;

create or replace function public.wayne_assign_daily_number()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  parent_number integer;
begin
  if new.daily_number is not null then return new; end if;
  new.business_day := (coalesce(new.placed_at, new.created_at, now()) at time zone public.wayne_store_zone())::date;
  -- Items added to a paid order go out as an add-on that keeps the order's number.
  if new.parent_order_id is not null then
    select daily_number into parent_number from public.orders where id = new.parent_order_id;
    if parent_number is not null then new.daily_number := parent_number; return new; end if;
  end if;
  insert into public.order_day_counters as counter (workspace_id, business_day, last_number)
  values (coalesce(new.workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), new.business_day, 1)
  on conflict (workspace_id, business_day) do update set last_number = counter.last_number + 1
  returning last_number into new.daily_number;
  return new;
end;
$function$;
revoke all on function public.wayne_assign_daily_number() from public, anon, authenticated;

drop trigger if exists ac_wayne_daily_number on public.orders;
-- "ac_": after the workspace is filled in (aa_) and the service check (ab_).
create trigger ac_wayne_daily_number before insert on public.orders
  for each row execute function public.wayne_assign_daily_number();

-- Orders already placed keep their W number; today's count carries on from them.
insert into public.order_day_counters (workspace_id, business_day, last_number)
select o.workspace_id, (coalesce(o.placed_at, o.created_at) at time zone public.wayne_store_zone())::date, count(*)
  from public.orders o
 where (coalesce(o.placed_at, o.created_at) at time zone public.wayne_store_zone())::date >= (now() at time zone public.wayne_store_zone())::date - 1
 group by 1, 2
on conflict (workspace_id, business_day) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Kitchen tickets for items added after the first ticket printed.
-- ---------------------------------------------------------------------------
alter table public.print_jobs drop constraint if exists print_jobs_job_type_check;
alter table public.print_jobs add constraint print_jobs_job_type_check
  check (job_type = any (array['kitchen_ticket', 'online_order', 'delivery_receipt', 'receipt_request', 'drawer_kick', 'tip_slip', 'kitchen_addition']));

-- ---------------------------------------------------------------------------
-- 3. Price and save ticket lines on an existing order (same rules as
--    wayne_create_pos_order).  Internal: only called by wayne_pos_add_items.
-- ---------------------------------------------------------------------------
create or replace function public.wayne_pos_insert_items(target_order_id uuid, items jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  item_payload jsonb;
  modifier_payload jsonb;
  item_record public.menu_items%rowtype;
  variant_record public.menu_item_variants%rowtype;
  choice_record record;
  group_record record;
  quantity_value integer;
  modifier_quantity integer;
  unit_price integer;
  modifier_total integer;
  line_total integer;
  added integer := 0;
  duplicate_choice_count integer;
  selection_count integer;
  open_price integer;
  open_name text;
  order_item_id uuid;
begin
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 50 then
    raise exception 'Add between 1 and 50 lines' using errcode = '22023';
  end if;
  for item_payload in select value from jsonb_array_elements(items) loop
    quantity_value := coalesce((item_payload ->> 'quantity')::integer, 0);
    if quantity_value not between 1 and 20 then raise exception 'Each ticket quantity must be between 1 and 20' using errcode = '22023'; end if;

    if item_payload ? 'open_item' then
      open_price := (item_payload #>> '{open_item,price_cents}')::integer;
      open_name := btrim(coalesce(item_payload #>> '{open_item,name}', ''));
      if open_price is null or open_price < 0 or open_price > 100000 then raise exception 'Enter a price for the open item' using errcode = '22023'; end if;
      if char_length(open_name) = 0 or char_length(open_name) > 80 then raise exception 'Name the open item' using errcode = '22023'; end if;
      insert into public.order_items (order_id, menu_item_id, variant_id, item_name_snapshot, variant_name_snapshot, unit_price_cents, modifier_unit_total_cents, quantity, line_total_cents, special_instructions, category_name_snapshot)
      values (target_order_id, null, null, open_name, null, open_price, 0, quantity_value, open_price * quantity_value, btrim(coalesce(item_payload ->> 'special_instructions', '')), 'Open food');
      added := added + open_price * quantity_value;
      continue;
    end if;

    select item.* into item_record from public.menu_items item join public.menu_categories category on category.id = item.category_id
     where item.id = (item_payload ->> 'menu_item_id')::uuid and item.pos_visible and item.archived_at is null and not item.sold_out and category.archived_at is null;
    if not found then raise exception 'A ticket item is unavailable' using errcode = 'P0001'; end if;
    if exists (select 1 from public.menu_item_variants variant where variant.menu_item_id = item_record.id and variant.active and variant.archived_at is null) then
      if nullif(item_payload ->> 'variant_id', '') is null then raise exception 'Choose a variant for %', item_record.name using errcode = '22023'; end if;
      select * into variant_record from public.menu_item_variants where id = (item_payload ->> 'variant_id')::uuid and menu_item_id = item_record.id and active and archived_at is null;
      if not found then raise exception 'A selected variant is unavailable' using errcode = 'P0001'; end if;
      unit_price := variant_record.price_cents;
    else
      if nullif(item_payload ->> 'variant_id', '') is not null then raise exception 'Invalid variant selection' using errcode = '22023'; end if;
      variant_record := null; unit_price := item_record.base_price_cents;
    end if;
    if jsonb_typeof(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) <> 'array' then raise exception 'Invalid modifier selections' using errcode = '22023'; end if;
    select count(*) - count(distinct value ->> 'choice_id') into duplicate_choice_count from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb));
    if duplicate_choice_count > 0 then raise exception 'Duplicate modifier choices are not allowed' using errcode = '22023'; end if;
    for modifier_payload in select value from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) loop
      modifier_quantity := coalesce((modifier_payload ->> 'quantity')::integer, 0);
      select choice.id, choice.name, choice.price_delta_cents, modifier_group.id group_id, modifier_group.name group_name, modifier_group.allow_quantities into choice_record
        from public.modifier_choices choice
        join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id
        join public.menu_item_modifier_groups link on link.modifier_group_id = modifier_group.id
       where choice.id = (modifier_payload ->> 'choice_id')::uuid and link.menu_item_id = item_record.id and link.active and choice.active and choice.archived_at is null and modifier_group.active and modifier_group.archived_at is null;
      if not found then raise exception 'A selected modifier is unavailable' using errcode = 'P0001'; end if;
      if modifier_quantity not between 1 and 20 or (not choice_record.allow_quantities and modifier_quantity <> 1) then raise exception 'Invalid modifier quantity' using errcode = '22023'; end if;
    end loop;
    for group_record in select modifier_group.* from public.menu_item_modifier_groups link join public.modifier_groups modifier_group on modifier_group.id = link.modifier_group_id
                         where link.menu_item_id = item_record.id and link.active and modifier_group.active and modifier_group.archived_at is null loop
      select coalesce(sum(case when group_record.allow_quantities then (selected.value ->> 'quantity')::integer else 1 end), 0)::integer into selection_count
        from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) selected
        join public.modifier_choices choice on choice.id = (selected.value ->> 'choice_id')::uuid
       where choice.modifier_group_id = group_record.id;
      if selection_count < group_record.min_select or selection_count > group_record.max_select or (group_record.required and selection_count = 0) then
        raise exception 'Invalid selections for %', group_record.customer_label using errcode = '22023';
      end if;
    end loop;
    modifier_total := public.wayne_line_modifier_total(item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));
    line_total := (unit_price + modifier_total) * quantity_value;
    if line_total < 0 then raise exception 'Item price cannot be negative' using errcode = '22023'; end if;

    insert into public.order_items (order_id, menu_item_id, variant_id, item_name_snapshot, variant_name_snapshot, unit_price_cents, modifier_unit_total_cents, quantity, line_total_cents, special_instructions)
    values (target_order_id, item_record.id, variant_record.id, item_record.name, variant_record.name, unit_price, modifier_total, quantity_value, line_total, btrim(coalesce(item_payload ->> 'special_instructions', '')))
    returning id into order_item_id;
    if coalesce((item_payload ->> 'lists_included')::boolean, false) then
      perform public.wayne_record_removed_included(order_item_id, item_record.id, item_payload -> 'modifiers');
    end if;
    for modifier_payload in select value from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) loop
      select choice.id, choice.name, choice.price_delta_cents, modifier_group.name group_name into choice_record
        from public.modifier_choices choice join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id
       where choice.id = (modifier_payload ->> 'choice_id')::uuid;
      insert into public.order_item_modifiers (order_item_id, modifier_choice_id, modifier_group_name_snapshot, modifier_name_snapshot, price_delta_cents, quantity)
      values (order_item_id, choice_record.id, choice_record.group_name, choice_record.name, choice_record.price_delta_cents, (modifier_payload ->> 'quantity')::integer);
      perform public.wayne_settle_included_modifier(order_item_id, item_record.id, variant_record.id, choice_record.id);
    end loop;
    perform public.wayne_apply_group_allowances(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));
    added := added + line_total;
  end loop;
  return added;
end;
$function$;
revoke all on function public.wayne_pos_insert_items(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Add items to an order already sent (owner, 2026-10-13: "edit orders so
--    you can add items if the customer wants to add something extra").
--
--    Not paid yet  → the items go on the same order; the total, tax and
--                    discount are worked out again; if the kitchen ticket has
--                    already printed, the kitchen gets a ticket with ONLY the
--                    new items ("ADDED TO #12").
--    Already paid  → the money taken stays as it is: the items go on an
--                    add-on for the same customer (same #, no second delivery
--                    fee, no minimum) that is paid on its own.
-- ---------------------------------------------------------------------------
create or replace function public.wayne_pos_add_items(target_order_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  note text := left(btrim(coalesce(payload ->> 'special_instructions', '')), 500);
  existing_order_id uuid;
  main public.orders%rowtype;
  settings public.store_settings%rowtype;
  rate integer;
  added integer;
  new_subtotal integer;
  new_discount integer := 0;
  new_tax integer;
  child_id uuid;
  result_row public.orders%rowtype;
  before_ids uuid[];
  new_ids uuid[];
  station text;
  discount_row record;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if char_length(request_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;
  if jsonb_typeof(payload -> 'items') is distinct from 'array' or jsonb_array_length(payload -> 'items') = 0 then
    raise exception 'Add at least one item' using errcode = '22023';
  end if;

  insert into public.order_idempotency (idempotency_key) values (request_key) on conflict do nothing;
  select request.order_id into existing_order_id from public.order_idempotency request where request.idempotency_key = request_key for update;
  if existing_order_id is not null then
    return (select jsonb_build_object('order_id', o.id, 'mode', case when o.parent_order_id is null then 'merged' else 'add_on' end,
      'order_number', o.order_number, 'daily_number', o.daily_number, 'total_cents', o.total_cents, 'duplicate', true)
      from public.orders o where o.id = existing_order_id);
  end if;

  select * into main from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  -- Adding to an add-on adds to the order it belongs to.
  if main.parent_order_id is not null then
    select * into main from public.orders where id = main.parent_order_id for update;
  end if;
  if main.status in ('cancelled', 'draft', 'payment_pending') then raise exception 'This order can''t take more items' using errcode = '22023'; end if;
  if main.payment_status in ('refunded', 'partially_refunded') then raise exception 'This order was refunded — start a new order instead' using errcode = '22023'; end if;
  select * into settings from public.store_settings where id = true;
  rate := coalesce((main.pricing_snapshot ->> 'tax_rate_basis_points')::integer, settings.tax_rate_basis_points, 0);

  if main.payment_status = 'unpaid' and not exists (select 1 from public.payments p where p.order_id = main.id and p.status in ('authorized', 'captured')) then
    -- Same order: nothing has been charged yet.
    select coalesce(array_agg(id), '{}') into before_ids from public.order_items where order_id = main.id;
    added := public.wayne_pos_insert_items(main.id, payload -> 'items');
    select coalesce(sum(line_total_cents), 0)::integer into new_subtotal from public.order_items where order_id = main.id;
    for discount_row in select * from public.order_discounts where order_id = main.id loop
      -- Same rule as when the order was placed: "fixed" is cents, anything else is basis points of the subtotal.
      discount_row.amount_cents := case
        when discount_row.discount_type_snapshot = 'fixed' then least(new_subtotal, coalesce(discount_row.discount_value_snapshot, discount_row.amount_cents))
        else least(new_subtotal, ((new_subtotal::bigint * discount_row.discount_value_snapshot + 5000) / 10000)::integer) end;
      new_discount := new_discount + discount_row.amount_cents;
      update public.order_discounts set amount_cents = discount_row.amount_cents where id = discount_row.id;
    end loop;
    new_discount := least(new_discount, new_subtotal);
    new_tax := (((new_subtotal - new_discount)::bigint * rate + 5000) / 10000)::integer;
    update public.orders o set
      subtotal_cents = new_subtotal, discount_cents = new_discount, tax_cents = new_tax,
      total_cents = new_subtotal - new_discount + o.delivery_fee_cents + new_tax + o.tip_cents,
      special_instructions = case when note = '' then o.special_instructions else left(btrim(o.special_instructions || case when o.special_instructions = '' then '' else ' · ' end || 'ADDED: ' || note), 1500) end
     where o.id = main.id
    returning * into result_row;
    select coalesce(array_agg(id), '{}') into new_ids from public.order_items where order_id = main.id and not (id = any(before_ids));

    -- The kitchen already has the first ticket: send only what was added.
    if exists (select 1 from public.print_jobs j where j.order_id = main.id and j.job_type = 'kitchen_ticket' and j.status <> 'pending') then
      for station in select distinct coalesce(i.kitchen_route_snapshot, 'kitchen') from public.order_items i where i.id = any(new_ids) loop
        insert into public.print_jobs as job (order_id, destination, job_type, payload, workspace_id, location_id)
        values (main.id, station, 'kitchen_addition',
          jsonb_build_object('item_ids', (select coalesce(jsonb_agg(i.id), '[]'::jsonb) from public.order_items i where i.id = any(new_ids) and coalesce(i.kitchen_route_snapshot, 'kitchen') = station),
            'order_number', main.order_number, 'daily_number', main.daily_number),
          main.workspace_id, main.location_id)
        on conflict (order_id, destination, job_type) do update set
          payload = case when job.status = 'pending'
            then jsonb_set(excluded.payload, '{item_ids}', coalesce(job.payload -> 'item_ids', '[]'::jsonb) || (excluded.payload -> 'item_ids'))
            else excluded.payload end,
          status = 'pending', attempts = 0, last_error = null, lease_token = null, lease_expires_at = null,
          claimed_by = null, worker_id = null, printed_at = null, created_at = now(), updated_at = now();
      end loop;
    end if;
    -- The kitchen screen shows the whole order.
    update public.kitchen_tickets kt set payload = kt.payload || jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.item_name_snapshot, 'variant', i.variant_name_snapshot, 'quantity', i.quantity,
        'instructions', i.special_instructions, 'station', coalesce(i.kitchen_route_snapshot, 'kitchen'),
        'modifiers', coalesce((select jsonb_agg(jsonb_build_object('name', m.modifier_name_snapshot, 'group', m.modifier_group_name_snapshot, 'quantity', m.quantity) order by m.created_at, m.id)
          from public.order_item_modifiers m where m.order_item_id = i.id), '[]'::jsonb)) order by i.created_at, i.id)
        from public.order_items i where i.order_id = main.id), '[]'::jsonb)), updated_at = now()
     where kt.order_id = main.id;

    insert into public.order_events (order_id, event_type, actor_user_id, metadata)
    values (main.id, 'order.items_added', auth.uid(), jsonb_build_object('added_cents', added, 'item_ids', to_jsonb(new_ids), 'total_cents', result_row.total_cents, 'idempotency_key', request_key));
    update public.order_idempotency set order_id = main.id where idempotency_key = request_key;
    return jsonb_build_object('order_id', main.id, 'mode', 'merged', 'order_number', main.order_number, 'daily_number', main.daily_number,
      'added_cents', added, 'total_cents', result_row.total_cents, 'payment_status', result_row.payment_status, 'duplicate', false);
  end if;

  -- Already paid (or the card is approved): the extra is an add-on paid on its own.
  insert into public.orders (order_number, customer_id, source, fulfillment_type, status, payment_status, payment_method,
    subtotal_cents, discount_cents, delivery_fee_cents, tax_cents, tip_cents, total_cents,
    customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, delivery_address_snapshot, special_instructions,
    pricing_snapshot, placed_at, promised_at, created_by_user_id, idempotency_key, phone_line, is_test, parent_order_id,
    workspace_id, location_id)
  values ('W' || lpad(nextval('public.wayne_order_number_seq')::text, 6, '0'), main.customer_id,
    case when main.source in ('pos', 'phone') then main.source else 'pos' end, main.fulfillment_type, 'placed', 'unpaid', 'test_manual',
    0, 0, 0, 0, 0, 0,
    main.customer_name_snapshot, main.customer_phone_snapshot, main.customer_email_snapshot, main.delivery_address_snapshot, note,
    jsonb_build_object('tax_rate_basis_points', rate, 'add_on_to', main.order_number, 'payment_mode', 'ADD-ON'),
    now(), greatest(coalesce(main.promised_at, now()), now()), auth.uid(), request_key, main.phone_line, main.is_test, main.id,
    main.workspace_id, main.location_id)
  returning id into child_id;
  added := public.wayne_pos_insert_items(child_id, payload -> 'items');
  new_tax := ((added::bigint * rate + 5000) / 10000)::integer;
  update public.orders o set subtotal_cents = added, tax_cents = new_tax, total_cents = added + new_tax,
    print_hold_until = now() + interval '2 minutes'
   where o.id = child_id
  returning * into result_row;
  insert into public.order_events (order_id, event_type, to_status, actor_user_id, metadata)
  values (child_id, 'order.placed', 'placed', auth.uid(), jsonb_build_object('source', result_row.source, 'add_on_to', main.order_number));
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (main.id, 'order.add_on_created', auth.uid(), jsonb_build_object('add_on_order_id', child_id, 'add_on_order_number', result_row.order_number, 'added_cents', added));
  update public.order_idempotency set order_id = child_id where idempotency_key = request_key;
  return jsonb_build_object('order_id', child_id, 'mode', 'add_on', 'order_number', result_row.order_number, 'daily_number', result_row.daily_number,
    'parent_order_id', main.id, 'parent_order_number', main.order_number,
    'added_cents', added, 'total_cents', result_row.total_cents, 'payment_status', 'unpaid', 'duplicate', false);
end;
$function$;
revoke all on function public.wayne_pos_add_items(uuid, jsonb) from public, anon;
grant execute on function public.wayne_pos_add_items(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The POS lists and slips carry the day's number and add-ons.
-- ---------------------------------------------------------------------------
create or replace function public.wayne_pos_day_orders(target_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  zone text;
  day date;
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  zone := public.wayne_store_zone();
  day := coalesce(target_day, (now() at time zone zone)::date);
  return jsonb_build_object(
    'day', day,
    'orders', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.placed_at desc)
      from (
        select o.id, o.order_number, o.daily_number, o.parent_order_id,
          parent.order_number as parent_order_number,
          o.customer_name_snapshot as customer_name, o.customer_phone_snapshot as customer_phone,
          o.fulfillment_type, o.source, o.phone_line, o.status, o.payment_method, o.payment_status,
          o.subtotal_cents, o.discount_cents, o.delivery_fee_cents, o.tax_cents, o.tip_cents, o.total_cents,
          coalesce(o.placed_at, o.created_at) as placed_at, o.promised_at, o.ready_at,
          o.out_for_delivery_at, o.completed_at, o.cancelled_at, o.is_test,
          o.delivery_address_snapshot as delivery_address, o.special_instructions,
          staff.display_name as taken_by,
          (select coalesce(sum(i.quantity), 0) from public.order_items i where i.order_id = o.id)::integer as item_count,
          paid.method as paid_method, paid.card_brand, paid.card_last4, paid.tendered_cents, paid.change_cents,
          coalesce(paid.captured_at, paid.authorized_at) as paid_at
        from public.orders o
        left join public.orders parent on parent.id = o.parent_order_id
        left join public.profiles staff on staff.id = o.created_by_user_id
        left join lateral (
          select p.method, p.card_brand, p.card_last4, p.tendered_cents, p.change_cents, p.captured_at, p.authorized_at
            from public.payments p
           where p.order_id = o.id and p.status in ('captured', 'authorized')
           order by coalesce(p.captured_at, p.authorized_at, p.created_at) desc
           limit 1
        ) paid on true
        where o.status <> 'draft'
          and (coalesce(o.placed_at, o.created_at) at time zone zone)::date = day
        order by coalesce(o.placed_at, o.created_at) desc
        limit 500
      ) row_data
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.wayne_pos_open_orders()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not (public.wayne_has_permission('pos.access') and public.wayne_has_permission('orders.manage')) then
    raise exception 'POS order access required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(open_order) order by open_order.placed_at)
    from (
      select id, order_number, daily_number, parent_order_id, customer_name_snapshot as customer_name, fulfillment_type, source, status,
        payment_method, payment_status, total_cents, placed_at, promised_at, ready_at, is_test
      from public.orders
      where status in ('placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery')
        and placed_at > now() - interval '24 hours'
      order by placed_at
      limit 100
    ) open_order), '[]'::jsonb);
end;
$function$;

create or replace function public.wayne_pos_print_document(target_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  settings public.store_settings%rowtype;
begin
  if not (public.wayne_has_permission('pos.access') or public.wayne_has_permission('printing.manage')) then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  select * into settings from public.store_settings where id = true;
  return (
    select jsonb_build_object(
      'store', jsonb_build_object(
        'name', settings.store_name, 'address_line1', settings.address_line1, 'address_line2', settings.address_line2,
        'city', settings.city, 'state', settings.state, 'postal_code', settings.postal_code,
        'phone', settings.public_phone, 'timezone', settings.timezone),
      'order', jsonb_build_object(
        'id', order_row.id, 'order_number', order_row.order_number, 'daily_number', order_row.daily_number,
        'add_on_to', parent.order_number,
        'source', order_row.source,
        'fulfillment_type', order_row.fulfillment_type, 'status', order_row.status,
        'payment_status', order_row.payment_status, 'payment_method', order_row.payment_method,
        'placed_at', order_row.placed_at, 'promised_at', order_row.promised_at,
        'phone_line', order_row.phone_line,
        'customer_name', order_row.customer_name_snapshot, 'customer_phone', order_row.customer_phone_snapshot,
        'delivery_address', order_row.delivery_address_snapshot,
        'special_instructions', order_row.special_instructions,
        'subtotal_cents', order_row.subtotal_cents, 'discount_cents', order_row.discount_cents,
        'delivery_fee_cents', order_row.delivery_fee_cents, 'tax_cents', order_row.tax_cents,
        'tip_cents', order_row.tip_cents, 'total_cents', order_row.total_cents,
        'taken_by', staff.display_name),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', item.id, 'name', item.item_name_snapshot, 'variant', item.variant_name_snapshot,
          'category', item.category_name_snapshot, 'station', coalesce(item.kitchen_route_snapshot, 'kitchen'),
          'quantity', item.quantity, 'line_total_cents', item.line_total_cents,
          'instructions', item.special_instructions,
          'modifiers', coalesce((
            select jsonb_agg(jsonb_build_object('name', modifier.modifier_name_snapshot, 'group', modifier.modifier_group_name_snapshot, 'quantity', modifier.quantity) order by modifier.created_at, modifier.id)
              from public.order_item_modifiers modifier where modifier.order_item_id = item.id), '[]'::jsonb)
        ) order by item.created_at, item.id)
          from public.order_items item where item.order_id = order_row.id), '[]'::jsonb)
    )
    from public.orders order_row
    left join public.orders parent on parent.id = order_row.parent_order_id
    left join public.profiles staff on staff.id = order_row.created_by_user_id
    where order_row.id = target_order_id
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Close out: tip payout and store income without tips.
-- ---------------------------------------------------------------------------
create or replace function public.wayne_day_closeout(target_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  zone text;
  day date;
  result jsonb;
begin
  if not (public.wayne_has_permission('cash.manage') or public.wayne_has_permission('reports.view')) then
    raise exception 'Manager permission required for the close out' using errcode = '42501';
  end if;
  zone := public.wayne_store_zone();
  day := coalesce(target_day, (now() at time zone zone)::date);

  with day_orders as (
    select o.*
      from public.orders o
     where not o.is_test
       and o.status <> 'draft'
       and (coalesce(o.placed_at, o.created_at) at time zone zone)::date = day
  ),
  sold as (select * from day_orders where status <> 'cancelled'),
  paid as (
    -- Money taken on the day's orders: captured, or a card authorised and held for the tip.
    select p.*, o.source as order_source, o.fulfillment_type, o.tip_cents as order_tip_cents,
      case
        when p.method <> 'card' then p.method
        when lower(coalesce(p.card_brand, '')) like '%visa%' then 'visa'
        when lower(coalesce(p.card_brand, '')) like '%master%' then 'mastercard'
        when lower(coalesce(p.card_brand, '')) like '%amex%' or lower(coalesce(p.card_brand, '')) like '%american%' then 'amex'
        when lower(coalesce(p.card_brand, '')) like '%discover%' then 'discover'
        else 'other_card'
      end as brand
      from public.payments p
      join sold o on o.id = p.order_id
     where p.status in ('captured', 'authorized')
  ),
  refunded as (
    select r.*
      from public.refunds r
      join public.orders o on o.id = r.order_id and not o.is_test
     where r.status = 'completed'
       and (r.created_at at time zone zone)::date = day
  ),
  unpaid as (
    select * from sold where payment_status not in ('paid', 'authorized', 'refunded', 'partially_refunded')
  )
  select jsonb_build_object(
    'day', day,
    'timezone', zone,
    'generated_at', now(),
    'sales', (select jsonb_build_object(
        'order_count', count(*),
        'item_count', coalesce((select sum(i.quantity) from public.order_items i join sold s on s.id = i.order_id), 0),
        'subtotal_cents', coalesce(sum(subtotal_cents), 0),
        'discount_cents', coalesce(sum(discount_cents), 0),
        'delivery_fee_cents', coalesce(sum(delivery_fee_cents), 0),
        'tax_cents', coalesce(sum(tax_cents), 0),
        'tip_cents', coalesce(sum(tip_cents), 0),
        'total_cents', coalesce(sum(total_cents), 0),
        'net_sales_cents', coalesce(sum(subtotal_cents - discount_cents), 0),
        'pickup_count', count(*) filter (where fulfillment_type = 'pickup'),
        'delivery_count', count(*) filter (where fulfillment_type = 'delivery'),
        'pickup_total_cents', coalesce(sum(total_cents) filter (where fulfillment_type = 'pickup'), 0),
        'delivery_total_cents', coalesce(sum(total_cents) filter (where fulfillment_type = 'delivery'), 0)
      ) from sold),
    'by_source', (select coalesce(jsonb_object_agg(source, jsonb_build_object('count', n, 'total_cents', cents)), '{}'::jsonb)
        from (select source, count(*) n, sum(total_cents) cents from sold group by source) s),
    'tenders', jsonb_build_object(
      'cash_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'cash'),
      'cash_count', (select count(*) from paid where method = 'cash'),
      'cash_at_counter_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'cash' and provider <> 'cash_on_delivery'),
      'cash_from_drivers_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'cash' and provider = 'cash_on_delivery'),
      'card_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'card'),
      'card_count', (select count(*) from paid where method = 'card'),
      'card_in_store_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'card' and order_source <> 'online'),
      'card_online_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'card' and order_source = 'online'),
      'card_held_for_tip_cents', (select coalesce(sum(amount_cents), 0) from paid where method = 'card' and status = 'authorized'),
      'other_cents', (select coalesce(sum(amount_cents), 0) from paid where method not in ('cash', 'card')),
      'card_tips_cents', (select coalesce(sum(order_tip_cents), 0) from (select distinct order_id, order_tip_cents from paid where method = 'card') t),
      'cash_tips_cents', (select coalesce(sum(order_tip_cents), 0) from (select distinct order_id, order_tip_cents from paid where method = 'cash') t)
    ),
    'card_brands', (select coalesce(jsonb_object_agg(brand, jsonb_build_object('count', n, 'cents', cents, 'in_store_cents', store_cents, 'online_cents', online_cents)), '{}'::jsonb)
        from (select brand, count(*) n, sum(amount_cents) cents,
                coalesce(sum(amount_cents) filter (where order_source <> 'online'), 0) store_cents,
                coalesce(sum(amount_cents) filter (where order_source = 'online'), 0) online_cents
                from paid where method = 'card' group by brand) b),
    'online', (select jsonb_build_object(
        'order_count', count(*),
        'pickup_count', count(*) filter (where fulfillment_type = 'pickup'),
        'delivery_count', count(*) filter (where fulfillment_type = 'delivery'),
        'subtotal_cents', coalesce(sum(subtotal_cents), 0),
        'discount_cents', coalesce(sum(discount_cents), 0),
        'delivery_fee_cents', coalesce(sum(delivery_fee_cents), 0),
        'tax_cents', coalesce(sum(tax_cents), 0),
        'tip_cents', coalesce(sum(tip_cents), 0),
        'total_cents', coalesce(sum(total_cents), 0),
        'paid_card_cents', (select coalesce(sum(amount_cents), 0) from paid where order_source = 'online' and method = 'card'),
        'paid_cash_cents', (select coalesce(sum(amount_cents), 0) from paid where order_source = 'online' and method = 'cash'),
        'unpaid_count', (select count(*) from unpaid where source = 'online'),
        'unpaid_cents', (select coalesce(sum(total_cents), 0) from unpaid where source = 'online')
      ) from sold where source = 'online'),
    'in_store', (select jsonb_build_object(
        'order_count', count(*),
        'counter_count', count(*) filter (where source = 'pos'),
        'phone_count', count(*) filter (where source = 'phone'),
        'total_cents', coalesce(sum(total_cents), 0)
      ) from sold where source <> 'online'),
    'refunds', jsonb_build_object(
      'count', (select count(*) from refunded),
      'cents', (select coalesce(sum(amount_cents), 0) from refunded),
      'cash_cents', (select coalesce(sum(r.amount_cents), 0) from refunded r join public.payments p on p.id = r.payment_id where p.method = 'cash')),
    'voids', (select jsonb_build_object('count', count(*), 'total_cents', coalesce(sum(total_cents), 0)) from day_orders where status = 'cancelled'),
    'unpaid', (select jsonb_build_object('count', count(*), 'total_cents', coalesce(sum(total_cents), 0),
        'orders', coalesce(jsonb_agg(jsonb_build_object('id', id, 'order_number', order_number, 'customer_name', customer_name_snapshot,
          'source', source, 'fulfillment_type', fulfillment_type, 'total_cents', total_cents, 'payment_method', payment_method) order by placed_at), '[]'::jsonb))
      from unpaid),
    'drawer', jsonb_build_object(
      'open_shifts', coalesce((select jsonb_agg(jsonb_build_object('id', shift.id, 'register_label', register.label, 'opened_at', shift.opened_at)
          || public.wayne_shift_cash_totals(shift.id) order by shift.opened_at)
        from public.register_shifts shift join public.registers register on register.id = shift.register_id
        where shift.status = 'open'), '[]'::jsonb),
      'closed_today', coalesce((select jsonb_agg(jsonb_build_object('id', shift.id, 'register_label', register.label,
          'opened_at', shift.opened_at, 'closed_at', shift.closed_at, 'opening_cash_cents', shift.opening_cash_cents,
          'expected_cash_cents', shift.expected_cash_cents, 'counted_cash_cents', shift.counted_cash_cents, 'variance_cents', shift.variance_cents) order by shift.closed_at)
        from public.register_shifts shift join public.registers register on register.id = shift.register_id
        where shift.status = 'closed' and (shift.closed_at at time zone zone)::date = day), '[]'::jsonb)),
    -- Tips are not store income (owner, 2026-10-13): card tips on every order
    -- that isn't a delivery are paid out to the owner; delivery tips go to the
    -- drivers at their cash-out.
    'tip_payout', jsonb_build_object(
      'owner_card_tips_cents', (select coalesce(sum(order_tip_cents), 0) from (select distinct order_id, order_tip_cents from paid where method = 'card' and fulfillment_type <> 'delivery') t),
      'owner_card_tip_count', (select count(*) from (select distinct order_id from paid where method = 'card' and fulfillment_type <> 'delivery' and order_tip_cents > 0) t),
      'owner_cash_tips_cents', (select coalesce(sum(order_tip_cents), 0) from (select distinct order_id, order_tip_cents from paid where method <> 'card' and fulfillment_type <> 'delivery') t),
      'driver_tips_cents', (select coalesce(sum(tip_cents), 0) from sold where fulfillment_type = 'delivery'),
      'income_cents', (select coalesce(sum(total_cents - tip_cents), 0) from sold)
    ),
    'saved', (select to_jsonb(saved) - 'report' - 'workspace_id' - 'location_id' || jsonb_build_object('closed_by_name', profile.display_name)
        from public.day_closeouts saved left join public.profiles profile on profile.id = saved.closed_by_user_id
        where saved.business_date = day order by saved.closed_at desc limit 1)
  ) into result;
  return result;
end;
$function$;
