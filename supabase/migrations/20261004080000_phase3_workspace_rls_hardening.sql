-- Hanafy Platform Phase 3: workspace RLS and authorization hardening.
--
-- This migration intentionally preserves the existing Wayne's application
-- contracts while making their database boundary tenant-safe. Legacy Wayne
-- RPCs remain available only to an authorized Wayne's member; future
-- workspace routes must use the generic hanafy_* authorization helpers.

create or replace function public.hanafy_can_access_workspace_data(
  target_workspace_id uuid,
  required_permissions text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_is_platform_admin()
    or (
      public.hanafy_is_workspace_member(target_workspace_id)
      and exists (
        select 1
        from unnest(required_permissions) required_permission(code)
        where public.hanafy_has_workspace_permission(target_workspace_id, required_permission.code)
      )
    );
$$;

create or replace function public.hanafy_current_workspace_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with active_memberships as (
    select membership.workspace_id, membership.workspace_role_id
    from public.workspace_members membership
    where membership.auth_user_id = auth.uid()
      and membership.status = 'active'
  ), selected_membership as (
    select membership.*
    from active_memberships membership
    where (select count(*) from active_memberships) = 1
  )
  select jsonb_build_object(
    'profile_id', profile.id,
    'display_name', profile.display_name,
    'role', role.code,
    'permissions', coalesce((
      select jsonb_agg(permission.code order by permission.code)
      from public.role_permissions role_permission
      join public.permissions permission on permission.id = role_permission.permission_id
      where role_permission.role_id = selected_membership.workspace_role_id
    ), '[]'::jsonb),
    'workspace_id', workspace.id,
    'workspace_slug', workspace.slug
  )
  from selected_membership
  join public.workspaces workspace on workspace.id = selected_membership.workspace_id
  join public.profiles profile on profile.id = auth.uid() and profile.active
  join public.roles role on role.id = selected_membership.workspace_role_id and role.active
  where workspace.status = 'active';
$$;

-- Keep the existing Wayne-only stored procedures safe until their callers gain
-- workspace routes in later phases. A membership in another workspace never
-- grants access to these procedures or their unscoped historical SQL.
create or replace function public.wayne_has_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_has_workspace_permission(
    '40000000-0000-4000-8000-000000000001'::uuid,
    required_permission
  );
$$;

-- The two-argument overload is deliberately named as part of the established
-- Wayne RPC privilege allow-list. It is the generic, tenant-aware predicate
-- used by RLS; unlike the legacy one-argument overload, it never assumes a
-- workspace and does not depend on another callable helper.
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
  select exists (
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
  );
$$;

create or replace function public.wayne_my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_current_workspace_access();
$$;

-- New staff are still created through the established profile trigger. During
-- the Wayne-only compatibility period, keep the membership record in sync with
-- that profile so a new cashier never loses access after the Phase 1 backfill.
-- Future provisioning replaces this bridge with explicit workspace invitations.
create or replace function public.hanafy_sync_legacy_waynes_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.workspace_members membership
    where membership.auth_user_id = new.id
      and membership.workspace_id = '40000000-0000-4000-8000-000000000001'::uuid
  ) or not exists (
    select 1 from public.workspace_members membership
    where membership.auth_user_id = new.id
  ) then
    insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id, status)
    values (
      '40000000-0000-4000-8000-000000000001'::uuid,
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

drop trigger if exists hanafy_sync_legacy_waynes_membership on public.profiles;
create trigger hanafy_sync_legacy_waynes_membership
after insert or update of role_id, active on public.profiles
for each row execute function public.hanafy_sync_legacy_waynes_membership();

-- Existing profiles are authoritative for legacy Wayne staff until the dedicated
-- workspace staff-management phase migrates those mutations.
insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id, status)
select
  '40000000-0000-4000-8000-000000000001'::uuid,
  profile.id,
  profile.role_id,
  case when profile.active then 'active' else 'suspended' end
