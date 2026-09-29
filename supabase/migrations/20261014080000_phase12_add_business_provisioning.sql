-- Hanafy Platform Phase 12: Add Business provisioning flow.
--
-- Build sheet §25, §39, §40 Phase 12.
--
--   * hanafy_platform_provision_workspace: one audited call creates a
--     business in 'provisioning' with its settings, first location (and that
--     location's settings, hardware and payment configuration rows) and ONLY
--     the services picked, checking service requirements (SMS needs CRM…).
--     A business can be flagged as a TEST workspace; nothing is sent or
--     activated automatically.  (§0: no real client workspace is created by
--     this migration — only the tools to do it deliberately.)
--   * hanafy_platform_provisioning_checklist: the §25.9 validation checklist
--     computed from real records (owner can sign in and open the business,
--     location complete, hours, messaging identity before SMS, payment
--     connection tested before cards, caller-ID device before caller ID,
--     web address before the website, billing agreement recorded…).
--   * hanafy_platform_set_workspace_status: activate (only when every
--     required check passes), suspend, archive (§39), reactivate — reason,
--     confirmation for anything live, audited.  Wayne's (the legacy
--     workspace) can never be archived from here.

alter table public.workspaces add column if not exists is_test boolean not null default false;
comment on column public.workspaces.is_test is 'Phase 12: a temporary test workspace created with Add Business. Never a real client.';

