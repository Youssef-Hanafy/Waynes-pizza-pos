begin;
set local lock_timeout = '3s';
set local statement_timeout = '20s';

do $verification$
declare
  owner_id uuid;
  source_item public.menu_items%rowtype;
  special_id uuid;
  special_variant_id uuid;
  source_prices jsonb;
  current_source_prices jsonb;
  special_price integer;
  menu jsonb;
begin
  select profile.id into owner_id
    from public.profiles profile
    join public.roles role on role.id = profile.role_id
   where role.code = 'owner'
   order by profile.created_at
   limit 1;
  if owner_id is null then raise exception 'No owner available for Specials verification'; end if;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);

  select item.* into source_item from public.menu_items item
   where not item.special and item.archived_at is null and item.pos_visible
     and exists (select 1 from public.menu_item_variants variant
                  where variant.menu_item_id = item.id and variant.active and variant.archived_at is null)
   order by item.created_at limit 1;
  if source_item.id is null then raise exception 'No regular POS item available for verification'; end if;
  if not public.wayne_has_permission(source_item.workspace_id, 'menu.manage') then
    raise exception 'Owner does not have menu management access';
  end if;

  select jsonb_object_agg(id::text, price_cents) into source_prices
    from public.menu_item_variants where menu_item_id = source_item.id;

  special_id := (public.wayne_make_special(source_item.id, 'Temporary deployment verification', null) ->> 'id')::uuid;
  if not exists (select 1 from public.menu_items where id = special_id and special
      and special_source_item_id = source_item.id and not customer_visible and not special_online and pos_visible) then
    raise exception 'Special copy is missing isolation from the regular/online menu';
  end if;

  select id into special_variant_id from public.menu_item_variants
    where menu_item_id = special_id and active and archived_at is null order by sort_order limit 1;
  perform public.wayne_set_special_prices(special_id, jsonb_build_array(jsonb_build_object('variant_id', special_variant_id, 'price_cents', 123)));
  select price_cents into special_price from public.menu_item_variants where id = special_variant_id;
  if special_price is distinct from 123 then raise exception 'Special price did not save independently'; end if;

  select jsonb_object_agg(id::text, price_cents) into current_source_prices
    from public.menu_item_variants where menu_item_id = source_item.id;
  if source_prices is distinct from current_source_prices then raise exception 'Regular item prices were changed'; end if;

  menu := public.wayne_pos_menu();
  if not exists (
    select 1 from jsonb_array_elements(menu) category
    cross join lateral jsonb_array_elements(category -> 'items') item
    where item ->> 'id' = special_id::text and (item ->> 'special')::boolean and (item ->> 'special_item')::boolean
  ) then raise exception 'Special was not returned to the POS Specials tab'; end if;

  begin
    perform public.wayne_set_special_prices(source_item.id, '[]'::jsonb);
    raise exception 'Regular item was accepted by the Specials price function';
  exception when invalid_parameter_value then
    null;
  end;
end;
$verification$;

rollback;

select 'passed: create special, independent price, regular price protection, POS visibility; all test writes rolled back' as verification;
