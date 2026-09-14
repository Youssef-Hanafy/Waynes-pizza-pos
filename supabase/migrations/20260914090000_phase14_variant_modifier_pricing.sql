-- Phase 14: per-size (per-variant) modifier pricing.
--
-- Wayne's live Thrive system charges a different amount for the same topping
-- depending on which size was ordered (e.g. Mushrooms +$1 on a Small pizza,
-- +$2 on a Large). The menu schema up to Phase 13 only supported one flat
-- price per modifier choice, which cannot represent that. This migration adds
-- an optional per-(choice, size) price override table; when no override row
-- exists for a given choice/variant pair, callers fall back to the choice's
-- flat modifier_choices.price_delta_cents (used by items with no sizes).

create table public.modifier_choice_variant_prices (
  id uuid primary key default gen_random_uuid(),
  modifier_choice_id uuid not null references public.modifier_choices(id) on delete cascade,
  menu_item_variant_id uuid not null references public.menu_item_variants(id) on delete cascade,
  price_delta_cents integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (modifier_choice_id, menu_item_variant_id)
);

comment on table public.modifier_choice_variant_prices is
  'Phase 14: per-size override of a modifier choice''s price. A row here wins over modifier_choices.price_delta_cents for that specific size.';

create index modifier_choice_variant_prices_choice_idx on public.modifier_choice_variant_prices (modifier_choice_id);
create index modifier_choice_variant_prices_variant_idx on public.modifier_choice_variant_prices (menu_item_variant_id);

alter table public.modifier_choice_variant_prices enable row level security;

create policy modifier_choice_variant_prices_admin_select on public.modifier_choice_variant_prices
for select to authenticated using (public.wayne_has_permission('menu.manage'));

revoke all on public.modifier_choice_variant_prices from anon, authenticated;
grant select on public.modifier_choice_variant_prices to authenticated;

-- Re-seed writer: accept an optional `variant_prices` array on each choice
-- payload ([{variant_name, price_delta_cents}, ...]) and, for each entry,
-- resolve the sibling variant just written for this same item by name and
-- store the per-size override.
create or replace function public.wayne_write_menu_children(target_item_id uuid, payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  variant jsonb;
  group_payload jsonb;
  choice jsonb;
  variant_price jsonb;
  group_id uuid;
  choice_id uuid;
  variant_row_id uuid;
  group_index integer := 0;
  choice_index integer;
begin
  if not public.wayne_has_permission('menu.manage') then
    raise exception 'Menu management permission required' using errcode = '42501';
  end if;

  for variant in select value from jsonb_array_elements(coalesce(payload -> 'variants', '[]'::jsonb)) loop
    insert into public.menu_item_variants (menu_item_id, name, price_cents, sku, sort_order)
    values (
      target_item_id,
      btrim(variant ->> 'name'),
      (variant ->> 'price_cents')::integer,
      nullif(btrim(coalesce(variant ->> 'sku', '')), ''),
      coalesce((variant ->> 'sort_order')::integer, 0)
    );
  end loop;

  for group_payload in select value from jsonb_array_elements(coalesce(payload -> 'modifier_groups', '[]'::jsonb)) loop
    insert into public.modifier_groups (
      name, customer_label, min_select, max_select, required, allow_quantities, sort_order
    ) values (
      btrim(group_payload ->> 'name'),
      btrim(group_payload ->> 'customer_label'),
      (group_payload ->> 'min_select')::integer,
      (group_payload ->> 'max_select')::integer,
      (group_payload ->> 'required')::boolean,
      (group_payload ->> 'allow_quantities')::boolean,
      group_index
    ) returning id into group_id;

    insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
    values (target_item_id, group_id, group_index);

    choice_index := 0;
    for choice in select value from jsonb_array_elements(coalesce(group_payload -> 'choices', '[]'::jsonb)) loop
      insert into public.modifier_choices (
        modifier_group_id, name, price_delta_cents, default_selected, sort_order
      ) values (
        group_id,
        btrim(choice ->> 'name'),
        (choice ->> 'price_delta_cents')::integer,
        (choice ->> 'default_selected')::boolean,
        choice_index
      ) returning id into choice_id;

      for variant_price in select value from jsonb_array_elements(coalesce(choice -> 'variant_prices', '[]'::jsonb)) loop
        select mv.id into variant_row_id
        from public.menu_item_variants mv
        where mv.menu_item_id = target_item_id
          and mv.name = btrim(variant_price ->> 'variant_name')
          and mv.active and mv.archived_at is null
        limit 1;

        if variant_row_id is not null then
          insert into public.modifier_choice_variant_prices (modifier_choice_id, menu_item_variant_id, price_delta_cents)
          values (choice_id, variant_row_id, (variant_price ->> 'price_delta_cents')::integer)
          on conflict (modifier_choice_id, menu_item_variant_id)
          do update set price_delta_cents = excluded.price_delta_cents, updated_at = now();
        end if;
      end loop;

      choice_index := choice_index + 1;
    end loop;
    group_index := group_index + 1;
  end loop;
end;
$$;

-- Public (customer-facing) menu: each choice now also carries variant_prices,
-- an array of {variant_id, price_delta_cents} overrides. The client (cart.ts)
-- prefers the entry matching the selected size and falls back to
-- price_delta_cents when the item has no sizes or no override exists.
create or replace function public.wayne_public_menu()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(category_payload order by category_sort, category_name), '[]'::jsonb)
  from (
    select
      category.sort_order as category_sort,
      category.name as category_name,
      jsonb_build_object(
        'id', category.id,
        'name', category.name,
        'description', category.description,
        'image_path', category.image_path,
        'image_alt', category.image_alt,
        'items', coalesce((
          select jsonb_agg(item_payload order by item_sort, item_name)
          from (
            select
              item.sort_order as item_sort,
              item.name as item_name,
              jsonb_build_object(
                'id', item.id,
                'name', item.name,
                'description', item.description,
                'image_path', item.image_path,
                'image_alt', item.image_alt,
                'base_price_cents', item.base_price_cents,
                'included_count_label', item.included_count_label,
                'sold_out', item.sold_out,
                'featured', item.featured,
                'available_days', item.available_days,
                'available_start', item.available_start,
                'available_end', item.available_end,
                'variants', coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'id', variant.id,
                    'name', variant.name,
                    'price_cents', variant.price_cents,
                    'sku', variant.sku
                  ) order by variant.sort_order, variant.name)
                  from public.menu_item_variants variant
                  where variant.menu_item_id = item.id and variant.active and variant.archived_at is null
                ), '[]'::jsonb),
                'modifier_groups', coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'id', modifier_group.id,
                    'name', modifier_group.name,
                    'customer_label', modifier_group.customer_label,
                    'min_select', modifier_group.min_select,
                    'max_select', modifier_group.max_select,
                    'required', modifier_group.required,
                    'allow_quantities', modifier_group.allow_quantities,
                    'choices', coalesce((
                      select jsonb_agg(jsonb_build_object(
                        'id', choice.id,
                        'name', choice.name,
                        'price_delta_cents', choice.price_delta_cents,
                        'default_selected', choice.default_selected,
                        'variant_prices', coalesce((
                          select jsonb_agg(jsonb_build_object(
                            'variant_id', vp.menu_item_variant_id,
                            'price_delta_cents', vp.price_delta_cents
                          ))
                          from public.modifier_choice_variant_prices vp
                          where vp.modifier_choice_id = choice.id
                        ), '[]'::jsonb)
                      ) order by choice.sort_order, choice.name)
                      from public.modifier_choices choice
                      where choice.modifier_group_id = modifier_group.id
                        and choice.active and choice.archived_at is null
                    ), '[]'::jsonb)
                  ) order by link.sort_order, modifier_group.name)
                  from public.menu_item_modifier_groups link
                  join public.modifier_groups modifier_group on modifier_group.id = link.modifier_group_id
                  where link.menu_item_id = item.id and link.active
                    and modifier_group.active and modifier_group.archived_at is null
                ), '[]'::jsonb)
              ) as item_payload
            from public.menu_items item
            where item.category_id = category.id
              and item.customer_visible and item.archived_at is null
          ) items
        ), '[]'::jsonb)
      ) as category_payload
    from public.menu_categories category
    where category.customer_visible and category.archived_at is null
  ) categories;
