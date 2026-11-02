-- "The modifiers are moving around and in different spots" (Ehab, 2026-11-01).
--
-- Every item keeps its own copy of each option section (Vegetables, Meats,
-- Sauces…), and each copy had its own order: an option added from the category
-- page went to the END of every copy, item edits reshuffled single copies, and
-- sections sat in a different place from item to item.  So the same option
-- (Lettuce, Hot Pepper…) was in a different spot on every sub.
--
-- Now one order per category, the same on every item in it:
--   * options in a section follow the fullest copy of that section in the
--     category; options it lacks go after, where they usually sit, then by name;
--   * sections follow where they usually sit on the category's items.
-- Run once now for every category, and again after every category-options or
-- item save (the admin actions call wayne_align_category_option_order).
--
-- Only sort_order changes: no option, price, size price or "comes with" link is
-- added, removed or changed.  No option group is shared between categories, so
-- one category's order never moves another's.  Re-runnable.

create or replace function public._wayne_align_category_option_order(target_category_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  moved_choices integer := 0;
  moved_sections integer := 0;
begin
  -- 1. Options inside each section.
  with copies as (
    select distinct g.id as gid, lower(btrim(g.customer_label)) as label, g.created_at
    from public.menu_items item
    join public.menu_item_modifier_groups link on link.menu_item_id = item.id and link.active
    join public.modifier_groups g on g.id = link.modifier_group_id and g.active and g.archived_at is null
    where item.category_id = target_category_id and item.archived_at is null
  ), live as (
    select c.id, c.modifier_group_id as gid, lower(btrim(c.name)) as cname,
      row_number() over (partition by c.modifier_group_id order by c.sort_order, lower(btrim(c.name)), c.id) as pos,
      count(*) over (partition by c.modifier_group_id) as total
    from public.modifier_choices c
    join copies on copies.gid = c.modifier_group_id
    where c.active and c.archived_at is null
  ), template as (
    select distinct on (copies.label) copies.label, copies.gid
    from copies
    join (select gid, count(*) as n from live group by gid) sizes on sizes.gid = copies.gid
    order by copies.label, sizes.n desc, copies.created_at, copies.gid
  ), ranked as (
    select copies.label, live.cname,
      min(case when live.gid = template.gid then live.pos end) as template_pos,
      avg(live.pos::numeric / live.total) as usual_place
    from live
    join copies on copies.gid = live.gid
    join template on template.label = copies.label
    group by copies.label, live.cname
  ), canon as (
    select label, cname,
      (row_number() over (partition by label order by template_pos nulls last, usual_place, cname) - 1)::integer as rank
    from ranked
  ), target as (
    select live.id, canon.rank
    from live
    join copies on copies.gid = live.gid
    join canon on canon.label = copies.label and canon.cname = live.cname
  )
  update public.modifier_choices c
     set sort_order = target.rank
    from target
   where c.id = target.id and c.sort_order is distinct from target.rank;
  get diagnostics moved_choices = row_count;

  -- 2. The sections on each item.
  with links as (
    select link.menu_item_id as iid, link.modifier_group_id as gid, lower(btrim(g.customer_label)) as label,
      row_number() over (partition by link.menu_item_id order by link.sort_order, g.name, g.id) as pos,
      count(*) over (partition by link.menu_item_id) as total
    from public.menu_items item
    join public.menu_item_modifier_groups link on link.menu_item_id = item.id and link.active
    join public.modifier_groups g on g.id = link.modifier_group_id and g.active and g.archived_at is null
    where item.category_id = target_category_id and item.archived_at is null
  ), canon as (
    select label, row_number() over (order by avg(pos::numeric / total), label) as rank
    from links group by label
  ), target as (
    select links.iid, links.gid,
      (row_number() over (partition by links.iid order by canon.rank, links.pos) - 1)::integer as new_pos
    from links join canon using (label)
  )
  update public.menu_item_modifier_groups link
     set sort_order = target.new_pos
    from target
   where link.menu_item_id = target.iid and link.modifier_group_id = target.gid
     and link.sort_order is distinct from target.new_pos;
  get diagnostics moved_sections = row_count;

  return jsonb_build_object('choices_moved', moved_choices, 'sections_moved', moved_sections);
end;
$function$;

revoke all on function public._wayne_align_category_option_order(uuid) from public, anon, authenticated;

create or replace function public.wayne_align_category_option_order(target_category_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not public.wayne_has_permission('menu.manage') then
    raise exception 'Menu management permission required' using errcode = '42501';
  end if;
  return public._wayne_align_category_option_order(target_category_id);
end;
$function$;

revoke all on function public.wayne_align_category_option_order(uuid) from public, anon;
grant execute on function public.wayne_align_category_option_order(uuid) to authenticated;

-- One shared order for every category, now.
select public._wayne_align_category_option_order(id) from public.menu_categories;
