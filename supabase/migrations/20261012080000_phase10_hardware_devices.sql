-- Hanafy Platform Phase 10: hardware / device administration.
--
-- Build sheet §21, §22, §11.3 (Hardware), §40 Phase 10.
--
--   * hardware_devices (§21.1): one registry row per physical device, per
--     workspace/location: type, vendor/model/serial/asset tag, ownership,
--     connection (ip/mac/protocol/port), assigned service, health.
--   * The store's operational hardware settings (Admin → Hardware,
--     location_hardware_configurations) stay the source the POS, print
--     station and caller-ID bridge read.  The registry follows them: saving
--     Admin → Hardware creates/updates the matching printer, drawer and
--     caller-ID rows, and a device removed from the settings is marked
--     inactive, never deleted.  Registry-only facts (ownership, serial,
--     asset tag, notes) are kept across those updates.
--   * Health (§21.4) comes only from real activity: a printed / failed print
--     job, a real (non-simulated) caller-ID ring, or a bridge heartbeat.
--     Devices Hanafy cannot observe (router, access point, a processor's own
--     card terminal) are 'not_monitored' and are never shown online just
--     because a row exists.
--   * Caller-ID lines (§22 phone_lines = location_caller_lines) get their
--     caller-ID device; caller events (phone_calls) get their phone line.
--   * payment_terminals.hardware_device_id links a terminal to its device.
--   * Platform Admin → Hardware (list, add, change, retire; audited).
--
-- Adapters are untouched (§21.3): operational code still goes through the
-- CallerIdProvider / printer / drawer / payment provider interfaces.

-- ---------------------------------------------------------------------------
-- 1. Registry
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  location_id uuid,
  device_type text not null check (device_type in ('pos_tablet', 'kitchen_display', 'caller_id', 'receipt_printer', 'kitchen_printer',
    'cash_drawer', 'payment_terminal', 'router', 'access_point', 'ups', 'other')),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  vendor text check (vendor is null or char_length(vendor) <= 120),
  model text check (model is null or char_length(model) <= 160),
  serial_number text check (serial_number is null or char_length(serial_number) <= 120),
  asset_tag text check (asset_tag is null or char_length(asset_tag) <= 60),
  status text not null default 'active' check (status in ('planned', 'active', 'inactive', 'retired')),
  ownership_type text not null default 'unknown' check (ownership_type in ('customer_owned', 'hanafy_owned', 'financed', 'leased', 'unknown')),
  connection_type text check (connection_type is null or connection_type in ('ethernet', 'wifi', 'usb', 'serial', 'bluetooth', 'printer_port', 'other')),
  ip_address inet,
  mac_address macaddr,
  protocol text check (protocol is null or protocol ~ '^[a-z0-9_\-]{1,40}$'),
  port integer check (port is null or port between 1 and 65535),
  assigned_service text check (assigned_service is null or assigned_service ~ '^[a-z][a-z0-9_]{1,40}$'),
  monitoring text not null default 'not_monitored' check (monitoring in ('telemetry', 'not_monitored')),
  last_seen_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) <= 500),
  error_count integer not null default 0 check (error_count >= 0),
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object'),
  notes text check (notes is null or char_length(notes) <= 1000),
  -- Where the row is mirrored from, e.g. 'location_hardware:receipt_printer'.
  source_key text check (source_key is null or source_key ~ '^[a-z_]+:[a-z0-9_:\-]+$'),
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, location_id, source_key),
  check ((status = 'retired') = (retired_at is not null)),
  foreign key (location_id, workspace_id) references public.locations(id, workspace_id) on delete restrict
);
create index if not exists hardware_devices_workspace_idx on public.hardware_devices(workspace_id, location_id, device_type);
create unique index if not exists hardware_devices_asset_tag_unique on public.hardware_devices(workspace_id, asset_tag) where asset_tag is not null;

comment on table public.hardware_devices is
  'Phase 10 (§21): device registry per workspace/location. Operational settings stay in location_hardware_configurations; health only from real activity.';
comment on column public.hardware_devices.monitoring is
  'telemetry: Hanafy sees real activity from this device (prints, rings, heartbeats). not_monitored: nothing reports on it, so it never shows online.';