$$;

create or replace function public.wayne_pos_menu()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.wayne_has_permission('pos.access') then coalesce(jsonb_agg(category_payload order by category_sort, category_name), '[]'::jsonb)
    else public.wayne_raise_permission_error('POS access required') end
  from (
    select category.sort_order category_sort, category.name category_name,
      jsonb_build_object(
        'id', category.id, 'name', category.name, 'description', category.description,
        'image_path', category.image_path, 'image_alt', category.image_alt,
        'items', coalesce((
          select jsonb_agg(item_payload order by item_sort, item_name)
          from (
            select item.sort_order item_sort, item.name item_name,
              jsonb_build_object(
                'id', item.id, 'name', item.name, 'description', item.description,
                'image_path', item.image_path, 'image_alt', item.image_alt,
                'base_price_cents', item.base_price_cents, 'included_count_label', item.included_count_label,
                'sold_out', item.sold_out, 'featured', item.featured,
                'available_days', item.available_days, 'available_start', item.available_start, 'available_end', item.available_end,
                'variants', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', variant.id, 'name', variant.name, 'price_cents', variant.price_cents, 'sku', variant.sku
                ) order by variant.sort_order, variant.name) from public.menu_item_variants variant
                  where variant.menu_item_id = item.id and variant.active and variant.archived_at is null), '[]'::jsonb),
                'modifier_groups', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', modifier_group.id, 'name', modifier_group.name, 'customer_label', modifier_group.customer_label,
                  'min_select', modifier_group.min_select, 'max_select', modifier_group.max_select,
                  'required', modifier_group.required, 'allow_quantities', modifier_group.allow_quantities,
                  'choices', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', choice.id, 'name', choice.name, 'price_delta_cents', choice.price_delta_cents,
                    'default_selected', choice.default_selected,
                    'variant_prices', coalesce((
                      select jsonb_agg(jsonb_build_object(
                        'variant_id', vp.menu_item_variant_id,
                        'price_delta_cents', vp.price_delta_cents
                      ))
                      from public.modifier_choice_variant_prices vp
                      where vp.modifier_choice_id = choice.id
                    ), '[]'::jsonb)
                  ) order by choice.sort_order, choice.name) from public.modifier_choices choice
                    where choice.modifier_group_id = modifier_group.id and choice.active and choice.archived_at is null), '[]'::jsonb)
                ) order by link.sort_order, modifier_group.name)
                from public.menu_item_modifier_groups link
                join public.modifier_groups modifier_group on modifier_group.id = link.modifier_group_id
                where link.menu_item_id = item.id and link.active and modifier_group.active and modifier_group.archived_at is null), '[]'::jsonb)
              ) item_payload
            from public.menu_items item
            where item.category_id = category.id and item.pos_visible and item.archived_at is null
          ) items
        ), '[]'::jsonb)
      ) category_payload
    from public.menu_categories category
    where category.archived_at is null
  ) categories;
$$;
