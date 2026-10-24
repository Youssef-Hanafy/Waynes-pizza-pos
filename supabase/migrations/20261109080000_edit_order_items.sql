-- Owner, 2026-10-24: "on Today's Orders, or the Orders page, you should be
-- able to click on the card and it'll bring you to the page where you are
-- taking the order and edit the items, add items and all of that … it brings
-- the original items up, and you can click on them and edit them or add new
-- items, and DO NOT PRINT A NEW SLIP for new items."
--
--   order_items.pos_line     each line as the POS rang it up (item, size,
--                            options, halves), so it can be opened again
--                            exactly as it was
--   wayne_pos_order_lines    an order's lines for the POS editor
--   wayne_pos_edit_items     remove lines, change quantities, add / replace
--                            lines — one step, same order, totals and tax
--                            recomputed like Add items; no new slip (a ticket
--                            still waiting prints the whole order; one already
--                            printed is not printed again)

alter table public.order_items add column if not exists pos_line jsonb;
comment on column public.order_items.pos_line is
  'The line as the POS rang it up (menu_item_id, variant_id, quantity, modifiers, special_instructions), so the order can be edited later.';

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

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$returning id into order_item_id;$o$,
$n$returning id into order_item_id;
    update public.order_items set pos_line = item_payload - 'lists_included' where id = order_item_id; -- kept to edit the order later (owner, 2026-10-24)$n$);

select public._wayne_patch_function('public.wayne_pos_insert_items(uuid,jsonb)'::regprocedure,
$o$returning id into order_item_id;$o$,
$n$returning id into order_item_id;
    update public.order_items set pos_line = item_payload - 'lists_included' where id = order_item_id; -- kept to edit the order later (owner, 2026-10-24)$n$);

drop function public._wayne_patch_function(regprocedure, text, text);

-- An order's lines for the POS editor.
create or replace function public.wayne_pos_order_lines(target_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  main public.orders%rowtype;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  select * into main from public.orders where id = target_order_id;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if main.parent_order_id is not null then
    select * into main from public.orders where id = main.parent_order_id;
  end if;
  return jsonb_build_object(
    'order', jsonb_build_object(
      'id', main.id, 'order_number', main.order_number, 'daily_number', main.daily_number,
      'customer_name', main.customer_name_snapshot, 'fulfillment_type', main.fulfillment_type,
      'status', main.status, 'payment_status', main.payment_status,
      'total_cents', main.total_cents, 'paid_cents', public.wayne_order_paid_cents(main.id),
      'discount_cents', main.discount_cents, 'source', main.source, 'placed_at', main.placed_at),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id, 'menu_item_id', item.menu_item_id, 'variant_id', item.variant_id,
        'name', item.item_name_snapshot, 'variant', item.variant_name_snapshot,
        'quantity', item.quantity, 'unit_price_cents', item.unit_price_cents,
        'modifier_unit_total_cents', item.modifier_unit_total_cents, 'line_total_cents', item.line_total_cents,
        'instructions', item.special_instructions, 'pos_line', item.pos_line,
        'modifiers', coalesce((
          select jsonb_agg(jsonb_build_object('choice_id', modifier.modifier_choice_id, 'name', modifier.modifier_name_snapshot,
            'quantity', modifier.quantity, 'placement', modifier.placement) order by modifier.created_at, modifier.id)
          from public.order_item_modifiers modifier where modifier.order_item_id = item.id), '[]'::jsonb)
      ) order by item.created_at, item.id)
      from public.order_items item where item.order_id = main.id), '[]'::jsonb));
end;
$$;

