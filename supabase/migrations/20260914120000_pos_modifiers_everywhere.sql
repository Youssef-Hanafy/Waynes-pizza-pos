-- Make the front-counter modifier experience useful for every pizza, calzone,
-- sub, wrap and salad that is already in the live menu.  Prices deliberately
-- start at $0 except for extra dressing, which preserves the existing $1.60
-- menu price.  Owners can change any price in Admin -> Menu without code.

do $migration$
declare
  pizza_group_id constant uuid := 'd41d9f2a-7e34-4adc-a088-66f1e4db3d01';
  sandwich_group_id constant uuid := 'd41d9f2a-7e34-4adc-a088-66f1e4db3d02';
  cold_sub_group_id constant uuid := 'd41d9f2a-7e34-4adc-a088-66f1e4db3d03';
  prep_group_id constant uuid := 'd41d9f2a-7e34-4adc-a088-66f1e4db3d04';
  extra_dressing_group_id constant uuid := 'd41d9f2a-7e34-4adc-a088-66f1e4db3d05';
  choice_name text;
  choice_position integer;
begin
  insert into public.modifier_groups (id, name, customer_label, min_select, max_select, required, allow_quantities, sort_order)
  values
    (pizza_group_id, 'POS pizza customizations', 'Toppings & changes', 0, 99, false, true, 900),
    (sandwich_group_id, 'POS sandwich customizations', 'Toppings & condiments', 0, 99, false, true, 900),
    (cold_sub_group_id, 'POS cold sub standard toppings', 'Included toppings', 0, 99, false, true, 910),
    (prep_group_id, 'POS sandwich preparation', 'Preparation', 0, 1, false, false, 920),
    (extra_dressing_group_id, 'POS salad extra dressings', 'Extra dressings ($1.60 each)', 0, 10, false, true, 920)
  on conflict (id) do update set
    customer_label = excluded.customer_label,
    min_select = excluded.min_select,
    max_select = excluded.max_select,
    required = excluded.required,
    allow_quantities = excluded.allow_quantities,
    active = true,
    archived_at = null;

  foreach choice_name in array array[
    'Pepperoni', 'Feta', 'Anchovies', 'Ham', 'Hamburger', 'Meatball', 'Salami', 'Sausage',
    'Artichoke', 'Banana Peppers', 'Black Olives', 'Eggplant', 'Garlic', 'Jalapenos', 'Onion',
    'Peppers', 'Pineapple', 'Spinach', 'Tomato', 'Broccoli', 'Cucumbers', 'Veggies', 'Bologna',
    'Hot Pepper', 'Mushrooms', 'Grilled Mushrooms', 'Bacon'
  ] loop
    select coalesce(max(sort_order), -10) + 10 into choice_position
    from public.modifier_choices where modifier_group_id = pizza_group_id;
    if not exists (select 1 from public.modifier_choices where modifier_group_id = pizza_group_id and name = choice_name) then
      insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, sort_order)
      values (pizza_group_id, choice_name, 0, choice_position);
    end if;
  end loop;

  foreach choice_name in array array[
    'Provolone Cheese', 'American Cheese', 'Feta', 'Lettuce', 'Tomato', 'Onion', 'Peppers',
    'Mushrooms', 'Grilled Mushrooms', 'Pickles', 'Hot Pepper', 'Banana Peppers', 'Jalapenos',
    'Mayo', 'Mustard', 'Oil', 'Vinegar', 'Ranch', 'BBQ Sauce', 'Hot Sauce', 'Toasted'
  ] loop
    select coalesce(max(sort_order), -10) + 10 into choice_position
    from public.modifier_choices where modifier_group_id = sandwich_group_id;
    if not exists (select 1 from public.modifier_choices where modifier_group_id = sandwich_group_id and name = choice_name) then
      insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, sort_order)
      values (sandwich_group_id, choice_name, 0, choice_position);
    end if;
  end loop;

  foreach choice_name in array array['Provolone Cheese', 'Lettuce', 'Tomato', 'Onion'] loop
    select coalesce(max(sort_order), -10) + 10 into choice_position
    from public.modifier_choices where modifier_group_id = cold_sub_group_id;
    if not exists (select 1 from public.modifier_choices where modifier_group_id = cold_sub_group_id and name = choice_name) then
      insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order)
      values (cold_sub_group_id, choice_name, 0, true, choice_position);
    else
      update public.modifier_choices set default_selected = true, active = true, archived_at = null
      where modifier_group_id = cold_sub_group_id and name = choice_name;
    end if;
  end loop;

  foreach choice_name in array array['Toasted', 'Not Toasted'] loop
    select coalesce(max(sort_order), -10) + 10 into choice_position
    from public.modifier_choices where modifier_group_id = prep_group_id;
    if not exists (select 1 from public.modifier_choices where modifier_group_id = prep_group_id and name = choice_name) then
      insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, sort_order)
      values (prep_group_id, choice_name, 0, choice_position);
    end if;
  end loop;

  foreach choice_name in array array[
    'House', 'Italian', 'Lite Italian', 'Ranch', 'Bleu Cheese', 'Peppercorn Parmesan',
    'Oil & Vinegar', 'Lemon & Oil', 'Balsamic Vinaigrette', 'Thousand Island'
  ] loop
    select coalesce(max(sort_order), -10) + 10 into choice_position
    from public.modifier_choices where modifier_group_id = extra_dressing_group_id;
    if not exists (select 1 from public.modifier_choices where modifier_group_id = extra_dressing_group_id and name = choice_name) then
      insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, sort_order)
      values (extra_dressing_group_id, choice_name, 160, choice_position);
    end if;
  end loop;

  -- Every pizza/calzone gets a complete, repeatable topping panel.  Existing
  -- required one/two/three-topping groups remain in place for their bundle
  -- rules; this extra panel is for adjustments and the kitchen ticket.
  insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
  select item.id, pizza_group_id, 900
  from public.menu_items item
  join public.menu_categories category on category.id = item.category_id
  where category.name in ('Pizza', 'Gourmet Pizza', 'Calzones') and item.archived_at is null
  on conflict (menu_item_id, modifier_group_id) do update set active = true, sort_order = excluded.sort_order;

  -- All sandwiches and wraps get the same immediate modifier layout.  Cold
  -- subs also receive their standard ingredients preselected so red removes
  -- and green adds exactly as on the legacy terminal.
  insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
  select item.id, sandwich_group_id, 900
  from public.menu_items item
  join public.menu_categories category on category.id = item.category_id
  where category.name in ('Cold Subs', 'Hot Subs', 'Chicken Subs', 'Fat Subs', 'Wraps') and item.archived_at is null
  on conflict (menu_item_id, modifier_group_id) do update set active = true, sort_order = excluded.sort_order;

  insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
  select item.id, prep_group_id, 920
  from public.menu_items item
  join public.menu_categories category on category.id = item.category_id
  where category.name in ('Cold Subs', 'Hot Subs', 'Chicken Subs', 'Fat Subs', 'Wraps') and item.archived_at is null
  on conflict (menu_item_id, modifier_group_id) do update set active = true, sort_order = excluded.sort_order;

  insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
  select item.id, cold_sub_group_id, 910
  from public.menu_items item
  join public.menu_categories category on category.id = item.category_id
  where category.name = 'Cold Subs' and item.archived_at is null
  on conflict (menu_item_id, modifier_group_id) do update set active = true, sort_order = excluded.sort_order;

  -- The original free dressing choice stays required.  This separate group is
  -- repeatable and priced, so staff and online customers can select a specific
  -- extra dressing as many times as needed.
  insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
  select item.id, existing_group.id, 900
  from public.menu_items item
  join public.menu_categories category on category.id = item.category_id
  join public.modifier_groups existing_group on existing_group.name = 'Salad dressing'
  where category.name = 'Salads' and item.archived_at is null
  on conflict (menu_item_id, modifier_group_id) do update set active = true, sort_order = least(public.menu_item_modifier_groups.sort_order, excluded.sort_order);

  insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
  select item.id, extra_dressing_group_id, 920
  from public.menu_items item
  join public.menu_categories category on category.id = item.category_id
  where category.name = 'Salads' and item.archived_at is null
  on conflict (menu_item_id, modifier_group_id) do update set active = true, sort_order = excluded.sort_order;

  update public.modifier_groups
  set allow_quantities = true, max_select = greatest(max_select, 10), active = true, archived_at = null
  where name = 'Salad extras';
end;
$migration$;
