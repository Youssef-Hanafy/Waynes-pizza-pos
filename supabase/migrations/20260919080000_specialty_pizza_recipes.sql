-- Specialty pizza recipes are stored as per-item modifier groups. This keeps
-- the recipe editable in Admin -> Menu and lets online ordering and the POS
-- use their existing default_selected behavior without a parallel hard-coded
-- product catalog.

do $specialty_pizzas$
declare
  pizza_group_id constant uuid := 'd41d9f2a-7e34-4adc-a088-66f1e4db3d01';
  gourmet_category_id uuid;
  recipe record;
  item_id uuid;
  recipe_group_id uuid;
  ingredient text;
  ingredient_position integer;
begin
  -- Bring printed-menu labels in line with the customer-facing names. Each
  -- row remains an ordinary menu_items record and can be changed by an owner.
  update public.menu_items item
  set name = renamed.new_name,
      description = renamed.description
  from (values
    ('Full Combo', 'Full Combo Pizza', 'Pepperoni, Meatball, Sausage, Ham, Mushrooms, Onion, Peppers'),
    ('Veggie Combo', 'Veggie Combo Pizza', 'Broccoli, Spinach, Black Olives, Mushrooms, Peppers, Onion, Tomato'),
    ('Primavera', 'Primavera Pizza', 'Spinach, Tomato, Broccoli'),
    ('Hawaiian', 'Hawaiian Pizza', 'Ham, Pineapple'),
    ('Meat Lovers', 'Meat Lovers Pizza', 'Pepperoni, Sausage, Ham, Salami'),
    ('Chicken, Broccoli & Garlic Pizza', 'Chicken Broccoli Garlic Pizza', 'Grilled Chicken, Broccoli, Garlic'),
    ('Chicken, Broccoli Alfredo Pizza', 'Chicken Broccoli Alfredo Pizza', 'Grilled Chicken, Broccoli, Alfredo Sauce'),
    ('Five Alarm Pizza', 'Five Alarm', 'Buffalo Chicken, Onion, Garlic, Jalapenos'),
    ('Alfredo Shrimp Scampi Pizza', 'Shrimp Scampi Alfredo', 'Shrimp, Garlic, Alfredo Sauce')
  ) as renamed(old_name, new_name, description),
  public.menu_categories category
  where category.id = item.category_id
    and category.name = 'Gourmet Pizza'
    and item.name = renamed.old_name;

  select id into gourmet_category_id
  from public.menu_categories
  where name = 'Gourmet Pizza' and archived_at is null
  order by sort_order, created_at
  limit 1;
  if gourmet_category_id is null then return; end if;

  -- Recipes sometimes call for ingredients that were not in the initial
  -- generic pizza modifier panel. Add them as normal editable choices.
  foreach ingredient in array array['Grilled Chicken', 'Shrimp', 'Alfredo Sauce', 'Ranch', 'BBQ Sauce', 'Buffalo Sauce', 'Buffalo Chicken', 'Lettuce'] loop
    if not exists (
      select 1 from public.modifier_choices
      where modifier_group_id = pizza_group_id and name = ingredient
    ) then
      select coalesce(max(sort_order), -10) + 10 into ingredient_position
      from public.modifier_choices where modifier_group_id = pizza_group_id;
      insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, sort_order)
      values (pizza_group_id, ingredient, 0, ingredient_position);
    end if;
  end loop;

  -- The one specialty item absent from the prior printed-menu import.
  select id into item_id from public.menu_items
  where category_id = gourmet_category_id and name = 'Grilled Chicken Pizza' and archived_at is null
  limit 1;
  if item_id is null then
    insert into public.menu_items (
      category_id, name, description, base_price_cents, sort_order,
      customer_visible, pos_visible
    ) values (
      gourmet_category_id, 'Grilled Chicken Pizza', 'Grilled Chicken', 0, 165,
      true, true
    ) returning id into item_id;
    insert into public.menu_item_variants (menu_item_id, name, price_cents, sku, sort_order)
    values
      (item_id, 'Small', 1200, null, 0),
      (item_id, 'Large', 1975, null, 10);
  end if;

  -- New and existing specialty pizzas have the editable all-toppings panel.
  insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order, active)
  select item.id, pizza_group_id, 900, true
  from public.menu_items item
  where item.category_id = gourmet_category_id and item.archived_at is null
  on conflict (menu_item_id, modifier_group_id) do update
    set active = true, sort_order = excluded.sort_order;

  for recipe in
    select * from (values
      ('Full Combo Pizza', array['Pepperoni', 'Meatball', 'Sausage', 'Ham', 'Mushrooms', 'Onion', 'Peppers']),
      ('Veggie Combo Pizza', array['Broccoli', 'Spinach', 'Black Olives', 'Mushrooms', 'Peppers', 'Onion', 'Tomato']),
      ('Primavera Pizza', array['Spinach', 'Tomato', 'Broccoli']),
      ('Greek Pizza', array['Spinach', 'Feta', 'Tomato']),
      ('Hawaiian Pizza', array['Ham', 'Pineapple']),
      ('Meat Lovers Pizza', array['Pepperoni', 'Sausage', 'Ham', 'Salami']),
      ('Chicken Broccoli Garlic Pizza', array['Grilled Chicken', 'Broccoli', 'Garlic']),
      ('Chicken Broccoli Alfredo Pizza', array['Grilled Chicken', 'Broccoli', 'Alfredo Sauce']),
      ('Chicken Bacon Ranch Pizza', array['Grilled Chicken', 'Bacon', 'Ranch']),
      ('BBQ Chicken Pizza', array['Grilled Chicken', 'BBQ Sauce']),
      ('Buffalo Chicken Pizza', array['Grilled Chicken', 'Buffalo Sauce']),
      ('Mexican Pizza', array['Hamburger', 'Banana Peppers', 'Onion', 'Peppers', 'Tomato', 'Lettuce']),
      ('Philly Steak Pizza', array['Onion', 'Peppers', 'Mushrooms']),
      ('Wayne''s Pizza', array['Eggplant', 'Mushrooms', 'Onion', 'Artichoke', 'Garlic']),
      ('Grilled Chicken Pizza', array['Grilled Chicken']),
      ('Shrimp Scampi Alfredo', array['Shrimp', 'Garlic', 'Alfredo Sauce']),
      ('Five Alarm', array['Buffalo Chicken', 'Onion', 'Garlic', 'Jalapenos'])
    ) as recipe_data(item_name, ingredients)
  loop
    select id into item_id from public.menu_items
    where category_id = gourmet_category_id and name = recipe.item_name and archived_at is null
    limit 1;
    if item_id is null then continue; end if;

    select id into recipe_group_id from public.modifier_groups
    where name = 'Included: ' || recipe.item_name and archived_at is null
    limit 1;
    if recipe_group_id is null then
      insert into public.modifier_groups (
        name, customer_label, min_select, max_select, required,
        allow_quantities, sort_order
      ) values (
        'Included: ' || recipe.item_name,
        'Included ingredients — tap to remove',
        0, cardinality(recipe.ingredients), false, true, 890
      ) returning id into recipe_group_id;
    end if;

    insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order, active)
    values (item_id, recipe_group_id, 890, true)
    on conflict (menu_item_id, modifier_group_id) do update
      set active = true, sort_order = excluded.sort_order;

    ingredient_position := 0;
    foreach ingredient in array recipe.ingredients loop
      if not exists (
        select 1 from public.modifier_choices
        where modifier_group_id = recipe_group_id and name = ingredient
      ) then
        insert into public.modifier_choices (
          modifier_group_id, name, price_delta_cents, default_selected, sort_order
        ) values (recipe_group_id, ingredient, 0, true, ingredient_position);
      end if;
      ingredient_position := ingredient_position + 10;
    end loop;
  end loop;
end;
$specialty_pizzas$;
