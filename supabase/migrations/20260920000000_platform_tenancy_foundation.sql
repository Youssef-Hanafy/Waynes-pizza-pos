-- Hanafy Platform — Phase 1: tenancy foundation.
--
-- The existing application remains a Wayne's-only POS during this migration.
-- These tables establish the business/workspace boundary that every new
-- business-owned table will use before any operational data is backfilled.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  legal_name text not null default '' check (char_length(legal_name) <= 240),
  public_email text not null default '' check (public_email = lower(btrim(public_email)) and char_length(public_email) <= 254),
  public_phone text not null default '' check (char_length(public_phone) <= 40),
  status text not null default 'active' check (status in ('draft', 'active', 'suspended', 'archived')),
  onboarding_status text not null default 'not_started' check (onboarding_status in ('not_started', 'in_progress', 'ready')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  timezone text not null default 'America/New_York' check (char_length(timezone) between 1 and 120),
  address_line1 text not null default '' check (char_length(address_line1) <= 200),
  address_line2 text not null default '' check (char_length(address_line2) <= 200),
  city text not null default '' check (char_length(city) <= 120),
  state_or_region text not null default '' check (char_length(state_or_region) <= 120),
  postal_code text not null default '' check (char_length(postal_code) <= 32),
  country_code text not null default 'US' check (country_code ~ '^[A-Z]{2}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create unique index locations_workspace_active_name_idx
  on public.locations (workspace_id, lower(name)) where active;
create index locations_workspace_id_idx on public.locations (workspace_id);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members (user_id, workspace_id) where active;
create index workspace_members_role_id_idx on public.workspace_members (workspace_id, role_id) where active;

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  role_id uuid not null references public.roles(id) on delete restrict,
  invited_by_user_id uuid references auth.users(id) on delete set null,
  token_hash text not null unique check (char_length(token_hash) = 64 and token_hash ~ '^[a-f0-9]+$'),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (accepted_at is null or accepted_at >= created_at),
  check (revoked_at is null or revoked_at >= created_at)
);
create index workspace_invites_active_email_idx
  on public.workspace_invites (workspace_id, email, expires_at)
  where accepted_at is null and revoked_at is null;

create table public.platform_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('platform_admin', 'support')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_services (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  service_id uuid not null references public.service_catalog(id) on delete restrict,
  status text not null default 'active' check (status in ('trial', 'active', 'paused', 'cancelled')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, service_id),
  check (ends_at is null or ends_at > starts_at)
);
create index workspace_services_workspace_id_idx on public.workspace_services (workspace_id, status);

create trigger workspaces_set_updated_at before update on public.workspaces
for each row execute function public.set_updated_at();
create trigger locations_set_updated_at before update on public.locations
for each row execute function public.set_updated_at();
create trigger workspace_members_set_updated_at before update on public.workspace_members
for each row execute function public.set_updated_at();
create trigger platform_users_set_updated_at before update on public.platform_users
for each row execute function public.set_updated_at();
create trigger service_catalog_set_updated_at before update on public.service_catalog
for each row execute function public.set_updated_at();
create trigger workspace_services_set_updated_at before update on public.workspace_services
for each row execute function public.set_updated_at();

-- Platform access is deliberately separate from restaurant ownership. A restaurant
-- owner must never become a Hanafy administrator merely by being an owner.
create or replace function public.hanafy_is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_users platform_user
    where platform_user.user_id = auth.uid()
      and platform_user.active
      and platform_user.role = 'platform_admin'
  );
$$;

