-- Hanafy Platform Phase 9: integration registry + payment connectors.
--
-- Build sheet §20, §24, §11.3 (Payments), §40 Phase 9.
--
--   * payment_provider_catalog: what each provider can do (capability
--     model) and whether it is actually available.  A planned provider can
--     be recorded but never shown as connected (§20.5 "do not fake").
--   * integration_connections (§24): one registry of every external
--     connection per workspace/location.  Provider-specific tables
--     (payment_connections, messaging_connections) extend it and keep their
--     registry row in step automatically.
--   * payment_connections (§20.2): provider, mode, environment, merchant
--     reference, capabilities (copied from the catalog, never from a
--     client), public configuration, secret REFERENCE only, per-connection
--     webhook key, verification.  'connected' requires a recorded
--     verification by the server after a real provider test.
--   * payment_terminals (§20.3) gain their connection and a terminal type;
--     Wayne's Boston North counter terminal is recorded as an
--     external/manual terminal, never as a charge-able reader.
--   * no raw card data: key names and card-number-looking values are
--     refused in every payment/integration JSON column and in payments.metadata.
--   * Platform Admin → Integrations (status + audited changes).
--
-- Wayne's today: counter card = the processor's own terminal (Boston North),
-- run manually; online card = none (Granbury handles online ordering).  So
-- Wayne's gets one 'manual_external' counter connection and nothing else;
-- order code keeps working exactly as before.

-- ---------------------------------------------------------------------------
-- 1. No raw card data (§20.6)
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_luhn_valid(digits text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  total integer := 0;
  position integer;
  digit integer;
  double boolean := false;
begin
  if digits !~ '^[0-9]{13,19}$' then return false; end if;
  for position in reverse char_length(digits)..1 loop
    digit := substr(digits, position, 1)::integer;
    if double then
      digit := digit * 2;
      if digit > 9 then digit := digit - 9; end if;
    end if;
    total := total + digit;
    double := not double;
  end loop;
  return total % 10 = 0;
end;
$$;

-- Returns the reason a JSON value looks like it holds card data, or null.
create or replace function public.hanafy_card_data_problem(value jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  item record;
  cleaned text;
begin
  if value is null then return null; end if;
  if jsonb_typeof(value) = 'object' then
    for item in select key, child from jsonb_each(value) as entry(key, child) loop
      if lower(item.key) ~ '(^|_)(pan|card_?number|cardnumber|cc_?number|cvv2?|cvc2?|csc|track_?[12]?_?data|track[12]|magstripe|pin_?block)$' then
        return 'field "' || item.key || '" is card data';
      end if;
      cleaned := public.hanafy_card_data_problem(item.child);
      if cleaned is not null then return cleaned; end if;
    end loop;
  elsif jsonb_typeof(value) = 'array' then
    for item in select child from jsonb_array_elements(value) as entry(child) loop
      cleaned := public.hanafy_card_data_problem(item.child);
      if cleaned is not null then return cleaned; end if;
    end loop;
  elsif jsonb_typeof(value) in ('string', 'number') then
    cleaned := regexp_replace(value #>> '{}', '[ -]', '', 'g');
    if cleaned ~ '^[2-6][0-9]{12,18}$' and public.hanafy_luhn_valid(cleaned) then
      return 'a value looks like a card number';
    end if;
  end if;
  return null;
end;
$$;

create or replace function public.hanafy_reject_card_data()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  problem text;
  column_name text;
begin
  foreach column_name in array tg_argv loop
    problem := public.hanafy_card_data_problem(to_jsonb(new) -> column_name);
    if problem is not null then
      raise exception 'CARD_DATA_REFUSED: % (%.%). Hanafy never stores card numbers, CVV, track or PIN data.', problem, tg_table_name, column_name
        using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists zz_hanafy_reject_card_data on public.payments;
create trigger zz_hanafy_reject_card_data before insert or update of metadata on public.payments
for each row execute function public.hanafy_reject_card_data('metadata');
drop trigger if exists zz_hanafy_reject_card_data on public.payment_webhook_events;
create trigger zz_hanafy_reject_card_data before insert on public.payment_webhook_events
for each row execute function public.hanafy_reject_card_data('payload');

-- ---------------------------------------------------------------------------
-- 2. Provider catalog + capability model
-- ---------------------------------------------------------------------------
create table if not exists public.payment_provider_catalog (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null,
  availability text not null check (availability in ('available', 'planned')),
  connection_modes text[] not null check (cardinality(connection_modes) >= 1),
  capabilities jsonb not null check (jsonb_typeof(capabilities) = 'object'),
  description text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.payment_provider_catalog (code, name, availability, connection_modes, capabilities, description) values
  ('manual_external', 'External terminal (manual)', 'available', array['manual_external'],
   '{"online_card": false, "card_present": true, "card_present_integrated": false, "manual_confirmation": true, "refunds_via_api": false, "voids_via_api": false, "webhooks": false}'::jsonb,
   'The business''s own processor terminal. The POS shows the amount, a person runs it on the terminal and confirms. No card data reaches Hanafy.'),
  ('square', 'Square', 'available', array['api', 'terminal_api'],
   '{"online_card": true, "card_present": true, "card_present_integrated": true, "manual_confirmation": false, "refunds_via_api": true, "voids_via_api": true, "webhooks": true}'::jsonb,
   'Square Web Payments (card tokenised in the browser) and Square Terminal API. Needs the business''s own Square account.'),
  ('worldpay', 'Worldpay', 'planned', array['api', 'terminal_api'],
   '{"online_card": false, "card_present": false, "card_present_integrated": false, "manual_confirmation": false, "refunds_via_api": false, "voids_via_api": false, "webhooks": false}'::jsonb,
   'Not built. Can be recorded as planned; cannot be connected.')
on conflict (code) do update set name = excluded.name, availability = excluded.availability, connection_modes = excluded.connection_modes,
  capabilities = excluded.capabilities, description = excluded.description, updated_at = now();

alter table public.payment_provider_catalog enable row level security;
revoke all on public.payment_provider_catalog from anon, authenticated;
grant select on public.payment_provider_catalog to authenticated;
drop policy if exists payment_provider_catalog_read on public.payment_provider_catalog;
create policy payment_provider_catalog_read on public.payment_provider_catalog for select to authenticated using (auth.uid() is not null);

-- ---------------------------------------------------------------------------
-- 3. Integration registry (§24)
-- ---------------------------------------------------------------------------
create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  location_id uuid,
  integration_type text not null check (integration_type in ('payment', 'messaging', 'email', 'maps', 'hardware_bridge', 'crm_bridge', 'other')),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  status text not null default 'not_configured' check (status in ('not_configured', 'pending', 'connected', 'active', 'manual', 'error', 'disabled')),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  public_configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(public_configuration) = 'object'),
  secret_reference text check (secret_reference is null or secret_reference ~ '^env:[A-Z][A-Z0-9_]{1,40}$'),
  verified_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) <= 500),
  source_table text check (source_table is null or source_table in ('payment_connections', 'messaging_connections', 'integration_destinations', 'location_caller_lines')),
  source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (source_table, source_id),
  -- Nothing is shown connected without a real, recorded verification.
  check (status <> 'connected' or verified_at is not null),
  foreign key (location_id, workspace_id) references public.locations(id, workspace_id) on delete restrict
);
create index if not exists integration_connections_workspace_idx on public.integration_connections(workspace_id, integration_type);