-- Edit an order's items in one step.
create or replace function public.wayne_pos_edit_items(target_order_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  note text := left(btrim(coalesce(payload ->> 'special_instructions', '')), 500);
  existing_order_id uuid;
  main public.orders%rowtype;
  settings public.store_settings%rowtype;
  rate integer;
  added integer := 0;
  removed_ids uuid[] := '{}';
  change jsonb;
  change_qty integer;
  changed integer := 0;
  new_subtotal integer;
  new_discount integer := 0;
  new_tax integer;
  new_total integer;
  paid integer;
  owes boolean;
  result_row public.orders%rowtype;
  before_ids uuid[];
  new_ids uuid[];
  discount_row record;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if char_length(request_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;

  insert into public.order_idempotency (idempotency_key) values (request_key) on conflict do nothing;
  select request.order_id into existing_order_id from public.order_idempotency request where request.idempotency_key = request_key for update;
  if existing_order_id is not null then
    return (select jsonb_build_object('order_id', o.id, 'mode', 'merged', 'order_number', o.order_number, 'daily_number', o.daily_number,
      'total_cents', o.total_cents, 'paid_cents', public.wayne_order_paid_cents(o.id), 'payment_status', o.payment_status, 'duplicate', true)
      from public.orders o where o.id = existing_order_id);
  end if;

  select * into main from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if main.parent_order_id is not null then
    select * into main from public.orders where id = main.parent_order_id for update;
  end if;
  if main.status in ('cancelled', 'draft', 'payment_pending') then raise exception 'This order can''t be changed' using errcode = '22023'; end if;
  if main.payment_status in ('refunded', 'partially_refunded') then raise exception 'This order was refunded — start a new order instead' using errcode = '22023'; end if;
  if exists (select 1 from public.payments p where p.order_id = main.id and p.status = 'pending') then
    raise exception 'A card payment is in progress on this order. Finish or cancel it first.' using errcode = '40001';
  end if;
  select * into settings from public.store_settings where id = true;
  rate := coalesce((main.pricing_snapshot ->> 'tax_rate_basis_points')::integer, settings.tax_rate_basis_points, 0);
  select coalesce(array_agg(id), '{}') into before_ids from public.order_items where order_id = main.id;

  -- 1. Lines taken off (or replaced by an edited copy).
  if jsonb_typeof(coalesce(payload -> 'remove_item_ids', '[]'::jsonb)) <> 'array' then raise exception 'Invalid changes' using errcode = '22023'; end if;
  select coalesce(array_agg(item.id), '{}') into removed_ids
    from public.order_items item
   where item.order_id = main.id
     and item.id::text in (select jsonb_array_elements_text(coalesce(payload -> 'remove_item_ids', '[]'::jsonb)));
  if cardinality(removed_ids) <> jsonb_array_length(coalesce(payload -> 'remove_item_ids', '[]'::jsonb)) then
    raise exception 'An item on this order changed meanwhile. Open the order again.' using errcode = '40001';
  end if;
  delete from public.order_item_modifiers where order_item_id = any(removed_ids);
  delete from public.order_items where id = any(removed_ids);

  -- 2. Quantities changed on lines that stay.
  for change in select value from jsonb_array_elements(coalesce(payload -> 'quantities', '[]'::jsonb)) loop
    change_qty := (change ->> 'quantity')::integer;
    if change_qty is null or change_qty not between 1 and 20 then raise exception 'Each ticket quantity must be between 1 and 20' using errcode = '22023'; end if;
    update public.order_items set quantity = change_qty, line_total_cents = (unit_price_cents + modifier_unit_total_cents) * change_qty
     where id = (change ->> 'id')::uuid and order_id = main.id and quantity <> change_qty;
    if found then changed := changed + 1; end if;
  end loop;

  -- 3. New lines (and edited copies of lines taken off), priced like a new order.
  if jsonb_typeof(payload -> 'items') = 'array' and jsonb_array_length(payload -> 'items') > 0 then
    added := public.wayne_pos_insert_items(main.id, payload -> 'items');
  end if;
  if not exists (select 1 from public.order_items where order_id = main.id) then
    raise exception 'An order needs at least one item. To call it off, cancel it in Admin → Orders.' using errcode = '22023';
  end if;

  -- 4. Totals — the same arithmetic as Add items.
  select coalesce(sum(line_total_cents), 0)::integer into new_subtotal from public.order_items where order_id = main.id;
  for discount_row in select * from public.order_discounts where order_id = main.id loop
    discount_row.amount_cents := case
      when discount_row.discount_type_snapshot = 'fixed' then least(new_subtotal, coalesce(discount_row.discount_value_snapshot, discount_row.amount_cents))
      else least(new_subtotal, ((new_subtotal::bigint * discount_row.discount_value_snapshot + 5000) / 10000)::integer) end;
    new_discount := new_discount + discount_row.amount_cents;
    update public.order_discounts set amount_cents = discount_row.amount_cents where id = discount_row.id;
  end loop;
  new_discount := least(new_discount, new_subtotal);
  new_tax := (((new_subtotal - new_discount)::bigint * rate + 5000) / 10000)::integer;
  new_total := new_subtotal - new_discount + main.delivery_fee_cents + new_tax + main.tip_cents;
  paid := public.wayne_order_paid_cents(main.id);
  if paid > new_total then
    raise exception 'This order was already paid %. Taking items off a paid order needs a refund of the difference — do that in Admin → Orders.', to_char(paid / 100.0, 'FM$999,990.00') using errcode = '22023';
  end if;
  owes := paid > 0 and new_total > paid;
  update public.orders o set
    subtotal_cents = new_subtotal, discount_cents = new_discount, tax_cents = new_tax, total_cents = new_total,
    payment_status = case when owes then 'unpaid' when paid > 0 and paid >= new_total and o.payment_status = 'unpaid' then 'paid' else o.payment_status end,
    status = case when owes and o.status = 'completed' then 'placed' else o.status end,
    completed_at = case when owes and o.status = 'completed' then null else o.completed_at end,
    special_instructions = case when note = '' then o.special_instructions else left(btrim(o.special_instructions || case when o.special_instructions = '' then '' else ' · ' end || 'ADDED: ' || note), 1500) end
   where o.id = main.id
  returning * into result_row;
  select coalesce(array_agg(id), '{}') into new_ids from public.order_items where order_id = main.id and not (id = any(before_ids));

  -- 5. No new slip (owner, 2026-10-24): the kitchen screen shows the order as it is now;
  -- a kitchen ticket still waiting prints the whole order, one already printed is not printed again.
  update public.kitchen_tickets kt set payload = kt.payload || jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'name', i.item_name_snapshot, 'variant', i.variant_name_snapshot, 'quantity', i.quantity,
      'instructions', i.special_instructions, 'station', coalesce(i.kitchen_route_snapshot, 'kitchen'),
      'modifiers', coalesce((select jsonb_agg(jsonb_build_object('name', m.modifier_name_snapshot, 'group', m.modifier_group_name_snapshot, 'quantity', m.quantity) order by m.created_at, m.id)
        from public.order_item_modifiers m where m.order_item_id = i.id), '[]'::jsonb)) order by i.created_at, i.id)
      from public.order_items i where i.order_id = main.id), '[]'::jsonb)), updated_at = now()
   where kt.order_id = main.id;

  if main.status = 'completed' and owes then
    insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
    values (main.id, 'order.reopened', 'completed', 'placed', auth.uid(), jsonb_build_object('reason', 'order edited after payment'));
  end if;
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (main.id, 'order.items_edited', auth.uid(), jsonb_build_object('removed_item_ids', to_jsonb(removed_ids), 'quantity_changes', changed,
    'added_item_ids', to_jsonb(new_ids), 'added_cents', added, 'total_cents', result_row.total_cents, 'paid_cents', paid, 'idempotency_key', request_key));
  update public.order_idempotency set order_id = main.id where idempotency_key = request_key;
  return jsonb_build_object('order_id', main.id, 'mode', 'merged', 'order_number', main.order_number, 'daily_number', main.daily_number,
    'added_cents', added, 'total_cents', result_row.total_cents, 'paid_cents', paid, 'payment_status', result_row.payment_status, 'duplicate', false);
end;
$$;

revoke all on function public.wayne_pos_order_lines(uuid) from public, anon;
revoke all on function public.wayne_pos_edit_items(uuid, jsonb) from public, anon;
grant execute on function public.wayne_pos_order_lines(uuid) to authenticated;
grant execute on function public.wayne_pos_edit_items(uuid, jsonb) to authenticated;
