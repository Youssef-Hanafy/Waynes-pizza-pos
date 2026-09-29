-- Hanafy Platform Phase 13: multi-tenant storefront / custom domain layer.
--
-- Build sheet §13, §37.1, §40 Phase 13.
--
-- Host → workspace_domains → workspace + location → branding/settings/menu.
-- Phases 4-5 already resolve the host for settings and gate public writes.
-- The remaining leaks were public READS that ignored the host:
--   * wayne_public_menu() and wayne_public_promotions() returned every
--     business's menu/deals → replaced for the storefront by
--     hanafy_public_menu(host) and hanafy_public_promotions(host), filtered to
--     the business that owns the host (unknown host → empty).
--   * wayne_public_order_status(order, token) answered on any host →
--     hanafy_public_order_status(host, order, token) only answers for an
--     order of the business that owns the host.
-- Plus:
--   * hanafy_public_workspace(host) also returns the business's brand
--     colours (tenant theme).
--   * Platform Admin → Domains & storefront: add / switch on-off / make
--     canonical / remove web addresses (validated, unique, platform hosts
--     reserved, audited), and edit a business's storefront basics (name,
--     headings, SEO, contact, ordering open, brand colour) for businesses
--     that don't have the full Website screen yet.
-- Unknown or inactive hosts still resolve to nothing (never Wayne's).

-- ---------------------------------------------------------------------------
-- 1. Host resolution helper
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_host_workspace(target_hostname text)
returns table (workspace_id uuid, location_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select domain.workspace_id, domain.location_id
  from public.workspace_domains domain
  join public.workspaces workspace on workspace.id = domain.workspace_id and workspace.status = 'active'
  join public.locations location on location.id = domain.location_id and location.status = 'active'
  where domain.hostname = public.hanafy_normalize_hostname(target_hostname) and domain.active
  limit 1;
$$;
revoke all on function public.hanafy_host_workspace(text) from public, anon, authenticated;

create or replace function public.hanafy_public_workspace(target_hostname text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workspace_id', workspace.id,
    'location_id', host.location_id,
    'workspace_slug', workspace.slug,
    'enabled_services', public.hanafy_active_services(workspace.id),
    'legacy_operations', workspace.id = public.hanafy_legacy_workspace_id(),
    'brand_colors', coalesce((select settings.brand_colors from public.workspace_settings settings where settings.workspace_id = workspace.id), '{}'::jsonb)
  )
  from public.hanafy_host_workspace(target_hostname) host
  join public.workspaces workspace on workspace.id = host.workspace_id;
$$;

-- ---------------------------------------------------------------------------
-- 2. Host-scoped public reads
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_public_menu(target_hostname text)
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
    join public.hanafy_host_workspace(target_hostname) host on host.workspace_id = category.workspace_id
    where category.customer_visible and category.archived_at is null
  ) categories;
$$;
revoke all on function public.hanafy_public_menu(text) from public;
grant execute on function public.hanafy_public_menu(text) to anon, authenticated;

create or replace function public.hanafy_public_promotions(target_hostname text)
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
  join public.hanafy_host_workspace(target_hostname) host on host.workspace_id = promotion.workspace_id
  where promotion.active and not promotion.private and not promotion.members_only
    and promotion.code_mode = 'public' and promotion.parent_promotion_id is null
    and promotion.archived_at is null
    and (promotion.starts_at is null or promotion.starts_at <= now())
    and (promotion.ends_at is null or promotion.ends_at > now())
    and (promotion.total_usage_limit is null or promotion.uses_count < promotion.total_usage_limit);
$$;
revoke all on function public.hanafy_public_promotions(text) from public;
grant execute on function public.hanafy_public_promotions(text) to anon, authenticated;

create or replace function public.hanafy_public_order_status(target_hostname text, target_order_id uuid, access_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.wayne_public_order_status(target_order_id, access_token)
  where exists (
    select 1 from public.orders orders
    join public.hanafy_host_workspace(target_hostname) host on host.workspace_id = orders.workspace_id
    where orders.id = target_order_id);
$$;
revoke all on function public.hanafy_public_order_status(text, uuid, uuid) from public;
grant execute on function public.hanafy_public_order_status(text, uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Platform Admin → Domains & storefront
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_platform_workspace_domains(target_workspace_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target public.workspaces%rowtype;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only']);
  select * into target from public.workspaces where slug = target_workspace_slug;
  if target.id is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'can_manage', public.hanafy_platform_role() in ('platform_owner', 'platform_admin'),
    'workspace_status', target.status,
    'domains', coalesce((select jsonb_agg(jsonb_build_object('id', domain.id, 'hostname', domain.hostname, 'location_id', domain.location_id,
        'location_name', location.name, 'is_canonical', domain.is_canonical, 'active', domain.active,
        'resolves', domain.active and target.status = 'active' and location.status = 'active', 'created_at', domain.created_at)
        order by domain.active desc, domain.is_canonical desc, domain.hostname)
      from public.workspace_domains domain join public.locations location on location.id = domain.location_id
      where domain.workspace_id = target.id), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', location.id, 'name', location.name, 'status', location.status,
        'storefront', coalesce((select settings.configuration from public.location_settings settings where settings.location_id = location.id), '{}'::jsonb))
        order by location.created_at)
      from public.locations location where location.workspace_id = target.id), '[]'::jsonb),
    'brand_colors', coalesce((select settings.brand_colors from public.workspace_settings settings where settings.workspace_id = target.id), '{}'::jsonb),
    'services', public.hanafy_active_services(target.id),
    'legacy', target.id = public.hanafy_legacy_workspace_id()
  );
