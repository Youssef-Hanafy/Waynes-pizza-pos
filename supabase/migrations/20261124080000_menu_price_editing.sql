-- Prices remain in menu_items / menu_item_variants. No order rows are changed.
-- A revision covers the entire editor, including changes to shared options.
alter table public.menu_items add column menu_revision bigint not null default 0;

create function public.wayne_bump_menu_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.menu_revision := old.menu_revision + 1;
  return new;
end;
$$;
create trigger menu_items_bump_revision before update on public.menu_items
for each row execute function public.wayne_bump_menu_revision();

create function public.wayne_touch_menu_parent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb;
  group_ids uuid[] := '{}';
  item_ids uuid[] := '{}';
begin
  -- Include both parents when a row is moved. Lock in ID order to reduce
  -- deadlocks when shared modifier groups touch several items.
  for row_data in select value from jsonb_array_elements(jsonb_build_array(
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end)) where value <> 'null'::jsonb
  loop
    if row_data ? 'menu_item_id' then
      item_ids := array_append(item_ids, (row_data->>'menu_item_id')::uuid);
    elsif tg_table_name = 'modifier_groups' then
      group_ids := array_append(group_ids, (row_data->>'id')::uuid);
    elsif row_data ? 'modifier_group_id' then
      group_ids := array_append(group_ids, (row_data->>'modifier_group_id')::uuid);
    elsif row_data ? 'modifier_choice_id' then
      group_ids := array_append(group_ids, (select modifier_group_id from public.modifier_choices where id=(row_data->>'modifier_choice_id')::uuid));
    end if;
  end loop;
  perform 1 from public.menu_items where id = any(item_ids) or id in (
    select menu_item_id from public.menu_item_modifier_groups where active and modifier_group_id=any(group_ids)
  ) order by id for update;
  update public.menu_items set menu_revision=menu_revision where id=any(item_ids) or id in (
    select menu_item_id from public.menu_item_modifier_groups where active and modifier_group_id=any(group_ids)
  );
  return null;
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['menu_item_variants','menu_item_modifier_groups','menu_item_included_choices',
    'modifier_groups','modifier_choices','modifier_choice_variant_prices','modifier_group_size_rules'] loop
    execute format('create trigger menu_parent_revision after insert or update or delete on public.%I for each row execute function public.wayne_touch_menu_parent()',t);
  end loop;
end;
$$;
revoke all on function public.wayne_touch_menu_parent() from public, anon, authenticated;

-- The full editor still supports archived-safe structural edits. Older clients
-- must reload; they cannot silently overwrite a new price with stale form data.
-- PT409 maps to HTTP 409; 40001 makes hosted PostgREST retry indefinitely.
alter function public.wayne_update_menu_item(uuid,jsonb) rename to wayne_update_menu_item_definition;
revoke all on function public.wayne_update_menu_item_definition(uuid,jsonb) from public, anon, authenticated, service_role;
create function public.wayne_update_menu_item(target_item_id uuid, payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  target public.menu_items%rowtype;
  saved_rules jsonb;
  group_rules jsonb;
  rule jsonb;
  new_group_id uuid;
begin
  select * into target from public.menu_items where id=target_item_id and archived_at is null for update;
  if not found then raise exception 'Menu item not found' using errcode='P0002'; end if;
  if not public.wayne_has_permission(target.workspace_id,'menu.manage') then
    raise exception 'Menu management permission required' using errcode='42501';
  end if;
  if (payload->>'expected_revision')::bigint is distinct from target.menu_revision then
    raise exception 'This item changed on another register. Reload before saving.' using errcode='PT409';
  end if;
  if not exists(select 1 from public.menu_categories where id=(payload->>'category_id')::uuid and workspace_id=target.workspace_id and archived_at is null) then
    raise exception 'Choose an active category in this business' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(payload->'variants') v group by lower(btrim(v->>'name')) having count(*)>1) then
    raise exception 'Size names must be unique' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(payload->'modifier_groups') g
    where ((g->>'required')::boolean and (g->>'min_select')::integer < 1)
       or (jsonb_array_length(g->'choices')=0 and ((g->>'required')::boolean or (g->>'min_select')::integer > 0))) then
    raise exception 'A group requiring selections must contain an active choice' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(payload->'modifier_groups') g
    where g->>'id' is not null and not exists(select 1 from public.menu_item_modifier_groups l
      join public.modifier_groups mg on mg.id=l.modifier_group_id
      where l.menu_item_id=target.id and l.modifier_group_id=(g->>'id')::uuid
        and l.active and mg.active and mg.archived_at is null and mg.workspace_id=target.workspace_id)) then
    raise exception 'The modifier groups changed or do not belong to this item. Reload before saving.' using errcode='PT409';
  end if;
  if exists(select 1 from jsonb_array_elements(payload->'variants') v where v->>'id' is not null
    and not exists(select 1 from public.menu_item_variants old_v where old_v.id=(v->>'id')::uuid
      and old_v.menu_item_id=target.id and old_v.active and old_v.archived_at is null)) then
    raise exception 'The sizes changed. Reload before saving.' using errcode='PT409';
  end if;

  -- The legacy full editor recreates groups and cannot serialize size rules.
  -- Retain their allowance values on the new group, using submitted group IDs
  -- and variant IDs to follow reordering/renaming without guessing by position.
  select coalesce(jsonb_agg(jsonb_build_object('index',g.ordinality-1,'rules',(
    select coalesce(jsonb_agg(jsonb_build_object(
      'size_name',case when r.size_name='' then '' else (
        select btrim(v->>'name') from jsonb_array_elements(payload->'variants') v
        where (v->>'id' is not null and exists(select 1 from public.menu_item_variants old_v
                where old_v.id=(v->>'id')::uuid and lower(btrim(old_v.name))=lower(btrim(r.size_name))))
           or (v->>'id' is null and lower(btrim(v->>'name'))=lower(btrim(r.size_name)))
        limit 1) end,
      'included_count',r.included_count,'max_portions',r.max_portions,'extra_each_cents',r.extra_each_cents)), '[]'::jsonb)
    from public.modifier_group_size_rules r where r.modifier_group_id=(g.value->>'id')::uuid
  ))),'[]'::jsonb) into saved_rules
  from jsonb_array_elements(payload->'modifier_groups') with ordinality g;

  perform public.wayne_update_menu_item_definition(target_item_id,payload);
  for group_rules in select value from jsonb_array_elements(saved_rules) loop
    select modifier_group_id into new_group_id from public.menu_item_modifier_groups
      where menu_item_id=target.id and active and sort_order=(group_rules->>'index')::integer;
    for rule in select value from jsonb_array_elements(group_rules->'rules') where value->>'size_name' is not null loop
      insert into public.modifier_group_size_rules(modifier_group_id,size_name,included_count,max_portions,extra_each_cents,workspace_id)
      values(new_group_id,rule->>'size_name',(rule->>'included_count')::integer,(rule->>'max_portions')::integer,(rule->>'extra_each_cents')::integer,target.workspace_id);
    end loop;
  end loop;
  return target.id;