-- ---------------------------------------------------------------------------
-- 4. Payment connections (§20.2) and terminals (§20.3)
-- ---------------------------------------------------------------------------
create table if not exists public.payment_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  location_id uuid,
  purpose text not null check (purpose in ('counter', 'online', 'counter_and_online')),
  provider text not null references public.payment_provider_catalog(code) on delete restrict,
  connection_mode text not null check (connection_mode in ('api', 'terminal_api', 'hosted_checkout', 'manual_external')),
  status text not null default 'not_configured' check (status in ('not_configured', 'pending_verification', 'connected', 'manual', 'error', 'disabled')),
  merchant_reference text check (merchant_reference is null or char_length(merchant_reference) <= 200),
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  capabilities jsonb not null default '{}'::jsonb,
  public_configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(public_configuration) = 'object'),
  secret_reference text check (secret_reference is null or secret_reference ~ '^env:[A-Z][A-Z0-9_]{1,40}$'),
  webhook_key text not null default encode(extensions.gen_random_bytes(18), 'hex') unique check (webhook_key ~ '^[0-9a-f]{24,64}$'),
  verified_at timestamptz,
  verification_note text check (verification_note is null or char_length(verification_note) <= 500),
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) <= 500),
  integration_connection_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  check (status <> 'connected' or verified_at is not null),
  check ((provider = 'manual_external') = (connection_mode = 'manual_external')),
  check (provider <> 'manual_external' or status in ('manual', 'disabled')),
  check (provider = 'manual_external' or status <> 'manual'),
  foreign key (location_id, workspace_id) references public.locations(id, workspace_id) on delete restrict,
  foreign key (integration_connection_id, workspace_id) references public.integration_connections(id, workspace_id) on delete restrict
);
-- One live connection per location and purpose.
create unique index if not exists payment_connections_one_live
  on public.payment_connections(workspace_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), purpose)
  where status <> 'disabled';

