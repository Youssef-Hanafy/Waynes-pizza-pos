-- Specials: the special and the regular item can never be mixed up (owner, 2026-10-20:
-- "the special price is using the regular price and the regular price is using the special price").
--
-- What happened: a special is its own copy of the item, with the same name in the same
-- category, so in Admin -> Menu the two "Cheese Pizza" rows looked identical and the
-- price edits went to the wrong one ($7.75 landed on the regular pizza, $8.25 on the special).
--
-- Now:
--   * every special remembers the regular item it was made from (special_source_item_id);
--   * Admin -> Menu -> Specials sets the special price per size right beside the regular
--     price (wayne_set_special_prices), and that function can only ever change a special;
--   * a special can never show online, whatever is ticked in the item editor.

alter table public.menu_items
  add column if not exists special_source_item_id uuid references public.menu_items(id) on delete set null;

comment on column public.menu_items.special_source_item_id is
  'For a special (POS-only copy): the regular menu item it was made from. Never set on a regular item.';

-- Existing specials: the regular item with the same name in the same category.
update public.menu_items special_copy
   set special_source_item_id = (
     select regular.id from public.menu_items regular
      where regular.workspace_id = special_copy.workspace_id
        and regular.category_id = special_copy.category_id
        and regular.name = special_copy.name
        and not regular.special
      order by (regular.archived_at is null) desc, regular.created_at
      limit 1)
 where special_copy.special and special_copy.special_source_item_id is null;

-- A special is POS-only, always.
create or replace function public._wayne_special_stays_pos_only()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.special then
    new.customer_visible := false;
    new.special_online := false;
  else
    new.special_source_item_id := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists menu_items_special_stays_pos_only on public.menu_items;
create trigger menu_items_special_stays_pos_only
  before insert or update of special, customer_visible, special_online, special_source_item_id on public.menu_items
  for each row execute function public._wayne_special_stays_pos_only();

-- "Make it a special": same copy as before, now linked to its regular item.
create or replace function public._wayne_copy_item_as_special(source_item_id uuid, headline text, ends_on date)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  source public.menu_items%rowtype;
  copy_id uuid := gen_random_uuid();
  variant_row record;
  new_variant uuid;
begin
  select * into source from public.menu_items where id = source_item_id and archived_at is null;
  if not found then raise exception 'That menu item could not be found' using errcode = 'P0002'; end if;
  if source.special then raise exception 'That item is already a special' using errcode = '22023'; end if;

  insert into public.menu_items (id, workspace_id, category_id, name, description, image_path, image_alt, base_price_cents, tax_category,
    included_count_label, sold_out, customer_visible, pos_visible, featured, kitchen_route, available_days, available_start, available_end,
    sort_order, pos_color, special, special_note, special_online, special_ends_on, pos_auto_add, special_source_item_id)
  values (copy_id, source.workspace_id, source.category_id, source.name, source.description, source.image_path, source.image_alt,
    source.base_price_cents, source.tax_category, source.included_count_label, false, false, true, false, source.kitchen_route,
    source.available_days, source.available_start, source.available_end, source.sort_order, source.pos_color,
    true, left(btrim(coalesce(headline, '')), 200), false, ends_on, source.pos_auto_add, source.id);

  for variant_row in
    select * from public.menu_item_variants where menu_item_id = source.id and archived_at is null order by sort_order, name
  loop
    insert into public.menu_item_variants (workspace_id, menu_item_id, name, price_cents, sku, sort_order, active)
    values (source.workspace_id, copy_id, variant_row.name, variant_row.price_cents, null, variant_row.sort_order, variant_row.active)
    returning id into new_variant;
    insert into public.modifier_choice_variant_prices (workspace_id, modifier_choice_id, menu_item_variant_id, price_delta_cents)
    select source.workspace_id, vp.modifier_choice_id, new_variant, vp.price_delta_cents
      from public.modifier_choice_variant_prices vp where vp.menu_item_variant_id = variant_row.id;
  end loop;

  insert into public.menu_item_modifier_groups (workspace_id, menu_item_id, modifier_group_id, sort_order, active)
  select source.workspace_id, copy_id, link.modifier_group_id, link.sort_order, link.active
    from public.menu_item_modifier_groups link where link.menu_item_id = source.id;

  insert into public.menu_item_included_choices (workspace_id, menu_item_id, modifier_choice_id)
  select source.workspace_id, copy_id, included.modifier_choice_id
    from public.menu_item_included_choices included where included.menu_item_id = source.id;

  return copy_id;
end;
$function$;
revoke all on function public._wayne_copy_item_as_special(uuid, text, date) from public, anon, authenticated;

-- Admin -> Menu -> Specials: the special price for each size.  Only ever touches a special's
-- own sizes (in place, so its option prices stay attached); the regular item can't be changed here.
-- prices: [{"variant_id": "...", "price_cents": 775}, ...]
create or replace function public.wayne_set_special_prices(special_item_id uuid, prices jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  target public.menu_items%rowtype;
  entry jsonb;
  new_price integer;
  changed integer := 0;
  before_prices jsonb;
begin
  select * into target from public.menu_items where id = special_item_id and archived_at is null;
  if not found then raise exception 'That special could not be found' using errcode = 'P0002'; end if;
  if not public.wayne_has_permission(target.workspace_id, 'menu.manage') then
    raise exception 'Menu permission required' using errcode = '42501';
  end if;
  if not target.special then
    raise exception 'Only a special''s price can be set here — the regular item is changed in Menu' using errcode = '22023';
  end if;
  if jsonb_typeof(prices) is distinct from 'array' then raise exception 'Prices must be a list' using errcode = '22023'; end if;

  select coalesce(jsonb_object_agg(id::text, price_cents), '{}'::jsonb) into before_prices
    from public.menu_item_variants where menu_item_id = target.id and archived_at is null;

  for entry in select value from jsonb_array_elements(prices)
  loop
    new_price := (entry->>'price_cents')::integer;
    if new_price is null or new_price < 0 or new_price > 100000 then
      raise exception 'Enter a price between $0.00 and $1,000.00' using errcode = '22023';
    end if;
    update public.menu_item_variants
       set price_cents = new_price, updated_at = now()
     where id = (entry->>'variant_id')::uuid
       and menu_item_id = target.id
       and archived_at is null
       and price_cents is distinct from new_price;
    changed := changed + (case when found then 1 else 0 end);
  end loop;

  -- The headline price shown for the special: its lowest size.
  update public.menu_items item
     set base_price_cents = coalesce((select min(v.price_cents) from public.menu_item_variants v
                                       where v.menu_item_id = target.id and v.archived_at is null and v.active), item.base_price_cents),
         updated_at = now()
   where item.id = target.id;

  perform public.wayne_write_audit('menu.special_prices_set', 'menu_items', target.id::text,
    'Set special prices for ' || target.name, jsonb_build_object('prices', before_prices),
    jsonb_build_object('prices', prices, 'changed', changed));
  return jsonb_build_object('id', target.id, 'name', target.name, 'changed', changed);
end;
$function$;
revoke all on function public.wayne_set_special_prices(uuid, jsonb) from public, anon;
grant execute on function public.wayne_set_special_prices(uuid, jsonb) to authenticated;
