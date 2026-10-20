-- Pizza halves, Large first, beverages 20 oz → 2 L (owner, 2026-10-20).
--
-- 1. Half toppings: "a button left / right for toppings on that side, or the
--    middle button if it's for the whole pizza".  Each topping on an order
--    remembers its side (order_item_modifiers.placement).  A half costs the
--    same as a whole topping (owner's choice), so no price math changes: the
--    side is applied after the line is priced, by labelling the modifier
--    "LEFT ½ Pepperoni" / "RIGHT ½ Pepperoni".  The kitchen screen, kitchen
--    slip, receipts and order history all print that label as they are.
--    Which option groups offer halves is a switch on the group
--    (modifier_groups.allow_halves), editable in Admin, and both Admin save
--    paths keep it.  Turned on for every Build Your Own + Gourmet pizza
--    group except Sauces and Cooking Instructions.
-- 2. Pizzas (Build Your Own + Gourmet): Large first, so it is the size
--    already picked, and Italian Style last.
-- 3. Beverages: 20 oz first, then the rest, 2 L at the bottom.
--
-- Functions are patched in place with exact text replacements, each checked
-- (count must match), so nothing else in them can drift.  Safe to re-run.

create or replace function public._wayne_patch_function_n(target regprocedure, old_text text, new_text text, expected integer default 1)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
  found_count integer;
begin
  if position(new_text in definition) > 0 and position(old_text in new_text) > 0 then
    -- new_text contains old_text: already applied when every occurrence is the new one.
    if (length(definition) - length(replace(definition, new_text, ''))) / length(new_text) = expected then return; end if;
  elsif position(new_text in definition) > 0 then
    return; -- already applied
  end if;
  found_count := (length(definition) - length(replace(definition, old_text, ''))) / length(old_text);
  if found_count <> expected then
    raise exception 'Patch for % expected % match(es), found %: %', target, expected, found_count, left(old_text, 120);
  end if;
  execute replace(definition, old_text, new_text);
end;
$$;

-- ── Schema ────────────────────────────────────────────────────────────────
alter table public.order_item_modifiers add column if not exists placement text not null default 'whole';
alter table public.order_item_modifiers drop constraint if exists order_item_modifiers_placement_check;
alter table public.order_item_modifiers add constraint order_item_modifiers_placement_check check (placement in ('whole', 'left', 'right'));

alter table public.modifier_groups add column if not exists allow_halves boolean not null default false;

-- ── The side, applied once the line is priced ─────────────────────────────
create or replace function public.wayne_apply_half_placements(p_order_item_id uuid, p_item_id uuid, p_variant_id uuid, p_modifiers jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected jsonb;
  side text;
  choice_row record;
  label text;
  touched boolean;
begin
  for selected in select value from jsonb_array_elements(coalesce(p_modifiers, '[]'::jsonb)) loop
    side := lower(btrim(coalesce(selected ->> 'placement', 'whole')));
    if side not in ('whole', 'left', 'right') then
      raise exception 'Choose left, whole or right for each topping' using errcode = '22023';
    end if;
    continue when side = 'whole';
    select choice.id, btrim(choice.name) as name, modifier_group.id as group_id, modifier_group.name as group_name, modifier_group.allow_halves
      into choice_row
      from public.modifier_choices choice
      join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id
     where choice.id = (selected ->> 'choice_id')::uuid;
    -- A side on a group that doesn't offer halves is simply the whole item.
    continue when not found or not choice_row.allow_halves;
    label := case side when 'left' then 'LEFT ½ ' else 'RIGHT ½ ' end;

    update public.order_item_modifiers
       set placement = side, modifier_name_snapshot = left(label || modifier_name_snapshot, 200)
     where order_item_id = p_order_item_id and modifier_choice_id = choice_row.id
       and placement = 'whole' and modifier_name_snapshot not like 'NO %';
    touched := found;

    -- Something the pizza comes with, moved to one half: its free portion was
    -- settled away (no row), but the kitchen still has to see which side.
    if not touched or (public.wayne_choice_included(p_item_id, choice_row.id)
                       and public.wayne_group_size_rule_id(choice_row.group_id, p_variant_id) is null) then
      insert into public.order_item_modifiers (order_item_id, modifier_choice_id, modifier_group_name_snapshot, modifier_name_snapshot, price_delta_cents, quantity, placement)
      values (p_order_item_id, choice_row.id, choice_row.group_name, left(label || choice_row.name, 200), 0, 1, side);
    end if;
  end loop;
end;
$$;

revoke all on function public.wayne_apply_half_placements(uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- ── Every path that writes order lines applies the side ───────────────────
select public._wayne_patch_function_n('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$perform public.wayne_apply_group_allowances(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));$o$,
$n$perform public.wayne_apply_group_allowances(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));
    perform public.wayne_apply_half_placements(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));$n$);

-- Add items to an order already sent (Today's Orders / Payments → Add items).
select public._wayne_patch_function_n('public.wayne_pos_insert_items(uuid,jsonb)'::regprocedure,
$o$perform public.wayne_apply_group_allowances(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));$o$,
$n$perform public.wayne_apply_group_allowances(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));
    perform public.wayne_apply_half_placements(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));$n$);

-- Website orders never send a side today; patched so the rule is the same everywhere.
select public._wayne_patch_function_n('public.wayne_create_test_order(jsonb)'::regprocedure,
$o$perform public.wayne_apply_group_allowances(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));$o$,
$n$perform public.wayne_apply_group_allowances(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));
    perform public.wayne_apply_half_placements(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> 'modifiers', '[]'::jsonb));$n$);

