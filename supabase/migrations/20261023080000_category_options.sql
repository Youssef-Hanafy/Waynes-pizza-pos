-- Category options (owner request 2026-10-08): edit a category's option
-- sections (Cheese, Meats, Sauces, Vegetables, Cooking Instructions…) once for
-- every item in it, instead of opening each item.
--
-- Items keep their own option groups (each item's "comes with" toppings stay
-- per item). A section is every active group with the same customer label on
-- the category's items; one save updates all of them together.
--
-- payload = { sections: [ {
--   key: "<current label>",            -- which section (case-insensitive)
--   customer_label, min_select, max_select, required, allow_quantities,
--   add_to_all_items: bool,            -- give the section to items missing it
--   choices: [ {
--     key: "<current name>" | null,    -- null = a new option
--     name, price_cents: int | null,   -- null = keep each item's price
--     variant_prices: { "<size name>": int | null | "clear" },
--     everywhere: bool,                -- add to the items that don't have it
--     remove: bool
--   } ] } ] }

create or replace function public.wayne_save_category_options(target_category_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  item_ids uuid[];
  gids uuid[];
  section jsonb;
  choice jsonb;
  size_entry record;
  grp public.modifier_groups%rowtype;
  ch public.modifier_choices%rowtype;
  template_id uuid;
  missing_item uuid;
  new_gid uuid;
  new_cid uuid;
  gid uuid;
  label_key text;
  new_label text;
  choice_key text;
  choice_name text;
  price integer;
  min_value integer;
  max_value integer;
  updated_choices integer := 0;
  added_choices integer := 0;
  removed_choices integer := 0;
begin
  if not public.wayne_has_permission('menu.manage') then
    raise exception 'Menu management permission required' using errcode = '42501';
  end if;
  perform 1 from public.menu_categories where id = target_category_id for update;
  if not found then raise exception 'Category not found' using errcode = 'P0002'; end if;

  select coalesce(array_agg(id), '{}') into item_ids
  from public.menu_items where category_id = target_category_id and archived_at is null;
  if cardinality(item_ids) = 0 then
    return jsonb_build_object('updated', 0, 'added', 0, 'removed', 0);
  end if;

  -- 1. A group this category shares with items elsewhere gets a private copy
  --    first, so a category save never changes another category's items.
  for grp in
    select distinct g.* from public.modifier_groups g
    join public.menu_item_modifier_groups link on link.modifier_group_id = g.id and link.active
    where link.menu_item_id = any(item_ids) and g.active and g.archived_at is null
      and exists (
        select 1 from public.menu_item_modifier_groups other
        join public.menu_items other_item on other_item.id = other.menu_item_id and other_item.archived_at is null
        where other.modifier_group_id = g.id and other.active and not (other.menu_item_id = any(item_ids)))
  loop
    insert into public.modifier_groups (name, customer_label, min_select, max_select, required, allow_quantities, sort_order, active)
    values (grp.name, grp.customer_label, grp.min_select, grp.max_select, grp.required, grp.allow_quantities, grp.sort_order, true)
    returning id into new_gid;
    for ch in select * from public.modifier_choices where modifier_group_id = grp.id and active and archived_at is null loop
      insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order, active)
      values (new_gid, ch.name, ch.price_delta_cents, ch.default_selected, ch.sort_order, true)
      returning id into new_cid;
      insert into public.modifier_choice_variant_prices (modifier_choice_id, menu_item_variant_id, price_delta_cents)
      select new_cid, price_row.menu_item_variant_id, price_row.price_delta_cents
      from public.modifier_choice_variant_prices price_row
      join public.menu_item_variants variant on variant.id = price_row.menu_item_variant_id
      where price_row.modifier_choice_id = ch.id and variant.menu_item_id = any(item_ids);
      update public.menu_item_included_choices set modifier_choice_id = new_cid
      where modifier_choice_id = ch.id and menu_item_id = any(item_ids);
    end loop;
    update public.menu_item_modifier_groups set modifier_group_id = new_gid
    where modifier_group_id = grp.id and menu_item_id = any(item_ids);
  end loop;

  for section in select value from jsonb_array_elements(coalesce(payload -> 'sections', '[]'::jsonb)) loop
    label_key := lower(btrim(coalesce(section ->> 'key', '')));
    continue when label_key = '';

    select coalesce(array_agg(distinct g.id), '{}') into gids
    from public.modifier_groups g
    join public.menu_item_modifier_groups link on link.modifier_group_id = g.id and link.active
    where link.menu_item_id = any(item_ids) and g.active and g.archived_at is null
      and lower(btrim(g.customer_label)) = label_key;
    continue when cardinality(gids) = 0;

    -- Section rules, the same on every item.
    new_label := btrim(coalesce(nullif(section ->> 'customer_label', ''), section ->> 'key'));
    min_value := coalesce((section ->> 'min_select')::integer, 0);
    max_value := coalesce((section ->> 'max_select')::integer, 1);
    if char_length(new_label) not between 1 and 160 then raise exception 'Section names must be 1–160 characters' using errcode = '22023'; end if;
    if min_value < 0 or max_value < 1 or max_value < min_value or max_value > 200 then
      raise exception '%: the most they can pick must be at least 1 and at least the fewest', new_label using errcode = '22023';
    end if;
    update public.modifier_groups set
      customer_label = new_label,
      min_select = min_value,
      max_select = max_value,
      required = coalesce((section ->> 'required')::boolean, required),
      allow_quantities = coalesce((section ->> 'allow_quantities')::boolean, allow_quantities)
    where id = any(gids);

    -- Items in the category that don't have this section yet get a copy of
    -- the fullest one, with nothing marked as coming on it.
    if coalesce((section ->> 'add_to_all_items')::boolean, false) then
      select g.id into template_id from public.modifier_groups g
      where g.id = any(gids)
      order by (select count(*) from public.modifier_choices c where c.modifier_group_id = g.id and c.active and c.archived_at is null) desc, g.created_at
      limit 1;
      for missing_item in
        select item_id from unnest(item_ids) item_id
        where not exists (select 1 from public.menu_item_modifier_groups link
          where link.menu_item_id = item_id and link.active and link.modifier_group_id = any(gids))
      loop
        select * into grp from public.modifier_groups where id = template_id;
        insert into public.modifier_groups (name, customer_label, min_select, max_select, required, allow_quantities, sort_order, active)
        values (left((select name from public.menu_items where id = missing_item) || ' – ' || grp.customer_label, 120),
          grp.customer_label, grp.min_select, grp.max_select, grp.required, grp.allow_quantities, grp.sort_order, true)
        returning id into new_gid;
        insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order, active)
        select new_gid, c.name, c.price_delta_cents, false, c.sort_order, true
        from public.modifier_choices c where c.modifier_group_id = template_id and c.active and c.archived_at is null;
        insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order, active)
        values (missing_item, new_gid,
          coalesce((select max(sort_order) + 1 from public.menu_item_modifier_groups where menu_item_id = missing_item and active), 0), true)
        on conflict (menu_item_id, modifier_group_id) do update set active = true;
        gids := gids || new_gid;
      end loop;
    end if;

    for choice in select value from jsonb_array_elements(coalesce(section -> 'choices', '[]'::jsonb)) loop
      choice_key := nullif(lower(btrim(coalesce(choice ->> 'key', ''))), '');
      choice_name := btrim(coalesce(nullif(choice ->> 'name', ''), choice ->> 'key', ''));
      price := nullif(choice ->> 'price_cents', '')::integer;
      if price is not null and price not between -100000 and 100000 then
        raise exception '%: price is out of range', choice_name using errcode = '22023';
      end if;

      if coalesce((choice ->> 'remove')::boolean, false) then
        continue when choice_key is null;
        with gone as (
          update public.modifier_choices set active = false, archived_at = coalesce(archived_at, now())
          where modifier_group_id = any(gids) and lower(btrim(name)) = choice_key and archived_at is null
          returning id)
        delete from public.menu_item_included_choices where modifier_choice_id in (select id from gone);
        removed_choices := removed_choices + 1;
        continue;
      end if;

      if char_length(choice_name) not between 1 and 120 then
        raise exception 'Option names must be 1–120 characters' using errcode = '22023';
      end if;

      if choice_key is not null then
        update public.modifier_choices set
          name = choice_name,
          price_delta_cents = coalesce(price, price_delta_cents)
        where modifier_group_id = any(gids) and lower(btrim(name)) = choice_key and active and archived_at is null;
        if found then updated_choices := updated_choices + 1; end if;
      end if;

      -- New options go on every item's section; "everywhere" fills the gaps.
      if choice_key is null or coalesce((choice ->> 'everywhere')::boolean, false) then
        foreach gid in array gids loop
          if not exists (select 1 from public.modifier_choices c where c.modifier_group_id = gid
              and c.active and c.archived_at is null and lower(btrim(c.name)) = lower(choice_name)) then
            insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order, active)
            values (gid, choice_name,
              coalesce(price, (select c.price_delta_cents from public.modifier_choices c
                where c.modifier_group_id = any(gids) and c.active and c.archived_at is null and lower(btrim(c.name)) = lower(choice_name)
                group by c.price_delta_cents order by count(*) desc limit 1), 0),
              false,
              coalesce((select max(c.sort_order) + 1 from public.modifier_choices c where c.modifier_group_id = gid), 0),
              true);
            added_choices := added_choices + 1;
          end if;
        end loop;
      end if;

      -- Per-size prices, matched by the size's name on each item.
      for size_entry in select key, value from jsonb_each(coalesce(choice -> 'variant_prices', '{}'::jsonb)) loop
        continue when jsonb_typeof(size_entry.value) = 'null';
        if size_entry.value = '"clear"'::jsonb then
          delete from public.modifier_choice_variant_prices price_row
          using public.modifier_choices c, public.menu_item_variants variant
          where price_row.modifier_choice_id = c.id and price_row.menu_item_variant_id = variant.id
            and c.modifier_group_id = any(gids) and lower(btrim(c.name)) = lower(choice_name)
            and lower(btrim(variant.name)) = lower(btrim(size_entry.key));
          continue;
        end if;
        price := (size_entry.value #>> '{}')::integer;
        if price not between -100000 and 100000 then
          raise exception '%: % price is out of range', choice_name, size_entry.key using errcode = '22023';
        end if;
        insert into public.modifier_choice_variant_prices (modifier_choice_id, menu_item_variant_id, price_delta_cents)
        select c.id, variant.id, price
        from public.modifier_choices c
        join public.menu_item_modifier_groups link on link.modifier_group_id = c.modifier_group_id and link.active
        join public.menu_item_variants variant on variant.menu_item_id = link.menu_item_id and variant.active and variant.archived_at is null
        where c.modifier_group_id = any(gids) and c.active and c.archived_at is null
          and lower(btrim(c.name)) = lower(choice_name)
          and link.menu_item_id = any(item_ids)
          and lower(btrim(variant.name)) = lower(btrim(size_entry.key))
        on conflict (modifier_choice_id, menu_item_variant_id) do update set price_delta_cents = excluded.price_delta_cents;
      end loop;
    end loop;
  end loop;

  return jsonb_build_object('updated', updated_choices, 'added', added_choices, 'removed', removed_choices);
end;
$function$;

revoke all on function public.wayne_save_category_options(uuid, jsonb) from public, anon;
grant execute on function public.wayne_save_category_options(uuid, jsonb) to authenticated, service_role;
