-- Wayne's Pizza POS — Phase 1 only: public site settings and menu administration.

insert into public.permissions (id, code, description) values
  ('20000000-0000-4000-8000-000000000008', 'menu.manage', 'Create and manage menu content'),
  ('20000000-0000-4000-8000-000000000009', 'content.manage', 'Manage public website content');

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code in ('menu.manage', 'content.manage')
where role.code in ('owner', 'manager');

create table public.store_settings (
  id boolean primary key default true check (id),
  store_name text not null default 'Wayne''s Pizza' check (char_length(store_name) between 1 and 120),
  owner_name text not null default '' check (char_length(owner_name) <= 120),
  story text not null default 'Wayne''s Pizza is a longtime Worcester neighborhood pizza shop that has been serving the community for over 50 years. The restaurant specializes in Greek- and Italian-style pizza along with calzones, subs, salads, pasta, fried foods, and other classic pizza-shop favorites.' check (char_length(story) <= 8000),
  owner_story text not null default '' check (char_length(owner_story) <= 8000),
  address_line1 text not null default '93 West Boylston St.' check (char_length(address_line1) <= 200),
  address_line2 text not null default '' check (char_length(address_line2) <= 200),
  city text not null default 'Worcester' check (char_length(city) <= 120),
  state text not null default 'MA' check (char_length(state) <= 80),
  postal_code text not null default '01606' check (char_length(postal_code) <= 20),
  public_phone text not null default '(508) 852-6326' check (char_length(public_phone) <= 40),
  public_email text not null default '' check (char_length(public_email) <= 254),
  timezone text not null default 'America/New_York',
  business_hours jsonb not null default '{
    "sunday":{"closed":false,"open":"11:00","close":"22:00"},
    "monday":{"closed":false,"open":"11:00","close":"22:00"},
    "tuesday":{"closed":false,"open":"11:00","close":"22:00"},
    "wednesday":{"closed":false,"open":"11:00","close":"22:00"},
    "thursday":{"closed":false,"open":"11:00","close":"22:00"},
    "friday":{"closed":false,"open":"11:00","close":"22:00"},
    "saturday":{"closed":false,"open":"11:00","close":"22:00"}
  }'::jsonb check (jsonb_typeof(business_hours) = 'object'),
  ordering_open boolean not null default true,
  pickup_enabled boolean not null default true,
  delivery_enabled boolean not null default true,
  service_area_text text not null default 'Serving Worcester and the surrounding neighborhood.' check (char_length(service_area_text) <= 1000),
  canonical_url text not null default 'https://waynespizzaofworcester.com' check (canonical_url = '' or canonical_url ~ '^https?://'),
  facebook_url text not null default '' check (facebook_url = '' or facebook_url ~ '^https?://'),
  instagram_url text not null default '' check (instagram_url = '' or instagram_url ~ '^https?://'),
  logo_path text,
  logo_alt text not null default 'Wayne''s Pizza logo' check (char_length(logo_alt) <= 300),
  announcement_text text not null default '' check (char_length(announcement_text) <= 500),
  homepage_eyebrow text not null default 'Worcester''s neighborhood pizza shop' check (char_length(homepage_eyebrow) <= 200),
  homepage_heading text not null default 'Hot pizza. Your way.' check (char_length(homepage_heading) <= 240),
  homepage_description text not null default 'Choose pickup or delivery, then explore Wayne''s current menu.' check (char_length(homepage_description) <= 1000),
  pickup_heading text not null default 'Pickup' check (char_length(pickup_heading) <= 100),
  pickup_description text not null default 'Order ahead and pick it up fresh at Wayne''s.' check (char_length(pickup_description) <= 500),
  delivery_heading text not null default 'Delivery' check (char_length(delivery_heading) <= 100),
  delivery_description text not null default 'See delivery availability and bring Wayne''s to your door.' check (char_length(delivery_description) <= 500),
  about_heading text not null default 'A Worcester favorite for over 50 years' check (char_length(about_heading) <= 240),
  contact_heading text not null default 'Visit or call Wayne''s' check (char_length(contact_heading) <= 240),
  ordering_instructions text not null default 'Choose pickup or delivery to browse the menu. Online checkout arrives in the next approved phase.' check (char_length(ordering_instructions) <= 1500),
  general_notice text not null default '' check (char_length(general_notice) <= 1000),
  footer_text text not null default 'Wayne''s Pizza — Worcester, Massachusetts' check (char_length(footer_text) <= 500),
  seo_home_title text not null default 'Wayne''s Pizza | Worcester, MA' check (char_length(seo_home_title) <= 180),
  seo_home_description text not null default 'Explore Wayne''s Pizza in Worcester, Massachusetts—serving Greek- and Italian-style pizza and classic pizza-shop favorites for over 50 years.' check (char_length(seo_home_description) <= 500),
  seo_menu_title text not null default 'Menu' check (char_length(seo_menu_title) <= 180),
  seo_menu_description text not null default 'Browse the current Wayne''s Pizza menu for pickup or delivery in Worcester.' check (char_length(seo_menu_description) <= 500),
  seo_about_title text not null default 'About Wayne''s Pizza' check (char_length(seo_about_title) <= 180),
  seo_about_description text not null default 'Learn about Wayne''s Pizza, a longtime Worcester neighborhood pizza shop serving the community for over 50 years.' check (char_length(seo_about_description) <= 500),
  seo_contact_title text not null default 'Contact Wayne''s Pizza' check (char_length(seo_contact_title) <= 180),
  seo_contact_description text not null default 'Find Wayne''s Pizza hours, phone number, and location at 93 West Boylston St. in Worcester, Massachusetts.' check (char_length(seo_contact_description) <= 500),
  faq_items jsonb not null default '[
    {"question":"Do you offer pickup?","answer":"Yes. Choose Pickup above to browse the current menu."},
    {"question":"Do you offer delivery?","answer":"Delivery availability and service area are shown before ordering."}
  ]'::jsonb check (jsonb_typeof(faq_items) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.store_settings (id) values (true);