end;
$$;
revoke all on function public.hanafy_platform_workspace_domains(text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspace_domains(text) to authenticated;

create or replace function public.hanafy_valid_hostname(target_hostname text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select char_length(target_hostname) between 4 and 253
    and target_hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$';
$$;

-- Hosts the platform itself answers on; never a business's storefront.
create or replace function public.hanafy_platform_hostname(target_hostname text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select target_hostname in ('hanafymedia.com', 'www.hanafymedia.com', 'app.hanafymedia.com', 'admin.hanafymedia.com', 'api.hanafymedia.com')
    or target_hostname like '%.supabase.co';
$$;

create or replace function public.hanafy_platform_save_domain(target_workspace_slug text, payload jsonb, change_reason text, confirmed boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  domain_id uuid := nullif(payload ->> 'id', '')::uuid;
  action text := coalesce(nullif(payload ->> 'action', ''), 'add');
  host text := public.hanafy_normalize_hostname(regexp_replace(regexp_replace(lower(btrim(coalesce(payload ->> 'hostname', ''))), '^https?://', ''), '/.*$', ''));
  location_value uuid := nullif(payload ->> 'location_id', '')::uuid;
  before_row public.workspace_domains%rowtype;
  after_row public.workspace_domains%rowtype;
  owner_name text;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if change_reason is null or char_length(btrim(change_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)' using errcode = '22023'; end if;
  select * into target from public.workspaces where slug = target_workspace_slug for update;
  if target.id is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;

  if action = 'add' then
    if not public.hanafy_valid_hostname(host) then raise exception 'Enter a web address like orders.joesdeli.com (no https://, no path)' using errcode = '22023'; end if;
    if public.hanafy_platform_hostname(host) then raise exception 'That address belongs to the Hanafy platform itself' using errcode = '22023'; end if;
    select workspace.name into owner_name from public.workspace_domains domain join public.workspaces workspace on workspace.id = domain.workspace_id where domain.hostname = host;
    if owner_name is not null then raise exception 'That web address is already used by %', owner_name using errcode = '23505'; end if;
    location_value := coalesce(location_value, (select location.id from public.locations location where location.workspace_id = target.id and location.status <> 'archived' order by location.created_at limit 1));
    if not exists (select 1 from public.locations location where location.id = location_value and location.workspace_id = target.id) then
      raise exception 'That location does not belong to this business' using errcode = '42501';
    end if;
    insert into public.workspace_domains (workspace_id, location_id, hostname, is_canonical, active)
    values (target.id, location_value, host,
      coalesce((payload ->> 'is_canonical')::boolean, false)
        or not exists (select 1 from public.workspace_domains existing where existing.workspace_id = target.id and existing.location_id = location_value and existing.is_canonical),
      true)
    returning * into after_row;
    if after_row.is_canonical then
      update public.workspace_domains set is_canonical = false where workspace_id = target.id and location_id = location_value and id <> after_row.id and is_canonical;
    end if;
  else
    select * into before_row from public.workspace_domains where id = domain_id and workspace_id = target.id for update;
    if before_row.id is null then raise exception 'Web address not found for this business' using errcode = 'P0002'; end if;
    if action in ('deactivate', 'remove') and before_row.active and target.status = 'active' and not confirmed
       and not exists (select 1 from public.workspace_domains other where other.workspace_id = target.id and other.id <> before_row.id and other.active) then
      return jsonb_build_object('status', 'needs_confirmation', 'warnings',
        jsonb_build_array(format('%s has no other web address: its website and online ordering stop answering.', target.name)));
    end if;
    if action = 'canonical' then
      update public.workspace_domains set is_canonical = false where workspace_id = target.id and location_id = before_row.location_id and is_canonical;
      update public.workspace_domains set is_canonical = true, active = true where id = before_row.id returning * into after_row;
    elsif action = 'activate' then
      update public.workspace_domains set active = true where id = before_row.id returning * into after_row;
    elsif action = 'deactivate' then
      update public.workspace_domains set active = false where id = before_row.id returning * into after_row;
    elsif action = 'remove' then
      if before_row.active then raise exception 'Switch the web address off before removing it' using errcode = '22023'; end if;
      delete from public.workspace_domains where id = before_row.id;
    else
      raise exception 'Unknown web address action' using errcode = '22023';
    end if;
  end if;

  perform public.hanafy_platform_write_audit('platform.domain.' || case action when 'add' then 'added' when 'canonical' then 'made_canonical' when 'activate' then 'activated' when 'deactivate' then 'deactivated' else 'removed' end,
    target.id, 'workspace_domain', coalesce(after_row.id, before_row.id)::text,
    format('%s web address %s for %s', initcap(case action when 'add' then 'added' when 'canonical' then 'made main' when 'activate' then 'switched on' when 'deactivate' then 'switched off' else 'removed' end),
      coalesce(after_row.hostname, before_row.hostname), target.name),
    case when before_row.id is null then null else to_jsonb(before_row) end, case when after_row.id is null then null else to_jsonb(after_row) end, btrim(change_reason), null);
  return jsonb_build_object('status', 'saved', 'id', coalesce(after_row.id, before_row.id));
end;
$$;
revoke all on function public.hanafy_platform_save_domain(text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.hanafy_platform_save_domain(text, jsonb, text, boolean) to authenticated;

-- Storefront basics for a location (whitelisted keys only) + brand colour.
create or replace function public.hanafy_platform_save_storefront(target_workspace_slug text, target_location_id uuid, payload jsonb, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  before_config jsonb;
  changes jsonb := '{}'::jsonb;
  item record;
  allowed_text text[] := array['store_name', 'brand_name', 'brand_short_name', 'homepage_eyebrow', 'homepage_heading', 'homepage_description', 'story',
    'about_heading', 'contact_heading', 'announcement_text', 'general_notice', 'footer_text', 'seo_home_title', 'seo_home_description',
    'seo_menu_title', 'seo_menu_description', 'seo_about_title', 'seo_about_description', 'seo_contact_title', 'seo_contact_description',
    'public_phone', 'public_email', 'service_area_text', 'facebook_url', 'instagram_url', 'tiktok_url'];
  primary_color text := nullif(btrim(payload ->> 'brand_primary'), '');
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if change_reason is null or char_length(btrim(change_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)' using errcode = '22023'; end if;
  select * into target from public.workspaces where slug = target_workspace_slug;
  if target.id is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  select settings.configuration into before_config from public.location_settings settings
  where settings.location_id = target_location_id and settings.workspace_id = target.id for update;
  if before_config is null then raise exception 'That location does not belong to this business' using errcode = '42501'; end if;

  for item in select key, value from jsonb_each(payload) loop
    if item.key = any(allowed_text) then
      if jsonb_typeof(item.value) <> 'string' or char_length(item.value #>> '{}') > 4000 then
        raise exception 'Field % must be text (up to 4000 characters)', item.key using errcode = '22023';
      end if;
      if item.key like '%_url' and (item.value #>> '{}') <> '' and (item.value #>> '{}') !~ '^https://' then
        raise exception 'Links must start with https://' using errcode = '22023';
      end if;
      changes := changes || jsonb_build_object(item.key, btrim(item.value #>> '{}'));
    elsif item.key = 'ordering_open' then
      if jsonb_typeof(item.value) <> 'boolean' then raise exception 'ordering_open is true or false' using errcode = '22023'; end if;
      changes := changes || jsonb_build_object('ordering_open', item.value);
    elsif item.key not in ('brand_primary') then
      raise exception 'Field % cannot be changed here', item.key using errcode = '22023';
    end if;
  end loop;
  if primary_color is not null and primary_color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Brand colour looks like #b02222' using errcode = '22023'; end if;

  update public.location_settings set configuration = configuration || changes where location_id = target_location_id;
  if payload ? 'brand_primary' then
    update public.workspace_settings set brand_colors = case when primary_color is null then brand_colors - 'primary' else brand_colors || jsonb_build_object('primary', lower(primary_color)) end
    where workspace_id = target.id;
  end if;
  perform public.hanafy_platform_write_audit('platform.storefront.updated', target.id, 'location_settings', target_location_id::text,
    format('Changed the website basics for %s (%s)', target.name, coalesce((select string_agg(key, ', ') from jsonb_object_keys(changes || case when payload ? 'brand_primary' then '{"brand_primary":1}'::jsonb else '{}'::jsonb end) key), 'nothing')),
    (select jsonb_object_agg(key, before_config -> key) from jsonb_object_keys(changes) key), changes, btrim(change_reason), null);
  return jsonb_build_object('status', 'saved');
end;
$$;
revoke all on function public.hanafy_platform_save_storefront(text, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_save_storefront(text, uuid, jsonb, text) to authenticated;
