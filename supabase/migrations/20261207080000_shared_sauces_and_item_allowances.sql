-- Shared sauce prices are workspace scoped. Included portions stay on each
-- item's groups and sizes; historic order/payment snapshots are untouched.
create table public.menu_shared_sauce_prices (
  workspace_id uuid not null references public.workspaces(id),
  choice_key text not null check (choice_key = lower(btrim(choice_key)) and choice_key <> ''),
  price_cents integer not null check (price_cents between 0 and 100000),
  primary key (workspace_id, choice_key)
);
alter table public.menu_shared_sauce_prices enable row level security;
revoke all on public.menu_shared_sauce_prices from anon, authenticated;

create function public.wayne_is_sauce_option(group_label text, choice_name text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(group_label,'') ~* '(sauce|dressing)'
    and coalesce(choice_name,'') !~* '^\s*(no|light|lite)\M';
$$;
create function public.wayne_shared_sauce_price(target_choice_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select p.price_cents from public.modifier_choices c
  join public.modifier_groups g on g.id=c.modifier_group_id
  join public.menu_shared_sauce_prices p on p.workspace_id=c.workspace_id and p.choice_key=lower(btrim(c.name))
  where c.id=target_choice_id and public.wayne_is_sauce_option(g.customer_label,c.name);
$$;
revoke all on function public.wayne_shared_sauce_price(uuid) from public;
grant execute on function public.wayne_shared_sauce_price(uuid) to anon,authenticated,service_role;

create function public.wayne_shared_sauce_catalog()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare wid uuid := (public.hanafy_current_workspace_access()->>'workspace_id')::uuid;
begin
  if not public.wayne_has_permission(wid,'menu.manage') then raise exception 'Menu permission required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('key',s.key,'name',s.name,'price_cents',p.price_cents,
    'min_cents',s.min_cents,'max_cents',s.max_cents,'item_count',s.item_count) order by s.name)
    from (
      select lower(btrim(c.name)) key,min(btrim(c.name)) name,min(coalesce(r.extra_each_cents,vp.price_delta_cents,c.price_delta_cents)) min_cents,
        max(coalesce(r.extra_each_cents,vp.price_delta_cents,c.price_delta_cents)) max_cents,count(distinct l.menu_item_id) item_count
      from public.modifier_choices c join public.modifier_groups g on g.id=c.modifier_group_id
      join public.menu_item_modifier_groups l on l.modifier_group_id=g.id and l.active
      join public.menu_items i on i.id=l.menu_item_id and i.archived_at is null
      left join public.modifier_group_size_rules r on r.modifier_group_id=g.id
      left join public.modifier_choice_variant_prices vp on vp.modifier_choice_id=c.id
      where c.workspace_id=wid and c.active and c.archived_at is null and g.active and g.archived_at is null
        and public.wayne_is_sauce_option(g.customer_label,c.name)
      group by lower(btrim(c.name))
    ) s left join public.menu_shared_sauce_prices p on p.workspace_id=wid and p.choice_key=s.key),'[]'::jsonb);
end;
$$;
revoke all on function public.wayne_shared_sauce_catalog() from public,anon;
grant execute on function public.wayne_shared_sauce_catalog() to authenticated;