comment on table public.payment_connections is
  'Phase 9 (§20.2): which processor/terminal a workspace (location) uses. Hanafy is never the merchant of record; secrets are referenced, never stored.';

-- Capabilities come from the catalog; planned providers can't go live.
create or replace function public.hanafy_payment_connection_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare catalog_row public.payment_provider_catalog%rowtype;
begin
  select * into catalog_row from public.payment_provider_catalog where code = new.provider;
  if not (new.connection_mode = any(catalog_row.connection_modes)) then
    raise exception '% does not support the % connection mode', catalog_row.name, new.connection_mode using errcode = '22023';
  end if;
  if catalog_row.availability <> 'available' and new.status not in ('not_configured', 'disabled') then
    raise exception '% is planned, not built; it can only be recorded as not configured', catalog_row.name using errcode = '22023';
  end if;
  new.capabilities := catalog_row.capabilities;
  if tg_op = 'UPDATE' and (old.provider, old.connection_mode, old.environment, old.merchant_reference, old.secret_reference, old.public_configuration)
       is distinct from (new.provider, new.connection_mode, new.environment, new.merchant_reference, new.secret_reference, new.public_configuration) then
    -- A changed setup must be verified again.
    new.verified_at := null;
    new.verification_note := null;
    if new.status = 'connected' then new.status := 'pending_verification'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_payment_connection_rules() from public, anon, authenticated;
drop trigger if exists ab_payment_connection_rules on public.payment_connections;
create trigger ab_payment_connection_rules before insert or update on public.payment_connections
for each row execute function public.hanafy_payment_connection_rules();

