-- Hanafy Platform Phase 1: additive tenancy foundation.
-- This migration deliberately does not add tenant columns to existing Wayne's
-- operational tables. Those records remain single-tenant until Phase 2.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (btrim(name) <> ''),
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  timezone text not null default 'America/New_York',
  currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (btrim(name) <> ''),
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  timezone text not null default 'America/New_York',
  address_line_1 text not null default '',
  address_line_2 text not null default '',
  city text not null default '',
  state_region text not null default '',
  postal_code text not null default '',
  country_code text not null default 'US' check (country_code ~ '^[A-Z]{2}$'),
  phone_number text not null default '',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table public.platform_users (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  platform_role text not null check (platform_role in ('platform_owner', 'platform_admin', 'platform_support', 'platform_read_only')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  workspace_role_id uuid not null references public.roles(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'invited', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, auth_user_id)
);

create table public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (btrim(name) <> ''),
  description text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  service_id uuid not null references public.service_catalog(id) on delete restrict,
  status text not null default 'enabled' check (status in ('enabled', 'trial', 'disabled')),
  configuration jsonb not null default '{}'::jsonb,
  enabled_at timestamptz not null default now(),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, service_id),
  check ((status = 'disabled') = (disabled_at is not null))
);

create index locations_workspace_id_idx on public.locations(workspace_id);
create index workspace_members_auth_user_id_idx on public.workspace_members(auth_user_id);
create index workspace_members_workspace_role_id_idx on public.workspace_members(workspace_role_id);
create index workspace_services_workspace_id_idx on public.workspace_services(workspace_id);
create index workspace_services_service_id_idx on public.workspace_services(service_id);

create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function public.set_updated_at();

create trigger locations_set_updated_at
before update on public.locations
for each row execute function public.set_updated_at();

create trigger platform_users_set_updated_at
before update on public.platform_users
for each row execute function public.set_updated_at();

create trigger workspace_members_set_updated_at
before update on public.workspace_members
for each row execute function public.set_updated_at();

create trigger service_catalog_set_updated_at
before update on public.service_catalog
for each row execute function public.set_updated_at();

create trigger workspace_services_set_updated_at
before update on public.workspace_services
for each row execute function public.set_updated_at();

-- Seed only the existing Wayne's tenant. Platform access is intentionally not
-- assigned here: workspace ownership must not imply platform administration.
insert into public.workspaces (id, slug, name, timezone, currency_code)
values ('40000000-0000-4000-8000-000000000001', 'waynes-pizza', 'Wayne''s Pizza', 'America/New_York', 'USD')
on conflict (slug) do nothing;

insert into public.locations (
  id, workspace_id, slug, name, timezone, address_line_1, city, state_region, postal_code, country_code, phone_number
)
select
  '40000000-0000-4000-8000-000000000002', workspace.id, 'worcester', 'Worcester location', 'America/New_York',
  '93 West Boylston St.', 'Worcester', 'MA', '01606', 'US', '(508) 852-6326'
from public.workspaces workspace
where workspace.slug = 'waynes-pizza'
on conflict (workspace_id, slug) do nothing;

-- Preserve every existing staff record and its role. Inactive staff are retained
-- as suspended memberships so the migration does not silently discard them.
insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id, status)
select workspace.id, profile.id, profile.role_id, case when profile.active then 'active' else 'suspended' end
from public.workspaces workspace
cross join public.profiles profile
where workspace.slug = 'waynes-pizza'
on conflict (workspace_id, auth_user_id) do nothing;

insert into public.service_catalog (code, name, description) values
  ('pos', 'Point of sale', 'Counter, phone, and order workflow'),
  ('online_ordering', 'Online ordering', 'Public ordering and menu browsing'),
  ('crm', 'CRM', 'Customer records and lifecycle context'),
  ('sms', 'SMS', 'SMS messaging capability'),
  ('email', 'Email', 'Email messaging capability'),
  ('automations', 'Automations', 'Rules and background automation capability'),
  ('customer_segments', 'Customer segments', 'Customer grouping and segmentation'),
  ('caller_id', 'Caller ID', 'Inbound caller lookup and phone workflow'),
  ('analytics', 'Analytics', 'Business reporting and analytics'),
  ('delivery', 'Delivery', 'Delivery and driver workflow'),
  ('staff_management', 'Staff management', 'Staff membership and access workflow'),
  ('website_storefront', 'Website storefront', 'Public storefront capability'),
  ('hardware_management', 'Hardware management', 'Printers, drawer, and device settings')
on conflict (code) do nothing;

insert into public.workspace_services (workspace_id, service_id, status, configuration)
select workspace.id, service.id, 'enabled', '{}'::jsonb
from public.workspaces workspace
join public.service_catalog service on service.code = any(array[
  'pos', 'online_ordering', 'crm', 'customer_segments', 'caller_id', 'analytics',
  'delivery', 'staff_management', 'website_storefront', 'hardware_management'
])
where workspace.slug = 'waynes-pizza'
on conflict (workspace_id, service_id) do nothing;

create or replace function public.hanafy_has_platform_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_users platform_user
    where platform_user.auth_user_id = auth.uid()
      and platform_user.active
  );
$$;

create or replace function public.hanafy_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_users platform_user
    where platform_user.auth_user_id = auth.uid()
      and platform_user.active
      and platform_user.platform_role in ('platform_owner', 'platform_admin')
  );
$$;

create or replace function public.hanafy_is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = target_workspace_id
      and membership.auth_user_id = auth.uid()
      and membership.status = 'active'
  );
$$;

