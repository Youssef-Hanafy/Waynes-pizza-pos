-- The right choices on the right items (owner, 2026-09-23).
--
--  * Appetizers (wings, fingers, fries, rings, poppers, mozz sticks, egg rolls,
--    garlic bread...) offered lettuce, salami, mozzarella and croutons. They now
--    offer only their dips. Quesadilla keeps its build-it groups.
--  * Dinners offered the same. They keep the side choice and dips; the ones
--    that really have toppings (Cheeseburger, Gyro, Quesadilla) keep them.
--  * Kids' chicken fingers and kid's pasta lose the vegetables, keep dips.
--  * Pizzas and calzones get "Extra Sauce" ($1.50) and "Lightly Cooked".
--  * Fried appetizers get an "Extra Crispy" option.
-- Nothing is deleted: item→group links are switched off, so turning one back on
-- in Admin → Menu restores it.

-- 1. Take the toppings off the items that don't have toppings.
update public.menu_item_modifier_groups link
set active = false
from public.menu_items item, public.menu_categories category, public.modifier_groups grp
where link.menu_item_id = item.id and item.category_id = category.id
  and grp.id = link.modifier_group_id and link.active
  and (grp.name like '%– Vegetables' or grp.name like '%– Meats' or grp.name like '%– Cheese' or grp.name like '%– Extras')
  and (
    (category.name = 'Appetizers' and item.name <> 'Quesadilla')
    or (category.name = 'Dinners' and item.name not in ('Cheeseburger Dinner', 'Gyro Dinner', 'Quesadilla Dinner'))
    or (category.name = 'Kids' and item.name in ('Kid''s Chicken Fingers', 'Kid''s Pasta'))
  );

-- 2. Extra sauce on pizzas and calzones, $1.50.
insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order)
select distinct grp.id, 'Extra Sauce', 150, false,
  (select coalesce(max(other.sort_order), 0) + 1 from public.modifier_choices other where other.modifier_group_id = grp.id)
from public.modifier_groups grp
join public.menu_item_modifier_groups link on link.modifier_group_id = grp.id and link.active
join public.menu_items item on item.id = link.menu_item_id and item.archived_at is null
join public.menu_categories category on category.id = item.category_id
where grp.active and grp.archived_at is null and grp.name like '%– Sauces'
  and category.name in ('Gourmet Pizza', 'Build Your Own Pizza', 'Calzones')
  and not exists (
    select 1 from public.modifier_choices existing
    where existing.modifier_group_id = grp.id and lower(existing.name) = 'extra sauce' and existing.archived_at is null
  );

-- 3. "Lightly Cooked" for pizzas and calzones (they only had Well Done / Double Cut).
insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order)
select distinct grp.id, 'Lightly Cooked', 0, false,
  (select coalesce(max(other.sort_order), 0) + 1 from public.modifier_choices other where other.modifier_group_id = grp.id)
from public.modifier_groups grp
join public.menu_item_modifier_groups link on link.modifier_group_id = grp.id and link.active
join public.menu_items item on item.id = link.menu_item_id and item.archived_at is null
join public.menu_categories category on category.id = item.category_id
where grp.active and grp.archived_at is null and grp.name like '%– Cooking Instructions'
  and category.name in ('Gourmet Pizza', 'Build Your Own Pizza', 'Calzones')
  and not exists (
    select 1 from public.modifier_choices existing
    where existing.modifier_group_id = grp.id and lower(existing.name) = 'lightly cooked' and existing.archived_at is null
  );

-- A sauce or cooking group must allow every one of its choices to be picked.
update public.modifier_groups grp
set max_select = (select count(*) from public.modifier_choices c where c.modifier_group_id = grp.id and c.active and c.archived_at is null),
    updated_at = now()
where grp.active and grp.archived_at is null
  and (grp.name like '%– Sauces' or grp.name like '%– Cooking Instructions')
  and grp.max_select < (select count(*) from public.modifier_choices c where c.modifier_group_id = grp.id and c.active and c.archived_at is null);

-- 4. Extra Crispy for the fryer.
insert into public.modifier_groups (name, customer_label, min_select, max_select, required, allow_quantities, sort_order)
select 'Fried Appetizers – Cooking', 'How to cook it', 0, 1, false, false, 90
where not exists (select 1 from public.modifier_groups where name = 'Fried Appetizers – Cooking' and archived_at is null);

insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order)
select grp.id, 'Extra Crispy', 0, false, 1
from public.modifier_groups grp
where grp.name = 'Fried Appetizers – Cooking' and grp.archived_at is null
  and not exists (select 1 from public.modifier_choices c where c.modifier_group_id = grp.id and c.name = 'Extra Crispy' and c.archived_at is null);

insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order, active)
select item.id, grp.id, 90, true
from public.menu_items item
join public.menu_categories category on category.id = item.category_id
cross join public.modifier_groups grp
where grp.name = 'Fried Appetizers – Cooking' and grp.archived_at is null
  and item.archived_at is null and category.name = 'Appetizers'
  and item.name in ('Buffalo Wings', 'Chicken Wings', 'Buffalo Fingers', 'Chicken Fingers', 'French Fries', 'Curly Fries',
                    'Cheese Fries', 'Onion Rings', 'Jalapeño Poppers', 'Mozzarella Sticks', 'Broccoli Puffs',
                    'Fried Mushrooms', 'Steak Egg Roll', 'Buffalo Chicken Egg Roll', 'Compo Plater')
on conflict (menu_item_id, modifier_group_id) do update set active = true;

-- 5. Calzones offered No Sauce but not Light Sauce; pizzas had both.
insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order)
select g.id, 'Light Sauce', 0, false, (select coalesce(max(c.sort_order), 0) + 1 from public.modifier_choices c where c.modifier_group_id = g.id)
from public.modifier_groups g
where g.name = 'Calzones – Sauces' and g.active and g.archived_at is null
  and not exists (select 1 from public.modifier_choices c where c.modifier_group_id = g.id and lower(c.name) = 'light sauce' and c.archived_at is null);

update public.modifier_groups g
set max_select = (select count(*) from public.modifier_choices c where c.modifier_group_id = g.id and c.active and c.archived_at is null), updated_at = now()
where g.name = 'Calzones – Sauces' and g.active and g.archived_at is null;