create table public.store_special_hours (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  label text not null default '' check (char_length(label) <= 160),
  closed boolean not null default true,
  opens_at time,
  closes_at time,
  public_note text not null default '' check (char_length(public_note) <= 500),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((closed and opens_at is null and closes_at is null) or (not closed and opens_at is not null and closes_at is not null))
);

create unique index store_special_hours_active_date_idx
on public.store_special_hours (service_date) where archived_at is null;

create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  image_path text,
  image_alt text not null default '' check (char_length(image_alt) <= 300),
  sort_order integer not null default 0,
  customer_visible boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.menu_categories(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 160),
  description text not null default '' check (char_length(description) <= 2000),
  image_path text,
  image_alt text not null default '' check (char_length(image_alt) <= 300),
  base_price_cents integer not null default 0 check (base_price_cents >= 0),
  tax_category text not null default 'prepared_food' check (char_length(tax_category) between 1 and 80),
  included_count_label text not null default '' check (char_length(included_count_label) <= 120),
  sold_out boolean not null default false,
  customer_visible boolean not null default true,
  pos_visible boolean not null default true,
  featured boolean not null default false,
  kitchen_route text check (kitchen_route is null or char_length(kitchen_route) <= 120),
  available_days smallint[] not null default array[0,1,2,3,4,5,6]::smallint[] check (available_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  available_start time,
  available_end time,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((available_start is null and available_end is null) or (available_start is not null and available_end is not null))
);

