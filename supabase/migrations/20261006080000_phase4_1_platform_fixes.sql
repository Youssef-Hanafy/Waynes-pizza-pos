-- Hanafy Platform Phase 4.1: fixes found by the Phase 0 audit (2026-09-28).
--
-- 1. Storefront hostnames: register the hosts Wayne's actually serves from so
--    the host-keyed storefront stops rendering "Store unavailable".
-- 2. Messaging identity: the Phase 4 backfill copied the store landline into
--    the SMS sender.  Wayne's real AWS origination identity is recorded instead;
--    the unprovisioned email identity is switched off.  (The Hanafy CRM still
--    performs the send; nothing here sends a message.)
-- 3. Service entitlements: Wayne's texts today, so `sms` and `automations` are
--    enabled.  `email` stays off until an email provider is provisioned.
-- 4. Status vocabularies the build sheet requires (provisioning / suspended),
--    service source and date window, and the platform_billing role.
-- 5. Platform-owner invitation: platform access is granted by an explicit,
--    audited invite that is redeemed only by a confirmed email address.  A
--    workspace owner never becomes a platform administrator implicitly.
-- 6. One source of truth for configuration.  Phase 4 moved the admin writes to
--    the new workspace/location tables, but 16 legacy functions still read the
--    old singletons (store_settings, pos_hardware_settings,
--    payment_provider_settings, store_phone_lines).  Mirror triggers keep both
--    in step in either direction, so a save can never be half-applied.
-- 7. Phase 4 defects: seo_about_title fell back to the about description, and
--    the hostname trailing-dot pattern was over-escaped.

-- ---------------------------------------------------------------------------
-- 4. Vocabularies
-- ---------------------------------------------------------------------------
alter table public.workspaces drop constraint if exists workspaces_status_check;
alter table public.workspaces add constraint workspaces_status_check
  check (status in ('provisioning', 'active', 'suspended', 'archived'));

alter table public.locations drop constraint if exists locations_status_check;
alter table public.locations add constraint locations_status_check
  check (status in ('provisioning', 'active', 'suspended', 'archived'));

alter table public.workspace_services drop constraint if exists workspace_services_status_check;
alter table public.workspace_services add constraint workspace_services_status_check
  check (status in ('enabled', 'trial', 'disabled', 'suspended'));
alter table public.workspace_services add column if not exists source text not null default 'manual';
alter table public.workspace_services drop constraint if exists workspace_services_source_check;
alter table public.workspace_services add constraint workspace_services_source_check
  check (source in ('plan', 'manual', 'custom_contract'));
alter table public.workspace_services add column if not exists starts_at timestamptz;
alter table public.workspace_services add column if not exists ends_at timestamptz;
alter table public.workspace_services drop constraint if exists workspace_services_window_check;
alter table public.workspace_services add constraint workspace_services_window_check
  check (starts_at is null or ends_at is null or ends_at > starts_at);

alter table public.platform_users drop constraint if exists platform_users_platform_role_check;
alter table public.platform_users add constraint platform_users_platform_role_check
  check (platform_role in ('platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only'));

-- The single place the pre-platform Wayne's code path is identified.  Legacy
-- Wayne-only functions keep working for this workspace only; new code must
-- never special-case it.
create or replace function public.hanafy_legacy_workspace_id()
returns uuid language sql immutable set search_path = '' as $$
  select '40000000-0000-4000-8000-000000000001'::uuid
$$;

-- Internal entitlement check (no caller-identity check: used by triggers,
-- workers and other SECURITY DEFINER functions).  Not granted to clients.
create or replace function public.hanafy_service_active(target_workspace_id uuid, required_service_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_services workspace_service
    join public.service_catalog service on service.id = workspace_service.service_id and service.active
    join public.workspaces workspace on workspace.id = workspace_service.workspace_id
    where workspace_service.workspace_id = target_workspace_id
      and service.code = required_service_code
      and workspace_service.status in ('enabled', 'trial')
      and (workspace_service.starts_at is null or workspace_service.starts_at <= now())
      and (workspace_service.ends_at is null or workspace_service.ends_at > now())
      and workspace.status in ('provisioning', 'active')
  );
$$;
revoke all on function public.hanafy_legacy_workspace_id() from public;
revoke all on function public.hanafy_service_active(uuid, text) from public;

