-- Hanafy Platform Phase 5: workspace shell and service gating.
--
-- Entitlement is enforced where every other rule is enforced: in the database
-- permission check.  A permission that belongs to a service is only effective
-- while that service is active for the workspace, so turning a service off
-- removes it from the UI (navigation is built from effective permissions),
-- from every server action and API route (they check the same permissions),
-- from the legacy wayne_* RPCs (they call wayne_has_permission) and from RLS
-- (the policies call the same predicate).  Turning it back on restores access
-- without touching roles.  Core permissions (admin.access, settings.manage,
-- audit.view) belong to no service and are never gated.
--
-- Also:
--   * explicit workspace selection for users with more than one membership;
--   * a workspace list for the switcher and a public host → workspace lookup;
--   * write-path guards for data that only exists when a service is on
--     (orders by channel, caller-ID rings, delivery assignments);
--   * Hanafy CRM event delivery waits (nothing is dropped) while `crm` is off;
--   * a new Auth user no longer receives a Wayne's membership row until a
--     Wayne's manager activates them.

-- ---------------------------------------------------------------------------
-- Service → permission map
-- ---------------------------------------------------------------------------
create table if not exists public.service_permissions (
  service_id uuid not null references public.service_catalog(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (service_id, permission_id)
);
create index if not exists service_permissions_permission_id_idx on public.service_permissions(permission_id);
alter table public.service_permissions enable row level security;
revoke all on public.service_permissions from anon, authenticated;
grant select on public.service_permissions to authenticated;
drop policy if exists service_permissions_authenticated_select on public.service_permissions;
create policy service_permissions_authenticated_select on public.service_permissions
for select to authenticated using (auth.uid() is not null);

insert into public.service_permissions (service_id, permission_id)
select service.id, permission.id
from (values
  ('pos', 'pos.access'), ('pos', 'pos.discount.manage'), ('pos', 'kitchen.access'), ('pos', 'cash.manage'),
  ('pos', 'printing.process'), ('pos', 'printing.manage'), ('pos', 'pilot.manage'),
  ('pos', 'orders.view'), ('pos', 'orders.manage'), ('pos', 'orders.cancel'), ('pos', 'payments.manage'),
  ('pos', 'menu.manage'), ('pos', 'promotions.manage'),
  ('online_ordering', 'orders.view'), ('online_ordering', 'orders.manage'), ('online_ordering', 'orders.cancel'),
  ('online_ordering', 'payments.manage'), ('online_ordering', 'menu.manage'), ('online_ordering', 'promotions.manage'),
  ('delivery', 'driver.access'), ('delivery', 'delivery.dispatch'), ('delivery', 'orders.view'),
  ('hardware_management', 'hardware.manage'), ('hardware_management', 'printing.manage'),
  ('crm', 'customers.view'), ('crm', 'integrations.manage'),
  ('customer_segments', 'segments.manage'),
  ('analytics', 'reports.view'), ('analytics', 'orders.view'),
  ('staff_management', 'staff.view'), ('staff_management', 'staff.manage'),
  ('website_storefront', 'content.manage')
) as mapping(service_code, permission_code)
join public.service_catalog service on service.code = mapping.service_code
join public.permissions permission on permission.code = mapping.permission_code
on conflict do nothing;

-- A permission is entitled when no service owns it, or when at least one of
-- the services that owns it is active for the workspace.
create or replace function public.hanafy_permission_entitled(target_workspace_id uuid, required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
      select 1 from public.service_permissions mapping
      join public.permissions permission on permission.id = mapping.permission_id
      where permission.code = required_permission
    )
    or exists (
      select 1 from public.service_permissions mapping
      join public.permissions permission on permission.id = mapping.permission_id
      join public.service_catalog service on service.id = mapping.service_id
      where permission.code = required_permission
        and public.hanafy_service_active(target_workspace_id, service.code)
    );
$$;
revoke all on function public.hanafy_permission_entitled(uuid, text) from public;

create or replace function public.hanafy_entitled_permissions(target_workspace_id uuid, target_role_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(permission.code order by permission.code), '[]'::jsonb)
  from public.role_permissions role_permission
  join public.permissions permission on permission.id = role_permission.permission_id
  where role_permission.role_id = target_role_id
    and public.hanafy_permission_entitled(target_workspace_id, permission.code);
$$;
revoke all on function public.hanafy_entitled_permissions(uuid, uuid) from public;

create or replace function public.hanafy_active_services(target_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(service.code order by service.code), '[]'::jsonb)
  from public.service_catalog service
  where service.active and public.hanafy_service_active(target_workspace_id, service.code);
$$;
revoke all on function public.hanafy_active_services(uuid) from public;

-- ---------------------------------------------------------------------------
-- Permission predicates now include entitlement
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
    public.hanafy_is_platform_admin()
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
    )
  );
