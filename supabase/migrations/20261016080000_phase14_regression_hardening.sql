-- Hanafy Platform Phase 14: Wayne's full regression and production hardening.
--
-- Build sheet §40 Phase 14, §31, §43.
--
-- Hardening found during the regression pass:
--   * The pre-platform public menu/deals functions (wayne_public_menu,
--     wayne_public_promotions) are still callable with the public key by
--     deployments that predate Phase 13.  They returned every business's
--     menu and deals.  They now return only the business they were built
--     for (the legacy workspace, Wayne's), so an old deployment keeps working
--     and nothing of another business can leak through them.
--   * One menu/deals builder per workspace (hanafy_workspace_menu /
--     hanafy_workspace_promotions, server-side only) now backs both the
--     host-scoped storefront functions and the legacy ones, so they can
--     never drift apart.

create or replace function public.hanafy_workspace_menu(target_workspace_id uuid)
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
                        'default_selected', (choice.default_selected or exists (
                          select 1 from public.menu_item_included_choices included
                          where included.menu_item_id = item.id and included.modifier_choice_id = choice.id)),
                        'variant_prices', coalesce((
                          select jsonb_agg(jsonb_build_object(
                            'variant_id', vp.menu_item_variant_id,
                            'price_delta_cents', vp.price_delta_cents
                          ))
                          from public.modifier_choice_variant_prices vp
                          where vp.modifier_choice_id = choice.id
                            and exists (
                              select 1 from public.menu_item_variants scoped
                              where scoped.id = vp.menu_item_variant_id
                                and scoped.menu_item_id = item.id
                            )
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
                    and modifier_group.workspace_id = category.workspace_id
                ), '[]'::jsonb)
              ) as item_payload
            from public.menu_items item
            where item.category_id = category.id and item.workspace_id = category.workspace_id
              and item.customer_visible and item.archived_at is null
          ) items
        ), '[]'::jsonb)
      ) as category_payload
    from public.menu_categories category
    where category.workspace_id = target_workspace_id
      and category.customer_visible and category.archived_at is null
  ) categories;
$$;
revoke all on function public.hanafy_workspace_menu(uuid) from public, anon, authenticated;

create or replace function public.hanafy_workspace_promotions(target_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', promotion.id, 'code', promotion.code, 'description', promotion.description,
    'discount_type', promotion.discount_type, 'discount_value', promotion.discount_value,
    'minimum_order_cents', promotion.minimum_order_cents, 'fulfillment_type', promotion.fulfillment_type,
    'ends_at', promotion.ends_at
  ) order by promotion.minimum_order_cents, promotion.code), '[]'::jsonb)
  from public.promotions promotion
  where promotion.workspace_id = target_workspace_id
    and promotion.active and not promotion.private and not promotion.members_only
    and promotion.code_mode = 'public' and promotion.parent_promotion_id is null
    and promotion.archived_at is null
    and (promotion.starts_at is null or promotion.starts_at <= now())
    and (promotion.ends_at is null or promotion.ends_at > now())
    and (promotion.total_usage_limit is null or promotion.uses_count < promotion.total_usage_limit);
$$;
revoke all on function public.hanafy_workspace_promotions(uuid) from public, anon, authenticated;

-- Storefront (Phase 13): the host's business, or nothing.
create or replace function public.hanafy_public_menu(target_hostname text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select public.hanafy_workspace_menu(host.workspace_id) from public.hanafy_host_workspace(target_hostname) host), '[]'::jsonb);
$$;

create or replace function public.hanafy_public_promotions(target_hostname text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select public.hanafy_workspace_promotions(host.workspace_id) from public.hanafy_host_workspace(target_hostname) host), '[]'::jsonb);
$$;

-- Pre-platform deployments: only the business these were built for.
create or replace function public.wayne_public_menu()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_workspace_menu(public.hanafy_legacy_workspace_id());
$$;

create or replace function public.wayne_public_promotions()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_workspace_promotions(public.hanafy_legacy_workspace_id());
$$;
