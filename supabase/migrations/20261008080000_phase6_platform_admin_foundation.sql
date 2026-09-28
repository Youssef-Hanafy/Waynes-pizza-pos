-- Hanafy Platform Phase 6: Platform Admin foundation.
--
-- Build sheet §8.1, §8.4, §11, §29, §30 and Phase 6 (§40):
--   * one server-side definition of "Hanafy platform staff" and what each
--     platform role may do in the console;
--   * NO invisible impersonation (§8.4).  Until now an active platform_owner /
--     platform_admin silently held every permission in every workspace.  From
--     this phase a platform user can act inside a business only during an
--     explicit, time-limited, reasoned support session for that one business,
--     and every row the support user causes in the audit log is stamped with
--     the session.  Wayne's staff can read their own business's sessions;
--   * a platform audit log (append-only) for console actions, mirrored into
--     the business's own audit log when the action changes that business;
--   * audit_log gains actor_type / reason / correlation_id / support session;
--   * service requirements (e.g. SMS needs CRM) and deliberate confirmation
--     before a business-critical service is turned off (§11.3 Services, §39);
--   * console RPCs: dashboard, workspace list, workspace detail, services,
--     users, health and audit.  All are SECURITY DEFINER, check the caller's
--     platform role themselves and never trust a client-supplied role.
--
-- Nothing here changes what a Wayne's member can do.  No platform user exists
-- on the live database yet, so no live access changes either.

-- ---------------------------------------------------------------------------
-- Platform roles
-- ---------------------------------------------------------------------------

-- The caller's active platform role, or null.
create or replace function public.hanafy_platform_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select platform_user.platform_role
  from public.platform_users platform_user
  where platform_user.auth_user_id = auth.uid() and platform_user.active;
$$;
revoke all on function public.hanafy_platform_role() from public, anon, authenticated;
grant execute on function public.hanafy_platform_role() to authenticated;

-- Raises unless the caller holds one of the given platform roles.
create or replace function public.hanafy_require_platform_role(allowed_roles text[])
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare caller_role text := public.hanafy_platform_role();
begin
  if auth.uid() is null or caller_role is null or not (caller_role = any(allowed_roles)) then
    raise exception 'Hanafy platform access required' using errcode = '42501';
  end if;
  return caller_role;
end;
$$;
revoke all on function public.hanafy_require_platform_role(text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Support sessions (§8.4)
-- ---------------------------------------------------------------------------
create table if not exists public.platform_support_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  platform_auth_user_id uuid references auth.users(id) on delete set null,
  platform_role text not null check (platform_role in ('platform_owner', 'platform_admin', 'platform_support')),
  actor_name text not null check (char_length(actor_name) between 1 and 200),
  reason text not null check (char_length(btrim(reason)) between 5 and 500),
  ticket_reference text check (ticket_reference is null or char_length(ticket_reference) between 1 and 120),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('ended', 'expired', 'revoked', 'replaced')),
  ended_by_auth_user_id uuid references auth.users(id) on delete set null,
  check (expires_at > started_at),
  check ((ended_at is null) = (end_reason is null))
);
create unique index if not exists platform_support_sessions_one_open_per_user
  on public.platform_support_sessions(platform_auth_user_id) where ended_at is null;
create index if not exists platform_support_sessions_workspace_idx
  on public.platform_support_sessions(workspace_id, started_at desc);

comment on table public.platform_support_sessions is
  'Phase 6 (§8.4): explicit, time-limited, reasoned Hanafy support access to one workspace. The only way a platform user acts inside a business.';

-- Role of the caller's live support session for this workspace, or null.
-- The session must be open and unexpired AND the platform user must still be
-- active with a support-capable role, so revoking a platform user ends their
-- access immediately.
create or replace function public.hanafy_support_session_role(target_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select platform_user.platform_role
  from public.platform_support_sessions support_session
  join public.platform_users platform_user
    on platform_user.auth_user_id = support_session.platform_auth_user_id
   and platform_user.active
   and platform_user.platform_role in ('platform_owner', 'platform_admin', 'platform_support')
  where support_session.platform_auth_user_id = auth.uid()
    and support_session.workspace_id = target_workspace_id
    and support_session.ended_at is null
    and support_session.expires_at > now()
  limit 1;
$$;
revoke all on function public.hanafy_support_session_role(uuid) from public, anon, authenticated;
-- Storage policies call it directly.
grant execute on function public.hanafy_support_session_role(uuid) to authenticated;

create or replace function public.hanafy_support_session_id(target_workspace_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select support_session.id
  from public.platform_support_sessions support_session
  where support_session.platform_auth_user_id = auth.uid()
    and support_session.workspace_id = target_workspace_id
    and support_session.ended_at is null
    and support_session.expires_at > now()
    and public.hanafy_support_session_role(target_workspace_id) is not null
  limit 1;
$$;
revoke all on function public.hanafy_support_session_id(uuid) from public, anon, authenticated;

-- What a support session may do.  platform_owner / platform_admin act with
-- the workspace's full entitled permission set; platform_support is
-- read-only.  Service entitlement is still applied on top by the callers.
create or replace function public.hanafy_support_permission_allowed(platform_role_value text, required_permission text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when platform_role_value in ('platform_owner', 'platform_admin') then true
    when platform_role_value = 'platform_support' then required_permission = any(array[
      'admin.access', 'orders.view', 'reports.view', 'customers.view', 'staff.view', 'audit.view'
    ])
    else false
  end;
$$;
revoke all on function public.hanafy_support_permission_allowed(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Permission predicates: platform users no longer hold silent access
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_has_workspace_permission(target_workspace_id uuid, required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_permission_entitled(target_workspace_id, required_permission)
  and (
    exists (
      select 1
      from public.workspace_members membership
      join public.roles role on role.id = membership.workspace_role_id and role.active
      join public.role_permissions role_permission on role_permission.role_id = role.id
      join public.permissions permission on permission.id = role_permission.permission_id
      where membership.workspace_id = target_workspace_id
        and membership.auth_user_id = auth.uid()
        and membership.status = 'active'
        and permission.code = required_permission
    )
    or public.hanafy_support_permission_allowed(public.hanafy_support_session_role(target_workspace_id), required_permission)
  );
$$;

-- The workspace-scoped legacy form now shares the one predicate.
create or replace function public.wayne_has_permission(target_workspace_id uuid, required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_has_workspace_permission(target_workspace_id, required_permission);
$$;

create or replace function public.hanafy_can_access_workspace_data(target_workspace_id uuid, required_permissions text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from unnest(required_permissions) required_permission(code)
    where public.hanafy_has_workspace_permission(target_workspace_id, required_permission.code)
  );
$$;

-- Effective permission list for a live support session.
create or replace function public.hanafy_support_permissions(target_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(permission.code order by permission.code), '[]'::jsonb)
  from public.permissions permission
  where public.hanafy_support_permission_allowed(public.hanafy_support_session_role(target_workspace_id), permission.code)
    and public.hanafy_permission_entitled(target_workspace_id, permission.code);
$$;
revoke all on function public.hanafy_support_permissions(uuid) from public, anon, authenticated;

-- Private storage: support-session scoped instead of a platform-wide bypass.
drop policy if exists hanafy_workspace_private_storage_select on storage.objects;
create policy hanafy_workspace_private_storage_select on storage.objects
for select to authenticated using (
  bucket_id = 'hanafy-workspace-private'
  and (
    public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name))
    or public.hanafy_support_session_role(public.hanafy_storage_workspace_id(name)) is not null
  )
);
drop policy if exists hanafy_workspace_private_storage_insert on storage.objects;
create policy hanafy_workspace_private_storage_insert on storage.objects
for insert to authenticated with check (
  bucket_id = 'hanafy-workspace-private'
  and (
    public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name))
    or public.hanafy_support_session_role(public.hanafy_storage_workspace_id(name)) in ('platform_owner', 'platform_admin')
  )
);
drop policy if exists hanafy_workspace_private_storage_update on storage.objects;
create policy hanafy_workspace_private_storage_update on storage.objects
for update to authenticated using (
  bucket_id = 'hanafy-workspace-private'
  and (
    public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name))
    or public.hanafy_support_session_role(public.hanafy_storage_workspace_id(name)) in ('platform_owner', 'platform_admin')
  )
) with check (
  bucket_id = 'hanafy-workspace-private'
  and (
    public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name))
    or public.hanafy_support_session_role(public.hanafy_storage_workspace_id(name)) in ('platform_owner', 'platform_admin')
  )
);
drop policy if exists hanafy_workspace_private_storage_delete on storage.objects;
create policy hanafy_workspace_private_storage_delete on storage.objects
for delete to authenticated using (
  bucket_id = 'hanafy-workspace-private'
  and (
    public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name))
    or public.hanafy_support_session_role(public.hanafy_storage_workspace_id(name)) in ('platform_owner', 'platform_admin')
  )
);