from public.profiles profile
on conflict (workspace_id, auth_user_id) do update
set workspace_role_id = excluded.workspace_role_id,
    status = excluded.status,
    updated_at = now();

-- Scope assignment is a compatibility bridge for existing Wayne-only
-- security-definer functions. It never grants a caller access to Wayne's data:
-- the RLS policies below still validate the final workspace id against auth.uid().
create or replace function public.hanafy_assign_legacy_workspace_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.workspace_id is null then
    new.workspace_id := '40000000-0000-4000-8000-000000000001'::uuid;
  end if;
  return new;
end;
$$;

create or replace function public.hanafy_assign_legacy_location_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.workspace_id is null then
    new.workspace_id := '40000000-0000-4000-8000-000000000001'::uuid;
  end if;
  if new.location_id is null then
    new.location_id := '40000000-0000-4000-8000-000000000002'::uuid;
  end if;
  return new;
end;
$$;

create or replace function public.hanafy_enforce_workspace_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.workspace_id is null then
    raise exception 'workspace_id is required' using errcode = '23502';
  end if;

  if TG_OP = 'UPDATE' and old.workspace_id is distinct from new.workspace_id then
    raise exception 'workspace_id cannot be reassigned' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.hanafy_enforce_location_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  scoped_location_workspace_id uuid;
begin
  if new.workspace_id is null then
    raise exception 'workspace_id is required' using errcode = '23502';
  end if;
  if new.location_id is null then
    raise exception 'location_id is required' using errcode = '23502';
  end if;
  if TG_OP = 'UPDATE' and old.workspace_id is distinct from new.workspace_id then
    raise exception 'workspace_id cannot be reassigned' using errcode = '42501';
  end if;

  select location.workspace_id into scoped_location_workspace_id
  from public.locations location
  where location.id = new.location_id;
  if scoped_location_workspace_id is distinct from new.workspace_id then
    raise exception 'location_id must belong to workspace_id' using errcode = '23514';
  end if;
  return new;
end;
$$;

do $$
declare
  table_name text;
  policy_name text;
  table_config record;
  read_expression text;
  write_expression text;