$$;

create or replace function public.wayne_has_permission(
  target_workspace_id uuid,
  required_permission text
)
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
      from public.platform_users platform_user
      where platform_user.auth_user_id = auth.uid()
        and platform_user.active
        and platform_user.platform_role in ('platform_owner', 'platform_admin')
    ) or exists (
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
  );
$$;

create or replace function public.wayne_has_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_has_workspace_permission(public.hanafy_legacy_workspace_id(), required_permission);
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
    'workspace_status', workspace.status,
    'workspace_role', access.workspace_role,
    'has_platform_access', access.has_platform_access,
    'is_platform_admin', access.is_platform_admin,
    'permissions', case
      when access.is_platform_admin then coalesce((
        select jsonb_agg(permission.code order by permission.code)
        from public.permissions permission
        where public.hanafy_permission_entitled(workspace.id, permission.code)
      ), '[]'::jsonb)
      else public.hanafy_entitled_permissions(workspace.id, access.workspace_role_id)
    end,
    'enabled_services', public.hanafy_active_services(workspace.id),
    'legacy_operations', workspace.id = public.hanafy_legacy_workspace_id()
  )
  from public.workspaces workspace
  cross join access
  where workspace.id = target_workspace_id
    and (access.has_platform_access or access.workspace_role_id is not null);
$$;

-- ---------------------------------------------------------------------------
-- Explicit workspace selection
-- ---------------------------------------------------------------------------
-- Two overloads with no defaults, so PostgREST resolves each call unambiguously
-- and the currently deployed app (which calls it with no arguments) keeps
-- working while the new app rolls out.
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
  )
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
  )
  from selected_membership
  join public.workspaces workspace on workspace.id = selected_membership.workspace_id
  join public.profiles profile on profile.id = auth.uid() and profile.active
  join public.roles role on role.id = selected_membership.workspace_role_id and role.active;
$$;
revoke all on function public.hanafy_current_workspace_access(text) from public;
grant execute on function public.hanafy_current_workspace_access(text) to authenticated;

create or replace function public.hanafy_current_workspace_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_current_workspace_access(null::text);
$$;
revoke all on function public.hanafy_current_workspace_access() from public;
grant execute on function public.hanafy_current_workspace_access() to authenticated;

create or replace function public.wayne_my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_current_workspace_access(null::text);
$$;

-- Workspaces the signed-in user can open: their memberships, plus every
-- workspace for Hanafy platform staff (clearly flagged as not a membership).
create or replace function public.hanafy_my_workspaces()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', workspace.id,
      'slug', workspace.slug,
      'name', workspace.name,
      'status', workspace.status,
      'role', role.code,
      'is_member', membership.id is not null
    ) order by workspace.name), '[]'::jsonb)
  from public.workspaces workspace
  left join public.workspace_members membership
    on membership.workspace_id = workspace.id
    and membership.auth_user_id = auth.uid()
    and membership.status = 'active'
  left join public.roles role on role.id = membership.workspace_role_id
  where auth.uid() is not null
    and workspace.status in ('provisioning', 'active', 'suspended')
    and (membership.id is not null or public.hanafy_has_platform_access());
