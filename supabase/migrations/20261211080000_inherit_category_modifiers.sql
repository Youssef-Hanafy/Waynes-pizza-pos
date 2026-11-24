-- Category options are stored on sibling items. Give the new item independent
-- copies so its own editing and pricing keep working through the normal menus.
create function public._wayne_inherit_category_modifiers(target_item_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  target public.menu_items%rowtype;
  section record;
  source_choice record;
  new_group_id uuid;
  new_choice_id uuid;
  next_sort_order integer;
begin
  select * into strict target from public.menu_items where id = target_item_id for update;
  select coalesce(max(sort_order) + 1, 0) into next_sort_order
  from public.menu_item_modifier_groups where menu_item_id = target.id and active;

  for section in
    with sibling_groups as (
      select g.*, sibling.id as item_id, link.sort_order as link_order,
        lower(btrim(g.customer_label)) as label_key,
        (g.required or g.min_select > 0 or exists (
          select 1 from public.modifier_group_size_rules rule
          where rule.modifier_group_id = g.id and rule.included_count > 0
        )) as item_terms,
        (select count(*) from public.modifier_choices c
         where c.modifier_group_id = g.id and c.active and c.archived_at is null) as choice_count
      from public.menu_items sibling
      join public.menu_item_modifier_groups link on link.menu_item_id = sibling.id and link.active
      join public.modifier_groups g on g.id = link.modifier_group_id and g.active and g.archived_at is null
      where sibling.category_id = target.category_id and sibling.workspace_id = target.workspace_id
        and sibling.archived_at is null and not sibling.special and sibling.id <> target.id
        and g.workspace_id = target.workspace_id
    ), templates as (
      select distinct on (g.label_key) g.*
      from sibling_groups g
      where g.choice_count > 0
        -- Selections tied to a requirement or included portions must be
        -- shared across configured siblings to serve as a category option.
        and (not g.item_terms or
          (select count(distinct s.item_id) from sibling_groups s where s.label_key = g.label_key)
          = (select count(distinct s.item_id) from sibling_groups s))
      order by g.label_key, g.item_terms, g.choice_count desc,
        g.created_at, g.id, g.item_id
    )
    select g.*,
      (select array_agg(distinct s.id) from sibling_groups s where s.label_key = g.label_key) as group_ids
    from templates g
    where not exists (
      select 1 from public.menu_item_modifier_groups link
      join public.modifier_groups existing on existing.id = link.modifier_group_id
      where link.menu_item_id = target.id and link.active and existing.active and existing.archived_at is null
        and lower(btrim(existing.customer_label)) = g.label_key
    )
    order by g.link_order, g.label_key
  loop
    insert into public.modifier_groups (workspace_id, name, customer_label, min_select, max_select,
      required, allow_quantities, allow_halves, sort_order)
    values (target.workspace_id, left(target.name || ' – ' || section.customer_label, 120), section.customer_label,
      section.min_select, section.max_select, section.required, section.allow_quantities, section.allow_halves,
      next_sort_order)
    returning id into new_group_id;

    insert into public.menu_item_modifier_groups (workspace_id, menu_item_id, modifier_group_id, sort_order)
    values (target.workspace_id, target.id, new_group_id, next_sort_order);
    next_sort_order := next_sort_order + 1;

    for source_choice in
      select distinct on (lower(btrim(c.name))) c.*
      from public.modifier_choices c
      where c.modifier_group_id = any(section.group_ids)
        and c.workspace_id = target.workspace_id and c.active and c.archived_at is null
      order by lower(btrim(c.name)), (c.modifier_group_id = section.id) desc, c.created_at, c.id
    loop
      -- An ingredient that comes on a sibling item is an item-specific choice.
      insert into public.modifier_choices (workspace_id, modifier_group_id, name, price_delta_cents, sort_order)
      values (target.workspace_id, new_group_id, source_choice.name, source_choice.price_delta_cents,
        source_choice.sort_order)
      returning id into new_choice_id;

      insert into public.modifier_choice_variant_prices
        (workspace_id, modifier_choice_id, menu_item_variant_id, price_delta_cents)
      select distinct on (destination.id)
        target.workspace_id, new_choice_id, destination.id, price.price_delta_cents
      from public.modifier_choice_variant_prices price
      join public.modifier_choices priced_choice on priced_choice.id = price.modifier_choice_id
      join public.menu_item_variants original on original.id = price.menu_item_variant_id
      join public.menu_items sibling on sibling.id = original.menu_item_id
      join public.menu_item_modifier_groups link on link.menu_item_id = sibling.id
        and link.modifier_group_id = priced_choice.modifier_group_id and link.active
      join public.menu_item_variants destination on destination.menu_item_id = target.id
        and lower(btrim(destination.name)) = lower(btrim(original.name))
      where priced_choice.modifier_group_id = any(section.group_ids) and priced_choice.active
        and priced_choice.workspace_id = target.workspace_id and priced_choice.archived_at is null
        and lower(btrim(priced_choice.name)) = lower(btrim(source_choice.name))
        and price.workspace_id = target.workspace_id
        and sibling.category_id = target.category_id and sibling.workspace_id = target.workspace_id
        and sibling.archived_at is null and not sibling.special and sibling.id <> target.id
        and original.active and original.archived_at is null and destination.active and destination.archived_at is null
      order by destination.id, (sibling.id = section.item_id) desc, (priced_choice.id = source_choice.id) desc,
        sibling.sort_order, sibling.created_at, sibling.id, original.id, priced_choice.id;
    end loop;

    -- Portion charges and caps are reusable. Included portions belong to the item.
    insert into public.modifier_group_size_rules
      (workspace_id, modifier_group_id, size_name, included_count, max_portions, extra_each_cents)
    select distinct on (lower(btrim(rule.size_name)))
      target.workspace_id, new_group_id, rule.size_name, 0, rule.max_portions, rule.extra_each_cents
    from public.modifier_group_size_rules rule
    where rule.modifier_group_id = any(section.group_ids)
      and (rule.max_portions is not null or rule.extra_each_cents is not null)
      and (rule.size_name = '' or exists (
        select 1 from public.menu_item_variants variant where variant.menu_item_id = target.id
          and variant.active and variant.archived_at is null
          and lower(btrim(variant.name)) = lower(btrim(rule.size_name))
      ))
    order by lower(btrim(rule.size_name)), (rule.modifier_group_id = section.id) desc, rule.created_at, rule.id;
  end loop;
end;
$$;
revoke all on function public._wayne_inherit_category_modifiers(uuid) from public, anon, authenticated, service_role;

alter function public.wayne_create_menu_item(jsonb) rename to wayne_create_menu_item_without_category_modifiers;
revoke all on function public.wayne_create_menu_item_without_category_modifiers(jsonb)
  from public, anon, authenticated, service_role;

create function public.wayne_create_menu_item(payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  category_workspace_id uuid;
  saved uuid;
begin
  select workspace_id into category_workspace_id from public.menu_categories
  where id = (payload->>'category_id')::uuid and archived_at is null for update;
  if not found then
    raise exception 'Choose an active category in this business' using errcode = '22023';
  end if;
  if not public.wayne_has_permission(category_workspace_id, 'menu.manage') then
    raise exception 'Menu management permission required' using errcode = '42501';
  end if;

  saved := public.wayne_create_menu_item_without_category_modifiers(payload);
  if not exists (select 1 from public.menu_items where id = saved and workspace_id = category_workspace_id) then
    raise exception 'Choose an active category in this business' using errcode = '22023';
  end if;
  perform public._wayne_inherit_category_modifiers(saved);
  return saved;
end;
$$;
revoke all on function public.wayne_create_menu_item(jsonb) from public, anon;
grant execute on function public.wayne_create_menu_item(jsonb) to authenticated;

-- Repair the existing Party Pizza in the Wayne's Pizza workspace.
select public._wayne_inherit_category_modifiers(item.id)
from public.menu_items item
join public.menu_categories category on category.id = item.category_id
join public.workspaces workspace on workspace.id = item.workspace_id and workspace.id = category.workspace_id
where workspace.slug = 'waynes-pizza'
  and lower(btrim(category.name)) = 'build your own pizza' and category.archived_at is null
  and lower(btrim(item.name)) = 'party pizza' and item.archived_at is null and not item.special;