begin
  for table_config in
    select *
    from (values
      ('store_settings', array['settings.manage', 'content.manage']::text[], array['settings.manage', 'content.manage']::text[], true),
      ('store_special_hours', array['settings.manage', 'content.manage']::text[], array['settings.manage', 'content.manage']::text[], true),
      ('customers', array['customers.view']::text[], array[]::text[], false),
      ('customer_phones', array['customers.view']::text[], array[]::text[], false),
      ('customer_addresses', array['customers.view']::text[], array[]::text[], false),
      ('marketing_consents', array['customers.view']::text[], array[]::text[], false),
      ('promotions', array['promotions.manage']::text[], array['promotions.manage']::text[], false),
      ('menu_categories', array['menu.manage']::text[], array['menu.manage']::text[], false),
      ('menu_items', array['menu.manage']::text[], array['menu.manage']::text[], false),
      ('menu_item_variants', array['menu.manage']::text[], array[]::text[], false),
      ('modifier_groups', array['menu.manage']::text[], array[]::text[], false),
      ('modifier_choices', array['menu.manage']::text[], array[]::text[], false),
      ('menu_item_modifier_groups', array['menu.manage']::text[], array[]::text[], false),
      ('modifier_choice_variant_prices', array['menu.manage']::text[], array[]::text[], false),
      ('menu_item_included_choices', array['menu.manage']::text[], array[]::text[], false),
      ('customer_segments', array['customers.view', 'segments.manage']::text[], array['segments.manage']::text[], false),
      ('customer_segment_memberships', array['customers.view', 'segments.manage']::text[], array[]::text[], false),
      ('customer_events', array['customers.view', 'segments.manage']::text[], array[]::text[], false),
      ('customer_segment_evaluation_runs', array['segments.manage']::text[], array[]::text[], false),
      ('order_idempotency', array['orders.view']::text[], array[]::text[], false),
      ('integration_destinations', array['integrations.manage']::text[], array[]::text[], false),
      ('integration_outbox', array['integrations.manage']::text[], array[]::text[], false),
      ('integration_delivery_logs', array['integrations.manage']::text[], array[]::text[], false),
      ('payment_provider_settings', array['payments.manage', 'pos.access']::text[], array['payments.manage']::text[], false),
      ('payment_webhook_events', array['payments.manage']::text[], array[]::text[], true),
      ('reward_grants', array['promotions.manage']::text[], array[]::text[], false),
      ('audit_log', array['audit.view']::text[], array[]::text[], true),
      ('orders', array['orders.view']::text[], array[]::text[], true),
      ('order_items', array['orders.view']::text[], array[]::text[], true),
      ('order_item_modifiers', array['orders.view']::text[], array[]::text[], true),
      ('order_discounts', array['orders.view']::text[], array[]::text[], true),
      ('order_events', array['orders.view']::text[], array[]::text[], true),
      ('payments', array['reports.view', 'payments.manage']::text[], array[]::text[], true),
      ('refunds', array['reports.view', 'payments.manage']::text[], array[]::text[], true),
      ('delivery_assignments', array['delivery.dispatch', 'driver.access']::text[], array[]::text[], true),
      ('kitchen_tickets', array['kitchen.access']::text[], array[]::text[], true),
      ('print_jobs', array['printing.manage', 'printing.process']::text[], array[]::text[], true),
      ('registers', array['cash.manage', 'pos.access']::text[], array[]::text[], true),
      ('register_shifts', array['cash.manage', 'pos.access']::text[], array[]::text[], true),
      ('cash_movements', array['cash.manage']::text[], array[]::text[], true),
      ('payment_terminals', array['payments.manage', 'pos.access']::text[], array['payments.manage']::text[], true),
      ('store_phone_lines', array['pos.access', 'hardware.manage']::text[], array['hardware.manage']::text[], true),
      ('phone_calls', array['pos.access']::text[], array[]::text[], true),
      ('pos_drafts', array['pos.access']::text[], array[]::text[], true),
      ('pos_hardware_settings', array['hardware.manage', 'pos.access']::text[], array['hardware.manage']::text[], true),
      ('pilot_checks', array['pilot.manage']::text[], array[]::text[], true)
    ) as config(table_name, read_permissions, write_permissions, location_scoped)
  loop
    table_name := table_config.table_name;
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon', table_name);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', table_name);

    for policy_name in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = table_name
    loop
      execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    end loop;

    select string_agg(
      format('public.wayne_has_permission(workspace_id, %L)', permission_code),
      ' or '
    ) into read_expression
    from unnest(table_config.read_permissions) permission_code;

    execute format(
      'create policy hanafy_workspace_read on public.%I for select to authenticated using (%s)',
      table_name,
      read_expression
    );

    if cardinality(table_config.write_permissions) > 0 then
      select string_agg(
        format('public.wayne_has_permission(workspace_id, %L)', permission_code),
        ' or '
      ) into write_expression
      from unnest(table_config.write_permissions) permission_code;

      execute format(
        'create policy hanafy_workspace_insert on public.%I for insert to authenticated with check (%s)',
        table_name,
        write_expression
      );
      execute format(
        'create policy hanafy_workspace_update on public.%I for update to authenticated using (%s) with check (%s)',
        table_name,
        write_expression,
        write_expression
      );
      execute format(
        'create policy hanafy_workspace_delete on public.%I for delete to authenticated using (%s)',
        table_name,
        write_expression
      );
    end if;

    execute format('drop trigger if exists aa_hanafy_assign_legacy_scope on public.%I', table_name);
    execute format(
      'create trigger aa_hanafy_assign_legacy_scope before insert on public.%I for each row execute function %s',
      table_name,
      case when table_config.location_scoped then 'public.hanafy_assign_legacy_location_scope()' else 'public.hanafy_assign_legacy_workspace_scope()' end
    );
    execute format('drop trigger if exists zz_hanafy_enforce_tenant_scope on public.%I', table_name);
    execute format(
      'create trigger zz_hanafy_enforce_tenant_scope before insert or update on public.%I for each row execute function %s',
      table_name,
      case when table_config.location_scoped then 'public.hanafy_enforce_location_scope()' else 'public.hanafy_enforce_workspace_scope()' end
    );

    execute format('alter table public.%I alter column workspace_id set not null', table_name);
    if table_config.location_scoped then
      execute format('alter table public.%I alter column location_id set not null', table_name);
    end if;
  end loop;
