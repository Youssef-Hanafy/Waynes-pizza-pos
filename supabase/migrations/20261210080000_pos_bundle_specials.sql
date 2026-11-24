alter table public.menu_items add column special_bundle jsonb;
alter table public.menu_items add constraint menu_items_special_bundle_check
  check (special_bundle is null or (special and special_source_item_id is null and jsonb_typeof(special_bundle) = 'array'));
create unique index menu_items_active_bundle_name_idx on public.menu_items (workspace_id, lower(name))
  where special_bundle is not null and archived_at is null;

create function public.wayne_bundle_components_available(bundle jsonb, workspace uuid)
returns boolean
language sql stable set search_path = ''
as $$
  select not exists (
    select 1
    from jsonb_to_recordset(bundle) as part(menu_item_id uuid, variant_id uuid)
    left join public.menu_items item on item.id = part.menu_item_id and item.workspace_id = workspace
    left join public.menu_categories category on category.id = item.category_id
    left join public.menu_item_variants variant on variant.id = part.variant_id
      and variant.menu_item_id = item.id and variant.active and variant.archived_at is null
    where item.id is null or item.special or not item.pos_visible or item.sold_out
      or item.archived_at is not null or category.archived_at is not null
      or (part.variant_id is not null and variant.id is null)
      or (part.variant_id is null and exists (
        select 1 from public.menu_item_variants size
        where size.menu_item_id = item.id and size.active and size.archived_at is null
      ))
  );
$$;
revoke all on function public.wayne_bundle_components_available(jsonb, uuid) from public, anon, authenticated;

create function public.wayne_save_bundle_special(target_id uuid, payload jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  workspace uuid := public.hanafy_legacy_workspace_id();
  target public.menu_items%rowtype;
  component public.menu_items%rowtype;
  size_name text;
  component_category uuid;
  component_route text;
  name_value text := btrim(coalesce(payload ->> 'name', ''));
  price integer := (payload ->> 'price_cents')::integer;
  ends_on date := (payload ->> 'ends_on')::date;
  parts jsonb := payload -> 'components';
  bundle jsonb := '[]'::jsonb;
  description_value text;
  part record;
begin
  if not coalesce(public.wayne_has_permission(workspace, 'menu.manage'), false) then
    raise exception 'Menu permission required' using errcode = '42501';
  end if;
  if char_length(name_value) not between 1 and 160 or price is null or price not between 1 and 100000 then
    raise exception 'Enter a name and a bundle price between $0.01 and $1,000.00' using errcode = '22023';
  end if;
  if jsonb_typeof(parts) is distinct from 'array' then
    raise exception 'Choose the items in this bundle' using errcode = '22023';
  end if;
  if jsonb_array_length(parts) not between 1 and 20 then
    raise exception 'Choose up to 20 different items and sizes' using errcode = '22023';
  end if;
  if target_id is not null then
    select * into target from public.menu_items
    where id = target_id and workspace_id = workspace and archived_at is null and special_bundle is not null
    for update;
    if not found then raise exception 'That bundle special could not be found' using errcode = 'P0002'; end if;
    if (payload ->> 'expected_revision')::bigint is distinct from target.menu_revision then
      raise exception 'This bundle changed. Reopen it before saving.' using errcode = '40001';
    end if;
  end if;

  if (select coalesce(sum(quantity), 0) from jsonb_to_recordset(parts) as p(quantity integer)) < 2 then
    raise exception 'A bundle needs at least two items. Set the quantity for repeated items.' using errcode = '22023';
  end if;
  for part in select * from jsonb_to_recordset(parts) as p(menu_item_id uuid, variant_id uuid, quantity integer) loop
    if part.quantity is null or part.quantity not between 1 and 20 then
      raise exception 'Set each item quantity between 1 and 20' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(bundle) as saved(menu_item_id uuid, variant_id uuid)
      where saved.menu_item_id = part.menu_item_id and saved.variant_id is not distinct from part.variant_id
    ) then
      raise exception 'Increase the quantity for a repeated item and size' using errcode = '22023';
    end if;
    select item.* into component from public.menu_items item
    join public.menu_categories category on category.id = item.category_id and category.archived_at is null
    where item.id = part.menu_item_id and item.workspace_id = workspace
      and item.pos_visible and not item.special and item.archived_at is null;
    if not found then raise exception 'Choose an active POS menu item' using errcode = '22023'; end if;
    size_name := null;
    if part.variant_id is not null then
      select name into size_name from public.menu_item_variants
      where id = part.variant_id and menu_item_id = component.id and active and archived_at is null;
      if not found then raise exception 'Choose an active size for %', component.name using errcode = '22023'; end if;
    elsif exists (
      select 1 from public.menu_item_variants where menu_item_id = component.id and active and archived_at is null
    ) then
      raise exception 'Choose a size for %', component.name using errcode = '22023';
    end if;
    if component_category is null then
      component_category := component.category_id;
      component_route := component.kitchen_route;
    end if;
    bundle := bundle || jsonb_build_array(jsonb_build_object(
      'menu_item_id', component.id, 'variant_id', part.variant_id,
      'name', concat_ws(' ', nullif(size_name, 'One Size'), component.name), 'quantity', part.quantity
    ));
  end loop;

  select left(string_agg((entry ->> 'quantity') || '× ' || (entry ->> 'name'), ' · ' order by position), 2000)
    into description_value from jsonb_array_elements(bundle) with ordinality as part(entry, position);
  if target_id is null then
    insert into public.menu_items (workspace_id, category_id, name, description, base_price_cents,
      kitchen_route, special, special_ends_on, special_bundle, customer_visible)
    values (workspace, component_category, name_value, description_value, price,
      component_route, true, ends_on, bundle, false)
    returning id into target_id;
  else
    update public.menu_items
    set category_id = component_category, name = name_value, description = description_value,
      base_price_cents = price, kitchen_route = component_route, special_ends_on = ends_on, special_bundle = bundle,
      updated_at = now()
    where id = target_id;
  end if;
  perform public.wayne_write_audit('menu.bundle_special_saved', 'menu_items', target_id::text,
    'Saved bundle special ' || name_value, null,
    jsonb_build_object('price_cents', price, 'components', bundle, 'ends_on', ends_on));
  return target_id;