create table public.menu_item_variants (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  price_cents integer not null check (price_cents >= 0),
  sku text check (sku is null or char_length(sku) <= 80),
  sort_order integer not null default 0,
  active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  customer_label text not null check (char_length(customer_label) between 1 and 160),
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1 check (max_select >= 1 and max_select >= min_select),
  required boolean not null default false,
  allow_quantities boolean not null default false,
  sort_order integer not null default 0,
  active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.modifier_choices (
  id uuid primary key default gen_random_uuid(),
  modifier_group_id uuid not null references public.modifier_groups(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  price_delta_cents integer not null default 0,
  default_selected boolean not null default false,
  sort_order integer not null default 0,
  active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.menu_item_modifier_groups (
  menu_item_id uuid not null references public.menu_items(id) on delete restrict,
  modifier_group_id uuid not null references public.modifier_groups(id) on delete restrict,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (menu_item_id, modifier_group_id)
);

create index menu_categories_public_idx on public.menu_categories (sort_order, name) where archived_at is null and customer_visible;
create index menu_items_category_idx on public.menu_items (category_id, sort_order, name);
create index menu_items_public_idx on public.menu_items (category_id, sort_order, name) where archived_at is null and customer_visible;
create index menu_item_variants_item_idx on public.menu_item_variants (menu_item_id, sort_order) where archived_at is null and active;
create index modifier_choices_group_idx on public.modifier_choices (modifier_group_id, sort_order) where archived_at is null and active;
create index menu_item_modifier_groups_item_idx on public.menu_item_modifier_groups (menu_item_id, sort_order) where active;

create trigger store_settings_set_updated_at before update on public.store_settings
for each row execute function public.set_updated_at();
create trigger store_special_hours_set_updated_at before update on public.store_special_hours
for each row execute function public.set_updated_at();
create trigger menu_categories_set_updated_at before update on public.menu_categories
for each row execute function public.set_updated_at();
create trigger menu_items_set_updated_at before update on public.menu_items
for each row execute function public.set_updated_at();
create trigger menu_item_variants_set_updated_at before update on public.menu_item_variants
for each row execute function public.set_updated_at();
create trigger modifier_groups_set_updated_at before update on public.modifier_groups
for each row execute function public.set_updated_at();
create trigger modifier_choices_set_updated_at before update on public.modifier_choices
for each row execute function public.set_updated_at();

alter table public.store_settings enable row level security;
alter table public.store_special_hours enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.menu_item_variants enable row level security;
alter table public.modifier_groups enable row level security;
alter table public.modifier_choices enable row level security;
alter table public.menu_item_modifier_groups enable row level security;

create policy store_settings_admin_select on public.store_settings
for select to authenticated using (public.wayne_has_permission('content.manage'));
create policy store_settings_admin_update on public.store_settings
for update to authenticated using (public.wayne_has_permission('content.manage'))
with check (public.wayne_has_permission('content.manage'));

create policy store_special_hours_public_select on public.store_special_hours
for select to anon, authenticated using (
  archived_at is null or public.wayne_has_permission('content.manage')
);
create policy store_special_hours_admin_insert on public.store_special_hours
for insert to authenticated with check (public.wayne_has_permission('content.manage'));
create policy store_special_hours_admin_update on public.store_special_hours
for update to authenticated using (public.wayne_has_permission('content.manage'))
with check (public.wayne_has_permission('content.manage'));

create policy menu_categories_public_select on public.menu_categories
for select to anon, authenticated using (
  (customer_visible and archived_at is null) or public.wayne_has_permission('menu.manage')
);
create policy menu_categories_admin_insert on public.menu_categories
for insert to authenticated with check (public.wayne_has_permission('menu.manage'));
create policy menu_categories_admin_update on public.menu_categories
for update to authenticated using (public.wayne_has_permission('menu.manage'))
with check (public.wayne_has_permission('menu.manage'));

create policy menu_items_public_select on public.menu_items
for select to anon, authenticated using (
  (
    customer_visible and archived_at is null and exists (
      select 1 from public.menu_categories category
      where category.id = category_id and category.customer_visible and category.archived_at is null
    )
  ) or public.wayne_has_permission('menu.manage')
);
create policy menu_items_admin_insert on public.menu_items
for insert to authenticated with check (public.wayne_has_permission('menu.manage'));
create policy menu_items_admin_update on public.menu_items
for update to authenticated using (public.wayne_has_permission('menu.manage'))
with check (public.wayne_has_permission('menu.manage'));

create policy menu_item_variants_public_select on public.menu_item_variants
for select to anon, authenticated using (
  (active and archived_at is null and exists (
    select 1 from public.menu_items item
    join public.menu_categories category on category.id = item.category_id
    where item.id = menu_item_id
      and item.customer_visible and item.archived_at is null
      and category.customer_visible and category.archived_at is null
  )) or public.wayne_has_permission('menu.manage')
);

create policy modifier_groups_public_select on public.modifier_groups
for select to anon, authenticated using (
  (active and archived_at is null and exists (
    select 1 from public.menu_item_modifier_groups link
    join public.menu_items item on item.id = link.menu_item_id
    join public.menu_categories category on category.id = item.category_id
    where link.modifier_group_id = modifier_groups.id and link.active
      and item.customer_visible and item.archived_at is null
      and category.customer_visible and category.archived_at is null
  )) or public.wayne_has_permission('menu.manage')
);

create policy modifier_choices_public_select on public.modifier_choices
for select to anon, authenticated using (
  (active and archived_at is null and exists (
    select 1 from public.menu_item_modifier_groups link
    join public.menu_items item on item.id = link.menu_item_id
    join public.menu_categories category on category.id = item.category_id
    where link.modifier_group_id = modifier_choices.modifier_group_id and link.active
      and item.customer_visible and item.archived_at is null
      and category.customer_visible and category.archived_at is null
  )) or public.wayne_has_permission('menu.manage')
);

create policy menu_item_modifier_groups_public_select on public.menu_item_modifier_groups
for select to anon, authenticated using (
  (active and exists (
    select 1 from public.menu_items item
    join public.menu_categories category on category.id = item.category_id
    where item.id = menu_item_id
      and item.customer_visible and item.archived_at is null
      and category.customer_visible and category.archived_at is null
  )) or public.wayne_has_permission('menu.manage')
);

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
  group_id uuid;
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
      );
      choice_index := choice_index + 1;
    end loop;
    group_index := group_index + 1;
  end loop;
end;
$$;

create or replace function public.wayne_create_menu_item(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  item_id uuid;
begin
  if not public.wayne_has_permission('menu.manage') then
    raise exception 'Menu management permission required' using errcode = '42501';
  end if;

  insert into public.menu_items (
    category_id, name, description, image_path, image_alt, base_price_cents,
    tax_category, included_count_label, sold_out, customer_visible, pos_visible,
    featured, kitchen_route, available_days, available_start, available_end, sort_order
  ) values (
    (payload ->> 'category_id')::uuid,
    btrim(payload ->> 'name'),
    btrim(coalesce(payload ->> 'description', '')),
    nullif(payload ->> 'image_path', ''),
    btrim(coalesce(payload ->> 'image_alt', '')),
    (payload ->> 'base_price_cents')::integer,
    btrim(payload ->> 'tax_category'),
    btrim(coalesce(payload ->> 'included_count_label', '')),
    (payload ->> 'sold_out')::boolean,
    (payload ->> 'customer_visible')::boolean,
    (payload ->> 'pos_visible')::boolean,
    (payload ->> 'featured')::boolean,
    nullif(btrim(coalesce(payload ->> 'kitchen_route', '')), ''),
    array(select jsonb_array_elements_text(payload -> 'available_days')::smallint),
    nullif(payload ->> 'available_start', '')::time,
    nullif(payload ->> 'available_end', '')::time,
    (payload ->> 'sort_order')::integer
  ) returning id into item_id;

  perform public.wayne_write_menu_children(item_id, payload);
  return item_id;
end;
$$;

create or replace function public.wayne_update_menu_item(target_item_id uuid, payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.wayne_has_permission('menu.manage') then
    raise exception 'Menu management permission required' using errcode = '42501';
  end if;

  perform 1 from public.menu_items where id = target_item_id for update;
  if not found then raise exception 'Menu item not found'; end if;

  update public.menu_items set
    category_id = (payload ->> 'category_id')::uuid,
    name = btrim(payload ->> 'name'),
    description = btrim(coalesce(payload ->> 'description', '')),
    image_path = coalesce(nullif(payload ->> 'image_path', ''), image_path),
    image_alt = btrim(coalesce(payload ->> 'image_alt', '')),
    base_price_cents = (payload ->> 'base_price_cents')::integer,
    tax_category = btrim(payload ->> 'tax_category'),
    included_count_label = btrim(coalesce(payload ->> 'included_count_label', '')),
    sold_out = (payload ->> 'sold_out')::boolean,
    customer_visible = (payload ->> 'customer_visible')::boolean,
    pos_visible = (payload ->> 'pos_visible')::boolean,
    featured = (payload ->> 'featured')::boolean,
    kitchen_route = nullif(btrim(coalesce(payload ->> 'kitchen_route', '')), ''),
    available_days = array(select jsonb_array_elements_text(payload -> 'available_days')::smallint),
    available_start = nullif(payload ->> 'available_start', '')::time,
    available_end = nullif(payload ->> 'available_end', '')::time,
    sort_order = (payload ->> 'sort_order')::integer
  where id = target_item_id;

  update public.menu_item_variants
  set active = false, archived_at = coalesce(archived_at, now())
  where menu_item_id = target_item_id and archived_at is null;

  update public.menu_item_modifier_groups
  set active = false
  where menu_item_id = target_item_id and active;

  update public.modifier_groups
  set active = false, archived_at = coalesce(archived_at, now())
  where id in (
    select modifier_group_id from public.menu_item_modifier_groups where menu_item_id = target_item_id
  ) and archived_at is null;

  update public.modifier_choices
  set active = false, archived_at = coalesce(archived_at, now())
  where modifier_group_id in (
    select modifier_group_id from public.menu_item_modifier_groups where menu_item_id = target_item_id
  ) and archived_at is null;

  perform public.wayne_write_menu_children(target_item_id, payload);
  return target_item_id;
end;
$$;

create or replace function public.wayne_public_store_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select (to_jsonb(settings) - 'created_at' - 'updated_at') || jsonb_build_object(
    'special_hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', special.id,
        'service_date', special.service_date,
        'label', special.label,
        'closed', special.closed,
        'opens_at', special.opens_at,
        'closes_at', special.closes_at,
        'public_note', special.public_note
      ) order by special.service_date)
      from public.store_special_hours special
      where special.archived_at is null and special.service_date >= current_date
    ), '[]'::jsonb)
  )
  from public.store_settings settings
  where id = true;
