-- Salads: one dressing section + extra meats (owner, 2026-10-12).
--
-- Every salad comes with 1 dressing; each dressing after that is $1.65.
-- Before, salads had two sections doing the same job: "Salad Dressing"
-- (choose your dressing, free) and "Salads – Salad Dressings" (extra
-- dressing, $1.10 each).  They are merged into the single "Salad Dressing"
-- section: pick any mix with quantities, the first portion is free and every
-- extra portion is $1.65 (modifier_group_size_rules, size '' = any size).
-- The old extra-dressing section is archived (not deleted) so past orders
-- that used it still read correctly.
--
-- Also adds "Salads – Meats" with one option, "Extra Meat" (more of the meat
-- the salad already has), to every salad.  $3.50 to match Extra Meat on the
-- subs; editable in Admin -> Menu -> Salads -> Options.

do $$
declare
  ws uuid;
  dressing uuid;
  old_extra uuid;
  meats uuid;
  salad_cat uuid;
begin
  select id, workspace_id into dressing, ws from public.modifier_groups
   where name = 'Salad Dressing' and archived_at is null limit 1;
  select id into old_extra from public.modifier_groups
   where name = 'Salads – Salad Dressings' and archived_at is null limit 1;
  select id into salad_cat from public.menu_categories
   where name ilike 'salad%' and archived_at is null order by sort_order limit 1;
  if dressing is null or salad_cat is null then
    raise notice 'salad dressing group or salad category not found; skipping';
    return;
  end if;

  -- 1. The one dressing section: 1 free, $1.65 each extra, quantities allowed.
  update public.modifier_groups
     set customer_label = 'Choose your dressing (1 included)',
         allow_quantities = true, min_select = 0, required = false,
         max_select = greatest(max_select, 10), updated_at = now()
   where id = dressing;

  insert into public.modifier_group_size_rules (modifier_group_id, size_name, included_count, max_portions, extra_each_cents, workspace_id)
  values (dressing, '', 1, null, 165, ws)
  on conflict (modifier_group_id, lower(btrim(size_name)))
  do update set included_count = 1, extra_each_cents = 165, updated_at = now();

  -- "Extra Dressing" as an option is redundant now (just add a second dressing).
  update public.modifier_choices set active = false, archived_at = coalesce(archived_at, now()), updated_at = now()
   where modifier_group_id = dressing and name = 'Extra Dressing';

  -- Every salad gets the dressing section, at the top.
  insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order, active, workspace_id)
  select mi.id, dressing, 0, true, mi.workspace_id
    from public.menu_items mi
   where mi.category_id = salad_cat and mi.archived_at is null
  on conflict do nothing;
  update public.menu_item_modifier_groups mg set active = true
    from public.menu_items mi
   where mg.menu_item_id = mi.id and mi.category_id = salad_cat and mg.modifier_group_id = dressing;

  if old_extra is not null then
    -- "Comes with" picks that pointed at the old section move to the same
    -- dressing in the merged one (Chicken Caesar -> Caesar Dressing).
    insert into public.menu_item_included_choices (menu_item_id, modifier_choice_id, workspace_id)
    select ic.menu_item_id, new_ch.id, ic.workspace_id
      from public.menu_item_included_choices ic
      join public.modifier_choices old_ch on old_ch.id = ic.modifier_choice_id and old_ch.modifier_group_id = old_extra
      join public.modifier_choices new_ch on new_ch.modifier_group_id = dressing and new_ch.name = old_ch.name and new_ch.archived_at is null
    on conflict do nothing;
    delete from public.menu_item_included_choices ic
     using public.modifier_choices old_ch
     where old_ch.id = ic.modifier_choice_id and old_ch.modifier_group_id = old_extra;

    delete from public.menu_item_modifier_groups where modifier_group_id = old_extra;
    update public.modifier_groups set active = false, archived_at = coalesce(archived_at, now()), updated_at = now()
     where id = old_extra;
  end if;

  -- 2. Extra meats for salads.
  select id into meats from public.modifier_groups where name = 'Salads – Meats' and archived_at is null limit 1;
  if meats is null then
    insert into public.modifier_groups (name, customer_label, min_select, max_select, required, allow_quantities, sort_order, active, workspace_id)
    values ('Salads – Meats', 'Extra meat', 0, 5, false, true, 15, true, ws)
    returning id into meats;

    insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order, active, workspace_id)
    values (meats, 'Extra Meat', 350, false, 0, true, ws);
  end if;

  insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order, active, workspace_id)
  select mi.id, meats, 15, true, mi.workspace_id
    from public.menu_items mi
   where mi.category_id = salad_cat and mi.archived_at is null
  on conflict do nothing;
end $$;