-- Slugs that would collide with platform routes or read as someone else.
create or replace function public.hanafy_reserved_slug(target_slug text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select target_slug = any(array['new', 'platform', 'admin', 'api', 'w', 'www', 'app', 'login', 'logout', 'signup', 'pos', 'kitchen', 'driver',
    'r', 'menu', 'order', 'checkout', 'rewards', 'offers', 'about', 'contact', 'terms', 'privacy', 'hanafy', 'hanafy-media', 'hanafymedia',
    'support', 'billing', 'settings', 'static', 'assets', 'public', 'unauthorized']);
$$;

-- The hardware defaults every new location starts with (simulator, nothing connected).
create or replace function public.hanafy_default_hardware_configuration()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{"caller_id_provider":"simulated","caller_device_model":"","caller_line_count":1,"caller_udp_port":3520,"caller_bind_address":"0.0.0.0","caller_device_ip":"","call_expire_minutes":10,"simulator_enabled":true,"receipt_printer":{},"kitchen_printers":[],"cash_drawer":{"connection":"none","model":""},"payment_terminal_mode":"manual_external"}'::jsonb;
$$;

-- ---------------------------------------------------------------------------
-- 1. Create a business (steps 1-3)
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_platform_provision_workspace(payload jsonb, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  business jsonb := coalesce(payload -> 'business', '{}'::jsonb);
  site jsonb := coalesce(payload -> 'location', '{}'::jsonb);
  slug_value text := lower(btrim(coalesce(business ->> 'slug', '')));
  name_value text := btrim(coalesce(business ->> 'name', ''));
  timezone_value text := coalesce(nullif(btrim(business ->> 'timezone'), ''), 'America/New_York');
  location_timezone text;
  currency_value text := upper(coalesce(nullif(btrim(business ->> 'currency_code'), ''), 'USD'));
  workspace_id_value uuid;
  location_id_value uuid;
  location_slug text;
  picked_code text;
  selected text[] := array[]::text[];
  missing text[];
  hours jsonb;
  day text;
  store_config jsonb;
  services_on text[];
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if change_reason is null or char_length(btrim(change_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)' using errcode = '22023'; end if;
  if name_value = '' or char_length(name_value) > 120 then raise exception 'Enter the business name (up to 120 characters)' using errcode = '22023'; end if;
  if slug_value !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or char_length(slug_value) > 60 then
    raise exception 'The web name (slug) uses lowercase letters, numbers and dashes, like joes-deli' using errcode = '22023';
  end if;
  if public.hanafy_reserved_slug(slug_value) then raise exception 'That web name is reserved; choose another' using errcode = '22023'; end if;
  if exists (select 1 from public.workspaces workspace where workspace.slug = slug_value) then
    raise exception 'A business already uses the web name %', slug_value using errcode = '23505';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names zone where zone.name = timezone_value) then
    raise exception 'Unknown time zone %', timezone_value using errcode = '22023';
  end if;
  location_timezone := coalesce(nullif(btrim(site ->> 'timezone'), ''), timezone_value);
  if not exists (select 1 from pg_catalog.pg_timezone_names zone where zone.name = location_timezone) then
    raise exception 'Unknown time zone %', location_timezone using errcode = '22023';
  end if;
  if currency_value !~ '^[A-Z]{3}$' then raise exception 'Currency is a 3-letter code like USD' using errcode = '22023'; end if;
  if nullif(btrim(site ->> 'name'), '') is null then raise exception 'Enter the first location''s name' using errcode = '22023'; end if;

  -- Services: known, active, and their requirements picked too.
  if jsonb_typeof(payload -> 'services') = 'array' then
    select array_agg(distinct value #>> '{}') into selected from jsonb_array_elements(payload -> 'services');
  end if;
  selected := coalesce(selected, array[]::text[]);
  foreach picked_code in array selected loop
    if not exists (select 1 from public.service_catalog service where service.code = picked_code and service.active) then
      raise exception 'Unknown service %', picked_code using errcode = '22023';
    end if;
    select requirement.requires_any into missing from public.service_requirements requirement
    where requirement.service_code = picked_code and not (requirement.requires_any && selected);
    if missing is not null then
      raise exception '% needs % as well', (select service.name from public.service_catalog service where service.code = picked_code),
        (select string_agg(service.name, ' or ' order by service.name) from public.service_catalog service where service.code = any(missing)) using errcode = '22023';
    end if;
  end loop;

  insert into public.workspaces (slug, name, status, timezone, currency_code, is_test, settings)
  values (slug_value, name_value, 'provisioning', timezone_value, currency_value, coalesce((business ->> 'is_test')::boolean, false),
    jsonb_strip_nulls(jsonb_build_object(
      'industry', nullif(btrim(business ->> 'industry'), ''),
      'primary_contact', jsonb_strip_nulls(jsonb_build_object('name', nullif(btrim(business ->> 'contact_name'), ''),
        'email', nullif(lower(btrim(business ->> 'contact_email')), ''), 'phone', nullif(btrim(business ->> 'contact_phone'), ''))),
      'provisioning', jsonb_build_object('started_at', now(), 'started_by', auth.uid()))))
  returning id into workspace_id_value;

  insert into public.workspace_settings (workspace_id, display_name, legal_name, support_email, support_phone)
  values (workspace_id_value, name_value, left(coalesce(btrim(business ->> 'legal_name'), ''), 240),
    left(coalesce(lower(btrim(business ->> 'contact_email')), ''), 254), left(coalesce(btrim(business ->> 'contact_phone'), ''), 40));

  location_slug := coalesce(nullif(regexp_replace(regexp_replace(lower(coalesce(site ->> 'slug', site ->> 'name')), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), ''), 'main');
  insert into public.locations (workspace_id, slug, name, status, timezone, address_line_1, address_line_2, city, state_region, postal_code, country_code, phone_number)
  values (workspace_id_value, left(location_slug, 60), btrim(site ->> 'name'), 'provisioning', location_timezone,
    coalesce(btrim(site ->> 'address_line_1'), ''), coalesce(btrim(site ->> 'address_line_2'), ''), coalesce(btrim(site ->> 'city'), ''),
    coalesce(btrim(site ->> 'state_region'), ''), coalesce(btrim(site ->> 'postal_code'), ''), upper(coalesce(nullif(btrim(site ->> 'country_code'), ''), 'US')),
    coalesce(btrim(site ->> 'phone'), ''))
  returning id into location_id_value;

  -- Hours: same open/close every day except the closed days.
  hours := '{}'::jsonb;
  foreach day in array array['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] loop
    hours := hours || jsonb_build_object(day, jsonb_build_object(
      'open', coalesce(nullif(site #>> '{hours,open}', ''), '11:00'), 'close', coalesce(nullif(site #>> '{hours,close}', ''), '21:00'),
      'closed', coalesce(site #> '{hours,closed_days}', '[]'::jsonb) ? day));
  end loop;
  if site #>> '{hours,open}' is not null and (site #>> '{hours,open}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Opening time looks like 11:00' using errcode = '22023'; end if;
  if site #>> '{hours,close}' is not null and (site #>> '{hours,close}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Closing time looks like 21:00' using errcode = '22023'; end if;

  store_config := jsonb_build_object(
    'store_name', name_value, 'brand_name', name_value, 'brand_short_name', name_value, 'timezone', location_timezone,
    'address_line1', coalesce(btrim(site ->> 'address_line_1'), ''), 'address_line2', coalesce(btrim(site ->> 'address_line_2'), ''),
    'city', coalesce(btrim(site ->> 'city'), ''), 'state', coalesce(btrim(site ->> 'state_region'), ''), 'postal_code', coalesce(btrim(site ->> 'postal_code'), ''),
    'public_phone', coalesce(btrim(site ->> 'phone'), ''), 'public_email', coalesce(lower(btrim(site ->> 'email')), ''),
    'business_hours', hours, 'ordering_open', false, 'pickup_enabled', true, 'delivery_enabled', 'delivery' = any(selected),
    'tips_enabled', false, 'test_ordering_enabled', true, 'tax_rate_basis_points', 0,
    'homepage_heading', name_value, 'seo_home_title', name_value, 'footer_text', name_value,
    'story', '', 'homepage_description', '', 'seo_home_description', name_value);
  insert into public.location_settings (location_id, workspace_id, configuration) values (location_id_value, workspace_id_value, store_config);
  insert into public.location_hardware_configurations (location_id, workspace_id, configuration)
  values (location_id_value, workspace_id_value, public.hanafy_default_hardware_configuration());
  insert into public.location_payment_configurations (location_id, workspace_id) values (location_id_value, workspace_id_value);
  if 'caller_id' = any(selected) then
    insert into public.location_caller_lines (workspace_id, location_id, line_number, label) values (workspace_id_value, location_id_value, 1, 'Line 1');
  end if;

  foreach picked_code in array selected loop
    insert into public.workspace_services (workspace_id, service_id, status, source, enabled_at)
    select workspace_id_value, service.id, 'enabled', case when payload ->> 'service_source' in ('plan', 'manual', 'custom_contract') then payload ->> 'service_source' else 'manual' end, now()
    from public.service_catalog service where service.code = picked_code;
  end loop;

  select array_agg(code order by code) into services_on from unnest(selected) code;
  perform public.hanafy_platform_write_audit('platform.workspace.provisioned', workspace_id_value, 'workspace', workspace_id_value::text,
    format('Started setting up %s%s (%s) with %s', name_value, case when coalesce((business ->> 'is_test')::boolean, false) then ' [TEST]' else '' end, slug_value,
      coalesce(array_to_string(services_on, ', '), 'no services')),
    null, jsonb_build_object('slug', slug_value, 'name', name_value, 'services', to_jsonb(coalesce(services_on, array[]::text[])), 'is_test', coalesce((business ->> 'is_test')::boolean, false)),
    btrim(change_reason), null);

  return jsonb_build_object('status', 'saved', 'workspace_id', workspace_id_value, 'slug', slug_value, 'location_id', location_id_value);
end;
$$;
revoke all on function public.hanafy_platform_provision_workspace(jsonb, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_provision_workspace(jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Validation checklist (§25.9), from real records only
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_provisioning_checklist(target_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  settings public.workspace_settings%rowtype;
  primary_location public.locations%rowtype;
  items jsonb := '[]'::jsonb;
  on_services text[] := coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(public.hanafy_active_services(target_workspace_id))), array[]::text[]);
  owner_row record;
  storefront boolean;
  cards boolean;
  pending_connections integer;
  good_connections integer;
  owner_permissions text[];
  add_item text;
begin
  select * into target from public.workspaces where id = target_workspace_id;
  select * into settings from public.workspace_settings where workspace_id = target_workspace_id;
  select * into primary_location from public.locations location where location.workspace_id = target_workspace_id and location.status <> 'archived'
  order by location.created_at limit 1;
  storefront := on_services && array['website_storefront', 'online_ordering'];
  cards := on_services && array['pos', 'online_ordering'];

  -- 1 Business details
  items := items || jsonb_build_object('key', 'business', 'step', 1, 'label', 'Business details (name, time zone, currency)', 'required', true, 'tab', '',
    'status', case when settings.workspace_id is not null and btrim(settings.display_name) <> '' and target.timezone <> '' then 'pass' else 'fail' end,
    'detail', coalesce(settings.display_name, 'No business settings yet') || ' · ' || target.timezone || ' · ' || target.currency_code);
  -- 2 Location
  items := items || jsonb_build_object('key', 'location', 'step', 2, 'label', 'First location with address and phone', 'required', true, 'tab', '',
    'status', case when primary_location.id is not null and btrim(primary_location.address_line_1) <> '' and btrim(primary_location.city) <> ''
      and btrim(primary_location.phone_number) <> '' then 'pass' else 'fail' end,
    'detail', case when primary_location.id is null then 'No location' else primary_location.name || ': ' ||
      coalesce(nullif(concat_ws(', ', nullif(primary_location.address_line_1, ''), nullif(primary_location.city, '')), ''), 'address missing') ||
      case when btrim(primary_location.phone_number) = '' then ' · phone missing' else ' · ' || primary_location.phone_number end end);
  items := items || jsonb_build_object('key', 'hours', 'step', 2, 'label', 'Opening hours', 'required', storefront, 'tab', '',
    'status', case when jsonb_typeof((select location.configuration -> 'business_hours' from public.location_settings location where location.location_id = primary_location.id)) = 'object' then 'pass'
      when storefront then 'fail' else 'optional' end,
    'detail', 'Change them in the business''s Website & hours screen.');
  -- 3 Services
  items := items || jsonb_build_object('key', 'services', 'step', 3, 'label', 'Services picked', 'required', true, 'tab', '/services',
    'status', case when cardinality(on_services) > 0 then 'pass' else 'fail' end,
    'detail', coalesce(array_to_string(on_services, ', '), 'none'));
  -- 4 Owner can sign in and open this business (access scoped by role)
  select membership.auth_user_id, auth_user.email, auth_user.email_confirmed_at, auth_user.last_sign_in_at, membership.workspace_role_id, profile.active as profile_active
  into owner_row
  from public.workspace_members membership
  join public.roles role on role.id = membership.workspace_role_id and role.code = 'owner'
  join auth.users auth_user on auth_user.id = membership.auth_user_id
  left join public.profiles profile on profile.id = membership.auth_user_id
  where membership.workspace_id = target_workspace_id and membership.status = 'active'
  order by membership.created_at limit 1;
  if owner_row.auth_user_id is not null then
    owner_permissions := coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(public.hanafy_entitled_permissions(target_workspace_id, owner_row.workspace_role_id))), array[]::text[]);
  end if;
  items := items || jsonb_build_object('key', 'owner', 'step', 4, 'label', 'Owner account', 'required', true, 'tab', '/users',
    'status', case when owner_row.auth_user_id is not null and owner_row.email_confirmed_at is not null and coalesce(owner_row.profile_active, true) then 'pass' else 'fail' end,
    'detail', case when owner_row.auth_user_id is null then 'Add the owner on the Users tab' else owner_row.email ||
      case when owner_row.last_sign_in_at is null then ' (has not signed in yet)' else ' (signed in)' end end);
  items := items || jsonb_build_object('key', 'access', 'step', 4, 'label', 'Owner access is limited to this business''s services', 'required', true, 'tab', '/users',
    'status', case when owner_permissions is not null and 'settings.manage' = any(owner_permissions) then 'pass' else 'fail' end,
    'detail', case when owner_permissions is null then 'No owner yet' else cardinality(owner_permissions) || ' permissions from the services picked' end);
  -- 5 Messaging identity before SMS
  if 'sms' = any(on_services) then
    items := items || jsonb_build_object('key', 'messaging', 'step', 5, 'label', 'Texting number set up', 'required', true, 'tab', '/messaging',
      'status', case when exists (select 1 from public.workspace_messaging_identities identity where identity.workspace_id = target_workspace_id and identity.channel = 'sms' and identity.active)
        then 'pass' else 'fail' end,
      'detail', coalesce((select identity.sender_address from public.workspace_messaging_identities identity
        where identity.workspace_id = target_workspace_id and identity.channel = 'sms' and identity.active limit 1), 'No SMS number yet'));
  end if;
  -- 6 Payments tested before live cards
  if cards then
    select count(*) filter (where connection.status in ('connected', 'manual')), count(*) filter (where connection.status in ('pending_verification', 'error'))
    into good_connections, pending_connections
    from public.payment_connections connection where connection.workspace_id = target_workspace_id and connection.status <> 'disabled';
    items := items || jsonb_build_object('key', 'payments', 'step', 6, 'label', 'Card payments tested', 'required', pending_connections > 0, 'tab', '/integrations',
      'status', case when pending_connections > 0 then 'fail' when good_connections > 0 then 'pass' else 'optional' end,
      'detail', case when pending_connections > 0 then pending_connections || ' connection(s) not tested yet'
        when good_connections > 0 then good_connections || ' working connection(s)' else 'No card processor: cash only until one is added' end);
  end if;
  -- 7 Hardware
  if 'caller_id' = any(on_services) then
    items := items || jsonb_build_object('key', 'caller_id', 'step', 7, 'label', 'Caller-ID box recorded and serving a line', 'required', true, 'tab', '/hardware',
      'status', case when exists (select 1 from public.location_caller_lines line join public.hardware_devices device on device.id = line.caller_id_device_id
        where line.workspace_id = target_workspace_id and line.active and device.status = 'active') then 'pass' else 'fail' end,
      'detail', 'Add the caller-ID box and tick its lines on the Hardware tab.');
  end if;
  items := items || jsonb_build_object('key', 'hardware', 'step', 7, 'label', 'No device reporting a problem', 'required', false, 'tab', '/hardware',
    'status', case when coalesce((public.hanafy_hardware_counts(target_workspace_id) ->> 'problems')::integer, 0) = 0 then 'pass' else 'fail' end,
    'detail', coalesce((public.hanafy_hardware_counts(target_workspace_id) ->> 'devices'), '0') || ' device(s) recorded');
  -- 8 Data import (optional)
  items := items || jsonb_build_object('key', 'import', 'step', 8, 'label', 'Customers / menu imported', 'required', false, 'tab', '',
    'status', 'optional',
    'detail', (select count(*) from public.customers customer where customer.workspace_id = target_workspace_id) || ' customers · ' ||
      (select count(*) from public.menu_items item where item.workspace_id = target_workspace_id) || ' menu items');
  -- Web address before the website
  if storefront then
    items := items || jsonb_build_object('key', 'domain', 'step', 9, 'label', 'Web address connected', 'required', true, 'tab', '/domains',
      'status', case when exists (select 1 from public.workspace_domains domain where domain.workspace_id = target_workspace_id and domain.active) then 'pass' else 'fail' end,
      'detail', coalesce((select string_agg(domain.hostname, ', ' order by domain.is_canonical desc) from public.workspace_domains domain
        where domain.workspace_id = target_workspace_id and domain.active), 'No web address yet'));
  end if;
  -- Hanafy billing (reminder, not blocking)
  items := items || jsonb_build_object('key', 'billing', 'step', 9, 'label', 'Hanafy agreement recorded', 'required', false, 'tab', '/billing',
    'status', case when (public.hanafy_workspace_billing_totals(target_workspace_id) -> 'agreement') <> 'null'::jsonb then 'pass' else 'optional' end,
    'detail', coalesce(public.hanafy_workspace_billing_totals(target_workspace_id) #>> '{agreement,label}', 'No agreement yet'));

  return jsonb_build_object(
    'status', target.status,
    'is_test', target.is_test,
    'items', items,
    'can_activate', target.status in ('provisioning', 'suspended')
      and not exists (select 1 from jsonb_array_elements(items) item where (item ->> 'required')::boolean and item ->> 'status' = 'fail'),
    'blocking', coalesce((select jsonb_agg(item ->> 'label') from jsonb_array_elements(items) item where (item ->> 'required')::boolean and item ->> 'status' = 'fail'), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.hanafy_provisioning_checklist(uuid) from public, anon, authenticated;

create or replace function public.hanafy_platform_workspace_setup(target_workspace_slug text)
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
  return public.hanafy_provisioning_checklist(target.id) || jsonb_build_object(
    'can_manage', public.hanafy_platform_role() in ('platform_owner', 'platform_admin'),
    'legacy', target.id = public.hanafy_legacy_workspace_id(),
    'settings', target.settings,
    'orders_30d', (select count(*) from public.orders orders where orders.workspace_id = target.id and orders.created_at > now() - interval '30 days'));
end;
$$;
revoke all on function public.hanafy_platform_workspace_setup(text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspace_setup(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Activate / suspend / archive (§25.10, §39)
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_platform_set_workspace_status(target_workspace_slug text, new_status text, change_reason text, confirmed boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  checklist jsonb;
  warnings jsonb := '[]'::jsonb;
  recent integer;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if change_reason is null or char_length(btrim(change_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)' using errcode = '22023'; end if;
  if new_status not in ('active', 'suspended', 'archived') then raise exception 'Choose active, suspended or archived' using errcode = '22023'; end if;
  select * into target from public.workspaces where slug = target_workspace_slug for update;
  if target.id is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  if target.status = new_status then return jsonb_build_object('status', 'unchanged'); end if;
  if target.status = 'archived' then raise exception 'An archived business stays archived' using errcode = '22023'; end if;

  if new_status = 'active' then
    checklist := public.hanafy_provisioning_checklist(target.id);
    if not (checklist ->> 'can_activate')::boolean then
      raise exception 'Not ready to go live: %', (select string_agg(value #>> '{}', '; ') from jsonb_array_elements(checklist -> 'blocking')) using errcode = '22023';
    end if;
    if not target.is_test and not confirmed then
      return jsonb_build_object('status', 'needs_confirmation', 'warnings',
        jsonb_build_array(format('%s goes live: its staff can use every service picked and its website answers on its web address.', target.name)));
    end if;
    update public.locations set status = 'active' where workspace_id = target.id and status = 'provisioning';
  else
    if target.id = public.hanafy_legacy_workspace_id() and new_status = 'archived' then
      raise exception '% cannot be archived from here', target.name using errcode = '42501';
    end if;
    select count(*) into recent from public.orders orders where orders.workspace_id = target.id and orders.created_at > now() - interval '30 days';
    if target.status = 'active' then
      warnings := warnings || to_jsonb(format('%s stops working for its staff and customers right away (%s orders in the last 30 days).', target.name, recent));
    end if;
    if new_status = 'archived' then
      warnings := warnings || to_jsonb('Archiving is permanent from this screen; records are kept but the business cannot be reopened here.'::text);
    end if;
    if jsonb_array_length(warnings) > 0 and not confirmed then
      return jsonb_build_object('status', 'needs_confirmation', 'warnings', warnings);
    end if;
    if new_status = 'archived' then
      -- Its web addresses stop answering; nothing else is deleted.
      update public.workspace_domains set active = false where workspace_id = target.id;
    end if;
  end if;

  update public.workspaces set status = new_status,
    settings = settings || case when new_status = 'active' and target.status = 'provisioning'
      then jsonb_build_object('activated_at', now(), 'activated_by', auth.uid()) else '{}'::jsonb end
  where id = target.id;
  perform public.hanafy_platform_write_audit('platform.workspace.' || case new_status when 'active' then 'activated' else new_status end, target.id, 'workspace', target.id::text,
    format('%s is now %s (was %s)', target.name, new_status, target.status), jsonb_build_object('status', target.status), jsonb_build_object('status', new_status),
    btrim(change_reason), null);
  return jsonb_build_object('status', 'saved');
end;
$$;
revoke all on function public.hanafy_platform_set_workspace_status(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.hanafy_platform_set_workspace_status(text, text, text, boolean) to authenticated;