end;
$$;
revoke all on function public.wayne_update_menu_item(uuid,jsonb) from public,anon;
grant execute on function public.wayne_update_menu_item(uuid,jsonb) to authenticated;

-- Price-only saves never replace children, included portions, half settings,
-- modifier overrides, or IDs referenced by other registers and historical lines.
create function public.wayne_set_menu_prices(target_item_id uuid, expected_revision bigint, base_price_cents integer, variant_prices jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target public.menu_items%rowtype;
begin
  select * into target from public.menu_items where id=target_item_id and archived_at is null for update;
  if not found then raise exception 'Menu item not found' using errcode='P0002'; end if;
  if not public.wayne_has_permission(target.workspace_id,'menu.manage') then
    raise exception 'Menu management permission required' using errcode='42501';
  end if;
  if target.special then raise exception 'Set special prices from Specials' using errcode='22023'; end if;
  if expected_revision is distinct from target.menu_revision then
    raise exception 'This item changed on another register. Reload before saving.' using errcode='PT409';
  end if;
  if base_price_cents is null or base_price_cents < 0 or base_price_cents > 1000000 then
    raise exception 'Enter a price between $0.00 and $10,000.00' using errcode='22023';
  end if;
  if jsonb_typeof(variant_prices) is distinct from 'array' then raise exception 'Sizes must be a list' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(variant_prices) p where
      jsonb_typeof(p->'price_cents') is distinct from 'number' or
      (p->>'price_cents') !~ '^\d+$' or (p->>'price_cents')::numeric not between 0 and 1000000) then
    raise exception 'Enter valid size prices in whole cents' using errcode='22023';
  end if;
  if (select count(*) from jsonb_array_elements(variant_prices)) <>
     (select count(distinct p->>'id') from jsonb_array_elements(variant_prices) p)
     or exists(select 1 from jsonb_array_elements(variant_prices) p where not exists(
       select 1 from public.menu_item_variants v where v.id=(p->>'id')::uuid and v.menu_item_id=target.id and v.active and v.archived_at is null))
     or exists(select 1 from public.menu_item_variants v where v.menu_item_id=target.id and v.active and v.archived_at is null and not exists(
       select 1 from jsonb_array_elements(variant_prices) p where (p->>'id')::uuid=v.id)) then
    raise exception 'The sizes changed. Reload before saving prices.' using errcode='PT409';
  end if;
  update public.menu_item_variants v set price_cents=(p->>'price_cents')::integer
    from jsonb_array_elements(variant_prices) p where v.id=(p->>'id')::uuid and v.menu_item_id=target.id and v.price_cents is distinct from (p->>'price_cents')::integer;
  update public.menu_items set base_price_cents=wayne_set_menu_prices.base_price_cents where id=target.id;
  return target.id;
end;
$$;
revoke all on function public.wayne_set_menu_prices(uuid,bigint,integer,jsonb) from public,anon;
grant execute on function public.wayne_set_menu_prices(uuid,bigint,integer,jsonb) to authenticated;

-- Internal revisions should not clutter the existing immutable audit entries.
-- Actual base/size/modifier price diffs continue to be logged by their triggers.
do $$
declare definition text := pg_get_functiondef('public.wayne_audit_row_change()'::regprocedure);
begin
  if position($old$array['created_at', 'updated_at', 'uses_count']$old$ in definition)=0 then
    raise exception 'Audit ignore list changed; review menu revision migration';
  end if;
  execute replace(definition,
    $old$array['created_at', 'updated_at', 'uses_count']$old$,
    $new$array['created_at', 'updated_at', 'uses_count', 'menu_revision']$new$);
end;
$$;
