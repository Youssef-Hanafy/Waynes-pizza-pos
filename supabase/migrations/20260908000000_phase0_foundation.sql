-- Wayne's Pizza POS — Phase 0 only: authentication, roles, permissions, and RLS.

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z_]*$'),
  name text not null,
  description text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z_.]*$'),
  description text not null default '',
  created_at timestamptz not null default now()
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  display_name text not null,
  role_id uuid not null references public.roles(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_role_id_idx on public.profiles(role_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger roles_set_updated_at
before update on public.roles
for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

insert into public.roles (id, code, name, description) values
  ('10000000-0000-4000-8000-000000000001', 'owner', 'Owner', 'Full business control'),
  ('10000000-0000-4000-8000-000000000002', 'manager', 'Manager', 'Daily operations and staff visibility'),
  ('10000000-0000-4000-8000-000000000003', 'cashier', 'Cashier', 'Front counter and phone orders'),
  ('10000000-0000-4000-8000-000000000004', 'kitchen', 'Kitchen', 'Kitchen display workflow'),
  ('10000000-0000-4000-8000-000000000005', 'driver', 'Driver', 'Assigned delivery workflow'),
  ('10000000-0000-4000-8000-000000000006', 'marketing_readonly', 'Marketing / Read Only', 'Read-only marketing visibility');

insert into public.permissions (id, code, description) values
  ('20000000-0000-4000-8000-000000000001', 'admin.access', 'Open the owner and manager administration area'),
  ('20000000-0000-4000-8000-000000000002', 'staff.view', 'View staff profiles'),
  ('20000000-0000-4000-8000-000000000003', 'staff.manage', 'Create and manage staff access'),
  ('20000000-0000-4000-8000-000000000004', 'settings.manage', 'Manage sensitive business settings'),
  ('20000000-0000-4000-8000-000000000005', 'pos.access', 'Use the front counter POS'),
  ('20000000-0000-4000-8000-000000000006', 'kitchen.access', 'Use the kitchen display'),
  ('20000000-0000-4000-8000-000000000007', 'driver.access', 'Use the driver workflow');

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
cross join public.permissions permission
where role.code = 'owner';

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code in ('admin.access', 'staff.view', 'pos.access', 'kitchen.access', 'driver.access')
where role.code = 'manager';

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on
  (role.code = 'cashier' and permission.code = 'pos.access') or
  (role.code = 'kitchen' and permission.code = 'kitchen.access') or
  (role.code = 'driver' and permission.code = 'driver.access');

create or replace function public.wayne_has_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.roles role on role.id = profile.role_id and role.active
    join public.role_permissions role_permission on role_permission.role_id = role.id
    join public.permissions permission on permission.id = role_permission.permission_id
    where profile.id = auth.uid()
      and profile.active
      and permission.code = required_permission
  );
$$;

create or replace function public.wayne_has_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.roles role on role.id = profile.role_id and role.active
    where profile.id = auth.uid()
      and profile.active
      and role.code = any(allowed_roles)
  );
$$;

create or replace function public.wayne_my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'profile_id', profile.id,
    'display_name', profile.display_name,
    'role', role.code,
    'permissions', coalesce(
      jsonb_agg(permission.code order by permission.code) filter (where permission.code is not null),
      '[]'::jsonb
    )
  )
  from public.profiles profile
  join public.roles role on role.id = profile.role_id and role.active
  left join public.role_permissions role_permission on role_permission.role_id = role.id
  left join public.permissions permission on permission.id = role_permission.permission_id
  where profile.id = auth.uid() and profile.active
  group by profile.id, profile.display_name, role.code;
$$;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_role_id uuid;
begin
  select id into default_role_id from public.roles where code = 'cashier' and active;
  if default_role_id is null then
    raise exception 'Default cashier role is missing';
  end if;

  insert into public.profiles (id, display_name, first_name, last_name, role_id, active)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email, 'Staff'), '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'first_name', ''),
    coalesce(new.raw_user_meta_data ->> 'last_name', ''),
    default_role_id,
    true
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.create_profile_for_new_user();

alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.profiles enable row level security;

create policy roles_authenticated_select on public.roles
for select to authenticated using (auth.uid() is not null);

create policy permissions_authenticated_select on public.permissions
for select to authenticated using (auth.uid() is not null);

create policy role_permissions_authenticated_select on public.role_permissions
for select to authenticated using (auth.uid() is not null);

create policy profiles_self_or_staff_view_select on public.profiles
for select to authenticated
using (id = auth.uid() or public.wayne_has_permission('staff.view'));

revoke all on public.roles, public.permissions, public.role_permissions, public.profiles from anon;
grant select on public.roles, public.permissions, public.role_permissions, public.profiles to authenticated;

revoke all on function public.wayne_has_permission(text) from public;
revoke all on function public.wayne_has_role(text[]) from public;
revoke all on function public.wayne_my_access() from public;
revoke all on function public.set_updated_at() from public;
revoke all on function public.create_profile_for_new_user() from public;
grant execute on function public.wayne_has_permission(text) to authenticated;
grant execute on function public.wayne_has_role(text[]) to authenticated;
grant execute on function public.wayne_my_access() to authenticated;

comment on table public.profiles is 'Phase 0 staff identity. Privileged role changes must use trusted server-side administration.';
