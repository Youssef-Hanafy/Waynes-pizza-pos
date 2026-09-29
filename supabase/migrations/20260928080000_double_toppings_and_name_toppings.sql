-- Owner, 2026-09-23:
--   1. "On all items you can double up on what already comes on it" -- e.g. a
--      Hawaiian pizza with extra ham and extra pineapple.  Topping groups
--      (vegetables, meats, cheese, and the "pick your toppings" groups on the
--      one/two/three-topping pizzas and the pasta special) now allow
--      quantities, the same switch sauces got in 20260925080000.  The portion
--      an item comes with stays free; every extra portion is charged at that
--      topping's (per-size) price.  "No Cheese" / "Light Cheese" stay
--      once-only in the screens (choiceAllowsExtra in lib/orders/cart.ts).
--   2. "Items that include toppings already are not shown ... sometimes the
--      toppings are literally in the name" -- e.g. Grilled Chicken Pizza had
--      nothing highlighted.  Items now also come with the toppings their name
--      says they have, and every "Comes with: ..." line is re-applied against
--      the groups currently switched on for that item (Mozzarella Sticks had
--      lost its marinara when the modifier cleanup swapped its sauce group).
-- The only thing taken away is the marinara on Alfredo pasta (2c).  All of it
-- can be changed in Admin -> Menu -> the item.

-- 1. Extra portions of toppings ------------------------------------------------
-- These groups' limits were "every option once" (the limit equals the number
-- of options), so the limit is raised to three portions of each to leave room
-- for extras.  Pick-N groups (two/three topping pizza) keep their limit: a
-- double pepperoni counts as two of the three toppings, as it does at the
-- counter.
with topping_groups as (
  select g.id,
         (select count(*) from public.modifier_choices c
           where c.modifier_group_id = g.id and c.active and c.archived_at is null) as option_count,
         g.max_select
  from public.modifier_groups g
  where g.active and g.archived_at is null and not g.allow_quantities
    and (g.name ~ ' – (Vegetables|Meats|Cheese)$'
         or g.name ~ '^(One|Two|Three) Topping Pizza – Toppings?$'
         or g.name = 'Pasta Special – Toppings')
)
update public.modifier_groups g
set allow_quantities = true,
    max_select = case when t.max_select >= t.option_count and t.option_count > 0
                      then greatest(t.max_select, t.option_count * 3) else t.max_select end,
    updated_at = now()
from topping_groups t
where g.id = t.id;

-- 2a. Re-apply each "Comes with: ..." line to the groups switched on now. -----
-- "Tomatoes and Onion" is split into two, but "Sweet and Sour" is kept whole
-- too, so either form matches.
with pieces as (
  select item.id as item_id, btrim(w.value) as piece
  from public.menu_items item
  cross join lateral unnest(string_to_array(regexp_replace(item.description, '^\s*Comes with:\s*', '', 'i'), ',')) as w(value)
  where item.archived_at is null and item.description ~* '^\s*Comes with:' and btrim(w.value) <> ''
),
wants as (
  select item_id, lower(piece) as want from pieces
  union
  select item_id, lower(btrim(part)) from pieces
  cross join lateral unnest(regexp_split_to_array(piece, '\s+and\s+', 'i')) as part
  where piece ~* '\s+and\s+' and btrim(part) <> ''
),
options as (
  select link.menu_item_id as item_id, choice.id as choice_id, lower(btrim(choice.name)) as option_name,
         link.sort_order as link_sort, choice.sort_order as choice_sort
  from public.menu_item_modifier_groups link
  join public.modifier_groups g on g.id = link.modifier_group_id and g.active and g.archived_at is null
  join public.modifier_choices choice on choice.modifier_group_id = g.id and choice.active and choice.archived_at is null
  where link.active
),
picked as (
  select distinct on (wants.item_id, wants.want) wants.item_id, options.choice_id
  from wants
  join options on options.item_id = wants.item_id
   and (options.option_name = wants.want or options.option_name = regexp_replace(wants.want, 'e?s$', ''))
  where not exists (
    select 1 from public.menu_item_included_choices ic
    join public.modifier_choices c on c.id = ic.modifier_choice_id
    where ic.menu_item_id = wants.item_id
      and (lower(c.name) = wants.want or lower(c.name) = regexp_replace(wants.want, 'e?s$', '')))
  order by wants.item_id, wants.want, options.link_sort, options.choice_sort
)
insert into public.menu_item_included_choices (menu_item_id, modifier_choice_id)
select item_id, choice_id from picked
on conflict do nothing;