alter table public.payment_terminals add column if not exists payment_connection_id uuid;
alter table public.payment_terminals add column if not exists terminal_type text not null default 'provider_reader';
alter table public.payment_terminals add column if not exists hardware_device_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_terminals_terminal_type_check') then
    alter table public.payment_terminals add constraint payment_terminals_terminal_type_check check (terminal_type in ('provider_reader', 'external_manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_terminals_connection_fk') then
    alter table public.payment_terminals add constraint payment_terminals_connection_fk
      foreign key (payment_connection_id, workspace_id) references public.payment_connections(id, workspace_id) on delete restrict;
  end if;
end;
$$;
comment on column public.payment_terminals.terminal_type is
  'provider_reader: a paired reader the POS can charge through the provider API. external_manual: the processor''s own terminal, run by a person; never charged by the POS.';

-- Registry rows follow their provider-specific record.
create or replace function public.hanafy_sync_integration_registry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  registry_id uuid;
  registry_status text;
  registry_name text;
  registry_provider text;
  registry_type text;
begin
  if tg_table_name = 'payment_connections' then
    registry_type := 'payment';
    registry_provider := new.provider;
    registry_status := case new.status when 'pending_verification' then 'pending' else new.status end;
    registry_name := (select catalog.name from public.payment_provider_catalog catalog where catalog.code = new.provider)
      || ' (' || replace(new.purpose, '_', ' ') || ')';
  else
    registry_type := 'messaging';
    registry_provider := new.provider;
    registry_status := case new.status when 'active' then 'active' when 'sandbox' then 'pending' when 'provisioning' then 'pending' when 'suspended' then 'disabled' else 'error' end;
    registry_name := 'Texting (' || case new.dispatch_mode when 'platform' then 'platform sender' else 'old Hanafy CRM sends' end || ')';
  end if;

  insert into public.integration_connections (workspace_id, location_id, integration_type, provider, status, name, secret_reference, verified_at,
    last_success_at, last_error_at, last_error_summary, source_table, source_id)
  values (new.workspace_id, nullif(to_jsonb(new) ->> 'location_id', '')::uuid, registry_type, registry_provider,
    registry_status, registry_name, new.secret_reference,
    nullif(to_jsonb(new) ->> 'verified_at', '')::timestamptz,
    new.last_success_at, new.last_error_at, new.last_error_summary, tg_table_name, new.id::text)
  on conflict (source_table, source_id) do update set
    status = excluded.status, name = excluded.name, provider = excluded.provider, location_id = excluded.location_id,
    secret_reference = excluded.secret_reference, verified_at = excluded.verified_at, last_success_at = excluded.last_success_at,
    last_error_at = excluded.last_error_at, last_error_summary = excluded.last_error_summary, updated_at = now()
  returning id into registry_id;

  if tg_table_name = 'payment_connections' and (to_jsonb(new) ->> 'integration_connection_id') is distinct from registry_id::text then
    update public.payment_connections set integration_connection_id = registry_id where id = new.id;
  end if;
  return null;
end;
$$;
revoke all on function public.hanafy_sync_integration_registry() from public, anon, authenticated;
drop trigger if exists zz_hanafy_integration_registry on public.payment_connections;
create trigger zz_hanafy_integration_registry after insert or update on public.payment_connections
for each row when (pg_trigger_depth() < 2) execute function public.hanafy_sync_integration_registry();
drop trigger if exists zz_hanafy_integration_registry on public.messaging_connections;
create trigger zz_hanafy_integration_registry after insert or update on public.messaging_connections
for each row execute function public.hanafy_sync_integration_registry();

do $$
declare table_name text;
begin
  foreach table_name in array array['integration_connections', 'payment_connections'] loop
    execute format('drop trigger if exists aa_hanafy_guard_platform_row on public.%I', table_name);
    execute format('create trigger aa_hanafy_guard_platform_row before insert or update on public.%I for each row execute function public.hanafy_guard_platform_row()', table_name);
    execute format('drop trigger if exists %I on public.%I', table_name || '_set_updated_at', table_name);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', table_name || '_set_updated_at', table_name);
    execute format('drop trigger if exists zz_hanafy_reject_card_data on public.%I', table_name);
    execute format('create trigger zz_hanafy_reject_card_data before insert or update on public.%I for each row execute function public.hanafy_reject_card_data(''public_configuration'')', table_name);
  end loop;
end;
$$;

alter table public.integration_connections enable row level security;
alter table public.payment_connections enable row level security;
revoke all on public.integration_connections, public.payment_connections from anon, authenticated;
grant select on public.integration_connections to authenticated;
-- payment_connections holds the webhook key: no direct reads; RPCs return what each screen needs.
drop policy if exists integration_connections_workspace_read on public.integration_connections;
create policy integration_connections_workspace_read on public.integration_connections for select to authenticated
using (public.hanafy_can_access_workspace_data(workspace_id, array['integrations.manage', 'payments.manage']));

-- ---------------------------------------------------------------------------
-- 5. Backfill
-- ---------------------------------------------------------------------------
-- Messaging connections from Phase 7 join the registry.
update public.messaging_connections set updated_at = updated_at;

-- Square configured through the old settings screen becomes a connection
-- (secret names kept: env:SQUARE → SQUARE_ACCESS_TOKEN / SQUARE_WEBHOOK_SIGNATURE_KEY).
insert into public.payment_connections (workspace_id, location_id, purpose, provider, connection_mode, status, merchant_reference, environment,
  public_configuration, secret_reference)
select config.workspace_id, config.location_id, 'counter_and_online', 'square', 'api', 'pending_verification', nullif(config.provider_location_id, ''),
  config.environment, jsonb_build_object('application_id', config.application_id, 'provider_location_id', config.provider_location_id,
    'notification_url', config.notification_url, 'online_card_enabled', config.online_card_enabled, 'terminal_card_enabled', config.terminal_card_enabled),
  'env:SQUARE'
from public.location_payment_configurations config
where config.provider = 'square'
on conflict do nothing;

-- Wayne's counter: the Boston North terminal, run by hand (manual_external).
insert into public.payment_connections (workspace_id, location_id, purpose, provider, connection_mode, status, merchant_reference, environment, public_configuration)
select location.workspace_id, location.id, 'counter', 'manual_external', 'manual_external', 'manual', 'Boston North', 'production',
  jsonb_build_object('processor_name', 'Boston North', 'note', 'Standalone processor terminal; the POS sends the amount to a person, not to the terminal.')
from public.locations location
join public.workspaces workspace on workspace.id = location.workspace_id and workspace.slug = 'waynes-pizza'
where location.slug = 'worcester'
  and not exists (select 1 from public.payment_connections existing where existing.location_id = location.id and existing.purpose in ('counter', 'counter_and_online') and existing.status <> 'disabled');

insert into public.payment_terminals (workspace_id, location_id, label, device_id, status, notes, terminal_type, payment_connection_id)
select connection.workspace_id, connection.location_id, 'Counter card terminal (Boston North)', 'external:' || connection.id::text, 'active',
  'Processor''s own terminal. Run the amount on it and confirm in the POS.', 'external_manual', connection.id
from public.payment_connections connection
where connection.provider = 'manual_external' and connection.status = 'manual'
  and not exists (select 1 from public.payment_terminals terminal where terminal.payment_connection_id = connection.id);

-- Existing readers belong to their location's Square connection.
update public.payment_terminals terminal set payment_connection_id = connection.id
from public.payment_connections connection
where terminal.payment_connection_id is null and terminal.terminal_type = 'provider_reader'
  and connection.provider = 'square' and connection.workspace_id = terminal.workspace_id and connection.location_id = terminal.location_id;

-- Old CRM bridge and caller-ID bridge appear in the registry too.
insert into public.integration_connections (workspace_id, integration_type, provider, status, name, verified_at, last_success_at, source_table, source_id, public_configuration)
select destination.workspace_id, 'crm_bridge', 'hanafy_crm',
  case when not destination.active then 'disabled'
       when exists (select 1 from public.integration_outbox o where o.destination = destination.id and o.status = 'delivered') then 'connected'
       else 'pending' end,
  'Hanafy CRM event bridge',
  (select max(o.delivered_at) from public.integration_outbox o where o.destination = destination.id and o.status = 'delivered'),
  (select max(o.delivered_at) from public.integration_outbox o where o.destination = destination.id and o.status = 'delivered'),
  'integration_destinations', destination.id,
  jsonb_build_object('endpoint_url', destination.endpoint_url, 'business_id', destination.business_id)
from public.integration_destinations destination
on conflict (source_table, source_id) do nothing;

insert into public.integration_connections (workspace_id, location_id, integration_type, provider, status, name, source_table, source_id, last_success_at)
select location.workspace_id, location.id, 'hardware_bridge', 'callerid_com_whozz_calling',
  case when exists (select 1 from public.phone_calls call where call.workspace_id = location.workspace_id and coalesce(call.simulated, false) = false) then 'active' else 'pending' end,
  'Caller ID bridge (Whozz Calling?)', 'location_caller_lines', location.id::text,
  (select max(call.started_at) from public.phone_calls call where call.workspace_id = location.workspace_id and coalesce(call.simulated, false) = false)
from public.locations location
where exists (select 1 from public.location_caller_lines line where line.location_id = location.id)
on conflict (source_table, source_id) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Server-side resolution + verification (service role)
-- ---------------------------------------------------------------------------

-- The connection to use for a workspace/location and purpose.  Never another
-- workspace's, never a fallback.  Location-specific beats workspace-wide.
create or replace function public.hanafy_payment_connection_for(target_workspace_id uuid, target_location_id uuid, target_purpose text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', connection.id, 'workspace_id', connection.workspace_id, 'location_id', connection.location_id,
    'provider', connection.provider, 'connection_mode', connection.connection_mode, 'status', connection.status,
    'environment', connection.environment, 'merchant_reference', connection.merchant_reference, 'capabilities', connection.capabilities,
    'public_configuration', connection.public_configuration, 'secret_reference', connection.secret_reference, 'purpose', connection.purpose)
  from public.payment_connections connection
  where connection.workspace_id = target_workspace_id
    and (connection.location_id is null or connection.location_id = target_location_id)
    and connection.status <> 'disabled'
    and (connection.purpose = target_purpose or connection.purpose = 'counter_and_online')
  order by (connection.location_id is not null) desc, (connection.purpose = target_purpose) desc, connection.created_at
  limit 1;
$$;
revoke all on function public.hanafy_payment_connection_for(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.hanafy_payment_connection_for(uuid, uuid, text) to service_role;

create or replace function public.hanafy_payment_connection_by_webhook_key(target_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', connection.id, 'workspace_id', connection.workspace_id, 'location_id', connection.location_id,
    'provider', connection.provider, 'connection_mode', connection.connection_mode, 'status', connection.status,
    'environment', connection.environment, 'merchant_reference', connection.merchant_reference, 'capabilities', connection.capabilities,
    'public_configuration', connection.public_configuration, 'secret_reference', connection.secret_reference, 'purpose', connection.purpose)
  from public.payment_connections connection
  where connection.webhook_key = target_key and connection.status <> 'disabled';
$$;
revoke all on function public.hanafy_payment_connection_by_webhook_key(text) from public, anon, authenticated;
grant execute on function public.hanafy_payment_connection_by_webhook_key(text) to service_role;

-- Only the server, after a real provider call succeeded, can mark a connection connected.
create or replace function public.hanafy_payment_connection_record_check(target_connection_id uuid, succeeded boolean, note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare connection public.payment_connections%rowtype;
begin
  select * into connection from public.payment_connections where id = target_connection_id for update;
  if connection.id is null then raise exception 'Payment connection not found' using errcode = 'P0002'; end if;
  if connection.provider = 'manual_external' then raise exception 'A manual terminal has nothing to verify' using errcode = 'P0001'; end if;
  if succeeded then
    update public.payment_connections set status = 'connected', verified_at = now(), verification_note = left(note, 500), last_success_at = now()
    where id = connection.id;
  else
    update public.payment_connections set status = 'error', verified_at = null, verification_note = left(note, 500), last_error_at = now(), last_error_summary = left(note, 500)
    where id = connection.id;
  end if;
  perform public.hanafy_platform_write_audit('platform.payment_connection.tested', connection.workspace_id, 'payment_connection', connection.id::text,
    format('Payment connection test %s: %s', case when succeeded then 'passed' else 'failed' end, left(note, 300)), null,
    jsonb_build_object('succeeded', succeeded), null, null);
  return jsonb_build_object('status', case when succeeded then 'connected' else 'error' end);
end;
$$;
revoke all on function public.hanafy_payment_connection_record_check(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.hanafy_payment_connection_record_check(uuid, boolean, text) to service_role;

-- Webhooks routed per connection are stored against that connection's business.
create or replace function public.hanafy_record_payment_webhook(target_connection_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection public.payment_connections%rowtype;
  inserted_id uuid;
  primary_location uuid;
begin
  select * into connection from public.payment_connections where id = target_connection_id;
  if connection.id is null then raise exception 'Payment connection not found' using errcode = 'P0002'; end if;
  primary_location := coalesce(connection.location_id, (select location.id from public.locations location where location.workspace_id = connection.workspace_id order by location.created_at limit 1));
  insert into public.payment_webhook_events (workspace_id, location_id, provider, event_id, event_type, signature_verified, payload)
  values (connection.workspace_id, primary_location, connection.provider,
    coalesce(nullif(payload ->> 'event_id', ''), gen_random_uuid()::text), coalesce(payload ->> 'event_type', ''),
    coalesce((payload ->> 'signature_verified')::boolean, false), coalesce(payload -> 'payload', '{}'::jsonb))
  on conflict (provider, event_id) do nothing
  returning id into inserted_id;
  if inserted_id is null then return jsonb_build_object('duplicate', true); end if;
  if coalesce((payload ->> 'signature_verified')::boolean, false) then
    update public.payment_connections set last_success_at = now() where id = connection.id;
  else
    update public.payment_connections set last_error_at = now(), last_error_summary = 'A webhook arrived with a bad signature' where id = connection.id;
  end if;
  return jsonb_build_object('duplicate', false, 'id', inserted_id);
end;
$$;
revoke all on function public.hanafy_record_payment_webhook(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.hanafy_record_payment_webhook(uuid, jsonb) to service_role;

-- The Square settings screen (Phase 4 table) keeps its Square connection in step.
create or replace function public.hanafy_sync_square_connection_from_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare existing uuid;
begin
  select connection.id into existing from public.payment_connections connection
  where connection.workspace_id = new.workspace_id and connection.location_id = new.location_id and connection.provider = 'square' and connection.status <> 'disabled';
  if new.provider = 'square' then
    if existing is null then
      update public.payment_connections set status = 'disabled'
      where workspace_id = new.workspace_id and location_id = new.location_id and purpose in ('counter_and_online', 'online') and status <> 'disabled';
      insert into public.payment_connections (workspace_id, location_id, purpose, provider, connection_mode, status, merchant_reference, environment, public_configuration, secret_reference)
      values (new.workspace_id, new.location_id,
        -- Keep a manual counter terminal if the store has one; otherwise Square serves both.
        case when exists (select 1 from public.payment_connections counter where counter.workspace_id = new.workspace_id and counter.location_id = new.location_id
          and counter.purpose = 'counter' and counter.status <> 'disabled') then 'online' else 'counter_and_online' end,
        'square', 'api', 'pending_verification', nullif(new.provider_location_id, ''), new.environment,
        jsonb_build_object('application_id', new.application_id, 'provider_location_id', new.provider_location_id, 'notification_url', new.notification_url,
          'online_card_enabled', new.online_card_enabled, 'terminal_card_enabled', new.terminal_card_enabled), 'env:SQUARE');
    else
      update public.payment_connections set merchant_reference = nullif(new.provider_location_id, ''), environment = new.environment,
        public_configuration = jsonb_build_object('application_id', new.application_id, 'provider_location_id', new.provider_location_id,
          'notification_url', new.notification_url, 'online_card_enabled', new.online_card_enabled, 'terminal_card_enabled', new.terminal_card_enabled)
      where id = existing;
    end if;
  elsif existing is not null then
    update public.payment_connections set status = 'disabled' where id = existing;
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_sync_square_connection_from_settings() from public, anon, authenticated;
drop trigger if exists zz_hanafy_square_connection_sync on public.location_payment_configurations;
create trigger zz_hanafy_square_connection_sync after insert or update on public.location_payment_configurations
for each row execute function public.hanafy_sync_square_connection_from_settings();

-- ---------------------------------------------------------------------------
-- 7. Workspace and Platform Admin RPCs
-- ---------------------------------------------------------------------------

-- What the business's Payments screen shows (no webhook key, no secret names).
create or replace function public.hanafy_payment_connections_summary(target_workspace_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'payments.manage');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', connection.id, 'purpose', connection.purpose, 'provider', connection.provider,
      'provider_name', catalog.name, 'connection_mode', connection.connection_mode, 'status', connection.status,
      'environment', connection.environment, 'merchant_reference', connection.merchant_reference, 'capabilities', connection.capabilities,
      'location_name', location.name, 'last_success_at', connection.last_success_at,
      'terminals', coalesce((select jsonb_agg(jsonb_build_object('label', terminal.label, 'type', terminal.terminal_type, 'status', terminal.status) order by terminal.label)
        from public.payment_terminals terminal where terminal.payment_connection_id = connection.id), '[]'::jsonb))
      order by connection.status = 'disabled', connection.purpose)
    from public.payment_connections connection
    join public.payment_provider_catalog catalog on catalog.code = connection.provider
    left join public.locations location on location.id = connection.location_id
    where connection.workspace_id = target
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.hanafy_payment_connections_summary(text) from public, anon, authenticated;
grant execute on function public.hanafy_payment_connections_summary(text) to authenticated;

create or replace function public.hanafy_platform_workspace_integrations(target_workspace_slug text)
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
    'integrations', coalesce((select jsonb_agg(jsonb_build_object('id', item.id, 'type', item.integration_type, 'provider', item.provider,
        'status', item.status, 'name', item.name, 'location_id', item.location_id, 'verified_at', item.verified_at,
        'last_success_at', item.last_success_at, 'last_error_at', item.last_error_at, 'last_error_summary', item.last_error_summary,
        'updated_at', item.updated_at) order by item.integration_type, item.name)
      from public.integration_connections item where item.workspace_id = target), '[]'::jsonb),
    'payment_connections', coalesce((select jsonb_agg(jsonb_build_object('id', connection.id, 'purpose', connection.purpose,
        'provider', connection.provider, 'provider_name', catalog.name, 'connection_mode', connection.connection_mode, 'status', connection.status,
        'environment', connection.environment, 'merchant_reference', connection.merchant_reference, 'capabilities', connection.capabilities,
        'public_configuration', connection.public_configuration, 'secret_reference', connection.secret_reference,
        'webhook_path', case when (connection.capabilities ->> 'webhooks')::boolean then '/api/payments/webhooks/' || connection.webhook_key end,
        'location_id', connection.location_id, 'location_name', location.name, 'verified_at', connection.verified_at,
        'verification_note', connection.verification_note, 'last_success_at', connection.last_success_at,
        'last_error_at', connection.last_error_at, 'last_error_summary', connection.last_error_summary,
        'terminals', coalesce((select jsonb_agg(jsonb_build_object('id', terminal.id, 'label', terminal.label, 'type', terminal.terminal_type,
            'status', terminal.status, 'last_used_at', terminal.last_used_at) order by terminal.label)
          from public.payment_terminals terminal where terminal.payment_connection_id = connection.id), '[]'::jsonb))
        order by connection.status = 'disabled', connection.purpose, connection.created_at)
      from public.payment_connections connection
      join public.payment_provider_catalog catalog on catalog.code = connection.provider
      left join public.locations location on location.id = connection.location_id
      where connection.workspace_id = target), '[]'::jsonb),
    'providers', coalesce((select jsonb_agg(jsonb_build_object('code', catalog.code, 'name', catalog.name, 'availability', catalog.availability,
        'connection_modes', to_jsonb(catalog.connection_modes), 'capabilities', catalog.capabilities, 'description', catalog.description) order by catalog.availability, catalog.name)
      from public.payment_provider_catalog catalog), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', location.id, 'name', location.name) order by location.created_at)
      from public.locations location where location.workspace_id = target), '[]'::jsonb),
    'last_card_payment_at', (select max(payment.captured_at) from public.payments payment where payment.workspace_id = target and payment.method = 'card' and payment.status = 'captured'),
    'webhook_problems_7d', (select count(*) from public.payment_webhook_events event
      where event.workspace_id = target and event.received_at > now() - interval '7 days' and (not event.signature_verified or event.processing_error is not null))
  );
end;
$$;
revoke all on function public.hanafy_platform_workspace_integrations(text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspace_integrations(text) to authenticated;

-- Audited create / change of a payment connection.  Never sets 'connected'
-- (only a successful server-side provider check does).
create or replace function public.hanafy_platform_save_payment_connection(target_workspace_slug text, payload jsonb, change_reason text, confirmed boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
  target_name text;
  connection_id uuid := nullif(payload ->> 'id', '')::uuid;
  before_row public.payment_connections%rowtype;
  after_row public.payment_connections%rowtype;
  requested_status text := payload ->> 'status';
  warnings jsonb := '[]'::jsonb;
  location_value uuid := nullif(payload ->> 'location_id', '')::uuid;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if change_reason is null or char_length(btrim(change_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)' using errcode = '22023'; end if;
  select workspace.id, workspace.name into target, target_name from public.workspaces workspace where workspace.slug = target_workspace_slug;
  if target is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  if requested_status = 'connected' then
    raise exception 'A connection shows connected only after the server tests it with the provider' using errcode = '22023';
  end if;
  if location_value is not null and not exists (select 1 from public.locations l where l.id = location_value and l.workspace_id = target) then
    raise exception 'That location does not belong to this business' using errcode = '42501';
  end if;

  if connection_id is not null then
    select * into before_row from public.payment_connections where id = connection_id and workspace_id = target for update;
    if before_row.id is null then raise exception 'Payment connection not found' using errcode = 'P0002'; end if;
    if requested_status = 'disabled' and before_row.status <> 'disabled' and before_row.purpose in ('counter', 'counter_and_online') then
      warnings := warnings || to_jsonb(format('%s''s counter will have no card payment method until another one is set up.', target_name));
    end if;
    if payload ->> 'environment' = 'production' and before_row.environment <> 'production' then
      warnings := warnings || to_jsonb('Real cards will be charged in production.'::text);
    end if;
  elsif coalesce(payload ->> 'environment', 'sandbox') = 'production' and payload ->> 'provider' <> 'manual_external' then
    warnings := warnings || to_jsonb('Real cards will be charged in production.'::text);
  end if;
  if jsonb_array_length(warnings) > 0 and not confirmed then
    return jsonb_build_object('status', 'needs_confirmation', 'warnings', warnings);
  end if;

  if connection_id is null then
    insert into public.payment_connections (workspace_id, location_id, purpose, provider, connection_mode, status, merchant_reference, environment,
      public_configuration, secret_reference)
    values (target, location_value, coalesce(payload ->> 'purpose', 'counter'), payload ->> 'provider',
      coalesce(payload ->> 'connection_mode', case when payload ->> 'provider' = 'manual_external' then 'manual_external' else 'api' end),
      coalesce(requested_status, case when payload ->> 'provider' = 'manual_external' then 'manual' else 'pending_verification' end),
      nullif(payload ->> 'merchant_reference', ''), coalesce(payload ->> 'environment', 'sandbox'),
      coalesce(payload -> 'public_configuration', '{}'::jsonb), nullif(payload ->> 'secret_reference', ''))
    returning * into after_row;
    if after_row.provider = 'manual_external' then
      insert into public.payment_terminals (workspace_id, location_id, label, device_id, status, notes, terminal_type, payment_connection_id)
      select target, coalesce(location_value, (select l.id from public.locations l where l.workspace_id = target order by l.created_at limit 1)),
        coalesce(nullif(payload ->> 'terminal_label', ''), 'Counter card terminal'), 'external:' || after_row.id::text, 'active',
        'Processor''s own terminal. Run the amount on it and confirm in the POS.', 'external_manual', after_row.id;
    end if;
  else
    update public.payment_connections set
      status = coalesce(requested_status, status),
      merchant_reference = case when payload ? 'merchant_reference' then nullif(payload ->> 'merchant_reference', '') else merchant_reference end,
      environment = coalesce(payload ->> 'environment', environment),
      public_configuration = coalesce(payload -> 'public_configuration', public_configuration),
      secret_reference = case when payload ? 'secret_reference' then nullif(payload ->> 'secret_reference', '') else secret_reference end
    where id = connection_id
    returning * into after_row;
  end if;

  perform public.hanafy_platform_write_audit(
    case when connection_id is null then 'platform.payment_connection.created' else 'platform.payment_connection.updated' end,
    target, 'payment_connection', after_row.id::text,
    format('%s payment connection for %s: %s (%s)', case when connection_id is null then 'Added' else 'Changed' end, target_name, after_row.provider, after_row.status),
    case when before_row.id is null then null else to_jsonb(before_row) - 'webhook_key' - 'secret_reference' end,
    to_jsonb(after_row) - 'webhook_key' - 'secret_reference', btrim(change_reason), null
  );
  return jsonb_build_object('status', 'saved', 'id', after_row.id, 'warnings', warnings);
end;
$$;
revoke all on function public.hanafy_platform_save_payment_connection(text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.hanafy_platform_save_payment_connection(text, jsonb, text, boolean) to authenticated;