-- ---------------------------------------------------------------------------
-- Audit (§29)
-- ---------------------------------------------------------------------------
alter table public.audit_log
  add column if not exists actor_type text,
  add column if not exists reason text,
  add column if not exists correlation_id text,
  add column if not exists support_session_id uuid references public.platform_support_sessions(id) on delete restrict;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'audit_log_actor_type_check') then
    -- Null only on rows written before Phase 6 (the log is immutable, so they are not rewritten).
    alter table public.audit_log add constraint audit_log_actor_type_check
      check (actor_type is null or actor_type in ('workspace_user', 'platform_user', 'system'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'audit_log_reason_check') then
    alter table public.audit_log add constraint audit_log_reason_check check (reason is null or char_length(reason) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'audit_log_correlation_id_check') then
    alter table public.audit_log add constraint audit_log_correlation_id_check check (correlation_id is null or char_length(correlation_id) <= 120);
  end if;
end $$;
create index if not exists audit_log_support_session_idx on public.audit_log(support_session_id) where support_session_id is not null;

-- Stamp who really acted.  Runs after the legacy scope default (aa_) and
-- before the scope enforcement (zz_).
create or replace function public.hanafy_stamp_audit_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare session_id uuid;
begin
  if new.actor_type is not null then return new; end if;
  if new.actor_user_id is null then
    new.actor_type := 'system';
    return new;
  end if;
  if new.actor_user_id = auth.uid() then
    session_id := public.hanafy_support_session_id(new.workspace_id);
  end if;
  if session_id is not null and not public.hanafy_is_workspace_member(new.workspace_id) then
    new.actor_type := 'platform_user';
    new.support_session_id := session_id;
    new.actor_name := left(new.actor_name, 170) || ' (Hanafy support)';
  elsif new.actor_user_id = auth.uid()
    and public.hanafy_platform_role() is not null
    and not public.hanafy_is_workspace_member(new.workspace_id) then
    new.actor_type := 'platform_user';
    new.actor_name := left(new.actor_name, 180) || ' (Hanafy)';
  else
    new.actor_type := 'workspace_user';
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_stamp_audit_actor() from public, anon, authenticated;
drop trigger if exists ab_hanafy_stamp_audit_actor on public.audit_log;
create trigger ab_hanafy_stamp_audit_actor before insert on public.audit_log
for each row execute function public.hanafy_stamp_audit_actor();

create table if not exists public.platform_audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_auth_user_id uuid references auth.users(id) on delete set null,
  actor_name text not null check (char_length(actor_name) between 1 and 200),
  actor_type text not null check (actor_type in ('platform_user', 'system')),
  actor_role text,
  action text not null check (action ~ '^[a-z][a-z_]*(\.[a-z_]+)+$'),
  workspace_id uuid references public.workspaces(id) on delete restrict,
  resource_type text not null check (char_length(resource_type) between 1 and 80),
  resource_id text check (resource_id is null or char_length(resource_id) <= 200),
  summary text not null check (char_length(summary) between 1 and 500),
  before_data jsonb,
  after_data jsonb,
  reason text check (reason is null or char_length(reason) <= 500),
  correlation_id text check (correlation_id is null or char_length(correlation_id) <= 120),
  support_session_id uuid references public.platform_support_sessions(id) on delete restrict
);
create index if not exists platform_audit_log_occurred_idx on public.platform_audit_log(occurred_at desc);
create index if not exists platform_audit_log_workspace_idx on public.platform_audit_log(workspace_id, occurred_at desc);

drop trigger if exists platform_audit_log_immutable on public.platform_audit_log;
create trigger platform_audit_log_immutable before update or delete on public.platform_audit_log
for each row execute function public.wayne_prevent_audit_mutation();
drop trigger if exists platform_audit_log_no_truncate on public.platform_audit_log;
create trigger platform_audit_log_no_truncate before truncate on public.platform_audit_log
for each statement execute function public.wayne_prevent_audit_mutation();

comment on table public.platform_audit_log is 'Phase 6 (§29): append-only log of Hanafy Platform Admin actions. Written only by platform RPCs.';