end;
$$;
revoke all on function public.wayne_save_bundle_special(uuid, jsonb) from public, anon;
grant execute on function public.wayne_save_bundle_special(uuid, jsonb) to authenticated;

do $$
declare
  definition text := pg_get_functiondef('public.wayne_pos_menu()'::regprocedure);
  updated text;
begin
  updated := replace(definition, $old$'sold_out', item.sold_out,$old$, $new$
    'special_bundle', item.special_bundle,
    'sold_out', item.sold_out or (item.special_bundle is not null
      and not public.wayne_bundle_components_available(item.special_bundle, item.workspace_id)),$new$);
  if updated = definition then raise exception 'POS bundle menu projection could not be updated'; end if;
  execute updated;
end;
$$;

-- New orders calculate the subtotal before inserting their lines. Lock the
-- bundles in a consistent order so both steps use the same price and recipe.
do $$
declare
  definition text := pg_get_functiondef('public.wayne_create_pos_order(jsonb)'::regprocedure);
  anchor text := $old$  for item_payload in select value from jsonb_array_elements(payload -> 'items') loop
    quantity_value := coalesce((item_payload ->> 'quantity')::integer, 0);$old$;
  updated text;
begin
  updated := replace(definition, anchor, $new$
  perform 1 from public.menu_items item
  where item.special_bundle is not null and item.id in (
    select (value ->> 'menu_item_id')::uuid from jsonb_array_elements(payload -> 'items') where not value ? 'open_item'
  )
  order by item.id for share;
$new$ || anchor);
  if updated = definition then raise exception 'POS bundle pricing could not be updated'; end if;
  execute updated;
end;
$$;

-- Persist the recipe on the order so edits to the menu never change old slips.
-- The ordinary order path prices and stores the bundle as one ticket line.
create function public.wayne_snapshot_bundle_components()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  item public.menu_items%rowtype;
  target_order public.orders%rowtype;
begin
  select * into item from public.menu_items
  where id = new.menu_item_id and special_bundle is not null
  for share;
  if not found then return new; end if;

  select * into target_order from public.orders where id = new.order_id;
  if target_order.workspace_id is distinct from item.workspace_id or target_order.source not in ('pos', 'phone')
    or target_order.fulfillment_type <> 'pickup' then
    raise exception 'Bundle specials are for POS and phone pickup orders only' using errcode = '22023';
  end if;
  if item.archived_at is not null or not item.pos_visible or item.sold_out
    or item.special_ends_on < (coalesce(target_order.placed_at, now()) at time zone public.wayne_store_zone())::date
    or not public.wayne_bundle_components_available(item.special_bundle, item.workspace_id) then
    raise exception 'The bundle special % is unavailable', item.name using errcode = 'P0001';
  end if;
  if new.variant_id is not null or new.modifier_unit_total_cents <> 0
    or new.unit_price_cents <> item.base_price_cents then
    raise exception 'The bundle special changed. Refresh the menu and add it again.' using errcode = '40001';
  end if;

  insert into public.order_item_modifiers (order_item_id, modifier_group_name_snapshot, modifier_name_snapshot, price_delta_cents, quantity)
  select new.id, 'Bundle includes', component.name, 0, component.quantity
  from jsonb_to_recordset(item.special_bundle) as component(name text, quantity integer);
  return new;
end;
$$;
revoke all on function public.wayne_snapshot_bundle_components() from public, anon, authenticated;
create trigger order_items_snapshot_bundle_components
after insert on public.order_items
for each row execute function public.wayne_snapshot_bundle_components();