-- ── The POS menu tells the screen which groups offer halves ───────────────
select public._wayne_patch_function_n('public.wayne_pos_menu()'::regprocedure,
$o$'allow_quantities', modifier_group.allow_quantities,$o$,
$n$'allow_quantities', modifier_group.allow_quantities, 'allow_halves', modifier_group.allow_halves,$n$);

-- ── Admin saves keep the switch ───────────────────────────────────────────
-- Item editor (re-creates the item's groups from the form).
select public._wayne_patch_function_n('public.wayne_write_menu_children(uuid,jsonb)'::regprocedure,
$o$required, allow_quantities, sort_order
    ) values ($o$,
$n$required, allow_quantities, allow_halves, sort_order
    ) values ($n$);
select public._wayne_patch_function_n('public.wayne_write_menu_children(uuid,jsonb)'::regprocedure,
$o$(group_payload ->> 'allow_quantities')::boolean,
      group_index$o$,
$n$(group_payload ->> 'allow_quantities')::boolean,
      coalesce((group_payload ->> 'allow_halves')::boolean, false),
      group_index$n$);

-- Category "Edit options for all items" (copies shared groups, updates in place).
select public._wayne_patch_function_n('public.wayne_save_category_options(uuid,jsonb)'::regprocedure,
$o$required, allow_quantities, sort_order, active)$o$,
$n$required, allow_quantities, allow_halves, sort_order, active)$n$, 2);
select public._wayne_patch_function_n('public.wayne_save_category_options(uuid,jsonb)'::regprocedure,
$o$grp.required, grp.allow_quantities, grp.sort_order, true)$o$,
$n$grp.required, grp.allow_quantities, grp.allow_halves, grp.sort_order, true)$n$, 2);
select public._wayne_patch_function_n('public.wayne_save_category_options(uuid,jsonb)'::regprocedure,
$o$allow_quantities = coalesce((section ->> 'allow_quantities')::boolean, allow_quantities)
    where id = any(gids);$o$,
$n$allow_quantities = coalesce((section ->> 'allow_quantities')::boolean, allow_quantities),
      allow_halves = coalesce((section ->> 'allow_halves')::boolean, allow_halves)
    where id = any(gids);$n$);

drop function public._wayne_patch_function_n(regprocedure, text, text, integer);

-- ── Data ──────────────────────────────────────────────────────────────────
-- Halves on every pizza topping group (not Sauces, not Cooking Instructions).
update public.modifier_groups g
   set allow_halves = true
 where g.active and g.archived_at is null and not g.allow_halves
   and g.customer_label in ('Cheese', 'Meats', 'Vegetables', 'Choose your topping', 'Choose 2 toppings', 'Choose 3 toppings')
   and exists (
     select 1 from public.menu_item_modifier_groups link
     join public.menu_items item on item.id = link.menu_item_id and item.archived_at is null
     join public.menu_categories category on category.id = item.category_id and category.archived_at is null
     where link.modifier_group_id = g.id and link.active
       and category.name in ('Build Your Own Pizza', 'Gourmet Pizza'));

-- Pizzas: Large first (the size already picked when the pizza opens), Italian
-- Style last; every other size keeps its order between them.  On the Build
-- Your Own pizzas that is Large and Italian Style swapping places.
update public.menu_item_variants variant
   set sort_order = bounds.lowest - 10
  from (
    select item.id as item_id, min(v.sort_order) as lowest
      from public.menu_items item
      join public.menu_categories category on category.id = item.category_id and category.archived_at is null
      join public.menu_item_variants v on v.menu_item_id = item.id and v.active and v.archived_at is null
     where item.archived_at is null and category.name in ('Build Your Own Pizza', 'Gourmet Pizza')
     group by item.id
  ) bounds
 where variant.menu_item_id = bounds.item_id and variant.name = 'Large' and variant.active and variant.archived_at is null
   and exists (select 1 from public.menu_item_variants other where other.menu_item_id = variant.menu_item_id and other.id <> variant.id
               and other.active and other.archived_at is null and other.sort_order <= variant.sort_order);

update public.menu_item_variants variant
   set sort_order = bounds.highest + 10
  from (
    select item.id as item_id, max(v.sort_order) as highest
      from public.menu_items item
      join public.menu_categories category on category.id = item.category_id and category.archived_at is null
      join public.menu_item_variants v on v.menu_item_id = item.id and v.active and v.archived_at is null
     where item.archived_at is null and category.name in ('Build Your Own Pizza', 'Gourmet Pizza')
     group by item.id
  ) bounds
 where variant.menu_item_id = bounds.item_id and variant.name = 'Italian Style' and variant.active and variant.archived_at is null
   and exists (select 1 from public.menu_item_variants other where other.menu_item_id = variant.menu_item_id and other.id <> variant.id
               and other.active and other.archived_at is null and other.sort_order >= variant.sort_order);

-- Beverages: 20 oz, then everything else, then 2 L (each group keeps its own order).
with ranked as (
  select item.id, row_number() over (
           order by case when item.name ~* '^\s*20\s*oz' then 0 when item.name ~* '^\s*2\s*l\M' then 2 else 1 end, item.sort_order, item.name) as position
    from public.menu_items item
    join public.menu_categories category on category.id = item.category_id
   where category.name = 'Beverages' and category.archived_at is null and item.archived_at is null
)
update public.menu_items item
   set sort_order = ranked.position * 10
  from ranked
 where item.id = ranked.id and item.sort_order is distinct from ranked.position * 10;