$$;
revoke all on function public.hanafy_my_workspaces() from public;
grant execute on function public.hanafy_my_workspaces() to authenticated;

-- Public host → workspace (only what a storefront needs; no private data).
create or replace function public.hanafy_public_workspace(target_hostname text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workspace_id', workspace.id,
    'location_id', domain.location_id,
    'workspace_slug', workspace.slug,
    'enabled_services', public.hanafy_active_services(workspace.id),
    'legacy_operations', workspace.id = public.hanafy_legacy_workspace_id()
  )
  from public.workspace_domains domain
  join public.workspaces workspace on workspace.id = domain.workspace_id and workspace.status = 'active'
  join public.locations location on location.id = domain.location_id and location.status = 'active'
  where domain.hostname = public.hanafy_normalize_hostname(target_hostname)
    and domain.active
  limit 1;
$$;
revoke all on function public.hanafy_public_workspace(text) from public;
grant execute on function public.hanafy_public_workspace(text) to anon, authenticated;

-- Staff-side settings come from the signed-in workspace, never the request host.
create or replace function public.hanafy_workspace_store_settings(target_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_location_store_settings(location.workspace_id, location.id)
  from public.locations location
  where location.workspace_id = target_workspace_id
    and location.status in ('provisioning', 'active')
    and (public.hanafy_is_workspace_member(target_workspace_id) or public.hanafy_has_platform_access())
  order by location.created_at, location.id
  limit 1;
$$;
revoke all on function public.hanafy_workspace_store_settings(uuid) from public;
grant execute on function public.hanafy_workspace_store_settings(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Write-path guards: data that can only exist while its service is on
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_require_service_for_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare required_service text;
begin
  -- Separate statements: a PL/pgSQL expression naming new.source would fail
  -- to plan on tables that have no such column.
  if tg_table_name = 'orders' then
    required_service := case to_jsonb(new) ->> 'source' when 'online' then 'online_ordering' when 'pos' then 'pos' when 'phone' then 'pos' else null end;
  elsif tg_table_name = 'phone_calls' then
    required_service := 'caller_id';
  elsif tg_table_name = 'delivery_assignments' then
    required_service := 'delivery';
  end if;
  if required_service is not null and not public.hanafy_service_active(new.workspace_id, required_service) then
    raise exception 'SERVICE_DISABLED:%', required_service using errcode = '42501',
      hint = 'This service is not enabled for the workspace.';
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_require_service_for_row() from public;

drop trigger if exists ab_hanafy_require_service on public.orders;
create trigger ab_hanafy_require_service before insert on public.orders
for each row execute function public.hanafy_require_service_for_row();
drop trigger if exists ab_hanafy_require_service on public.phone_calls;
create trigger ab_hanafy_require_service before insert on public.phone_calls
for each row execute function public.hanafy_require_service_for_row();
drop trigger if exists ab_hanafy_require_service on public.delivery_assignments;
create trigger ab_hanafy_require_service before insert on public.delivery_assignments
for each row execute function public.hanafy_require_service_for_row();

-- ---------------------------------------------------------------------------
-- Hanafy CRM delivery waits while the workspace's `crm` service is off.
-- Events stay pending (never dropped) and go out in order when it is back on.
-- ---------------------------------------------------------------------------
create or replace function public.wayne_claim_hanafy_outbox(worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare row_value public.integration_outbox%rowtype;
begin
  if not exists (select 1 from public.integration_destinations where id = 'hanafy' and active) then
    return null;
  end if;

  select * into row_value from public.integration_outbox
  where destination = 'hanafy'
    and ((status in ('pending','failed') and next_attempt_at <= now())
      or (status = 'processing' and lease_expires_at <= now()))
    and public.hanafy_service_active(workspace_id, 'crm')
  order by created_at
  for update skip locked
  limit 1;
  if not found then return null; end if;

  if row_value.status = 'processing' then
    insert into public.integration_delivery_logs(outbox_id, attempt_number, request_status, error_message)
    values (row_value.id, row_value.attempts, 'failed', 'Delivery lease expired before a result was recorded.')
    on conflict (outbox_id, attempt_number) do nothing;
  end if;

  update public.integration_outbox
  set status = 'processing', attempts = attempts + 1, lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '5 minutes', last_error = null,
      http_request_id = null, dispatched_at = null
  where id = row_value.id
  returning * into row_value;
  return to_jsonb(row_value);
end;
$$;

-- ---------------------------------------------------------------------------
-- New Auth users (e.g. Hanafy platform staff) are not enrolled in Wayne's
-- just by existing.
-- Existing Wayne's memberships keep following their profile, and a new staff
-- member joins when a Wayne's manager activates them (wayne_admin_update_staff).
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_sync_legacy_waynes_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare has_legacy_membership boolean;
begin
  select exists (
    select 1 from public.workspace_members membership
    where membership.auth_user_id = new.id
      and membership.workspace_id = public.hanafy_legacy_workspace_id()
  ) into has_legacy_membership;

  if has_legacy_membership or (
    new.active
    and tg_op = 'UPDATE'
    and not exists (select 1 from public.workspace_members membership where membership.auth_user_id = new.id)
  ) then
    insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id, status)
    values (
      public.hanafy_legacy_workspace_id(),
      new.id,
      new.role_id,
      case when new.active then 'active' else 'suspended' end
    )
    on conflict (workspace_id, auth_user_id) do update
    set workspace_role_id = excluded.workspace_role_id,
        status = excluded.status,
        updated_at = now();
  end if;
  return new;
end;
$$;

comment on table public.service_permissions is 'Phase 5: which service owns each permission. A permission owned by services is effective only while one of them is active for the workspace.';
comment on function public.hanafy_current_workspace_access(text) is 'Phase 5 trusted server context: the named workspace (validated membership) or the only active membership.';

-- ---------------------------------------------------------------------------
-- Configuration saves act on the selected workspace (explicit slug from the
-- server's validated selection, or the only membership).
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_selected_location(target_workspace_slug text, required_permission text)
returns table (workspace_id uuid, location_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  selected_workspace_id uuid;
  selected_location_id uuid;
begin
  selected_workspace_id := (public.hanafy_current_workspace_access(target_workspace_slug) ->> 'workspace_id')::uuid;
  if selected_workspace_id is null or not public.hanafy_has_workspace_permission(selected_workspace_id, required_permission) then
    raise exception 'Permission required: %', required_permission using errcode = '42501';
  end if;
  select location.id into selected_location_id from public.locations location
  where location.workspace_id = selected_workspace_id and location.status = 'active'
  order by location.created_at, location.id limit 1;
  if selected_location_id is null then raise exception 'An active location is required' using errcode = 'P0002'; end if;
  return query select selected_workspace_id, selected_location_id;
end;
$$;
revoke all on function public.hanafy_selected_location(text, text) from public;

-- New two-argument form; the one-argument form stays for the deployed app.
create or replace function public.hanafy_save_location_settings(payload jsonb, target_workspace_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected record;
  saved public.location_settings%rowtype;
begin
  select * into selected from public.hanafy_selected_location(target_workspace_slug, 'content.manage');
  if jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'Settings must be an object' using errcode = '22023';
  end if;

  update public.location_settings
    set configuration = configuration || (payload - 'receipt_header' - 'receipt_footer' - 'id'),
        receipt_header = coalesce(payload ->> 'receipt_header', receipt_header),
        receipt_footer = coalesce(payload ->> 'receipt_footer', receipt_footer)
    where location_settings.workspace_id = selected.workspace_id and location_settings.location_id = selected.location_id
    returning * into saved;
  if not found then raise exception 'Location settings not found' using errcode = 'P0002'; end if;

  update public.workspace_settings set
    display_name = coalesce(nullif(saved.configuration ->> 'store_name', ''), display_name),
    description = coalesce(saved.configuration ->> 'story', description),
    support_email = coalesce(saved.configuration ->> 'public_email', support_email),
    support_phone = coalesce(saved.configuration ->> 'public_phone', support_phone),
    logo_path = coalesce(saved.configuration ->> 'logo_path', logo_path),
    logo_alt = coalesce(saved.configuration ->> 'logo_alt', logo_alt),
    social_links = social_links || jsonb_strip_nulls(jsonb_build_object(
      'facebook_url', saved.configuration ->> 'facebook_url',
      'instagram_url', saved.configuration ->> 'instagram_url',
      'tiktok_url', saved.configuration ->> 'tiktok_url'))
  where workspace_settings.workspace_id = selected.workspace_id;
  return saved.configuration || jsonb_build_object('receipt_header', saved.receipt_header, 'receipt_footer', saved.receipt_footer);
end;
$$;

-- New two-argument form; the one-argument form stays for the deployed app.
create or replace function public.hanafy_save_location_hardware_configuration(payload jsonb, target_workspace_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected record;
  saved jsonb;
begin
  select * into selected from public.hanafy_selected_location(target_workspace_slug, 'hardware.manage');
  if jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'Hardware settings must be an object' using errcode = '22023';
  end if;
  update public.location_hardware_configurations
  set configuration = configuration || payload
  where location_hardware_configurations.workspace_id = selected.workspace_id
    and location_hardware_configurations.location_id = selected.location_id
  returning configuration || jsonb_build_object('updated_at', updated_at) into saved;
  if not found then raise exception 'Hardware configuration not found' using errcode = 'P0002'; end if;
  if payload ? 'caller_line_count' then
    insert into public.location_caller_lines (workspace_id, location_id, line_number, label)
    select selected.workspace_id, selected.location_id, line_number, 'Line ' || line_number
    from generate_series(1, (payload ->> 'caller_line_count')::integer) line_number
    on conflict (location_id, line_number) do nothing;
    update public.location_caller_lines
    set active = line_number <= (payload ->> 'caller_line_count')::integer
    where location_caller_lines.workspace_id = selected.workspace_id and location_caller_lines.location_id = selected.location_id;
  end if;
  return saved;
end;
$$;

-- New two-argument form; the one-argument form stays for the deployed app.
create or replace function public.hanafy_save_location_payment_configuration(payload jsonb, target_workspace_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected record;
  saved public.location_payment_configurations%rowtype;
begin
  select * into selected from public.hanafy_selected_location(target_workspace_slug, 'payments.manage');
  update public.location_payment_configurations set
    provider = coalesce(nullif(btrim(payload ->> 'provider'), ''), provider),
    environment = coalesce(nullif(btrim(payload ->> 'environment'), ''), environment),
    application_id = btrim(coalesce(payload ->> 'application_id', application_id)),
    provider_location_id = btrim(coalesce(payload ->> 'location_id', provider_location_id)),
    notification_url = btrim(coalesce(payload ->> 'notification_url', notification_url)),
    online_card_enabled = coalesce((payload ->> 'online_card_enabled')::boolean, online_card_enabled),
    terminal_card_enabled = coalesce((payload ->> 'terminal_card_enabled')::boolean, terminal_card_enabled)
  where location_payment_configurations.workspace_id = selected.workspace_id
    and location_payment_configurations.location_id = selected.location_id
  returning * into saved;
  if not found then raise exception 'Payment configuration not found' using errcode = 'P0002'; end if;
  return to_jsonb(saved) || jsonb_build_object('location_id', saved.provider_location_id);
end;
$$;

revoke all on function public.hanafy_save_location_settings(jsonb, text) from public;
revoke all on function public.hanafy_save_location_hardware_configuration(jsonb, text) from public;
revoke all on function public.hanafy_save_location_payment_configuration(jsonb, text) from public;
grant execute on function public.hanafy_save_location_settings(jsonb, text) to authenticated;
grant execute on function public.hanafy_save_location_hardware_configuration(jsonb, text) to authenticated;
grant execute on function public.hanafy_save_location_payment_configuration(jsonb, text) to authenticated;