-- Writes one platform audit row and, when the action changes a business
-- that has a location, the same event into that business's own audit log.
create or replace function public.hanafy_platform_write_audit(
  action_value text,
  target_workspace_id uuid,
  resource_type_value text,
  resource_id_value text,
  summary_value text,
  before_value jsonb default null,
  after_value jsonb default null,
  reason_value text default null,
  support_session_value uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role_value text := public.hanafy_platform_role();
  actor_label text;
  primary_location uuid;
  correlation text := gen_random_uuid()::text;
begin
  if actor is not null then
    select coalesce(nullif(btrim(profile.display_name), ''), split_part(auth_user.email, '@', 1), 'Hanafy staff')
    into actor_label
    from auth.users auth_user
    left join public.profiles profile on profile.id = auth_user.id
    where auth_user.id = actor;
  end if;
  actor_label := coalesce(actor_label, case when actor is null then 'System' else 'Hanafy staff' end);

  insert into public.platform_audit_log (
    actor_auth_user_id, actor_name, actor_type, actor_role, action, workspace_id, resource_type,
    resource_id, summary, before_data, after_data, reason, correlation_id, support_session_id
  ) values (
    actor, actor_label, case when actor is null then 'system' else 'platform_user' end, actor_role_value,
    action_value, target_workspace_id, resource_type_value, left(resource_id_value, 200), left(summary_value, 500),
    before_value, after_value, left(reason_value, 500), correlation, support_session_value
  );

  if target_workspace_id is not null then
    select location.id into primary_location
    from public.locations location
    where location.workspace_id = target_workspace_id
    order by (location.status in ('provisioning', 'active')) desc, location.created_at, location.id
    limit 1;
    if primary_location is not null then
      insert into public.audit_log (
        workspace_id, location_id, actor_user_id, actor_name, actor_type, action, entity_type, entity_id,
        summary, changes, metadata, reason, correlation_id, support_session_id
      ) values (
        target_workspace_id, primary_location, actor, left(actor_label, 180) || ' (Hanafy)', 'platform_user',
        action_value, resource_type_value, left(resource_id_value, 200), left(summary_value, 500),
        case when before_value is null and after_value is null then '{}'::jsonb
             else jsonb_build_object('from', before_value, 'to', after_value) end,
        jsonb_build_object('source', 'hanafy_platform_admin', 'platform_role', actor_role_value),
        left(reason_value, 500), correlation, support_session_value
      );
    end if;
  end if;
end;
$$;
revoke all on function public.hanafy_platform_write_audit(text, uuid, text, text, text, jsonb, jsonb, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS for the new tables
-- ---------------------------------------------------------------------------
alter table public.platform_support_sessions enable row level security;
revoke all on public.platform_support_sessions from anon, authenticated;
grant select on public.platform_support_sessions to authenticated;
drop policy if exists platform_support_sessions_read on public.platform_support_sessions;
-- Platform staff see all sessions; a business sees the sessions opened on it.
create policy platform_support_sessions_read on public.platform_support_sessions
for select to authenticated using (
  public.hanafy_has_platform_access()
  or public.hanafy_has_workspace_permission(workspace_id, 'audit.view')
);

alter table public.platform_audit_log enable row level security;
revoke all on public.platform_audit_log from anon, authenticated;
grant select on public.platform_audit_log to authenticated;
drop policy if exists platform_audit_log_platform_read on public.platform_audit_log;
create policy platform_audit_log_platform_read on public.platform_audit_log
for select to authenticated using (public.hanafy_has_platform_access());

-- ---------------------------------------------------------------------------
-- Service requirements (§11.3 Services: "prevent accidental removal when
-- dependent features exist")
-- ---------------------------------------------------------------------------
create table if not exists public.service_requirements (
  service_code text primary key references public.service_catalog(code) on delete cascade,
  -- At least one of these must be active while the service is active.
  requires_any text[] not null check (cardinality(requires_any) between 1 and 12),
  note text not null check (char_length(note) between 1 and 300),
  created_at timestamptz not null default now()
);
alter table public.service_requirements enable row level security;
revoke all on public.service_requirements from anon, authenticated;
grant select on public.service_requirements to authenticated;
drop policy if exists service_requirements_authenticated_read on public.service_requirements;
create policy service_requirements_authenticated_read on public.service_requirements
for select to authenticated using (auth.uid() is not null);

insert into public.service_requirements (service_code, requires_any, note)
select requirement.service_code, requirement.requires_any, requirement.note
from (values
  ('sms', array['crm'], 'Texts are sent by the Hanafy CRM.'),
  ('email', array['crm'], 'Email is sent by the Hanafy CRM.'),
  ('automations', array['crm'], 'Automations run in the Hanafy CRM.'),
  ('caller_id', array['pos'], 'Caller ID pops the customer on the register.'),
  ('delivery', array['pos', 'online_ordering'], 'Delivery needs orders from the register or online ordering.')
) as requirement(service_code, requires_any, note)
where exists (select 1 from public.service_catalog service where service.code = requirement.service_code)
on conflict (service_code) do update set requires_any = excluded.requires_any, note = excluded.note;

-- ---------------------------------------------------------------------------
-- Workspace context: platform staff see the business, act only in support
-- ---------------------------------------------------------------------------
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
      public.hanafy_support_session_id(target_workspace_id) as support_session_id,
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
    'workspace_status', workspace.status,
    'workspace_role', access.workspace_role,
    'has_platform_access', access.has_platform_access,
    'is_platform_admin', access.is_platform_admin,
    'permissions', case
      when access.workspace_role_id is not null then public.hanafy_entitled_permissions(workspace.id, access.workspace_role_id)
      when access.support_session_id is not null then public.hanafy_support_permissions(workspace.id)
      else '[]'::jsonb
    end,
    'enabled_services', public.hanafy_active_services(workspace.id),
    'legacy_operations', workspace.id = public.hanafy_legacy_workspace_id(),
    'support_session', case when access.workspace_role_id is null and access.support_session_id is not null then (
      select jsonb_build_object('id', support_session.id, 'expires_at', support_session.expires_at,
        'platform_role', support_session.platform_role, 'reason', support_session.reason)
      from public.platform_support_sessions support_session where support_session.id = access.support_session_id
    ) end
  )
  from public.workspaces workspace
  cross join access
  where workspace.id = target_workspace_id
    and (access.has_platform_access or access.workspace_role_id is not null);
$$;

-- Trusted access for /admin, /pos, … : a membership, or — only for the
-- explicitly named workspace — the caller's live support session.
create or replace function public.hanafy_current_workspace_access(target_workspace_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with active_memberships as (
    select membership.workspace_id, membership.workspace_role_id, workspace.slug
    from public.workspace_members membership
    join public.workspaces workspace on workspace.id = membership.workspace_id
      and workspace.status in ('provisioning', 'active')
    where membership.auth_user_id = auth.uid()
      and membership.status = 'active'
  ), selected_membership as (
    select membership.*
    from active_memberships membership
    where (target_workspace_slug is not null and membership.slug = target_workspace_slug)
       or (target_workspace_slug is null and (select count(*) from active_memberships) = 1)
  ), member_access as (
    select jsonb_build_object(
      'profile_id', profile.id,
      'display_name', profile.display_name,
      'role', role.code,
      'permissions', public.hanafy_entitled_permissions(workspace.id, selected_membership.workspace_role_id),
      'workspace_id', workspace.id,
      'workspace_slug', workspace.slug,
      'workspace_name', workspace.name,
      'location_id', (
        select location.id from public.locations location
        where location.workspace_id = workspace.id and location.status in ('provisioning', 'active')
        order by location.created_at, location.id limit 1
      ),
      'enabled_services', public.hanafy_active_services(workspace.id),
      'legacy_operations', workspace.id = public.hanafy_legacy_workspace_id(),
      'membership_count', (select count(*) from active_memberships)
    ) as access
    from selected_membership
    join public.workspaces workspace on workspace.id = selected_membership.workspace_id
    join public.profiles profile on profile.id = auth.uid() and profile.active
    join public.roles role on role.id = selected_membership.workspace_role_id and role.active
  ), support_access as (
    select jsonb_build_object(
      'profile_id', auth_user.id,
      'display_name', coalesce(nullif(btrim(profile.display_name), ''), split_part(auth_user.email, '@', 1), 'Hanafy staff') || ' (Hanafy support)',
      'role', 'hanafy_support',
      'permissions', public.hanafy_support_permissions(workspace.id),
      'workspace_id', workspace.id,
      'workspace_slug', workspace.slug,
      'workspace_name', workspace.name,
      'location_id', (
        select location.id from public.locations location
        where location.workspace_id = workspace.id and location.status in ('provisioning', 'active')
        order by location.created_at, location.id limit 1
      ),
      'enabled_services', public.hanafy_active_services(workspace.id),
      'legacy_operations', workspace.id = public.hanafy_legacy_workspace_id(),
      'membership_count', (select count(*) from active_memberships),
      'support_session', jsonb_build_object(
        'id', support_session.id,
        'expires_at', support_session.expires_at,
        'platform_role', support_session.platform_role,
        'reason', support_session.reason
      )
    ) as access
    from public.workspaces workspace
    join public.platform_support_sessions support_session
      on support_session.id = public.hanafy_support_session_id(workspace.id)
    join auth.users auth_user on auth_user.id = auth.uid()
    left join public.profiles profile on profile.id = auth_user.id
    where target_workspace_slug is not null
      and workspace.slug = target_workspace_slug
      and workspace.status in ('provisioning', 'active', 'suspended')
      and not exists (select 1 from selected_membership)
  )
  select access from member_access
  union all
  select access from support_access
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Console reads
-- ---------------------------------------------------------------------------

-- Who the caller is on the platform (null for everyone else).
create or replace function public.hanafy_platform_me()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'auth_user_id', auth_user.id,
    'email', auth_user.email,
    'display_name', coalesce(nullif(btrim(profile.display_name), ''), split_part(auth_user.email, '@', 1), 'Hanafy staff'),
    'platform_role', platform_user.platform_role,
    'can_manage', platform_user.platform_role in ('platform_owner', 'platform_admin'),
    'can_support', platform_user.platform_role in ('platform_owner', 'platform_admin', 'platform_support'),
    'support_session', (
      select jsonb_build_object('id', support_session.id, 'workspace_id', workspace.id, 'workspace_slug', workspace.slug,
        'workspace_name', workspace.name, 'expires_at', support_session.expires_at, 'reason', support_session.reason)
      from public.platform_support_sessions support_session
      join public.workspaces workspace on workspace.id = support_session.workspace_id
      where support_session.platform_auth_user_id = auth_user.id
        and support_session.ended_at is null and support_session.expires_at > now()
      limit 1
    )
  )
  from public.platform_users platform_user
  join auth.users auth_user on auth_user.id = platform_user.auth_user_id
  left join public.profiles profile on profile.id = auth_user.id
  where platform_user.auth_user_id = auth.uid() and platform_user.active;
$$;
revoke all on function public.hanafy_platform_me() from public, anon, authenticated;
grant execute on function public.hanafy_platform_me() to authenticated;

-- The caller's live support session on any workspace (for the banner), or null.
create or replace function public.hanafy_my_support_session()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', support_session.id, 'workspace_id', workspace.id, 'workspace_slug', workspace.slug,
    'workspace_name', workspace.name, 'expires_at', support_session.expires_at, 'reason', support_session.reason,
    'platform_role', support_session.platform_role)
  from public.platform_support_sessions support_session
  join public.workspaces workspace on workspace.id = support_session.workspace_id
  where support_session.platform_auth_user_id = auth.uid()
    and support_session.ended_at is null
    and support_session.expires_at > now()
    and public.hanafy_support_session_role(workspace.id) is not null
  limit 1;
$$;
revoke all on function public.hanafy_my_support_session() from public, anon, authenticated;
grant execute on function public.hanafy_my_support_session() to authenticated;

-- Health signals for one workspace (§30).  Counts and timestamps only.
create or replace function public.hanafy_platform_workspace_health(target_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  outbox_pending integer;
  outbox_failed integer;
  outbox_oldest timestamptz;
  outbox_last_delivered timestamptz;
  outbox_last_error text;
  print_failed_24h integer;
  print_stuck integer;
  webhook_errors_7d integer;
  last_order timestamptz;
  orders_24h integer;
  last_ring timestamptz;
  sms_on boolean := public.hanafy_service_active(target_workspace_id, 'sms');
  crm_on boolean := public.hanafy_service_active(target_workspace_id, 'crm');
  sms_identity boolean;
  issues jsonb := '[]'::jsonb;
  level text := 'ok';
begin
  select count(*) filter (where outbox.status in ('pending', 'processing')),
         count(*) filter (where outbox.status = 'failed'),
         min(outbox.created_at) filter (where outbox.status in ('pending', 'processing')),
         max(outbox.delivered_at)
  into outbox_pending, outbox_failed, outbox_oldest, outbox_last_delivered
  from public.integration_outbox outbox where outbox.workspace_id = target_workspace_id;
  select left(outbox.last_error, 200) into outbox_last_error
  from public.integration_outbox outbox
  where outbox.workspace_id = target_workspace_id and outbox.status <> 'delivered' and outbox.last_error is not null
  order by outbox.created_at desc limit 1;

  select count(*) filter (where job.status = 'failed' and job.updated_at > now() - interval '24 hours'),
         count(*) filter (where job.status in ('pending', 'processing') and job.created_at < now() - interval '10 minutes')
  into print_failed_24h, print_stuck
  from public.print_jobs job where job.workspace_id = target_workspace_id;

  select count(*) into webhook_errors_7d from public.payment_webhook_events event
  where event.workspace_id = target_workspace_id and event.received_at > now() - interval '7 days'
    and (event.processing_error is not null or not event.signature_verified);

  select max(orders.created_at), count(*) filter (where orders.created_at > now() - interval '24 hours')
  into last_order, orders_24h
  from public.orders orders where orders.workspace_id = target_workspace_id;

  select max(call.started_at) into last_ring from public.phone_calls call
  where call.workspace_id = target_workspace_id and not coalesce(call.simulated, false);

  select exists (select 1 from public.workspace_messaging_identities identity
    where identity.workspace_id = target_workspace_id and identity.channel = 'sms' and identity.active)
  into sms_identity;

  if outbox_failed > 0 then
    issues := issues || jsonb_build_object('severity', 'alert', 'code', 'outbox_failed', 'message', outbox_failed || ' CRM event(s) failed to deliver');
  end if;
  if outbox_pending > 0 and outbox_oldest < now() - interval '15 minutes' then
    issues := issues || jsonb_build_object('severity', case when crm_on then 'alert' else 'warn' end, 'code', 'outbox_backlog',
      'message', outbox_pending || ' CRM event(s) waiting' || case when crm_on then ' longer than 15 minutes' else ' (CRM is off; they send when it is turned on)' end);
  end if;
  if print_failed_24h > 0 then
    issues := issues || jsonb_build_object('severity', 'warn', 'code', 'print_failed', 'message', print_failed_24h || ' print job(s) failed in the last 24 hours');
  end if;
  if print_stuck > 0 then
    issues := issues || jsonb_build_object('severity', 'warn', 'code', 'print_stuck', 'message', print_stuck || ' print job(s) waiting more than 10 minutes');
  end if;
  if webhook_errors_7d > 0 then
    issues := issues || jsonb_build_object('severity', 'alert', 'code', 'payment_webhook', 'message', webhook_errors_7d || ' payment webhook problem(s) in the last 7 days');
  end if;
  if sms_on and not sms_identity then
    issues := issues || jsonb_build_object('severity', 'alert', 'code', 'sms_identity', 'message', 'SMS is on but no active SMS number is set');
  end if;
  if sms_on and not crm_on then
    issues := issues || jsonb_build_object('severity', 'warn', 'code', 'sms_without_crm', 'message', 'SMS is on but CRM is off, so texts cannot send');
  end if;

  if exists (select 1 from jsonb_array_elements(issues) issue where issue ->> 'severity' = 'alert') then level := 'alert';
  elsif jsonb_array_length(issues) > 0 then level := 'warn';
  end if;

  return jsonb_build_object(
    'level', level,
    'issues', issues,
    'outbox', jsonb_build_object('pending', outbox_pending, 'failed', outbox_failed, 'oldest_pending_at', outbox_oldest,
      'last_delivered_at', outbox_last_delivered, 'last_error', outbox_last_error, 'crm_enabled', crm_on),
    'printing', jsonb_build_object('failed_24h', print_failed_24h, 'stuck', print_stuck),
    'payments', jsonb_build_object('webhook_problems_7d', webhook_errors_7d),
    'orders', jsonb_build_object('last_order_at', last_order, 'last_24h', orders_24h),
    'caller_id', jsonb_build_object('last_ring_at', last_ring)
  );
end;
$$;
revoke all on function public.hanafy_platform_workspace_health(uuid) from public, anon, authenticated;

-- One row per business for the list and the dashboard.
create or replace function public.hanafy_platform_workspace_summary(target_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', workspace.id,
    'slug', workspace.slug,
    'name', workspace.name,
    'status', workspace.status,
    'created_at', workspace.created_at,
    'primary_location', (
      select jsonb_build_object('id', location.id, 'name', location.name, 'city', location.city,
        'state_region', location.state_region, 'status', location.status)
      from public.locations location where location.workspace_id = workspace.id
      order by (location.status in ('provisioning', 'active')) desc, location.created_at, location.id limit 1
    ),
    'location_count', (select count(*) from public.locations location where location.workspace_id = workspace.id),
    'services', public.hanafy_active_services(workspace.id),
    'owner', (
      select jsonb_build_object('name', coalesce(nullif(btrim(profile.display_name), ''), split_part(auth_user.email, '@', 1)), 'email', auth_user.email)
      from public.workspace_members membership
      join public.roles role on role.id = membership.workspace_role_id and role.code = 'owner'
      join auth.users auth_user on auth_user.id = membership.auth_user_id
      left join public.profiles profile on profile.id = membership.auth_user_id
      where membership.workspace_id = workspace.id and membership.status = 'active'
      order by membership.created_at limit 1
    ),
    'member_count', (select count(*) from public.workspace_members membership
      where membership.workspace_id = workspace.id and membership.status = 'active'),
    'messaging', (
      select jsonb_build_object('channel', identity.channel, 'sender_address', identity.sender_address,
        'provider', identity.provider, 'active', identity.active)
      from public.workspace_messaging_identities identity
      where identity.workspace_id = workspace.id and identity.channel = 'sms'
      order by identity.active desc, identity.updated_at desc limit 1
    ),
    'payment', (
      select jsonb_build_object('provider', config.provider, 'environment', config.environment,
        'online_card_enabled', config.online_card_enabled, 'terminal_card_enabled', config.terminal_card_enabled)
      from public.location_payment_configurations config
      where config.workspace_id = workspace.id
      order by config.updated_at desc limit 1
    ),
    'hardware', jsonb_build_object(
      'registers', (select count(*) from public.registers register where register.workspace_id = workspace.id and register.active),
      'caller_lines', (select count(*) from public.location_caller_lines line where line.workspace_id = workspace.id)
    ),
    'health', public.hanafy_platform_workspace_health(workspace.id),
    'billing', null
  )
  from public.workspaces workspace
  where workspace.id = target_workspace_id;
$$;
revoke all on function public.hanafy_platform_workspace_summary(uuid) from public, anon, authenticated;

create or replace function public.hanafy_platform_workspaces()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only']);
  return coalesce((
    select jsonb_agg(public.hanafy_platform_workspace_summary(workspace.id) order by workspace.name)
    from public.workspaces workspace
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.hanafy_platform_workspaces() from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspaces() to authenticated;

create or replace function public.hanafy_platform_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  summaries jsonb;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only']);
  summaries := public.hanafy_platform_workspaces();

  return jsonb_build_object(
    'workspaces', jsonb_build_object(
      'total', (select count(*) from public.workspaces),
      'active', (select count(*) from public.workspaces where status = 'active'),
      'provisioning', (select count(*) from public.workspaces where status = 'provisioning'),
      'suspended', (select count(*) from public.workspaces where status = 'suspended'),
      'archived', (select count(*) from public.workspaces where status = 'archived')
    ),
    -- Aggregates only: no customer rows leave their business here.
    'totals', jsonb_build_object(
      'customers', (select count(*) from public.customers where removed_at is null),
      'orders_24h', (select count(*) from public.orders where created_at > now() - interval '24 hours'),
      'members', (select count(*) from public.workspace_members where status = 'active'),
      'platform_users', (select count(*) from public.platform_users where active)
    ),
    'workspace_rows', summaries,
    'issues', coalesce((
      select jsonb_agg(issue || jsonb_build_object('workspace_slug', summary ->> 'slug', 'workspace_name', summary ->> 'name')
        order by (issue ->> 'severity') = 'alert' desc, summary ->> 'name')
      from jsonb_array_elements(summaries) summary
      cross join lateral jsonb_array_elements(summary -> 'health' -> 'issues') issue
    ), '[]'::jsonb),
    'support_sessions', coalesce((
      select jsonb_agg(jsonb_build_object('id', support_session.id, 'workspace_slug', workspace.slug,
          'workspace_name', workspace.name, 'actor_name', support_session.actor_name,
          'platform_role', support_session.platform_role, 'reason', support_session.reason,
          'started_at', support_session.started_at, 'expires_at', support_session.expires_at)
        order by support_session.started_at desc)
      from public.platform_support_sessions support_session
      join public.workspaces workspace on workspace.id = support_session.workspace_id
      where support_session.ended_at is null and support_session.expires_at > now()
    ), '[]'::jsonb),
    'recent_audit', coalesce((
      select jsonb_agg(entry order by (entry ->> 'occurred_at') desc)
      from (
        select jsonb_build_object('id', log.id, 'occurred_at', log.occurred_at, 'actor_name', log.actor_name,
          'action', log.action, 'summary', log.summary, 'workspace_name', workspace.name, 'workspace_slug', workspace.slug) as entry
        from public.platform_audit_log log
        left join public.workspaces workspace on workspace.id = log.workspace_id
        order by log.occurred_at desc, log.id desc limit 15
      ) recent
    ), '[]'::jsonb),
    -- Hanafy billing and equipment balances arrive in Phase 11.
    'billing', null
  );
end;
$$;
revoke all on function public.hanafy_platform_dashboard() from public, anon, authenticated;
grant execute on function public.hanafy_platform_dashboard() to authenticated;

create or replace function public.hanafy_platform_workspace_detail(target_workspace_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only']);
  select * into target from public.workspaces where slug = target_workspace_slug;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;

  return public.hanafy_platform_workspace_summary(target.id) || jsonb_build_object(
    'timezone', target.timezone,
    'currency_code', target.currency_code,
    'locations', coalesce((
      select jsonb_agg(jsonb_build_object('id', location.id, 'slug', location.slug, 'name', location.name,
        'status', location.status, 'city', location.city, 'state_region', location.state_region,
        'phone_number', location.phone_number, 'timezone', location.timezone) order by location.created_at, location.id)
      from public.locations location where location.workspace_id = target.id
    ), '[]'::jsonb),
    'domains', coalesce((
      select jsonb_agg(jsonb_build_object('hostname', domain.hostname, 'is_canonical', domain.is_canonical, 'active', domain.active)
        order by domain.is_canonical desc, domain.hostname)
      from public.workspace_domains domain where domain.workspace_id = target.id
    ), '[]'::jsonb),
    'service_catalog', coalesce((
      select jsonb_agg(jsonb_build_object(
          'code', service.code,
          'name', service.name,
          'description', service.description,
          'catalog_active', service.active,
          'status', coalesce(workspace_service.status, 'disabled'),
          'source', workspace_service.source,
          'starts_at', workspace_service.starts_at,
          'ends_at', workspace_service.ends_at,
          'enabled_at', workspace_service.enabled_at,
          'disabled_at', workspace_service.disabled_at,
          'updated_at', workspace_service.updated_at,
          'effective', public.hanafy_service_active(target.id, service.code),
          'requires_any', coalesce((select to_jsonb(requirement.requires_any) from public.service_requirements requirement where requirement.service_code = service.code), '[]'::jsonb),
          'requirement_note', (select requirement.note from public.service_requirements requirement where requirement.service_code = service.code),
          'required_by', coalesce((select jsonb_agg(requirement.service_code order by requirement.service_code) from public.service_requirements requirement where service.code = any(requirement.requires_any)), '[]'::jsonb),
          'permissions', coalesce((select jsonb_agg(permission.code order by permission.code) from public.service_permissions mapping
            join public.permissions permission on permission.id = mapping.permission_id where mapping.service_id = service.id), '[]'::jsonb)
        ) order by service.name)
      from public.service_catalog service
      left join public.workspace_services workspace_service
        on workspace_service.service_id = service.id and workspace_service.workspace_id = target.id
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'customers', (select count(*) from public.customers customer where customer.workspace_id = target.id and customer.removed_at is null),
      'orders_total', (select count(*) from public.orders orders where orders.workspace_id = target.id),
      'orders_30d', (select count(*) from public.orders orders where orders.workspace_id = target.id and orders.created_at > now() - interval '30 days')
    ),
    'messaging_identities', coalesce((
      select jsonb_agg(jsonb_build_object('channel', identity.channel, 'sender_name', identity.sender_name,
        'sender_address', identity.sender_address, 'provider', identity.provider, 'active', identity.active,
        'updated_at', identity.updated_at) order by identity.channel, identity.active desc)
      from public.workspace_messaging_identities identity where identity.workspace_id = target.id
    ), '[]'::jsonb),
    'payment_configurations', coalesce((
      select jsonb_agg(jsonb_build_object('location_id', config.location_id, 'provider', config.provider,
        'environment', config.environment, 'provider_location_id', config.provider_location_id,
        'online_card_enabled', config.online_card_enabled, 'terminal_card_enabled', config.terminal_card_enabled,
        'updated_at', config.updated_at))
      from public.location_payment_configurations config where config.workspace_id = target.id
    ), '[]'::jsonb),
    'last_card_payment_at', (select max(payment.created_at) from public.payments payment where payment.workspace_id = target.id),
    'support_sessions', coalesce((
      select jsonb_agg(entry order by (entry ->> 'started_at') desc)
      from (
        select jsonb_build_object('id', support_session.id, 'actor_name', support_session.actor_name,
          'platform_role', support_session.platform_role, 'reason', support_session.reason,
          'ticket_reference', support_session.ticket_reference, 'started_at', support_session.started_at,
          'expires_at', support_session.expires_at, 'ended_at', support_session.ended_at,
          'end_reason', support_session.end_reason,
          'live', support_session.ended_at is null and support_session.expires_at > now(),
          'actions', (select count(*) from public.audit_log log where log.support_session_id = support_session.id and log.action not like 'platform.support\_%')) as entry
        from public.platform_support_sessions support_session
        where support_session.workspace_id = target.id
        order by support_session.started_at desc limit 20
      ) recent
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.hanafy_platform_workspace_detail(text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspace_detail(text) to authenticated;

create or replace function public.hanafy_platform_workspace_members(target_workspace_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only']);
  select * into target from public.workspaces where slug = target_workspace_slug;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;

  return jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'auth_user_id', membership.auth_user_id,
          'email', auth_user.email,
          'display_name', coalesce(nullif(btrim(profile.display_name), ''), split_part(auth_user.email, '@', 1)),
          'role', role.code,
          'role_name', role.name,
          'status', membership.status,
          'last_sign_in_at', auth_user.last_sign_in_at,
          'joined_at', membership.created_at,
          'is_platform_user', exists (select 1 from public.platform_users platform_user where platform_user.auth_user_id = membership.auth_user_id and platform_user.active)
        ) order by (membership.status = 'active') desc, (role.code = 'owner') desc, lower(coalesce(profile.display_name, auth_user.email)))
      from public.workspace_members membership
      join auth.users auth_user on auth_user.id = membership.auth_user_id
      join public.roles role on role.id = membership.workspace_role_id
      left join public.profiles profile on profile.id = membership.auth_user_id
      where membership.workspace_id = target.id
    ), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('code', role.code, 'name', role.name, 'description', role.description,
        'permissions', coalesce((select jsonb_agg(permission.code order by permission.code) from public.role_permissions role_permission
          join public.permissions permission on permission.id = role_permission.permission_id where role_permission.role_id = role.id), '[]'::jsonb))
        order by case role.code when 'owner' then 0 when 'manager' then 1 else 2 end, role.name)
      from public.roles role where role.active
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.hanafy_platform_workspace_members(text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspace_members(text) to authenticated;

-- Audit for one business: the business's own log (summaries only; field
-- changes can hold customer data) plus console actions on it.
create or replace function public.hanafy_platform_workspace_audit(target_workspace_slug text, max_rows integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  row_limit integer := least(greatest(coalesce(max_rows, 100), 1), 500);
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support', 'platform_read_only']);
  select * into target from public.workspaces where slug = target_workspace_slug;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;

  return jsonb_build_object(
    'workspace', coalesce((
      select jsonb_agg(entry order by (entry ->> 'occurred_at') desc, (entry ->> 'id')::bigint desc)
      from (
        select jsonb_build_object('id', log.id, 'occurred_at', log.occurred_at, 'actor_name', log.actor_name,
          'actor_type', coalesce(log.actor_type, case when log.actor_user_id is null then 'system' else 'workspace_user' end),
          'action', log.action, 'entity_type', log.entity_type, 'summary', log.summary,
          'reason', log.reason, 'support_session_id', log.support_session_id) as entry
        from public.audit_log log
        where log.workspace_id = target.id
        order by log.occurred_at desc, log.id desc
        limit row_limit
      ) recent
    ), '[]'::jsonb),
    'platform', coalesce((
      select jsonb_agg(entry order by (entry ->> 'occurred_at') desc, (entry ->> 'id')::bigint desc)
      from (
        select jsonb_build_object('id', log.id, 'occurred_at', log.occurred_at, 'actor_name', log.actor_name,
          'actor_role', log.actor_role, 'action', log.action, 'summary', log.summary, 'reason', log.reason,
          'before_data', log.before_data, 'after_data', log.after_data, 'support_session_id', log.support_session_id) as entry
        from public.platform_audit_log log
        where log.workspace_id = target.id
        order by log.occurred_at desc, log.id desc
        limit row_limit
      ) recent
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.hanafy_platform_workspace_audit(text, integer) from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspace_audit(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Console writes
-- ---------------------------------------------------------------------------

-- Turn a service on/off (or trial / suspend) for a business.
-- Returns {status: 'saved'} or {status: 'needs_confirmation', warnings: [...]}.
create or replace function public.hanafy_platform_set_service(
  target_workspace_slug text,
  service_code text,
  new_status text,
  new_source text,
  new_starts_at timestamptz,
  new_ends_at timestamptz,
  change_reason text,
  confirmed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  service public.service_catalog%rowtype;
  current_row public.workspace_services%rowtype;
  was_effective boolean;
  will_be_effective boolean;
  clean_reason text := nullif(btrim(coalesce(change_reason, '')), '');
  missing_requirement text[];
  dependents text[];
  warnings jsonb := '[]'::jsonb;
  open_count integer;
  before_value jsonb;
  after_value jsonb;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if new_status not in ('enabled', 'trial', 'disabled', 'suspended') then
    raise exception 'Choose enabled, trial, disabled or suspended' using errcode = '22023';
  end if;
  if coalesce(new_source, 'manual') not in ('plan', 'manual', 'custom_contract') then
    raise exception 'Choose plan, manual or custom contract' using errcode = '22023';
  end if;
  if new_starts_at is not null and new_ends_at is not null and new_ends_at <= new_starts_at then
    raise exception 'The end date must be after the start date' using errcode = '22023';
  end if;
  if clean_reason is null or char_length(clean_reason) < 3 then
    raise exception 'Give a reason for the change' using errcode = '22023';
  end if;
  if char_length(clean_reason) > 500 then raise exception 'Keep the reason under 500 characters' using errcode = '22023'; end if;

  select * into target from public.workspaces where slug = target_workspace_slug for update;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  select * into service from public.service_catalog where code = service_code;
  if not found then raise exception 'Unknown service' using errcode = '22023'; end if;
  select * into current_row from public.workspace_services
  where workspace_id = target.id and service_id = service.id for update;

  was_effective := public.hanafy_service_active(target.id, service.code);
  will_be_effective := new_status in ('enabled', 'trial')
    and service.active
    and (new_starts_at is null or new_starts_at <= now())
    and (new_ends_at is null or new_ends_at > now())
    and target.status in ('provisioning', 'active');

  -- Turning on (or scheduling on): its requirements must be on.
  if new_status in ('enabled', 'trial') then
    select requirement.requires_any into missing_requirement
    from public.service_requirements requirement
    where requirement.service_code = service.code
      and not exists (select 1 from unnest(requirement.requires_any) required(code)
        where public.hanafy_service_active(target.id, required.code));
    if missing_requirement is not null then
      raise exception '% needs % turned on first', service.name,
        (select string_agg(catalog.name, ' or ' order by catalog.name) from public.service_catalog catalog where catalog.code = any(missing_requirement))
        using errcode = '22023';
    end if;
  end if;

  -- Turning off: nothing that is on may depend on it alone.
  if was_effective and not will_be_effective then
    select array_agg(dependent_service.name order by dependent_service.name) into dependents
    from public.service_requirements requirement
    join public.service_catalog dependent_service on dependent_service.code = requirement.service_code
    where service.code = any(requirement.requires_any)
      and public.hanafy_service_active(target.id, requirement.service_code)
      and not exists (select 1 from unnest(requirement.requires_any) alternative(code)
        where alternative.code <> service.code and public.hanafy_service_active(target.id, alternative.code));
    if dependents is not null then
      raise exception 'Turn off % first: it needs %', array_to_string(dependents, ', '), service.name using errcode = '22023';
    end if;

    -- Business-critical switches need a deliberate second click (§39).
    if service.code = 'pos' then
      select count(*) into open_count from public.orders orders
      where orders.workspace_id = target.id and orders.source in ('pos', 'phone', 'admin')
        and orders.status in ('placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery');
      warnings := warnings || to_jsonb('The register, kitchen screen and phone orders stop working immediately for ' || target.name || '.');
      if open_count > 0 then warnings := warnings || to_jsonb(open_count || ' register/phone order(s) are still open.'); end if;
      select count(*) into open_count from public.pos_drafts draft
      where draft.workspace_id = target.id and draft.status in ('open', 'held') and draft.item_count > 0;
      if open_count > 0 then warnings := warnings || to_jsonb(open_count || ' ticket(s) are being built or held on registers.'); end if;
    elsif service.code = 'online_ordering' then
      select count(*) into open_count from public.orders orders
      where orders.workspace_id = target.id and orders.source = 'online'
        and orders.status in ('payment_pending', 'placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery');
      warnings := warnings || to_jsonb('Customers can no longer order on the website.'::text);
      if open_count > 0 then warnings := warnings || to_jsonb(open_count || ' online order(s) are still open.'); end if;
    elsif service.code = 'website_storefront' then
      warnings := warnings || to_jsonb('The public website for ' || target.name || ' will show "not found".');
    elsif service.code = 'delivery' then
      select count(*) into open_count from public.orders orders
      where orders.workspace_id = target.id and orders.status = 'out_for_delivery';
      if open_count > 0 then warnings := warnings || to_jsonb(open_count || ' order(s) are out for delivery.'); end if;
    elsif service.code = 'crm' then
      warnings := warnings || to_jsonb('Events to the Hanafy CRM will wait (nothing is lost) and send in order when CRM is turned back on.'::text);
    elsif service.code = 'sms' then
      warnings := warnings || to_jsonb('Rewards sign-up and text opt-in are hidden from customers.'::text);
    end if;

    if jsonb_array_length(warnings) > 0 and not coalesce(confirmed, false) then
      return jsonb_build_object('status', 'needs_confirmation', 'warnings', warnings);
    end if;
  end if;

  before_value := case when current_row.id is null then null else jsonb_build_object('status', current_row.status,
    'source', current_row.source, 'starts_at', current_row.starts_at, 'ends_at', current_row.ends_at) end;
  after_value := jsonb_build_object('status', new_status, 'source', coalesce(new_source, 'manual'),
    'starts_at', new_starts_at, 'ends_at', new_ends_at);

  if before_value is not distinct from after_value then
    return jsonb_build_object('status', 'unchanged');
  end if;

  insert into public.workspace_services (workspace_id, service_id, status, source, starts_at, ends_at, enabled_at, disabled_at)
  values (target.id, service.id, new_status, coalesce(new_source, 'manual'), new_starts_at, new_ends_at,
    now(), case when new_status = 'disabled' then now() end)
  on conflict (workspace_id, service_id) do update set
    status = excluded.status,
    source = excluded.source,
    starts_at = excluded.starts_at,
    ends_at = excluded.ends_at,
    enabled_at = case when excluded.status in ('enabled', 'trial') and public.workspace_services.status not in ('enabled', 'trial')
      then now() else public.workspace_services.enabled_at end,
    disabled_at = case when excluded.status = 'disabled' then coalesce(public.workspace_services.disabled_at, now()) else null end,
    updated_at = now();

  perform public.hanafy_platform_write_audit(
    'platform.service_changed', target.id, 'workspace_services', service.code,
    service.name || ' set to ' || new_status || ' for ' || target.name,
    before_value, after_value, clean_reason, null);

  return jsonb_build_object('status', 'saved', 'effective', public.hanafy_service_active(target.id, service.code));
end;
$$;
revoke all on function public.hanafy_platform_set_service(text, text, text, text, timestamptz, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.hanafy_platform_set_service(text, text, text, text, timestamptz, timestamptz, text, boolean) to authenticated;

-- Give an existing account a role in a business, change it, or suspend it.
-- Wayne's (the legacy workspace) keeps its staff on profiles, which mirror
-- into workspace_members; other businesses use workspace_members directly.
create or replace function public.hanafy_platform_set_member(
  target_workspace_slug text,
  member_email text,
  role_code text,
  member_status text,
  change_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  new_role public.roles%rowtype;
  target_user uuid;
  existing public.workspace_members%rowtype;
  existing_role_code text;
  remaining_owners integer;
  clean_email text := lower(btrim(coalesce(member_email, '')));
  clean_reason text := nullif(btrim(coalesce(change_reason, '')), '');
  before_value jsonb;
  after_value jsonb;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if member_status not in ('active', 'suspended') then
    raise exception 'Choose active or suspended' using errcode = '22023';
  end if;
  if clean_reason is null or char_length(clean_reason) < 3 then
    raise exception 'Give a reason for the change' using errcode = '22023';
  end if;
  if char_length(clean_reason) > 500 then raise exception 'Keep the reason under 500 characters' using errcode = '22023'; end if;

  select * into target from public.workspaces where slug = target_workspace_slug;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  select * into new_role from public.roles where code = role_code and active;
  if not found then raise exception 'Unknown role' using errcode = '22023'; end if;
  select id into target_user from auth.users where lower(email) = clean_email;
  if target_user is null then raise exception 'No account uses that email' using errcode = 'P0002'; end if;

  -- Serialise owner changes for this business.
  perform 1 from public.workspace_members membership
  join public.roles role on role.id = membership.workspace_role_id and role.code = 'owner'
  where membership.workspace_id = target.id for update of membership;

  select * into existing from public.workspace_members
  where workspace_id = target.id and auth_user_id = target_user for update;
  if found then
    select code into existing_role_code from public.roles where id = existing.workspace_role_id;
    before_value := jsonb_build_object('role', existing_role_code, 'status', existing.status);
  end if;

  if existing_role_code = 'owner' and existing.status = 'active' and (new_role.code <> 'owner' or member_status <> 'active') then
    select count(*) into remaining_owners
    from public.workspace_members membership
    join public.roles role on role.id = membership.workspace_role_id and role.code = 'owner'
    where membership.workspace_id = target.id and membership.status = 'active' and membership.auth_user_id <> target_user;
    if remaining_owners = 0 then raise exception 'At least one active owner is required' using errcode = '22023'; end if;
  end if;

  after_value := jsonb_build_object('role', new_role.code, 'status', member_status);
  if before_value is not distinct from after_value then
    return jsonb_build_object('status', 'unchanged');
  end if;

  -- Membership first, so activating a profile never auto-enrols the account
  -- in Wayne's through the legacy mirror.
  insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id, status)
  values (target.id, target_user, new_role.id, member_status)
  on conflict (workspace_id, auth_user_id) do update
    set workspace_role_id = excluded.workspace_role_id, status = excluded.status, updated_at = now();

  if target.id = public.hanafy_legacy_workspace_id() then
    -- Wayne's legacy screens read the profile; keep it identical.
    update public.profiles
    set role_id = new_role.id, active = (member_status = 'active')
    where id = target_user
      and (role_id is distinct from new_role.id or active is distinct from (member_status = 'active'));
  elsif member_status = 'active' then
    -- A sign-in needs an active profile; it grants nothing on its own.
    update public.profiles set active = true where id = target_user and not active;
  end if;

  perform public.hanafy_platform_write_audit(
    case when before_value is null then 'platform.member_added' else 'platform.member_changed' end,
    target.id, 'workspace_members', target_user::text,
    case when before_value is null then 'Added ' else 'Changed ' end || clean_email || ' (' || new_role.name || ', ' || member_status || ') in ' || target.name,
    before_value, after_value, clean_reason, null);

  return jsonb_build_object('status', 'saved', 'auth_user_id', target_user, 'role', new_role.code, 'member_status', member_status);
end;
$$;
revoke all on function public.hanafy_platform_set_member(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_set_member(text, text, text, text, text) to authenticated;

-- Start an audited support session on one business (§8.4).
create or replace function public.hanafy_platform_start_support(
  target_workspace_slug text,
  support_reason text,
  ticket_reference text default null,
  duration_minutes integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text;
  target public.workspaces%rowtype;
  clean_reason text := nullif(btrim(coalesce(support_reason, '')), '');
  clean_ticket text := nullif(btrim(coalesce(ticket_reference, '')), '');
  minutes integer := coalesce(duration_minutes, 60);
  actor_label text;
  previous public.platform_support_sessions%rowtype;
  support_row public.platform_support_sessions%rowtype;
begin
  caller_role := public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support']);
  if clean_reason is null or char_length(clean_reason) < 5 then
    raise exception 'Say why you need to enter this business (at least 5 characters)' using errcode = '22023';
  end if;
  if char_length(clean_reason) > 500 then raise exception 'Keep the reason under 500 characters' using errcode = '22023'; end if;
  if clean_ticket is not null and char_length(clean_ticket) > 120 then raise exception 'Ticket reference is too long' using errcode = '22023'; end if;
  if minutes < 15 or minutes > 480 then raise exception 'Support sessions last between 15 minutes and 8 hours' using errcode = '22023'; end if;

  select * into target from public.workspaces where slug = target_workspace_slug;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  if target.status = 'archived' then raise exception 'This business is archived' using errcode = '22023'; end if;

  select coalesce(nullif(btrim(profile.display_name), ''), split_part(auth_user.email, '@', 1), 'Hanafy staff')
  into actor_label
  from auth.users auth_user left join public.profiles profile on profile.id = auth_user.id
  where auth_user.id = auth.uid();

  -- One open session per person: close the previous one first.
  for previous in
    select * from public.platform_support_sessions
    where platform_auth_user_id = auth.uid() and ended_at is null
    for update
  loop
    update public.platform_support_sessions
    set ended_at = least(now(), previous.expires_at),
        end_reason = case when previous.expires_at <= now() then 'expired' else 'replaced' end,
        ended_by_auth_user_id = auth.uid()
    where id = previous.id;
    if previous.expires_at > now() then
      perform public.hanafy_platform_write_audit('platform.support_ended', previous.workspace_id, 'platform_support_sessions',
        previous.id::text, 'Hanafy support session ended (another business was opened)', null, null, null, previous.id);
    end if;
  end loop;

  insert into public.platform_support_sessions (workspace_id, platform_auth_user_id, platform_role, actor_name, reason, ticket_reference, expires_at)
  values (target.id, auth.uid(), caller_role, coalesce(actor_label, 'Hanafy staff'), clean_reason, clean_ticket, now() + make_interval(mins => minutes))
  returning * into support_row;

  perform public.hanafy_platform_write_audit('platform.support_started', target.id, 'platform_support_sessions', support_row.id::text,
    coalesce(actor_label, 'Hanafy staff') || ' entered ' || target.name || ' as Hanafy support until '
      || to_char(support_row.expires_at at time zone target.timezone, 'HH12:MI AM'),
    null, jsonb_build_object('platform_role', caller_role, 'expires_at', support_row.expires_at, 'ticket_reference', clean_ticket),
    clean_reason, support_row.id);

  return jsonb_build_object('id', support_row.id, 'workspace_slug', target.slug, 'workspace_name', target.name,
    'expires_at', support_row.expires_at, 'platform_role', caller_role);
end;
$$;
revoke all on function public.hanafy_platform_start_support(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.hanafy_platform_start_support(text, text, text, integer) to authenticated;

-- End the caller's own session (no argument), or — for owners/admins —
-- revoke someone else's.
create or replace function public.hanafy_platform_end_support(target_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text;
  support_row public.platform_support_sessions%rowtype;
  own boolean;
begin
  caller_role := public.hanafy_platform_role();
  if auth.uid() is null or caller_role is null then
    raise exception 'Hanafy platform access required' using errcode = '42501';
  end if;

  if target_session_id is null then
    select * into support_row from public.platform_support_sessions
    where platform_auth_user_id = auth.uid() and ended_at is null
    order by started_at desc limit 1 for update;
    if not found then return jsonb_build_object('status', 'none'); end if;
  else
    select * into support_row from public.platform_support_sessions where id = target_session_id for update;
    if not found then raise exception 'Support session not found' using errcode = 'P0002'; end if;
  end if;

  own := support_row.platform_auth_user_id = auth.uid();
  if not own and caller_role not in ('platform_owner', 'platform_admin') then
    raise exception 'Only a platform owner or admin can end someone else''s session' using errcode = '42501';
  end if;
  if support_row.ended_at is not null then return jsonb_build_object('status', 'already_ended'); end if;

  update public.platform_support_sessions
  set ended_at = least(now(), support_row.expires_at),
      end_reason = case when support_row.expires_at <= now() then 'expired' when own then 'ended' else 'revoked' end,
      ended_by_auth_user_id = auth.uid()
  where id = support_row.id;

  perform public.hanafy_platform_write_audit('platform.support_ended', support_row.workspace_id, 'platform_support_sessions',
    support_row.id::text,
    case when own then 'Hanafy support session ended by ' || support_row.actor_name
      else 'Hanafy support session of ' || support_row.actor_name || ' revoked' end,
    null, jsonb_build_object('actions', (select count(*) from public.audit_log log where log.support_session_id = support_row.id and log.action not like 'platform.support\_%')),
    null, support_row.id);

  return jsonb_build_object('status', 'ended', 'workspace_id', support_row.workspace_id);
end;
$$;
revoke all on function public.hanafy_platform_end_support(uuid) from public, anon, authenticated;
grant execute on function public.hanafy_platform_end_support(uuid) to authenticated;

-- Platform-wide console log.
create or replace function public.hanafy_platform_audit(max_rows integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare row_limit integer := least(greatest(coalesce(max_rows, 200), 1), 1000);
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only']);
  return coalesce((
    select jsonb_agg(entry order by (entry ->> 'occurred_at') desc, (entry ->> 'id')::bigint desc)
    from (
      select jsonb_build_object('id', log.id, 'occurred_at', log.occurred_at, 'actor_name', log.actor_name,
        'actor_role', log.actor_role, 'action', log.action, 'summary', log.summary, 'reason', log.reason,
        'workspace_slug', workspace.slug, 'workspace_name', workspace.name,
        'before_data', log.before_data, 'after_data', log.after_data, 'support_session_id', log.support_session_id) as entry
      from public.platform_audit_log log
      left join public.workspaces workspace on workspace.id = log.workspace_id
      order by log.occurred_at desc, log.id desc
      limit row_limit
    ) recent
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.hanafy_platform_audit(integer) from public, anon, authenticated;
grant execute on function public.hanafy_platform_audit(integer) to authenticated;

comment on function public.hanafy_current_workspace_access(text) is
  'Phase 6: the named workspace through a validated membership, the only active membership, or — for the named workspace only — the caller''s live Hanafy support session.';
comment on function public.hanafy_has_workspace_permission(uuid, text) is
  'Phase 6: membership permission, or a live support session (read-only for platform_support), always reduced to the workspace''s active services. Platform roles alone grant nothing inside a business.';