create or replace function public.hanafy_has_workspace_permission(target_workspace_id uuid, required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_is_platform_admin()
  or exists (
    select 1
    from public.workspace_members membership
    join public.roles role on role.id = membership.workspace_role_id and role.active
    join public.role_permissions role_permission on role_permission.role_id = role.id
    join public.permissions permission on permission.id = role_permission.permission_id
    where membership.workspace_id = target_workspace_id
      and membership.auth_user_id = auth.uid()
      and membership.status = 'active'
      and permission.code = required_permission
  );
$$;

create or replace function public.hanafy_workspace_service_enabled(target_workspace_id uuid, required_service_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (public.hanafy_is_workspace_member(target_workspace_id) or public.hanafy_has_platform_access())
  and exists (
    select 1
    from public.workspace_services workspace_service
    join public.service_catalog service on service.id = workspace_service.service_id and service.active
    where workspace_service.workspace_id = target_workspace_id
      and workspace_service.status in ('enabled', 'trial')
      and service.code = required_service_code
  );
$$;

create or replace function public.hanafy_workspace_context(target_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with access as (
    select
      public.hanafy_has_platform_access() as has_platform_access,
      public.hanafy_is_platform_admin() as is_platform_admin,
      membership.workspace_role_id,
      role.code as workspace_role
    from (select 1) seed
    left join public.workspace_members membership
      on membership.workspace_id = target_workspace_id
      and membership.auth_user_id = auth.uid()
      and membership.status = 'active'
    left join public.roles role on role.id = membership.workspace_role_id and role.active
  )
  select jsonb_build_object(
    'workspace_id', workspace.id,
    'workspace_slug', workspace.slug,
    'workspace_name', workspace.name,
    'workspace_role', access.workspace_role,
    'has_platform_access', access.has_platform_access,
    'is_platform_admin', access.is_platform_admin,
    'permissions', coalesce((
      select jsonb_agg(permission.code order by permission.code)
      from public.role_permissions role_permission
      join public.permissions permission on permission.id = role_permission.permission_id
      where role_permission.role_id = access.workspace_role_id
    ), '[]'::jsonb),
    'enabled_services', coalesce((
      select jsonb_agg(service.code order by service.code)
      from public.workspace_services workspace_service
      join public.service_catalog service on service.id = workspace_service.service_id and service.active
      where workspace_service.workspace_id = workspace.id
        and workspace_service.status in ('enabled', 'trial')
    ), '[]'::jsonb)
  )
  from public.workspaces workspace
  cross join access
  where workspace.id = target_workspace_id
    and (access.has_platform_access or access.workspace_role_id is not null);
$$;

alter table public.workspaces enable row level security;
alter table public.locations enable row level security;
alter table public.platform_users enable row level security;
alter table public.workspace_members enable row level security;
alter table public.service_catalog enable row level security;
alter table public.workspace_services enable row level security;

create policy workspaces_member_or_platform_select on public.workspaces
for select to authenticated
using (public.hanafy_has_platform_access() or public.hanafy_is_workspace_member(id));

create policy locations_member_or_platform_select on public.locations
for select to authenticated
using (public.hanafy_has_platform_access() or public.hanafy_is_workspace_member(workspace_id));

create policy platform_users_self_or_admin_select on public.platform_users
for select to authenticated
using (auth_user_id = auth.uid() or public.hanafy_is_platform_admin());

create policy workspace_members_member_or_platform_select on public.workspace_members
for select to authenticated
using (auth_user_id = auth.uid() or public.hanafy_has_platform_access() or public.hanafy_is_workspace_member(workspace_id));

create policy service_catalog_authenticated_select on public.service_catalog
for select to authenticated
using (auth.uid() is not null);

create policy workspace_services_member_or_platform_select on public.workspace_services
for select to authenticated
using (public.hanafy_has_platform_access() or public.hanafy_is_workspace_member(workspace_id));

revoke all on public.workspaces, public.locations, public.platform_users, public.workspace_members, public.service_catalog, public.workspace_services from anon;
revoke all on public.workspaces, public.locations, public.platform_users, public.workspace_members, public.service_catalog, public.workspace_services from authenticated;
grant select on public.workspaces, public.locations, public.platform_users, public.workspace_members, public.service_catalog, public.workspace_services to authenticated;

revoke all on function public.hanafy_has_platform_access() from public;
revoke all on function public.hanafy_is_platform_admin() from public;
revoke all on function public.hanafy_is_workspace_member(uuid) from public;
revoke all on function public.hanafy_has_workspace_permission(uuid, text) from public;
revoke all on function public.hanafy_workspace_service_enabled(uuid, text) from public;
revoke all on function public.hanafy_workspace_context(uuid) from public;
grant execute on function public.hanafy_has_platform_access() to authenticated;
grant execute on function public.hanafy_is_platform_admin() to authenticated;
grant execute on function public.hanafy_is_workspace_member(uuid) to authenticated;
grant execute on function public.hanafy_has_workspace_permission(uuid, text) to authenticated;
grant execute on function public.hanafy_workspace_service_enabled(uuid, text) to authenticated;
grant execute on function public.hanafy_workspace_context(uuid) to authenticated;

comment on table public.workspaces is 'Hanafy Platform tenant root. Existing operational tables are attached in later phases.';
comment on table public.locations is 'Workspace operating locations. Wayne''s Worcester is the only Phase 1 seed.';
comment on table public.platform_users is 'Explicit platform administration; workspace membership never grants platform access.';
comment on table public.workspace_members is 'Per-workspace staff membership reusing the established Wayne role and permission catalogue.';
comment on table public.workspace_services is 'Per-workspace service entitlement and configuration state.';