-- No secrets in browser-readable configuration (§21.1).
create or replace function public.hanafy_hardware_secret_problem(value jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare item record; found text;
begin
  if value is null then return null; end if;
  if jsonb_typeof(value) = 'object' then
    for item in select key, child from jsonb_each(value) as entry(key, child) loop
      if lower(item.key) ~ '(password|passwd|secret|token|api_?key|private_?key|psk|wpa|credential)' then
        return 'field "' || item.key || '" looks like a secret';
      end if;
      found := public.hanafy_hardware_secret_problem(item.child);
      if found is not null then return found; end if;
    end loop;
  elsif jsonb_typeof(value) = 'array' then
    for item in select child from jsonb_array_elements(value) as entry(child) loop
      found := public.hanafy_hardware_secret_problem(item.child);
      if found is not null then return found; end if;
    end loop;
  end if;
  return null;
end;
$$;

create or replace function public.hanafy_hardware_device_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare problem text := public.hanafy_hardware_secret_problem(new.configuration);
begin
  if problem is not null then
    raise exception 'HARDWARE_SECRET_REFUSED: % (keep device passwords out of Hanafy; configuration is visible to the business''s managers)', problem using errcode = '22023';
  end if;
  if new.status = 'retired' and new.retired_at is null then new.retired_at := now(); end if;
  if new.status <> 'retired' then new.retired_at := null; end if;
  -- A device nobody observes carries no health, whatever a caller sends.
  if new.monitoring = 'not_monitored' then
    new.last_seen_at := null; new.last_success_at := null; new.last_error_at := null; new.last_error_summary := null; new.error_count := 0;
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_hardware_device_rules() from public, anon, authenticated;

drop trigger if exists ab_hanafy_hardware_device_rules on public.hardware_devices;
create trigger ab_hanafy_hardware_device_rules before insert or update on public.hardware_devices
for each row execute function public.hanafy_hardware_device_rules();
drop trigger if exists aa_hanafy_guard_platform_row on public.hardware_devices;
create trigger aa_hanafy_guard_platform_row before insert or update on public.hardware_devices
for each row execute function public.hanafy_guard_platform_row();
drop trigger if exists hardware_devices_set_updated_at on public.hardware_devices;
create trigger hardware_devices_set_updated_at before update on public.hardware_devices
for each row execute function public.set_updated_at();

alter table public.hardware_devices enable row level security;
revoke all on public.hardware_devices from anon, authenticated;
grant select on public.hardware_devices to authenticated;
drop policy if exists hardware_devices_workspace_read on public.hardware_devices;
create policy hardware_devices_workspace_read on public.hardware_devices for select to authenticated
using (public.hanafy_can_access_workspace_data(workspace_id, array['hardware.manage']));
-- Writes only through the audited RPCs and triggers below.

-- Health as shown everywhere (§21.4).  Never 'ok' without real activity.
create or replace function public.hanafy_hardware_health(device public.hardware_devices)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when device.status in ('retired', 'inactive') then 'off'
    when device.monitoring = 'not_monitored' then 'not_monitored'
    when device.last_seen_at is null and device.last_error_at is null then 'unknown'
    when device.last_error_at is not null and device.last_error_at >= coalesce(device.last_success_at, '-infinity'::timestamptz)
      and device.last_error_at > now() - interval '24 hours' then 'error'
    when device.last_seen_at > now() - interval '24 hours' then 'ok'
    else 'stale'
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Links: caller-ID lines (§22), caller events, payment terminals
-- ---------------------------------------------------------------------------
alter table public.location_caller_lines add column if not exists caller_id_device_id uuid;
alter table public.phone_calls add column if not exists phone_line_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'location_caller_lines_device_fk') then
    alter table public.location_caller_lines add constraint location_caller_lines_device_fk
      foreign key (caller_id_device_id, workspace_id) references public.hardware_devices(id, workspace_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'location_caller_lines_id_workspace_key') then
    alter table public.location_caller_lines add constraint location_caller_lines_id_workspace_key unique (id, workspace_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'phone_calls_phone_line_fk') then
    alter table public.phone_calls add constraint phone_calls_phone_line_fk
      foreign key (phone_line_id, workspace_id) references public.location_caller_lines(id, workspace_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_terminals_hardware_device_fk') then
    alter table public.payment_terminals add constraint payment_terminals_hardware_device_fk
      foreign key (hardware_device_id, workspace_id) references public.hardware_devices(id, workspace_id) on delete restrict;
  end if;
end;
$$;
create index if not exists phone_calls_phone_line_idx on public.phone_calls(phone_line_id);

-- Only a caller-ID device at the same location can serve caller lines.
create or replace function public.hanafy_caller_line_device_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.caller_id_device_id is not null and not exists (
    select 1 from public.hardware_devices device where device.id = new.caller_id_device_id and device.device_type = 'caller_id'
      and device.location_id is not distinct from new.location_id) then
    raise exception 'Caller lines can only be served by a caller-ID device at the same location' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_caller_line_device_check() from public, anon, authenticated;
drop trigger if exists ab_hanafy_caller_line_device_check on public.location_caller_lines;
create trigger ab_hanafy_caller_line_device_check before insert or update of caller_id_device_id on public.location_caller_lines
for each row execute function public.hanafy_caller_line_device_check();

-- Each ring is tied to its line; a real ring is proof the caller-ID box is alive.
create or replace function public.hanafy_phone_call_line_and_health()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare line public.location_caller_lines%rowtype;
begin
  if new.phone_line_id is null and new.line_number is not null and new.location_id is not null then
    select * into line from public.location_caller_lines where location_id = new.location_id and line_number = new.line_number;
    new.phone_line_id := line.id;
  elsif new.phone_line_id is not null then
    select * into line from public.location_caller_lines where id = new.phone_line_id;
  end if;
  if tg_op = 'INSERT' and not coalesce(new.simulated, false) and line.caller_id_device_id is not null then
    update public.hardware_devices set last_seen_at = greatest(coalesce(last_seen_at, '-infinity'::timestamptz), coalesce(new.started_at, now())),
      last_success_at = greatest(coalesce(last_success_at, '-infinity'::timestamptz), coalesce(new.started_at, now()))
    where id = line.caller_id_device_id and monitoring = 'telemetry';
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_phone_call_line_and_health() from public, anon, authenticated;
drop trigger if exists ac_hanafy_phone_call_line on public.phone_calls;
create trigger ac_hanafy_phone_call_line before insert or update of line_number, location_id, phone_line_id on public.phone_calls
for each row execute function public.hanafy_phone_call_line_and_health();

-- A finished print job is proof the printer (and a kicked drawer) answered.
create or replace function public.hanafy_print_job_device_health()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  keys text[];
begin
  if new.status is not distinct from old.status or new.status not in ('printed', 'failed') then return null; end if;
  keys := case new.destination
    when 'receipt' then array['location_hardware:receipt_printer'] || case when new.job_type = 'drawer_kick' then array['location_hardware:cash_drawer'] else array[]::text[] end
    when 'kitchen' then array['location_hardware:kitchen_printer_0']
    else array[]::text[] end;
  if new.status = 'printed' then
    update public.hardware_devices set last_seen_at = now(), last_success_at = now()
    where workspace_id = new.workspace_id and location_id = new.location_id and source_key = any(keys) and monitoring = 'telemetry';
  else
    update public.hardware_devices set last_error_at = now(), error_count = error_count + 1,
      last_error_summary = left(coalesce(nullif(new.last_error, ''), 'Print job failed'), 500)
    where workspace_id = new.workspace_id and location_id = new.location_id and source_key = any(keys) and monitoring = 'telemetry';
  end if;
  return null;
end;
$$;
revoke all on function public.hanafy_print_job_device_health() from public, anon, authenticated;
drop trigger if exists zz_hanafy_print_job_device_health on public.print_jobs;
create trigger zz_hanafy_print_job_device_health after update of status on public.print_jobs
for each row execute function public.hanafy_print_job_device_health();

-- Bridges (print station, caller-ID bridge, Android app) report in here (server only).
create or replace function public.hanafy_hardware_heartbeat(target_device_id uuid, succeeded boolean, message text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare device public.hardware_devices%rowtype;
begin
  select * into device from public.hardware_devices where id = target_device_id for update;
  if device.id is null then raise exception 'Device not found' using errcode = 'P0002'; end if;
  if device.monitoring <> 'telemetry' or device.status not in ('active', 'planned') then
    return jsonb_build_object('recorded', false, 'reason', 'device is not monitored');
  end if;
  if succeeded then
    update public.hardware_devices set last_seen_at = now(), last_success_at = now() where id = device.id;
  else
    update public.hardware_devices set last_seen_at = now(), last_error_at = now(), error_count = error_count + 1,
      last_error_summary = left(coalesce(nullif(btrim(message), ''), 'Device reported a problem'), 500) where id = device.id;
  end if;
  return jsonb_build_object('recorded', true);
end;
$$;
revoke all on function public.hanafy_hardware_heartbeat(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.hanafy_hardware_heartbeat(uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The registry follows Admin → Hardware
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_try_inet(value text)
returns inet language plpgsql immutable set search_path = '' as $$
begin
  if value is null or btrim(value) = '' then return null; end if;
  return btrim(value)::inet;
exception when others then return null;
end;
$$;

create or replace function public.hanafy_try_macaddr(value text)
returns macaddr language plpgsql immutable set search_path = '' as $$
begin
  if value is null or btrim(value) = '' then return null; end if;
  return btrim(value)::macaddr;
exception when others then return null;
end;
$$;

create or replace function public.hanafy_try_port(value text)
returns integer language plpgsql immutable set search_path = '' as $$
declare parsed integer;
begin
  if value is null or btrim(value) !~ '^[0-9]{1,5}$' then return null; end if;
  parsed := btrim(value)::integer;
  return case when parsed between 1 and 65535 then parsed end;
end;
$$;

create or replace function public.hanafy_upsert_config_device(
  target_workspace_id uuid, target_location_id uuid, key_value text, type_value text, name_value text, model_value text,
  vendor_value text, connection_value text, ip_value text, mac_value text, protocol_value text, port_value integer,
  service_value text, monitoring_value text, active_value boolean, config_value jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare device_id uuid;
begin
  insert into public.hardware_devices (workspace_id, location_id, source_key, device_type, name, model, vendor, connection_type,
    ip_address, mac_address, protocol, port, assigned_service, monitoring, status, configuration)
  values (target_workspace_id, target_location_id, key_value, type_value, coalesce(nullif(btrim(name_value), ''), initcap(replace(type_value, '_', ' '))),
    nullif(btrim(model_value), ''), vendor_value, connection_value, public.hanafy_try_inet(ip_value), public.hanafy_try_macaddr(mac_value),
    nullif(lower(btrim(protocol_value)), ''), port_value, service_value, monitoring_value,
    case when active_value then 'active' else 'inactive' end, coalesce(config_value, '{}'::jsonb))
  on conflict (workspace_id, location_id, source_key) do update set
    device_type = excluded.device_type,
    name = excluded.name,
    model = coalesce(excluded.model, public.hardware_devices.model),
    vendor = coalesce(public.hardware_devices.vendor, excluded.vendor),
    connection_type = excluded.connection_type,
    ip_address = excluded.ip_address,
    mac_address = coalesce(excluded.mac_address, public.hardware_devices.mac_address),
    protocol = excluded.protocol,
    port = excluded.port,
    assigned_service = excluded.assigned_service,
    monitoring = excluded.monitoring,
    status = case when public.hardware_devices.status = 'retired' then 'retired' else excluded.status end,
    configuration = excluded.configuration
  returning id into device_id;
  return device_id;
end;
$$;
revoke all on function public.hanafy_upsert_config_device(uuid, uuid, text, text, text, text, text, text, text, text, text, integer, text, text, boolean, jsonb) from public, anon, authenticated;

create or replace function public.hanafy_sync_hardware_registry(target_workspace_id uuid, target_location_id uuid, config jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  printer jsonb;
  kitchen jsonb;
  index_value integer := 0;
  keys text[] := array[]::text[];
  caller_device uuid;
  drawer_connection text := coalesce(config #>> '{cash_drawer,connection}', 'none');
  caller_mode text := coalesce(config ->> 'caller_id_provider', 'simulated');
  vendor_of text;
begin
  if config is null or target_location_id is null then return; end if;

  printer := config -> 'receipt_printer';
  if printer is not null and jsonb_typeof(printer) = 'object' and coalesce(nullif(printer ->> 'ip', ''), nullif(printer ->> 'model', '')) is not null then
    vendor_of := case when printer ->> 'model' ilike 'epson%' or printer ->> 'model_key' like 'epson%' then 'Epson'
                      when printer ->> 'model' ilike 'star%' or printer ->> 'model_key' like 'star%' then 'Star Micronics' end;
    perform public.hanafy_upsert_config_device(target_workspace_id, target_location_id, 'location_hardware:receipt_printer', 'receipt_printer',
      coalesce(nullif(printer ->> 'name', ''), 'Receipt printer'), printer ->> 'model', vendor_of,
      case when nullif(printer ->> 'ip', '') is not null then 'ethernet' end,
      printer ->> 'ip', printer ->> 'mac', printer ->> 'protocol', public.hanafy_try_port(printer ->> 'port'), 'pos', 'telemetry',
      coalesce((printer ->> 'enabled')::boolean, true),
      jsonb_strip_nulls(jsonb_build_object('model_key', printer ->> 'model_key', 'paper_width_mm', printer -> 'paper_width_mm',
        'online_order_slips', printer -> 'online_order_slips', 'tip_slip', printer ->> 'tip_slip', 'auto_delivery_receipts', printer -> 'auto_delivery_receipts',
        'print_destination', 'receipt')));
    keys := keys || 'location_hardware:receipt_printer'::text;
  end if;

  if jsonb_typeof(config -> 'kitchen_printers') = 'array' then
    for kitchen in select value from jsonb_array_elements(config -> 'kitchen_printers') loop
      if jsonb_typeof(kitchen) = 'object' and coalesce(nullif(kitchen ->> 'ip', ''), nullif(kitchen ->> 'model', '')) is not null then
        vendor_of := case when kitchen ->> 'model' ilike 'epson%' or kitchen ->> 'model_key' like 'epson%' then 'Epson'
                          when kitchen ->> 'model' ilike 'star%' or kitchen ->> 'model_key' like 'star%' then 'Star Micronics' end;
        perform public.hanafy_upsert_config_device(target_workspace_id, target_location_id, 'location_hardware:kitchen_printer_' || index_value, 'kitchen_printer',
          coalesce(nullif(kitchen ->> 'name', ''), 'Kitchen printer'), kitchen ->> 'model', vendor_of,
          case when nullif(kitchen ->> 'ip', '') is not null then 'ethernet' end,
          kitchen ->> 'ip', kitchen ->> 'mac', kitchen ->> 'protocol', public.hanafy_try_port(kitchen ->> 'port'), 'pos', 'telemetry',
          coalesce((kitchen ->> 'enabled')::boolean, true),
          jsonb_strip_nulls(jsonb_build_object('model_key', kitchen ->> 'model_key', 'paper_width_mm', kitchen -> 'paper_width_mm',
            'two_color', kitchen -> 'two_color', 'routing_categories', kitchen -> 'routing_categories',
            'print_destination', case when index_value = 0 then 'kitchen' end)));
        keys := keys || ('location_hardware:kitchen_printer_' || index_value);
      end if;
      index_value := index_value + 1;
    end loop;
  end if;

  if drawer_connection <> 'none' then
    perform public.hanafy_upsert_config_device(target_workspace_id, target_location_id, 'location_hardware:cash_drawer', 'cash_drawer',
      'Cash drawer', coalesce(nullif(config #>> '{cash_drawer,model}', ''), 'Cash drawer'), null,
      case when drawer_connection = 'receipt_printer' then 'printer_port' else 'other' end, null, null, null, null, 'pos',
      -- A drawer kicked through the receipt printer is observed via its drawer-kick jobs.
      case when drawer_connection = 'receipt_printer' then 'telemetry' else 'not_monitored' end, true,
      jsonb_build_object('connection', drawer_connection));
    keys := keys || 'location_hardware:cash_drawer'::text;
  end if;

  if nullif(config ->> 'caller_device_model', '') is not null or caller_mode <> 'simulated' then
    caller_device := public.hanafy_upsert_config_device(target_workspace_id, target_location_id, 'location_hardware:caller_id', 'caller_id',
      'Caller ID box', config ->> 'caller_device_model',
      case when config ->> 'caller_device_model' ilike '%callerid.com%' or config ->> 'caller_device_model' ilike '%whozz%' then 'CallerID.com' end,
      'ethernet', config ->> 'caller_device_ip', null, 'udp', public.hanafy_try_port(config ->> 'caller_udp_port'), 'caller_id', 'telemetry', true,
      jsonb_strip_nulls(jsonb_build_object('provider_mode', caller_mode, 'line_count', config -> 'caller_line_count', 'bind_address', config ->> 'caller_bind_address',
        'simulator_enabled', config -> 'simulator_enabled')));
    keys := keys || 'location_hardware:caller_id'::text;
    update public.location_caller_lines set caller_id_device_id = caller_device
    where workspace_id = target_workspace_id and location_id = target_location_id and caller_id_device_id is null;
  end if;

  -- Gone from the settings: keep the record (history, equipment balances), mark it inactive.
  update public.hardware_devices set status = 'inactive'
  where workspace_id = target_workspace_id and location_id = target_location_id
    and source_key like 'location_hardware:%' and not (source_key = any(keys)) and status = 'active';
end;
$$;
revoke all on function public.hanafy_sync_hardware_registry(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.hanafy_sync_hardware_registry_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.hanafy_sync_hardware_registry(new.workspace_id, new.location_id, new.configuration);
  return null;
end;
$$;
revoke all on function public.hanafy_sync_hardware_registry_trigger() from public, anon, authenticated;
drop trigger if exists zz_hanafy_hardware_registry on public.location_hardware_configurations;
create trigger zz_hanafy_hardware_registry after insert or update of configuration on public.location_hardware_configurations
for each row execute function public.hanafy_sync_hardware_registry_trigger();

-- ---------------------------------------------------------------------------
-- 4. Backfill Wayne's known hardware
-- ---------------------------------------------------------------------------
select public.hanafy_sync_hardware_registry(config.workspace_id, config.location_id, config.configuration)
from public.location_hardware_configurations config;

-- Wayne's store equipment is owned outright by the owner (not leased from Thrive).
update public.hardware_devices device set ownership_type = 'customer_owned',
  notes = coalesce(device.notes, 'Owned by the store owner (bought outright).')
from public.workspaces workspace
where workspace.id = device.workspace_id and workspace.slug = 'waynes-pizza' and device.ownership_type = 'unknown'
  and device.device_type in ('receipt_printer', 'kitchen_printer', 'cash_drawer', 'caller_id');

update public.hardware_devices device set notes = 'The owner''s own Whozz Calling? unit, repurposed from the old system. Health shows once real rings arrive (the POS runs the simulator until the bridge is switched on).'
from public.workspaces workspace
where workspace.id = device.workspace_id and workspace.slug = 'waynes-pizza' and device.device_type = 'caller_id';

-- Network gear Hanafy needs to know about (not monitored).
insert into public.hardware_devices (workspace_id, location_id, source_key, device_type, name, vendor, model, ownership_type, connection_type, assigned_service, monitoring, configuration, notes)
select location.workspace_id, location.id, 'manual:router', 'router', 'Store router', 'MikroTik', 'MikroTik router', 'customer_owned', 'ethernet', 'hardware_management', 'not_monitored',
  jsonb_build_object('lan_subnet', '10.10.10.0/24', 'remote_access', 'VPN'), 'Store LAN 10.10.10.x; reachable remotely over the store VPN. Owned by the store owner.'
from public.locations location join public.workspaces workspace on workspace.id = location.workspace_id and workspace.slug = 'waynes-pizza'
where location.slug = 'worcester'
on conflict (workspace_id, location_id, source_key) do nothing;

insert into public.hardware_devices (workspace_id, location_id, source_key, device_type, name, vendor, model, ownership_type, connection_type, assigned_service, monitoring, configuration, notes)
select location.workspace_id, location.id, 'manual:access_point', 'access_point', 'Store Wi-Fi access point', 'EnGenius', 'EnGenius access point', 'customer_owned', 'ethernet', 'hardware_management', 'not_monitored',
  jsonb_build_object('ssid', 'ThriveAP'), 'Store Wi-Fi "ThriveAP" on 10.10.10.x. Owned by the store owner.'
from public.locations location join public.workspaces workspace on workspace.id = location.workspace_id and workspace.slug = 'waynes-pizza'
where location.slug = 'worcester'
on conflict (workspace_id, location_id, source_key) do nothing;

-- Every card terminal gets a device record and the link (§20.3 ↔ §21).
insert into public.hardware_devices (workspace_id, location_id, source_key, device_type, name, vendor, ownership_type, assigned_service, monitoring, configuration, notes)
select terminal.workspace_id, terminal.location_id, 'payment_terminal:' || terminal.id::text, 'payment_terminal', terminal.label,
  nullif(connection.merchant_reference, ''), 'unknown', 'pos',
  case when terminal.terminal_type = 'provider_reader' then 'telemetry' else 'not_monitored' end,
  jsonb_build_object('terminal_type', terminal.terminal_type),
  case when terminal.terminal_type = 'external_manual' then 'The processor''s own terminal. The POS never talks to it; ownership (store or processor) still to be confirmed.' end
from public.payment_terminals terminal
left join public.payment_connections connection on connection.id = terminal.payment_connection_id
where terminal.hardware_device_id is null and terminal.location_id is not null
on conflict (workspace_id, location_id, source_key) do nothing;

update public.payment_terminals terminal set hardware_device_id = device.id
from public.hardware_devices device
where terminal.hardware_device_id is null and device.workspace_id = terminal.workspace_id
  and device.source_key = 'payment_terminal:' || terminal.id::text;

-- Caller events learn their line.
update public.phone_calls call set phone_line_id = line.id
from public.location_caller_lines line
where call.phone_line_id is null and line.location_id = call.location_id and line.line_number = call.line_number;

-- The caller-ID box's last real ring counts as last seen.
update public.hardware_devices device set last_seen_at = rings.last_ring, last_success_at = rings.last_ring
from (
  select line.caller_id_device_id, max(call.started_at) as last_ring
  from public.phone_calls call join public.location_caller_lines line on line.id = call.phone_line_id
  where not coalesce(call.simulated, false) and line.caller_id_device_id is not null
  group by line.caller_id_device_id
) rings
where device.id = rings.caller_id_device_id and rings.last_ring is not null;

-- Print history counts too.
update public.hardware_devices device set last_seen_at = jobs.last_printed, last_success_at = jobs.last_printed
from (
  select job.workspace_id, job.location_id,
    case job.destination when 'receipt' then 'location_hardware:receipt_printer' when 'kitchen' then 'location_hardware:kitchen_printer_0' end as key,
    max(job.printed_at) as last_printed
  from public.print_jobs job where job.status = 'printed' and job.printed_at is not null group by 1, 2, 3
) jobs
where device.workspace_id = jobs.workspace_id and device.location_id = jobs.location_id and device.source_key = jobs.key and device.monitoring = 'telemetry';

-- ---------------------------------------------------------------------------
-- 5. Health and summary include hardware
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_hardware_counts(target_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'devices', count(*) filter (where device.status <> 'retired'),
    'monitored', count(*) filter (where device.status = 'active' and device.monitoring = 'telemetry'),
    'problems', count(*) filter (where device.status = 'active' and public.hanafy_hardware_health(device) = 'error'),
    'never_seen', count(*) filter (where device.status = 'active' and public.hanafy_hardware_health(device) = 'unknown'),
    'last_problem', (select jsonb_build_object('name', problem.name, 'summary', problem.last_error_summary, 'at', problem.last_error_at)
      from public.hardware_devices problem
      where problem.workspace_id = target_workspace_id and problem.status = 'active' and public.hanafy_hardware_health(problem) = 'error'
      order by problem.last_error_at desc limit 1))
  from public.hardware_devices device
  where device.workspace_id = target_workspace_id;
$$;
revoke all on function public.hanafy_hardware_counts(uuid) from public, anon, authenticated;

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
  hardware jsonb := public.hanafy_hardware_counts(target_workspace_id);
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
  if coalesce((hardware ->> 'problems')::integer, 0) > 0 then
    issues := issues || jsonb_build_object('severity', 'warn', 'code', 'hardware_error',
      'message', (hardware ->> 'problems') || ' device(s) reporting a problem'
        || coalesce(': ' || (hardware #>> '{last_problem,name}') || ' (' || left(hardware #>> '{last_problem,summary}', 120) || ')', ''));
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
    'caller_id', jsonb_build_object('last_ring_at', last_ring),
    'hardware', hardware - 'last_problem'
  );
end;
$$;

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
    ) || (public.hanafy_hardware_counts(workspace.id) - 'last_problem'),
    'health', public.hanafy_platform_workspace_health(workspace.id),
    'billing', null
  )
  from public.workspaces workspace
  where workspace.id = target_workspace_id;
$$;

-- ---------------------------------------------------------------------------
-- 6. Platform Admin → Hardware
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_hardware_device_json(device public.hardware_devices)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', device.id, 'location_id', device.location_id,
    'location_name', (select location.name from public.locations location where location.id = device.location_id),
    'device_type', device.device_type, 'name', device.name, 'vendor', device.vendor, 'model', device.model,
    'serial_number', device.serial_number, 'asset_tag', device.asset_tag, 'status', device.status, 'ownership_type', device.ownership_type,
    'connection_type', device.connection_type, 'ip_address', host(device.ip_address), 'mac_address', device.mac_address::text,
    'protocol', device.protocol, 'port', device.port, 'assigned_service', device.assigned_service, 'monitoring', device.monitoring,
    'health', public.hanafy_hardware_health(device), 'last_seen_at', device.last_seen_at, 'last_success_at', device.last_success_at,
    'last_error_at', device.last_error_at, 'last_error_summary', device.last_error_summary, 'error_count', device.error_count,
    'configuration', device.configuration, 'notes', device.notes, 'source_key', device.source_key,
    'managed_by_settings', coalesce(device.source_key like 'location_hardware:%', false),
    'caller_lines', coalesce((select jsonb_agg(jsonb_build_object('line_number', line.line_number, 'label', line.label, 'active', line.active) order by line.line_number)
      from public.location_caller_lines line where line.caller_id_device_id = device.id), '[]'::jsonb),
    'payment_terminal', (select jsonb_build_object('id', terminal.id, 'label', terminal.label, 'type', terminal.terminal_type, 'status', terminal.status)
      from public.payment_terminals terminal where terminal.hardware_device_id = device.id limit 1),
    'retired_at', device.retired_at, 'created_at', device.created_at, 'updated_at', device.updated_at);
$$;
revoke all on function public.hanafy_hardware_device_json(public.hardware_devices) from public, anon, authenticated;

create or replace function public.hanafy_platform_workspace_hardware(target_workspace_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target uuid;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only']);
  select workspace.id into target from public.workspaces workspace where workspace.slug = target_workspace_slug;
  if target is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'can_manage', public.hanafy_platform_role() in ('platform_owner', 'platform_admin'),
    'counts', public.hanafy_hardware_counts(target) - 'last_problem',
    'devices', coalesce((select jsonb_agg(public.hanafy_hardware_device_json(device)
        order by device.status = 'retired', device.location_id, device.device_type, device.name)
      from public.hardware_devices device where device.workspace_id = target), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', location.id, 'name', location.name) order by location.created_at)
      from public.locations location where location.workspace_id = target), '[]'::jsonb),
    'caller_lines', coalesce((select jsonb_agg(jsonb_build_object('id', line.id, 'location_id', line.location_id, 'line_number', line.line_number,
        'label', line.label, 'active', line.active, 'caller_id_device_id', line.caller_id_device_id) order by line.location_id, line.line_number)
      from public.location_caller_lines line where line.workspace_id = target), '[]'::jsonb),
    'payment_terminals', coalesce((select jsonb_agg(jsonb_build_object('id', terminal.id, 'label', terminal.label, 'type', terminal.terminal_type,
        'status', terminal.status, 'hardware_device_id', terminal.hardware_device_id) order by terminal.label)
      from public.payment_terminals terminal where terminal.workspace_id = target), '[]'::jsonb),
    'registers', (select count(*) from public.registers register where register.workspace_id = target and register.active)
  );
end;
$$;
revoke all on function public.hanafy_platform_workspace_hardware(text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspace_hardware(text) to authenticated;

-- Add / change / retire a device.  Devices mirrored from Admin → Hardware
-- keep their operational fields (address, port, type, location) in step with
-- those settings; Platform Admin records the rest (ownership, serial, tag…).
create or replace function public.hanafy_platform_save_hardware_device(target_workspace_slug text, payload jsonb, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
  target_name text;
  device_id uuid := nullif(payload ->> 'id', '')::uuid;
  before_row public.hardware_devices%rowtype;
  after_row public.hardware_devices%rowtype;
  location_value uuid := nullif(payload ->> 'location_id', '')::uuid;
  managed boolean := false;
  line_number_value integer;
  terminal_id uuid := nullif(payload ->> 'payment_terminal_id', '')::uuid;
  port_value integer := public.hanafy_try_port(payload ->> 'port');
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if change_reason is null or char_length(btrim(change_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)' using errcode = '22023'; end if;
  select workspace.id, workspace.name into target, target_name from public.workspaces workspace where workspace.slug = target_workspace_slug;
  if target is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  if location_value is not null and not exists (select 1 from public.locations l where l.id = location_value and l.workspace_id = target) then
    raise exception 'That location does not belong to this business' using errcode = '42501';
  end if;
  if nullif(payload ->> 'ip_address', '') is not null and public.hanafy_try_inet(payload ->> 'ip_address') is null then
    raise exception 'That IP address is not valid' using errcode = '22023';
  end if;
  if nullif(payload ->> 'mac_address', '') is not null and public.hanafy_try_macaddr(payload ->> 'mac_address') is null then
    raise exception 'That MAC address is not valid' using errcode = '22023';
  end if;
  if nullif(payload ->> 'port', '') is not null and port_value is null then
    raise exception 'Port must be a number from 1 to 65535' using errcode = '22023';
  end if;

  if device_id is not null then
    select * into before_row from public.hardware_devices where id = device_id and workspace_id = target for update;
    if before_row.id is null then raise exception 'Device not found for this business' using errcode = 'P0002'; end if;
    managed := coalesce(before_row.source_key like 'location_hardware:%', false);
    if managed and (
         (payload ? 'ip_address' and public.hanafy_try_inet(payload ->> 'ip_address') is distinct from before_row.ip_address)
      or (payload ? 'port' and port_value is distinct from before_row.port)
      or (payload ? 'location_id' and location_value is distinct from before_row.location_id)
      or (payload ? 'device_type' and payload ->> 'device_type' is distinct from before_row.device_type)) then
      raise exception 'This device follows the business''s Admin → Hardware settings; change its address, port, type or location there' using errcode = '22023';
    end if;
    update public.hardware_devices set
      name = coalesce(nullif(btrim(payload ->> 'name'), ''), name),
      vendor = case when payload ? 'vendor' then nullif(btrim(payload ->> 'vendor'), '') else vendor end,
      model = case when payload ? 'model' and not managed then nullif(btrim(payload ->> 'model'), '') else model end,
      serial_number = case when payload ? 'serial_number' then nullif(btrim(payload ->> 'serial_number'), '') else serial_number end,
      asset_tag = case when payload ? 'asset_tag' then nullif(btrim(payload ->> 'asset_tag'), '') else asset_tag end,
      status = coalesce(nullif(payload ->> 'status', ''), status),
      ownership_type = coalesce(nullif(payload ->> 'ownership_type', ''), ownership_type),
      connection_type = case when payload ? 'connection_type' and not managed then nullif(payload ->> 'connection_type', '') else connection_type end,
      ip_address = case when payload ? 'ip_address' and not managed then public.hanafy_try_inet(payload ->> 'ip_address') else ip_address end,
      mac_address = case when payload ? 'mac_address' then public.hanafy_try_macaddr(payload ->> 'mac_address') else mac_address end,
      protocol = case when payload ? 'protocol' and not managed then nullif(lower(btrim(payload ->> 'protocol')), '') else protocol end,
      port = case when payload ? 'port' and not managed then port_value else port end,
      assigned_service = case when payload ? 'assigned_service' then nullif(payload ->> 'assigned_service', '') else assigned_service end,
      monitoring = case when payload ? 'monitoring' and not managed then coalesce(nullif(payload ->> 'monitoring', ''), monitoring) else monitoring end,
      location_id = case when payload ? 'location_id' and not managed then location_value else location_id end,
      notes = case when payload ? 'notes' then nullif(btrim(payload ->> 'notes'), '') else notes end,
      configuration = case when payload ? 'configuration' then coalesce(payload -> 'configuration', '{}'::jsonb) else configuration end
    where id = device_id
    returning * into after_row;
  else
    if coalesce(payload ->> 'device_type', '') = '' then raise exception 'Pick a device type' using errcode = '22023'; end if;
    insert into public.hardware_devices (workspace_id, location_id, source_key, device_type, name, vendor, model, serial_number, asset_tag, status,
      ownership_type, connection_type, ip_address, mac_address, protocol, port, assigned_service, monitoring, configuration, notes)
    values (target, coalesce(location_value, (select l.id from public.locations l where l.workspace_id = target order by l.created_at limit 1)),
      'manual:' || replace(gen_random_uuid()::text, '-', ''), payload ->> 'device_type',
      coalesce(nullif(btrim(payload ->> 'name'), ''), initcap(replace(payload ->> 'device_type', '_', ' '))),
      nullif(btrim(payload ->> 'vendor'), ''), nullif(btrim(payload ->> 'model'), ''), nullif(btrim(payload ->> 'serial_number'), ''),
      nullif(btrim(payload ->> 'asset_tag'), ''), coalesce(nullif(payload ->> 'status', ''), 'active'), coalesce(nullif(payload ->> 'ownership_type', ''), 'unknown'),
      nullif(payload ->> 'connection_type', ''), public.hanafy_try_inet(payload ->> 'ip_address'), public.hanafy_try_macaddr(payload ->> 'mac_address'),
      nullif(lower(btrim(payload ->> 'protocol')), ''), port_value, nullif(payload ->> 'assigned_service', ''),
      coalesce(nullif(payload ->> 'monitoring', ''), 'not_monitored'), coalesce(payload -> 'configuration', '{}'::jsonb), nullif(btrim(payload ->> 'notes'), ''))
    returning * into after_row;
  end if;

  -- Caller-ID box → which lines it serves.
  if after_row.device_type = 'caller_id' and jsonb_typeof(payload -> 'caller_lines') = 'array' then
    update public.location_caller_lines set caller_id_device_id = null
    where workspace_id = target and caller_id_device_id = after_row.id;
    for line_number_value in select (value #>> '{}')::integer from jsonb_array_elements(payload -> 'caller_lines') loop
      update public.location_caller_lines set caller_id_device_id = after_row.id
      where workspace_id = target and location_id = after_row.location_id and line_number = line_number_value;
      if not found then raise exception 'Line % does not exist at that location', line_number_value using errcode = '22023'; end if;
    end loop;
  end if;

  -- Card terminal device → its payment terminal record.
  if payload ? 'payment_terminal_id' then
    if terminal_id is not null and after_row.device_type <> 'payment_terminal' then
      raise exception 'Only a payment terminal device can be linked to a card terminal' using errcode = '22023';
    end if;
    update public.payment_terminals set hardware_device_id = null where workspace_id = target and hardware_device_id = after_row.id;
    if terminal_id is not null then
      update public.payment_terminals set hardware_device_id = after_row.id where id = terminal_id and workspace_id = target;
      if not found then raise exception 'That card terminal does not belong to this business' using errcode = '42501'; end if;
    end if;
  end if;

  perform public.hanafy_platform_write_audit(
    case when device_id is null then 'platform.hardware.created'
         when after_row.status = 'retired' and before_row.status <> 'retired' then 'platform.hardware.retired'
         else 'platform.hardware.updated' end,
    target, 'hardware_device', after_row.id::text,
    format('%s %s for %s: %s (%s)', case when device_id is null then 'Added' when after_row.status = 'retired' and before_row.status <> 'retired' then 'Retired' else 'Changed' end,
      replace(after_row.device_type, '_', ' '), target_name, after_row.name, after_row.status),
    case when before_row.id is null then null else to_jsonb(before_row) end, to_jsonb(after_row), btrim(change_reason), null);
  return jsonb_build_object('status', 'saved', 'id', after_row.id);
end;
$$;
revoke all on function public.hanafy_platform_save_hardware_device(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_save_hardware_device(text, jsonb, text) to authenticated;

-- The business's own Hardware screen: its devices, read-only.
create or replace function public.hanafy_workspace_devices(target_workspace_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'hardware.manage');
begin
  return coalesce((select jsonb_agg(public.hanafy_hardware_device_json(device) - 'source_key' - 'configuration'
      order by device.device_type, device.name)
    from public.hardware_devices device where device.workspace_id = target and device.status <> 'retired'), '[]'::jsonb);
end;
$$;
revoke all on function public.hanafy_workspace_devices(text) from public, anon, authenticated;
grant execute on function public.hanafy_workspace_devices(text) to authenticated;

-- The caller-ID bridge registry row points at its device.
update public.integration_connections registry set public_configuration = registry.public_configuration
  || jsonb_build_object('hardware_device_id', device.id)
from public.hardware_devices device
where registry.source_table = 'location_caller_lines' and device.device_type = 'caller_id'
  and device.location_id::text = registry.source_id;
