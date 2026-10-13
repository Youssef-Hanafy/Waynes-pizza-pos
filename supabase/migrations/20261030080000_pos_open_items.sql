-- Open items on the POS (owner, 2026-10-13: "open food for extra costs, misc").
--
-- A POS ticket line may carry "open_item": {"name": text, "price_cents": int}
-- instead of a menu item.  The cashier names and prices it; it is stored as an
-- order line with no menu item (category "Open food") and prints on the
-- kitchen ticket and receipt like any other line.  Only wayne_create_pos_order
-- accepts it — online checkout never does.
--
-- The function is patched in place (its body is long and changes often), and
-- every patch point is checked so a mismatch fails loudly instead of silently.
do $migration$
declare
  body text := pg_get_functiondef('public.wayne_create_pos_order(jsonb)'::regprocedure);
  patched text;
  anchor_declare constant text := E'  linked_phone_line smallint;\nbegin';
  anchor_validate constant text := E'    if quantity_value not between 1 and 20 then raise exception ''Each ticket quantity must be between 1 and 20'' using errcode = ''22023''; end if;\n';
  anchor_insert constant text := E'    quantity_value := (item_payload ->> ''quantity'')::integer;\n    select * into item_record from public.menu_items where id = (item_payload ->> ''menu_item_id'')::uuid;';
begin
  if position('open_item' in body) > 0 then
    raise notice 'wayne_create_pos_order already handles open items';
    return;
  end if;
  if position(anchor_declare in body) = 0 or position(anchor_validate in body) = 0 or position(anchor_insert in body) = 0 then
    raise exception 'wayne_create_pos_order changed: open-item patch points not found';
  end if;

  patched := replace(body, anchor_declare, E'  linked_phone_line smallint;\n  open_price integer;\n  open_name text;\nbegin');

  patched := replace(patched, anchor_validate, anchor_validate || $patch$
    if item_payload ? 'open_item' then
      open_price := (item_payload #>> '{open_item,price_cents}')::integer;
      open_name := btrim(coalesce(item_payload #>> '{open_item,name}', ''));
      if open_price is null or open_price < 0 or open_price > 100000 then raise exception 'Enter a price for the open item' using errcode = '22023'; end if;
      if char_length(open_name) = 0 or char_length(open_name) > 80 then raise exception 'Name the open item' using errcode = '22023'; end if;
      subtotal := subtotal + open_price * quantity_value;
      continue;
    end if;
$patch$);

  patched := replace(patched, anchor_insert, E'    quantity_value := (item_payload ->> ''quantity'')::integer;\n' || $patch$
    if item_payload ? 'open_item' then
      open_price := (item_payload #>> '{open_item,price_cents}')::integer;
      open_name := btrim(item_payload #>> '{open_item,name}');
      insert into public.order_items (order_id, menu_item_id, variant_id, item_name_snapshot, variant_name_snapshot, unit_price_cents, modifier_unit_total_cents, quantity, line_total_cents, special_instructions, category_name_snapshot)
      values (created_order_id, null, null, open_name, null, open_price, 0, quantity_value, open_price * quantity_value, btrim(coalesce(item_payload ->> 'special_instructions', '')), 'Open food');
      continue;
    end if;
$patch$ || E'    select * into item_record from public.menu_items where id = (item_payload ->> ''menu_item_id'')::uuid;');

  execute patched;
end;
$migration$;