create function public.wayne_save_shared_sauce_prices(payload jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare wid uuid := (public.hanafy_current_workspace_access()->>'workspace_id')::uuid; row jsonb; saved integer := 0;
begin
  if not public.wayne_has_permission(wid,'menu.manage') then raise exception 'Menu permission required' using errcode='42501'; end if;
  if jsonb_typeof(payload) is distinct from 'array' or jsonb_array_length(payload)>200 then raise exception 'Invalid sauce prices' using errcode='22023'; end if;
  for row in select value from jsonb_array_elements(payload) loop
    if (row->>'price_cents') is null or (row->>'price_cents') !~ '^\d+$' or (row->>'price_cents')::numeric not between 0 and 100000 then raise exception 'Enter a valid sauce price' using errcode='22023'; end if;
    if not exists(select 1 from public.modifier_choices c join public.modifier_groups g on g.id=c.modifier_group_id
      where c.workspace_id=wid and lower(btrim(c.name))=row->>'key' and c.active and c.archived_at is null
        and g.active and g.archived_at is null and public.wayne_is_sauce_option(g.customer_label,c.name)) then
      raise exception 'Sauce not found in this business' using errcode='22023';
    end if;
    insert into public.menu_shared_sauce_prices(workspace_id,choice_key,price_cents)
      values(wid,row->>'key',(row->>'price_cents')::integer)
      on conflict(workspace_id,choice_key) do update set price_cents=excluded.price_cents;
    -- Invalidate editor revisions and refresh feeds on connected registers.
    update public.modifier_choices c set updated_at=now() from public.modifier_groups g
      where g.id=c.modifier_group_id and c.workspace_id=wid and lower(btrim(c.name))=row->>'key'
        and public.wayne_is_sauce_option(g.customer_label,c.name);
    saved := saved+1;
  end loop;
  perform public.wayne_write_audit('menu.shared_sauce_prices_saved','workspaces',wid::text,'Updated shared sauce prices','{}'::jsonb,jsonb_build_object('prices',payload));
  return saved;
end;
$$;
revoke all on function public.wayne_save_shared_sauce_prices(jsonb) from public,anon;
grant execute on function public.wayne_save_shared_sauce_prices(jsonb) to authenticated;

-- Apply one price in both server pricing and all public/POS menu feeds.
do $$
declare def text; target regprocedure;
begin
  def := pg_get_functiondef('public.wayne_modifier_unit_cents(uuid,uuid)'::regprocedure);
  if position('select coalesce(' in def)=0 then raise exception 'Modifier price function changed'; end if;
  execute replace(def,'select coalesce(','select coalesce(public.wayne_shared_sauce_price(target_choice_id),');
  def := pg_get_functiondef('public.wayne_group_allowance_lines(uuid,uuid,jsonb)'::regprocedure);
  if position('coalesce(rule.extra_each_cents, picked.unit)' in def)=0 then raise exception 'Allowance pricing changed'; end if;
  execute replace(def,'coalesce(rule.extra_each_cents, picked.unit)','coalesce(public.wayne_shared_sauce_price(picked.id), rule.extra_each_cents, picked.unit)');
  for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('wayne_public_menu','wayne_pos_menu','hanafy_workspace_menu')
  loop
    def := pg_get_functiondef(target);
    if position('''price_delta_cents'', choice.price_delta_cents' in def)>0 then
      execute replace(def,'''price_delta_cents'', choice.price_delta_cents',
        '''shared_price_cents'', public.wayne_shared_sauce_price(choice.id), ''price_delta_cents'', choice.price_delta_cents');
    end if;
  end loop;
end $$;

-- Store the explicit rules submitted by the editor AFTER its legacy child
-- writer has finished. An omitted field preserves rules for older clients;
-- an empty array explicitly removes them. The surrounding RPC is atomic.
create function public.wayne_apply_item_size_rules(target_item_id uuid,payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare grp record; rule jsonb; gid uuid; wid uuid;
begin
  select workspace_id into wid from public.menu_items where id=target_item_id;
  for grp in select value,ordinality from jsonb_array_elements(payload->'modifier_groups') with ordinality loop
    if not (grp.value ? 'size_rules') then continue; end if;
    if jsonb_typeof(grp.value->'size_rules') is distinct from 'array' or jsonb_array_length(grp.value->'size_rules')>101 then raise exception 'Invalid included portions' using errcode='22023'; end if;
    select modifier_group_id into gid from public.menu_item_modifier_groups
      where menu_item_id=target_item_id and active and sort_order=grp.ordinality-1;
    if gid is null then raise exception 'Modifier group not found' using errcode='22023'; end if;
    delete from public.modifier_group_size_rules where modifier_group_id=gid;
    for rule in select value from jsonb_array_elements(grp.value->'size_rules') loop
      if (rule->>'included_count') is null or (rule->>'included_count') !~ '^\d+$' or (rule->>'included_count')::numeric not between 0 and 20
        or ((rule->>'max_portions') is not null and ((rule->>'max_portions')::integer not between greatest(1,(rule->>'included_count')::integer) and 20))
        or ((rule->>'extra_each_cents') is not null and (rule->>'extra_each_cents')::integer not between 0 and 100000) then
        raise exception 'Check included and maximum portions' using errcode='22023';
      end if;
      if coalesce(rule->>'variant_name','')<>'' and not exists(select 1 from public.menu_item_variants v where v.menu_item_id=target_item_id and v.active and v.archived_at is null and lower(btrim(v.name))=lower(btrim(rule->>'variant_name'))) then
        raise exception 'Included portions refer to an unknown size' using errcode='22023';
      end if;
      insert into public.modifier_group_size_rules(modifier_group_id,size_name,included_count,max_portions,extra_each_cents,workspace_id)
        values(gid,btrim(coalesce(rule->>'variant_name','')),(rule->>'included_count')::integer,(rule->>'max_portions')::integer,(rule->>'extra_each_cents')::integer,wid);
    end loop;
    if jsonb_array_length(grp.value->'size_rules')>0 then
      update public.modifier_groups set allow_quantities=true,max_select=greatest(min_select,20) where id=gid;
    end if;
  end loop;
end;
$$;
revoke all on function public.wayne_apply_item_size_rules(uuid,jsonb) from public,anon,authenticated,service_role;
alter function public.wayne_update_menu_item(uuid,jsonb) rename to wayne_update_menu_item_preserve_rules;
revoke all on function public.wayne_update_menu_item_preserve_rules(uuid,jsonb) from public,anon,authenticated,service_role;
create function public.wayne_update_menu_item(target_item_id uuid,payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare saved uuid;
begin
  saved := public.wayne_update_menu_item_preserve_rules(target_item_id,payload);
  perform public.wayne_apply_item_size_rules(saved,payload);
  return saved;
end;
$$;
revoke all on function public.wayne_update_menu_item(uuid,jsonb) from public,anon;
grant execute on function public.wayne_update_menu_item(uuid,jsonb) to authenticated;
alter function public.wayne_create_menu_item(jsonb) rename to wayne_create_menu_item_without_rules;
revoke all on function public.wayne_create_menu_item_without_rules(jsonb) from public,anon,authenticated,service_role;
create function public.wayne_create_menu_item(payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare saved uuid;
begin
  saved := public.wayne_create_menu_item_without_rules(payload);
  perform public.wayne_apply_item_size_rules(saved,payload);
  return saved;
end;
$$;
revoke all on function public.wayne_create_menu_item(jsonb) from public,anon;
grant execute on function public.wayne_create_menu_item(jsonb) to authenticated;

-- Preserve allowance rules when the category editor isolates a shared group.
do $$
declare def text;
begin
  def := pg_get_functiondef('public.wayne_save_category_options(uuid,jsonb)'::regprocedure);
  if position('returning id into new_gid;' in def)=0 then raise exception 'Category clone writer changed'; end if;
  execute replace(def,'returning id into new_gid;', 'returning id into new_gid;
    insert into public.modifier_group_size_rules(modifier_group_id,size_name,included_count,max_portions,extra_each_cents,workspace_id)
      select new_gid,size_name,included_count,max_portions,extra_each_cents,workspace_id from public.modifier_group_size_rules where modifier_group_id=grp.id;');
end $$;

-- Category changes touch only rows edited by the owner. Differing item rules
-- are never silently replaced with the first item's values.
create function public.wayne_save_category_menu_options(target_category_id uuid,payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare wid uuid; result jsonb; section jsonb; rule jsonb; gid uuid;
begin
  select workspace_id into wid from public.menu_categories where id=target_category_id for update;
  if wid is null or wid is distinct from (public.hanafy_current_workspace_access()->>'workspace_id')::uuid
    or not public.wayne_has_permission(wid,'menu.manage') then raise exception 'Menu permission required' using errcode='42501'; end if;
  result := public.wayne_save_category_options(target_category_id,jsonb_build_object('sections',coalesce(payload->'sections','[]'::jsonb)));
  for section in select value from jsonb_array_elements(coalesce(payload->'size_rules','[]'::jsonb)) loop
    for gid in select distinct g.id from public.modifier_groups g
      join public.menu_item_modifier_groups l on l.modifier_group_id=g.id and l.active
      join public.menu_items i on i.id=l.menu_item_id and i.category_id=target_category_id and i.archived_at is null
      where g.active and g.archived_at is null and lower(btrim(g.customer_label))=lower(btrim(section->>'label'))
    loop
      for rule in select value from jsonb_array_elements(section->'rules') loop
        delete from public.modifier_group_size_rules where modifier_group_id=gid and lower(btrim(size_name))=lower(btrim(coalesce(rule->>'size_name','')));
        if rule->>'included_count' is not null then
          if (rule->>'included_count')::integer not between 0 and 20 then raise exception 'Included portions must be 0 to 20' using errcode='22023'; end if;
          insert into public.modifier_group_size_rules(modifier_group_id,size_name,included_count,max_portions,extra_each_cents,workspace_id)
            values(gid,btrim(coalesce(rule->>'size_name','')),(rule->>'included_count')::integer,(rule->>'max_portions')::integer,(rule->>'extra_each_cents')::integer,wid);
          update public.modifier_groups set allow_quantities=true,max_select=greatest(20,min_select) where id=gid;
        end if;
      end loop;
    end loop;
  end loop;
  perform public.wayne_write_audit('menu.category_allowances_saved','menu_categories',target_category_id::text,'Updated category options and included portions','{}'::jsonb,payload);
  return result;
end;
$$;
revoke all on function public.wayne_save_category_menu_options(uuid,jsonb) from public,anon;
grant execute on function public.wayne_save_category_menu_options(uuid,jsonb) to authenticated;