create or replace function public.hanafy_is_workspace_member(target_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.hanafy_is_platform_admin() or exists (
    select 1
    from public.workspace_members member
    join public.workspaces workspace on workspace.id = member.workspace_id
    where member.workspace_id = target_workspace_id
      and member.user_id = auth.uid()
      and member.active
      and workspace.status = 'active'
  );
$$;

create or replace function public.hanafy_has_workspace_permission(target_workspace_id uuid, required_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.hanafy_is_platform_admin() or exists (
    select 1
    from public.workspace_members member
    join public.workspaces workspace on workspace.id = member.workspace_id and workspace.status = 'active'
    join public.roles role on role.id = member.role_id and role.active
    join public.role_permissions role_permission on role_permission.role_id = role.id
    join public.permissions permission on permission.id = role_permission.permission_id
    where member.workspace_id = target_workspace_id
      and member.user_id = auth.uid()
      and member.active
      and permission.code = required_permission
  );
$$;

create or replace function public.hanafy_workspace_has_service(target_workspace_id uuid, required_service_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.workspace_services workspace_service
    join public.service_catalog service on service.id = workspace_service.service_id and service.active
    where workspace_service.workspace_id = target_workspace_id
      and workspace_service.status in ('trial', 'active')
      and workspace_service.starts_at <= now()
      and (workspace_service.ends_at is null or workspace_service.ends_at > now())
      and service.code = required_service_code
  );
$$;

create or replace function public.hanafy_my_workspace_access(target_workspace_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'workspace_id', workspace.id,
    'workspace_slug', workspace.slug,
    'workspace_name', workspace.name,
    'role', role.code,
    'permissions', coalesce((
      select jsonb_agg(permission.code order by permission.code)
      from public.role_permissions role_permission
      join public.permissions permission on permission.id = role_permission.permission_id
      where role_permission.role_id = role.id
    ), '[]'::jsonb),
    'location_ids', coalesce((
      select jsonb_agg(location.id order by location.name)
      from public.locations location
      where location.workspace_id = workspace.id and location.active
    ), '[]'::jsonb)
  )
  from public.workspace_members member
  join public.workspaces workspace on workspace.id = member.workspace_id and workspace.status = 'active'
  join public.roles role on role.id = member.role_id and role.active
  where member.workspace_id = target_workspace_id
    and member.user_id = auth.uid()
    and member.active;
$$;

-- Provisioning is callable only by a Hanafy platform administrator. It creates
-- an isolated business, its first location, owner membership, and the selected
-- product entitlements in one transaction.
create or replace function public.hanafy_create_workspace(
  workspace_slug_value text,
  workspace_name_value text,
  legal_name_value text,
  public_email_value text,
  public_phone_value text,
  location_name_value text,
  timezone_value text,
  owner_user_id_value uuid,
  service_codes_value text[] default array[]::text[]
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  created_workspace_id uuid;
  owner_role_id uuid;
  requested_service_count integer;
  resolved_service_count integer;
begin
  if not public.hanafy_is_platform_admin() then
    raise exception 'Platform administrator access required' using errcode = '42501';
  end if;
  if workspace_slug_value is null or lower(btrim(workspace_slug_value)) !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(btrim(workspace_slug_value)) not between 3 and 80 then
    raise exception 'Workspace slug is invalid' using errcode = '22023';
  end if;
  if workspace_name_value is null or char_length(btrim(workspace_name_value)) not between 1 and 160 then
    raise exception 'Workspace name is invalid' using errcode = '22023';
  end if;
  if location_name_value is null or char_length(btrim(location_name_value)) not between 1 and 160 then
    raise exception 'Location name is invalid' using errcode = '22023';
  end if;
  if timezone_value is null or char_length(btrim(timezone_value)) not between 1 and 120 then
    raise exception 'Timezone is invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users account where account.id = owner_user_id_value) then
    raise exception 'Owner account does not exist' using errcode = '23503';
  end if;
  select id into owner_role_id from public.roles where code = 'owner' and active;
  if owner_role_id is null then raise exception 'Owner role is unavailable' using errcode = 'P0001'; end if;

  select count(*) into requested_service_count
  from (select distinct unnest(coalesce(service_codes_value, array[]::text[])) as code) requested;
  select count(*) into resolved_service_count
  from public.service_catalog service
  where service.active and service.code = any(coalesce(service_codes_value, array[]::text[]));
  if requested_service_count <> resolved_service_count then
    raise exception 'One or more selected services are unavailable' using errcode = '22023';
  end if;

  insert into public.workspaces (slug, name, legal_name, public_email, public_phone, onboarding_status)
  values (
    lower(btrim(workspace_slug_value)),
    btrim(workspace_name_value),
    left(coalesce(btrim(legal_name_value), ''), 240),
    lower(btrim(coalesce(public_email_value, ''))),
    left(btrim(coalesce(public_phone_value, '')), 40),
    'in_progress'
  ) returning id into created_workspace_id;

  insert into public.locations (workspace_id, slug, name, timezone)
  values (created_workspace_id, 'main', btrim(location_name_value), btrim(timezone_value));
  insert into public.workspace_members (workspace_id, user_id, role_id)
  values (created_workspace_id, owner_user_id_value, owner_role_id);
  insert into public.workspace_services (workspace_id, service_id)
  select created_workspace_id, service.id
  from public.service_catalog service
  where service.code = any(coalesce(service_codes_value, array[]::text[])) and service.active;

  return created_workspace_id;
end;
$$;

-- A business owner configures only their own profile and first location. The
-- later POS/menu migrations will add their own scoped setup operations.
create or replace function public.hanafy_update_workspace_onboarding(
  target_workspace_id uuid,
  workspace_name_value text,
  legal_name_value text,
  public_email_value text,
  public_phone_value text,
  location_id_value uuid,
  location_name_value text,
  timezone_value text,
  address_line1_value text,
  address_line2_value text,
  city_value text,
  state_or_region_value text,
  postal_code_value text,
  country_code_value text,
  complete_value boolean default false
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.hanafy_has_workspace_permission(target_workspace_id, 'settings.manage') then
    raise exception 'Business settings permission required' using errcode = '42501';
  end if;
  if workspace_name_value is null or char_length(btrim(workspace_name_value)) not between 1 and 160
    or location_name_value is null or char_length(btrim(location_name_value)) not between 1 and 160
    or timezone_value is null or char_length(btrim(timezone_value)) not between 1 and 120
    or country_code_value is null or upper(btrim(country_code_value)) !~ '^[A-Z]{2}$' then
    raise exception 'One or more setup fields are invalid' using errcode = '22023';
  end if;

  update public.workspaces
  set name = btrim(workspace_name_value),
      legal_name = left(coalesce(btrim(legal_name_value), ''), 240),
      public_email = lower(btrim(coalesce(public_email_value, ''))),
      public_phone = left(btrim(coalesce(public_phone_value, '')), 40),
      onboarding_status = case when complete_value then 'ready' else 'in_progress' end
  where id = target_workspace_id;
  if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;

  update public.locations
  set name = btrim(location_name_value),
      timezone = btrim(timezone_value),
      address_line1 = left(btrim(coalesce(address_line1_value, '')), 200),
      address_line2 = left(btrim(coalesce(address_line2_value, '')), 200),
      city = left(btrim(coalesce(city_value, '')), 120),
      state_or_region = left(btrim(coalesce(state_or_region_value, '')), 120),
      postal_code = left(btrim(coalesce(postal_code_value, '')), 32),
      country_code = upper(btrim(country_code_value))
  where id = location_id_value and workspace_id = target_workspace_id;
  if not found then raise exception 'Location not found' using errcode = 'P0002'; end if;
end;
$$;

-- The first workspace mirrors the existing single-business installation. The
-- legacy profile rows remain authoritative until every operational table has a
-- required workspace_id and its RLS policies are migrated in a later phase.
insert into public.workspaces (id, slug, name, legal_name, public_email, public_phone, onboarding_status)
select
  '50000000-0000-4000-8000-000000000001',
  'waynes-pizza',
  settings.store_name,
  settings.store_name,
  settings.public_email,
  settings.public_phone,
  'ready'
from public.store_settings settings
where settings.id = true;

insert into public.locations (id, workspace_id, slug, name, timezone, address_line1, address_line2, city, state_or_region, postal_code)
select
  '50000000-0000-4000-8000-000000000101',
  '50000000-0000-4000-8000-000000000001',
  'main',
  'Main location',
  settings.timezone,
  settings.address_line1,
  settings.address_line2,
  settings.city,
  settings.state,
  settings.postal_code
from public.store_settings settings
where settings.id = true;

insert into public.workspace_members (workspace_id, user_id, role_id, active)
select '50000000-0000-4000-8000-000000000001', profile.id, profile.role_id, profile.active
from public.profiles profile;

insert into public.service_catalog (id, code, name, description) values
  ('60000000-0000-4000-8000-000000000001', 'restaurant_pos', 'Restaurant POS', 'Counter POS, kitchen workflow, cash, reporting, and staff access.'),
  ('60000000-0000-4000-8000-000000000002', 'online_ordering', 'Online ordering', 'Branded ordering website, menu, pickup, and delivery setup.'),
  ('60000000-0000-4000-8000-000000000003', 'customer_engagement', 'Customer engagement', 'Customer intelligence, loyalty offers, and Hanafy marketing integration.'),
  ('60000000-0000-4000-8000-000000000004', 'delivery_operations', 'Delivery operations', 'Driver dispatch and delivery performance tools.');

insert into public.workspace_services (workspace_id, service_id)
select '50000000-0000-4000-8000-000000000001', service.id
from public.service_catalog service;

alter table public.workspaces enable row level security;
alter table public.locations enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.platform_users enable row level security;
alter table public.service_catalog enable row level security;
alter table public.workspace_services enable row level security;

create policy workspaces_platform_or_member_select on public.workspaces for select to authenticated
using (public.hanafy_is_workspace_member(id));
create policy locations_platform_or_member_select on public.locations for select to authenticated
using (public.hanafy_is_workspace_member(workspace_id));
create policy workspace_members_self_or_staff_select on public.workspace_members for select to authenticated
using (user_id = auth.uid() or public.hanafy_has_workspace_permission(workspace_id, 'staff.view'));
create policy workspace_invites_staff_manage_select on public.workspace_invites for select to authenticated
using (public.hanafy_has_workspace_permission(workspace_id, 'staff.manage'));
create policy platform_users_self_or_platform_admin_select on public.platform_users for select to authenticated
using (user_id = auth.uid() or public.hanafy_is_platform_admin());
create policy service_catalog_authenticated_select on public.service_catalog for select to authenticated
using (active or public.hanafy_is_platform_admin());
create policy workspace_services_platform_or_member_select on public.workspace_services for select to authenticated
using (public.hanafy_is_workspace_member(workspace_id));

revoke all on public.workspaces, public.locations, public.workspace_members, public.workspace_invites,
  public.platform_users, public.service_catalog, public.workspace_services from public, anon;
grant select on public.workspaces, public.locations, public.workspace_members, public.workspace_invites,
  public.platform_users, public.service_catalog, public.workspace_services to authenticated;

revoke all on function public.hanafy_is_platform_admin() from public;
revoke all on function public.hanafy_is_workspace_member(uuid) from public;
revoke all on function public.hanafy_has_workspace_permission(uuid, text) from public;
revoke all on function public.hanafy_workspace_has_service(uuid, text) from public;
revoke all on function public.hanafy_my_workspace_access(uuid) from public;
revoke all on function public.hanafy_create_workspace(text, text, text, text, text, text, text, uuid, text[]) from public;
revoke all on function public.hanafy_update_workspace_onboarding(uuid, text, text, text, text, uuid, text, text, text, text, text, text, text, text, boolean) from public;
grant execute on function public.hanafy_is_platform_admin() to authenticated;
grant execute on function public.hanafy_is_workspace_member(uuid) to authenticated;
grant execute on function public.hanafy_has_workspace_permission(uuid, text) to authenticated;
grant execute on function public.hanafy_workspace_has_service(uuid, text) to authenticated;
grant execute on function public.hanafy_my_workspace_access(uuid) to authenticated;
grant execute on function public.hanafy_create_workspace(text, text, text, text, text, text, text, uuid, text[]) to authenticated;
grant execute on function public.hanafy_update_workspace_onboarding(uuid, text, text, text, text, uuid, text, text, text, text, text, text, text, text, boolean) to authenticated;

comment on table public.workspaces is 'A customer business in the Hanafy platform. New restaurant-owned data must reference this table.';
comment on table public.locations is 'A physical or operational location owned by one workspace.';
comment on table public.workspace_members is 'Per-workspace staff membership. Replaces the single-business profile role during the tenancy migration.';