end;
$$;

-- Private tenant storage has a UUID workspace prefix. Public Wayne menu images
-- remain public storefront assets; they contain no private tenant data.
create or replace function public.hanafy_storage_workspace_id(object_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return nullif(split_part(object_name, '/', 1), '')::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('hanafy-workspace-private', 'hanafy-workspace-private', false)
    on conflict (id) do update set public = false;

    drop policy if exists hanafy_workspace_private_storage_select on storage.objects;
    drop policy if exists hanafy_workspace_private_storage_insert on storage.objects;
    drop policy if exists hanafy_workspace_private_storage_update on storage.objects;
    drop policy if exists hanafy_workspace_private_storage_delete on storage.objects;

    create policy hanafy_workspace_private_storage_select on storage.objects
    for select to authenticated
    using (
      bucket_id = 'hanafy-workspace-private'
      and (public.hanafy_is_platform_admin() or public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name)))
    );
    create policy hanafy_workspace_private_storage_insert on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'hanafy-workspace-private'
      and (public.hanafy_is_platform_admin() or public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name)))
    );
    create policy hanafy_workspace_private_storage_update on storage.objects
    for update to authenticated
    using (
      bucket_id = 'hanafy-workspace-private'
      and (public.hanafy_is_platform_admin() or public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name)))
    )
    with check (
      bucket_id = 'hanafy-workspace-private'
      and (public.hanafy_is_platform_admin() or public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name)))
    );
    create policy hanafy_workspace_private_storage_delete on storage.objects
    for delete to authenticated
    using (
      bucket_id = 'hanafy-workspace-private'
      and (public.hanafy_is_platform_admin() or public.hanafy_is_workspace_member(public.hanafy_storage_workspace_id(name)))
    );
  end if;
end;
$$;

revoke all on function public.hanafy_can_access_workspace_data(uuid, text[]) from public;
revoke all on function public.hanafy_current_workspace_access() from public;
revoke all on function public.hanafy_storage_workspace_id(text) from public;
grant execute on function public.hanafy_can_access_workspace_data(uuid, text[]) to authenticated;
grant execute on function public.hanafy_current_workspace_access() to authenticated;
grant execute on function public.hanafy_storage_workspace_id(text) to authenticated;
-- The predicate is safe for policy evaluation by every database role: it only
-- returns a boolean after checking auth.uid() against membership. Keeping this
-- executable by PUBLIC also lets table-owner audit triggers evaluate RLS under
-- the acting role without a privilege error.
grant execute on function public.hanafy_can_access_workspace_data(uuid, text[]) to public;
grant execute on function public.wayne_has_permission(uuid, text) to anon, authenticated;
grant execute on function public.hanafy_has_platform_access() to public;
grant execute on function public.hanafy_is_platform_admin() to public;
grant execute on function public.hanafy_is_workspace_member(uuid) to public;
grant execute on function public.hanafy_has_workspace_permission(uuid, text) to public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.hanafy_can_access_workspace_data(uuid, text[]) to service_role;
  end if;
end;
$$;

comment on function public.hanafy_can_access_workspace_data(uuid, text[]) is 'Phase 3 RLS predicate: explicit platform administration or active workspace membership with one permitted capability.';
comment on function public.hanafy_current_workspace_access() is 'Phase 3 trusted server context for a legacy route with exactly one active workspace membership.';