$$;

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
                        'default_selected', choice.default_selected
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

revoke all on public.store_settings, public.store_special_hours, public.menu_categories, public.menu_items,
  public.menu_item_variants, public.modifier_groups, public.modifier_choices,
  public.menu_item_modifier_groups from anon, authenticated;

grant select on public.menu_categories, public.menu_items, public.menu_item_variants,
  public.modifier_groups, public.modifier_choices, public.menu_item_modifier_groups to anon, authenticated;
grant select on public.store_settings, public.store_special_hours to authenticated;
grant insert, update on public.store_settings, public.store_special_hours, public.menu_categories, public.menu_items to authenticated;

revoke all on function public.wayne_write_menu_children(uuid, jsonb) from public;
revoke all on function public.wayne_create_menu_item(jsonb) from public;
revoke all on function public.wayne_update_menu_item(uuid, jsonb) from public;
revoke all on function public.wayne_public_store_settings() from public;
revoke all on function public.wayne_public_menu() from public;
grant execute on function public.wayne_create_menu_item(jsonb) to authenticated;
grant execute on function public.wayne_update_menu_item(uuid, jsonb) to authenticated;
grant execute on function public.wayne_public_store_settings() to anon, authenticated;
grant execute on function public.wayne_public_menu() to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'wayne-menu',
  'wayne-menu',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy wayne_menu_images_public_read on storage.objects
for select to anon, authenticated using (bucket_id = 'wayne-menu');

create policy wayne_menu_images_admin_insert on storage.objects
for insert to authenticated with check (
  bucket_id = 'wayne-menu' and (
    public.wayne_has_permission('menu.manage') or public.wayne_has_permission('content.manage')
  )
);

create policy wayne_menu_images_admin_update on storage.objects
for update to authenticated using (
  bucket_id = 'wayne-menu' and (
    public.wayne_has_permission('menu.manage') or public.wayne_has_permission('content.manage')
  )
) with check (
  bucket_id = 'wayne-menu' and (
    public.wayne_has_permission('menu.manage') or public.wayne_has_permission('content.manage')
  )
);

create policy wayne_menu_images_admin_delete on storage.objects
for delete to authenticated using (
  bucket_id = 'wayne-menu' and (
    public.wayne_has_permission('menu.manage') or public.wayne_has_permission('content.manage')
  )
);

comment on table public.menu_items is 'Phase 1 menu records are archived, never hard-deleted; future order rows reference immutable snapshots.';
comment on function public.wayne_create_menu_item(jsonb) is 'Transactional server-authorized Phase 1 menu item creation.';