create or replace function public.hanafy_workspace_service_enabled(target_workspace_id uuid, required_service_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (public.hanafy_is_workspace_member(target_workspace_id) or public.hanafy_has_platform_access())
    and public.hanafy_service_active(target_workspace_id, required_service_code);
$$;

-- ---------------------------------------------------------------------------
-- 1. Hostnames
-- ---------------------------------------------------------------------------
insert into public.workspace_domains (workspace_id, location_id, hostname, is_canonical)
select location.workspace_id, location.id, host.hostname, false
from public.locations location
join public.workspaces workspace on workspace.id = location.workspace_id and workspace.slug = 'waynes-pizza'
cross join (values ('www.waynespizzaofworcester.com'), ('waynes-pizza-pos.vercel.app')) as host(hostname)
where location.slug = 'worcester'
on conflict (hostname) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Messaging identity (only corrects the exact wrong Phase 4 backfill)
-- ---------------------------------------------------------------------------
update public.workspace_messaging_identities identity
set sender_address = '+15136764597',
    provider = 'aws_end_user_messaging',
    provider_configuration = jsonb_build_object(
      'region', 'us-east-1',
      'origination_identity', 'phone-ae22e45ef42b420b8e7096b9e67daf7b',
      'message_type', 'PROMOTIONAL',
      'managed_by', 'hanafy_crm'
    ),
    active = true
from public.workspaces workspace
where workspace.id = identity.workspace_id
  and workspace.slug = 'waynes-pizza'
  and identity.channel = 'sms'
  and identity.sender_address = '(508) 852-6326';

update public.workspace_messaging_identities identity
set active = false,
    provider = 'none'
from public.workspaces workspace
where workspace.id = identity.workspace_id
  and workspace.slug = 'waynes-pizza'
  and identity.channel = 'email'
  and identity.provider = 'aws';

-- ---------------------------------------------------------------------------
-- 3. Services Wayne's actually uses today
-- ---------------------------------------------------------------------------
insert into public.workspace_services (workspace_id, service_id, status, source, configuration)
select workspace.id, service.id, 'enabled', 'manual', '{}'::jsonb
from public.workspaces workspace
join public.service_catalog service on service.code in ('sms', 'automations')
where workspace.slug = 'waynes-pizza'
on conflict (workspace_id, service_id) do update
set status = 'enabled', disabled_at = null, updated_at = now()
where public.workspace_services.status = 'disabled';

-- ---------------------------------------------------------------------------
-- 3b. Brand names that used to be hard-coded in storefront copy.  Seeded for
--     Wayne's with exactly the wording the site shows today; other workspaces
--     derive them from their business name until they set their own.
-- ---------------------------------------------------------------------------
update public.location_settings location
set configuration = jsonb_build_object(
      'brand_name', 'Wayne’s Pizza',
      'brand_short_name', 'Wayne’s',
      'rewards_program_name', 'Wayne’s Rewards'
    ) || location.configuration
from public.workspaces workspace
where workspace.id = location.workspace_id
  and workspace.slug = 'waynes-pizza';

-- ---------------------------------------------------------------------------
-- 5. Platform-owner invitation
-- ---------------------------------------------------------------------------
create table if not exists public.platform_user_invites (
  email text primary key check (email = lower(btrim(email)) and email like '%_@_%'),
  platform_role text not null check (platform_role in ('platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only')),
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_auth_user_id uuid references auth.users(id) on delete set null
);
alter table public.platform_user_invites enable row level security;
revoke all on public.platform_user_invites from anon, authenticated;
grant select on public.platform_user_invites to authenticated;
drop policy if exists platform_user_invites_admin_select on public.platform_user_invites;
create policy platform_user_invites_admin_select on public.platform_user_invites
for select to authenticated using (public.hanafy_is_platform_admin());

-- Redeemed only once the Auth user has a confirmed email, so nobody can claim
-- platform access by registering someone else's address.
create or replace function public.hanafy_redeem_platform_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare invite public.platform_user_invites%rowtype;
begin
  if new.email is null or new.email_confirmed_at is null then return new; end if;
  select * into invite from public.platform_user_invites
  where email = lower(btrim(new.email)) and accepted_at is null
  for update;
  if not found then return new; end if;

  insert into public.platform_users (auth_user_id, platform_role, active)
  values (new.id, invite.platform_role, true)
  on conflict (auth_user_id) do update set platform_role = excluded.platform_role, active = true, updated_at = now();
  update public.platform_user_invites set accepted_at = now(), accepted_auth_user_id = new.id where email = invite.email;
  return new;
end;
$$;
revoke all on function public.hanafy_redeem_platform_invite() from public;

do $$
begin
  -- Local test databases model auth.users without Supabase's confirmation column.
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at') then
    execute 'drop trigger if exists hanafy_redeem_platform_invite on auth.users';
    execute 'create trigger hanafy_redeem_platform_invite after insert or update of email, email_confirmed_at on auth.users for each row execute function public.hanafy_redeem_platform_invite()';
  end if;
end;
$$;

insert into public.platform_user_invites (email, platform_role)
values ('hanafymedia@gmail.com', 'platform_owner')
on conflict (email) do nothing;

-- Redeem immediately if that confirmed account already exists.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at') then
    update auth.users set email = email
    where lower(email) in (select email from public.platform_user_invites where accepted_at is null)
      and email_confirmed_at is not null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Configuration mirrors (new tables are the source of truth; the legacy
--    singletons stay readable by the pre-platform functions).
--    pg_trigger_depth() guards stop the two directions from re-entering.
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_mirror_location_settings_to_legacy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  column_list text;
  value_list text;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  select string_agg(format('%I', column_name), ', ' order by ordinal_position),
         string_agg(format('source.%I', column_name), ', ' order by ordinal_position)
  into column_list, value_list
  from information_schema.columns
  where table_schema = 'public' and table_name = 'store_settings'
    and column_name not in ('id', 'workspace_id', 'location_id', 'created_at', 'updated_at');
  execute format(
    'update public.store_settings target set (%s) = (select %s from jsonb_populate_record(target, $1) source) where target.workspace_id = $2 and target.location_id = $3',
    column_list, value_list
  ) using new.configuration, new.workspace_id, new.location_id;
  return new;
end;
$$;

create or replace function public.hanafy_mirror_legacy_store_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  update public.location_settings
  set configuration = configuration || (to_jsonb(new) - array['id', 'workspace_id', 'location_id', 'created_at', 'updated_at']::text[])
  where workspace_id = new.workspace_id and location_id = new.location_id;
  return new;
end;
$$;

create or replace function public.hanafy_mirror_location_hardware_to_legacy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  column_list text;
  value_list text;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  select string_agg(format('%I', column_name), ', ' order by ordinal_position),
         string_agg(format('source.%I', column_name), ', ' order by ordinal_position)
  into column_list, value_list
  from information_schema.columns
  where table_schema = 'public' and table_name = 'pos_hardware_settings'
    and column_name not in ('id', 'workspace_id', 'location_id', 'updated_at', 'updated_by');
  execute format(
    'update public.pos_hardware_settings target set (%s) = (select %s from jsonb_populate_record(target, $1) source), updated_at = now(), updated_by = coalesce(auth.uid(), target.updated_by) where target.workspace_id = $2 and target.location_id = $3',
    column_list, value_list
  ) using new.configuration, new.workspace_id, new.location_id;
  return new;
end;
$$;

create or replace function public.hanafy_mirror_legacy_hardware_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  update public.location_hardware_configurations
  set configuration = configuration || (to_jsonb(new) - array['id', 'workspace_id', 'location_id', 'updated_at', 'updated_by']::text[])
  where workspace_id = new.workspace_id and location_id = new.location_id;
  return new;
end;
$$;

create or replace function public.hanafy_mirror_caller_line_to_legacy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  update public.store_phone_lines
  set label = new.label, phone_number = new.phone_number, active = new.active
  where workspace_id = new.workspace_id and location_id = new.location_id and line_number = new.line_number;
  if not found and new.workspace_id = public.hanafy_legacy_workspace_id() then
    insert into public.store_phone_lines (workspace_id, location_id, line_number, label, phone_number, active)
    values (new.workspace_id, new.location_id, new.line_number, coalesce(nullif(new.label, ''), 'Line ' || new.line_number), new.phone_number, new.active)
    on conflict (line_number) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.hanafy_mirror_legacy_phone_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  insert into public.location_caller_lines (workspace_id, location_id, line_number, label, phone_number, active)
  values (new.workspace_id, new.location_id, new.line_number, new.label, new.phone_number, new.active)
  on conflict (location_id, line_number) do update
  set label = excluded.label, phone_number = excluded.phone_number, active = excluded.active;
  return new;
end;
$$;

create or replace function public.hanafy_mirror_location_payment_to_legacy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  update public.payment_provider_settings
  set provider = new.provider,
      environment = new.environment,
      application_id = new.application_id,
      location_id = new.provider_location_id,
      notification_url = new.notification_url,
      online_card_enabled = new.online_card_enabled,
      terminal_card_enabled = new.terminal_card_enabled,
      updated_by_user_id = coalesce(auth.uid(), updated_by_user_id)
  where workspace_id = new.workspace_id;
  return new;
end;
$$;

create or replace function public.hanafy_mirror_legacy_payment_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  update public.location_payment_configurations
  set provider = new.provider,
      environment = new.environment,
      application_id = new.application_id,
      provider_location_id = new.location_id,
      notification_url = new.notification_url,
      online_card_enabled = new.online_card_enabled,
      terminal_card_enabled = new.terminal_card_enabled
  where workspace_id = new.workspace_id;
  return new;
end;
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'hanafy_mirror_location_settings_to_legacy', 'hanafy_mirror_legacy_store_settings',
    'hanafy_mirror_location_hardware_to_legacy', 'hanafy_mirror_legacy_hardware_settings',
    'hanafy_mirror_caller_line_to_legacy', 'hanafy_mirror_legacy_phone_line',
    'hanafy_mirror_location_payment_to_legacy', 'hanafy_mirror_legacy_payment_settings'
  ] loop
    execute format('revoke all on function public.%I() from public', fn);
  end loop;