-- 2b. Toppings named in the item's own name. ----------------------------------
-- pattern: matched against the item name; option: the topping it comes with;
-- skip: not added when the item already comes with an option matching this
-- (e.g. "Steak and Mushroom Sub" already has Grilled Mushrooms);
-- categories: limits a rule to certain menu categories.
with rules(pattern, option_name, skip_pattern, categories) as (
  values
    ('\mgrilled chicken\M',        'Grilled Chicken', 'chicken',  null::text[]),
    ('\mchicken cutlet\M',         'Crispy Chicken',  'chicken',  null),
    -- plain "chicken" on pizzas, calzones and pasta is the grilled chicken;
    -- cutlets and fingers are breaded, so they are left to the rule above.
    ('^(?!.*(cutlet|finger|crispy)).*\mchicken\M', 'Grilled Chicken', 'chicken', array['Gourmet Pizza','Calzones','Pasta']),
    ('\mbacon\M',                  'Bacon',           'bacon',    null),
    ('\mham\M',                    'Ham',             '^ham$',    null),
    ('\msteak\M',                  'Steak',           'steak',    null),
    ('\mmeatball\M',               'Meatball',        'meatball', null),
    ('\msausage\M',                'Sausage',         'sausage',  null),
    ('\mpepperoni\M',              'Pepperoni',       'pepperoni',null),
    ('\msalami\M',                 'Salami',          'salami',   null),
    ('\mpastrami\M',               'Pastrami',        'pastrami', null),
    ('\mbologna\M',                'Bologna',         'bologna',  null),
    ('\m(cheese)?burger\M',        'Hamburger',       'hamburger',null),
    ('\mbroccoli\M',               'Broccoli',        'broccoli', null),
    ('\mmushrooms?\M',             'Mushrooms',       'mushroom', null),
    ('\monions?\M',                'Onion',           'onion',    null),
    ('\meggplant\M',               'Eggplant',        'eggplant', null),
    ('\mgarlic\M',                 'Garlic',          'garlic',   null),
    ('\mspinach\M',                'Spinach',         'spinach',  null),
    ('\mpineapple\M',              'Pineapple',       'pineapple',null),
    ('\mfeta\M',                   'Feta',            'feta',     null),
    ('\mprovolone\M',              'Provolone Cheese','provolone',null),
    ('\mamerican\M',               'American Cheese', 'american', array['Cold Subs']),
    ('\mbbq\M',                    'BBQ Sauce',       'bbq',      null),
    ('\mranch\M',                  'Ranch',           'ranch',    null),
    ('\malfredo\M',                'Alfredo Sauce',   'alfredo',  null),
    ('\mteriyaki\M',               'Teriyaki Sauce',  'teriyaki', null),
    ('\mbuffalo\M',                'Hot Sauce',       'hot sauce',array['Gourmet Pizza','Calzones']),
    ('\mcaesar\M',                 'Caesar Dressing', 'caesar',   null)
),
options as (
  select item.id as item_id, item.name as item_name, cat.name as category, choice.id as choice_id,
         choice.name as option_name, link.sort_order as link_sort, choice.sort_order as choice_sort
  from public.menu_items item
  join public.menu_categories cat on cat.id = item.category_id
  join public.menu_item_modifier_groups link on link.menu_item_id = item.id and link.active
  join public.modifier_groups g on g.id = link.modifier_group_id and g.active and g.archived_at is null
  join public.modifier_choices choice on choice.modifier_group_id = g.id and choice.active and choice.archived_at is null
  where item.archived_at is null
    -- the "pick your toppings" groups are the customer's choice, not a recipe
    and g.name !~ 'Topping Pizza – Toppings?$' and g.name <> 'Pasta Special – Toppings'
),
picked as (
  select distinct on (o.item_id, r.option_name) o.item_id, o.choice_id
  from rules r
  join options o on lower(o.item_name) ~ r.pattern and lower(o.option_name) = lower(r.option_name)
   and (r.categories is null or o.category = any(r.categories))
  where not exists (
    select 1 from public.menu_item_included_choices ic
    join public.modifier_choices c on c.id = ic.modifier_choice_id
    where ic.menu_item_id = o.item_id and lower(c.name) ~ r.skip_pattern)
  order by o.item_id, r.option_name, o.link_sort, o.choice_sort
)
insert into public.menu_item_included_choices (menu_item_id, modifier_choice_id)
select item_id, choice_id from picked
on conflict do nothing;

-- 2c. An Alfredo pasta comes with Alfredo, not marinara.  The Thrive export
-- listed "Comes with: Marinara Sauce" on Shrimp Broccoli Alfredo; now that its
-- name gives it Alfredo, the marinara is taken off so the kitchen isn't told
-- both.  (Chicken Broccoli Alfredo was already set up this way.)
delete from public.menu_item_included_choices ic
using public.menu_items item, public.modifier_choices choice
where ic.menu_item_id = item.id and ic.modifier_choice_id = choice.id
  and item.name ~* '\malfredo\M' and choice.name = 'Marinara Sauce'
  and exists (
    select 1 from public.menu_item_included_choices other
    join public.modifier_choices alfredo on alfredo.id = other.modifier_choice_id
    where other.menu_item_id = item.id and alfredo.name = 'Alfredo Sauce');
