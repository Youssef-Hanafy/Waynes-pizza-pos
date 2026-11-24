-- A full item save writes private modifier groups, so opting out affects only
-- the item being edited. Existing choices continue to use the shared catalog.
alter table public.modifier_choices add column use_shared_price boolean not null default true;

create or replace function public.wayne_shared_sauce_price(target_choice_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select p.price_cents from public.modifier_choices c
  join public.modifier_groups g on g.id = c.modifier_group_id
  join public.menu_shared_sauce_prices p on p.workspace_id = c.workspace_id and p.choice_key = lower(btrim(c.name))
  where c.id = target_choice_id and c.use_shared_price and public.wayne_is_sauce_option(g.customer_label, c.name);
$$;

do $$
declare
  definition text;
  target regprocedure;
  choice_columns constant text := 'modifier_group_id, name, price_delta_cents, default_selected, sort_order';
  clone_columns constant text := '(' || choice_columns || ', active)' || chr(10) || '      values (new_gid, ch.name';
  shared_field constant text := '''shared_price_cents'', public.wayne_shared_sauce_price(choice.id)';
  portion_price constant text := 'coalesce(public.wayne_shared_sauce_price(picked.id), rule.extra_each_cents, picked.unit)';
  catalog_count constant text := 'count(distinct l.menu_item_id) item_count';
  seed_order constant text := 'order by lower(btrim(c.name)), (c.modifier_group_id = section.id) desc';
  price_order constant text := 'order by destination.id, (sibling.id = section.item_id) desc';
begin
  definition := pg_get_functiondef('public.wayne_write_menu_children(uuid,jsonb)'::regprocedure);
  if strpos(definition, choice_columns) = 0 or strpos(definition, '        choice_index') = 0 then
    raise exception 'Menu choice writer changed';
  end if;
  execute replace(replace(definition, choice_columns, choice_columns || ', use_shared_price'),
    '        choice_index', $value$        choice_index,
        case when public.wayne_is_sauce_option(group_payload->>'customer_label', choice->>'name') then
          coalesce((choice->>'use_shared_price')::boolean, (
            select previous.use_shared_price
            from public.modifier_choices previous
            join public.menu_item_modifier_groups link on link.modifier_group_id = previous.modifier_group_id
            where link.menu_item_id = target_item_id
              and link.modifier_group_id = (group_payload->>'id')::uuid
              and (previous.active or previous.archived_at = now())
              and lower(btrim(previous.name)) = lower(btrim(choice->>'name'))
            order by previous.sort_order, previous.id
            limit 1
          ), true)
        else true end$value$);

  definition := pg_get_functiondef('public.wayne_group_allowance_lines(uuid,uuid,jsonb)'::regprocedure);
  if strpos(definition, portion_price) = 0 or strpos(definition, 'select choice.id, choice.name,') = 0 then
    raise exception 'Modifier allowance pricing changed';
  end if;
  execute replace(replace(definition, 'select choice.id, choice.name,', 'select choice.id, choice.name, choice.use_shared_price,'),
    portion_price, 'case when picked.use_shared_price then ' || portion_price || ' else picked.unit end');

  foreach target in array array[
    'public.hanafy_workspace_menu(uuid)'::regprocedure,
    'public.wayne_pos_menu()'::regprocedure
  ] loop
    definition := pg_get_functiondef(target);
    if strpos(definition, shared_field) = 0 then raise exception 'Shared pricing missing from %', target; end if;
    execute replace(definition, shared_field, shared_field || ', ''use_shared_price'', choice.use_shared_price');
  end loop;

  -- A category edit can isolate a group previously shared with another
  -- category. Preserve its prices and selections when making that copy.
  definition := pg_get_functiondef('public.wayne_save_category_options(uuid,jsonb)'::regprocedure);
  if strpos(definition, '(new_gid, ch.name, ch.price_delta_cents, ch.default_selected, ch.sort_order, true)') = 0
    or strpos(definition, clone_columns) = 0 then
    raise exception 'Category choice clone changed';
  end if;
  execute replace(replace(definition, clone_columns,
    '(' || choice_columns || ', active, use_shared_price)' || chr(10) || '      values (new_gid, ch.name'),
    '(new_gid, ch.name, ch.price_delta_cents, ch.default_selected, ch.sort_order, true)',
    '(new_gid, ch.name, ch.price_delta_cents, ch.default_selected, ch.sort_order, true, ch.use_shared_price)');

  definition := pg_get_functiondef('public.wayne_shared_sauce_catalog()'::regprocedure);
  if strpos(definition, catalog_count) = 0 then raise exception 'Shared sauce catalog changed'; end if;
  execute replace(definition, catalog_count, 'count(distinct l.menu_item_id) filter (where c.use_shared_price) item_count');

  -- New items still opt into shared pricing. Prefer shared-priced siblings
  -- when inheriting their fallback and per-size prices.
  definition := pg_get_functiondef('public._wayne_inherit_category_modifiers(uuid)'::regprocedure);
  if strpos(definition, seed_order) = 0 or strpos(definition, price_order) = 0 then
    raise exception 'Category modifier inheritance changed';
  end if;
  execute replace(replace(definition, seed_order,
    'order by lower(btrim(c.name)), c.use_shared_price desc, (c.modifier_group_id = section.id) desc'),
    price_order, 'order by destination.id, priced_choice.use_shared_price desc, (sibling.id = section.item_id) desc');
end;
$$;