end;
$$;

drop trigger if exists zzz_hanafy_mirror_to_legacy on public.location_settings;
create trigger zzz_hanafy_mirror_to_legacy after insert or update of configuration on public.location_settings
for each row execute function public.hanafy_mirror_location_settings_to_legacy();
drop trigger if exists zzz_hanafy_mirror_from_legacy on public.store_settings;
create trigger zzz_hanafy_mirror_from_legacy after update on public.store_settings
for each row execute function public.hanafy_mirror_legacy_store_settings();

drop trigger if exists zzz_hanafy_mirror_to_legacy on public.location_hardware_configurations;
create trigger zzz_hanafy_mirror_to_legacy after insert or update of configuration on public.location_hardware_configurations
for each row execute function public.hanafy_mirror_location_hardware_to_legacy();
drop trigger if exists zzz_hanafy_mirror_from_legacy on public.pos_hardware_settings;
create trigger zzz_hanafy_mirror_from_legacy after update on public.pos_hardware_settings
for each row execute function public.hanafy_mirror_legacy_hardware_settings();

drop trigger if exists zzz_hanafy_mirror_to_legacy on public.location_caller_lines;
create trigger zzz_hanafy_mirror_to_legacy after insert or update on public.location_caller_lines
for each row execute function public.hanafy_mirror_caller_line_to_legacy();
drop trigger if exists zzz_hanafy_mirror_from_legacy on public.store_phone_lines;
create trigger zzz_hanafy_mirror_from_legacy after insert or update on public.store_phone_lines
for each row execute function public.hanafy_mirror_legacy_phone_line();

drop trigger if exists zzz_hanafy_mirror_to_legacy on public.location_payment_configurations;
create trigger zzz_hanafy_mirror_to_legacy after insert or update on public.location_payment_configurations
for each row execute function public.hanafy_mirror_location_payment_to_legacy();
drop trigger if exists zzz_hanafy_mirror_from_legacy on public.payment_provider_settings;
create trigger zzz_hanafy_mirror_from_legacy after update on public.payment_provider_settings
for each row execute function public.hanafy_mirror_legacy_payment_settings();

-- Bring the pairs into line once, from the Phase 4 source of truth.
update public.location_settings set configuration = configuration;
update public.location_hardware_configurations set configuration = configuration;
update public.location_payment_configurations set updated_at = now();
update public.location_caller_lines set label = label;

-- ---------------------------------------------------------------------------
-- 7. Phase 4 defects
-- ---------------------------------------------------------------------------
-- Settings save: the location row is authoritative; the mirror trigger writes
-- the legacy singleton column-for-column (no hand-copied field list to drift).
create or replace function public.hanafy_save_location_settings(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_workspace_id uuid;
  selected_location_id uuid;
  saved public.location_settings%rowtype;
begin
  selected_workspace_id := (public.hanafy_current_workspace_access() ->> 'workspace_id')::uuid;
  if selected_workspace_id is null or not public.hanafy_has_workspace_permission(selected_workspace_id, 'content.manage') then
    raise exception 'Content management permission required' using errcode = '42501';
  end if;
  if jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'Settings must be an object' using errcode = '22023';
  end if;
  select id into selected_location_id from public.locations
  where workspace_id = selected_workspace_id and status = 'active' order by created_at limit 1;
  if selected_location_id is null then raise exception 'An active location is required' using errcode = 'P0002'; end if;

  update public.location_settings
    set configuration = configuration || (payload - 'receipt_header' - 'receipt_footer' - 'id'),
        receipt_header = coalesce(payload ->> 'receipt_header', receipt_header),
        receipt_footer = coalesce(payload ->> 'receipt_footer', receipt_footer)
    where workspace_id = selected_workspace_id and location_id = selected_location_id
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
  where workspace_id = selected_workspace_id;
  return saved.configuration || jsonb_build_object('receipt_header', saved.receipt_header, 'receipt_footer', saved.receipt_footer);
end;
$$;

create or replace function public.hanafy_normalize_hostname(target_hostname text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(lower(btrim(split_part(coalesce(target_hostname, ''), ':', 1))), '\.+$', '')
$$;
grant execute on function public.hanafy_normalize_hostname(text) to anon, authenticated;

-- Shared builder for the public (by hostname) and staff (by workspace) views
-- of a location's storefront settings.
create or replace function public.hanafy_location_store_settings(target_workspace_id uuid, target_location_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select location.configuration || jsonb_build_object(
    'id', true,
    'canonical_url', coalesce(
      (select 'https://' || domain.hostname from public.workspace_domains domain
       where domain.workspace_id = location.workspace_id and domain.location_id = location.location_id
         and domain.active and domain.is_canonical limit 1),
      location.configuration ->> 'canonical_url', ''),
    'special_hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', hours.id, 'service_date', hours.service_date, 'label', hours.label,
        'closed', hours.closed, 'opens_at', case when hours.opens_at is null then null else to_char(hours.opens_at, 'HH24:MI') end,
        'closes_at', case when hours.closes_at is null then null else to_char(hours.closes_at, 'HH24:MI') end,
        'public_note', hours.public_note
      ) order by hours.service_date)
      from public.store_special_hours hours
      where hours.workspace_id = location.workspace_id and hours.location_id = location.location_id and hours.archived_at is null
    ), '[]'::jsonb)
  )
  from public.location_settings location
  where location.workspace_id = target_workspace_id and location.location_id = target_location_id;
$$;
revoke all on function public.hanafy_location_store_settings(uuid, uuid) from public;

create or replace function public.hanafy_public_store_settings(target_hostname text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_location_store_settings(domain.workspace_id, domain.location_id)
    || jsonb_build_object('canonical_url', 'https://' || coalesce(
      (select canonical.hostname from public.workspace_domains canonical
       where canonical.workspace_id = domain.workspace_id and canonical.location_id = domain.location_id
         and canonical.active and canonical.is_canonical limit 1),
      domain.hostname))
  from public.workspace_domains domain
  join public.workspaces workspace on workspace.id = domain.workspace_id and workspace.status = 'active'
  where domain.hostname = public.hanafy_normalize_hostname(target_hostname)
    and domain.active
  limit 1;
$$;
revoke all on function public.hanafy_public_store_settings(text) from public;
grant execute on function public.hanafy_public_store_settings(text) to anon, authenticated;

comment on table public.platform_user_invites is 'Pending platform access, redeemed only by a confirmed Auth email. Workspace membership never implies platform access.';
comment on function public.hanafy_legacy_workspace_id() is 'The one workspace the pre-platform wayne_* functions serve. New code must use workspace context instead.';
