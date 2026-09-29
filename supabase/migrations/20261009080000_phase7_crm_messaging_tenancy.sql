-- Hanafy Platform Phase 7: tenantize Hanafy CRM and messaging.
--
-- Build sheet §15, §17, §19, §40 Phase 7.  Decision (2026-09-28, Youssef):
-- the workspace-scoped CRM + messaging model lives in THIS database (the
-- platform database); the separate Hanafy CRM project keeps sending Wayne's
-- live texts over the signed HMAC bridge until its sending is cut over, so
-- nothing live double-sends or stops.
--
--   * customers stay the one canonical contact record (no CRM contact copy);
--     the old CRM business is mapped to its workspace (crm_legacy_business_links);
--   * messaging_connections + messaging_origination_identities (§19.1/19.2):
--     every sender belongs to exactly one workspace, a phone number can belong
--     to only one workspace, and there is never a fallback sender (§19.3);
--   * message_templates, marketing_campaigns (+ recipients) and message_jobs
--     (§19.4) are workspace-scoped with composite foreign keys, so a campaign,
--     job, template, customer and sender from two different workspaces cannot
--     be joined even by a buggy caller;
--   * suppression_entries per workspace + channel; STOP overrides marketing
--     and automations (§19.5).  Ordering/contact data is never consent;
--   * one server-side send path (hanafy_enqueue_message) that re-checks
--     workspace ownership, service entitlement, consent, suppression and the
--     sender on every message, and again when the dispatcher claims it;
--   * a dispatcher contract (claim / finish / delivery status) for the
--     platform sender, which only ever sends for connections whose
--     dispatch_mode is 'platform'.  Wayne's stays 'legacy_crm_bridge'.
--   * Platform Admin → Messaging reads and audited changes (§11.3).
--
-- Nothing here changes how Wayne's texts go out today.

-- ---------------------------------------------------------------------------
-- 0. Composite keys used by the tenant-safe foreign keys below
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_id_workspace_key') then
    alter table public.customers add constraint customers_id_workspace_key unique (id, workspace_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'locations_id_workspace_key') then
    alter table public.locations add constraint locations_id_workspace_key unique (id, workspace_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'customer_segments_id_workspace_key') then
    alter table public.customer_segments add constraint customer_segments_id_workspace_key unique (id, workspace_id);
  end if;
end;
$$;

-- Generic guard for Phase 7+ tenant tables: a workspace is required, never
-- reassigned, and there is NO default workspace (unlike the legacy triggers).
create or replace function public.hanafy_guard_platform_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is null then
    raise exception 'workspace_id is required' using errcode = '23502';
  end if;
  if tg_op = 'UPDATE' and old.workspace_id is distinct from new.workspace_id then
    raise exception 'workspace_id cannot be reassigned' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_guard_platform_row() from public, anon, authenticated;

-- Resolves a workspace by slug and checks one permission there.  Every
-- workspace-facing RPC in this phase starts with it; the browser never
-- supplies a workspace id.
create or replace function public.hanafy_require_workspace_permission(target_workspace_slug text, required_permission text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  select workspace.id into target from public.workspaces workspace where workspace.slug = target_workspace_slug;
  if target is null then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  if not public.hanafy_has_workspace_permission(target, required_permission) then
    raise exception 'You do not have permission for this (%).', required_permission using errcode = '42501';
  end if;
  return target;
end;
$$;
revoke all on function public.hanafy_require_workspace_permission(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (id, code, description) values
  ('20000000-0000-4000-8000-000000000029', 'campaigns.view', 'See campaigns, templates, message history and the sending number'),
  ('20000000-0000-4000-8000-000000000030', 'campaigns.manage', 'Create, schedule, send and cancel campaigns and templates'),
  ('20000000-0000-4000-8000-000000000031', 'messaging.manage', 'Manage opt-outs (suppressions) for texts and email')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code in ('campaigns.view', 'campaigns.manage', 'messaging.manage')
where role.code in ('owner', 'manager')
on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code = 'campaigns.view'
where role.code = 'marketing_readonly'
on conflict do nothing;

insert into public.service_permissions (service_id, permission_id)
select service.id, permission.id
from (values
  ('sms', 'campaigns.view'), ('sms', 'campaigns.manage'), ('sms', 'messaging.manage'),
  ('email', 'campaigns.view'), ('email', 'campaigns.manage'), ('email', 'messaging.manage')
) as mapping(service_code, permission_code)
join public.service_catalog service on service.code = mapping.service_code
join public.permissions permission on permission.code = mapping.permission_code
on conflict do nothing;

-- Read-only Hanafy support may look at campaigns and message history.
create or replace function public.hanafy_support_permission_allowed(platform_role_value text, required_permission text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when platform_role_value in ('platform_owner', 'platform_admin') then true
    when platform_role_value = 'platform_support' then required_permission = any(array[
      'admin.access', 'orders.view', 'reports.view', 'customers.view', 'staff.view', 'audit.view', 'campaigns.view'
    ])
    else false
  end;
$$;
revoke all on function public.hanafy_support_permission_allowed(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Old Hanafy CRM business → workspace map (§14 duplicates, §26)
-- ---------------------------------------------------------------------------
create table if not exists public.crm_legacy_business_links (
  workspace_id uuid primary key references public.workspaces(id) on delete restrict,
  legacy_system text not null default 'hanafy_crm' check (legacy_system = 'hanafy_crm'),
  legacy_project_ref text not null check (legacy_project_ref ~ '^[a-z0-9]{20}$'),
  legacy_business_id uuid not null unique,
  legacy_business_slug text not null check (legacy_business_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  notes text not null default '' check (char_length(notes) <= 1000),
  linked_at timestamptz not null default now()
);
comment on table public.crm_legacy_business_links is
  'Phase 7: which Hanafy CRM (separate Supabase project) business each workspace was. Only Wayne''s is linked; archived prospects are never migrated (§26, §43).';

insert into public.crm_legacy_business_links (workspace_id, legacy_project_ref, legacy_business_id, legacy_business_slug, notes)
select workspace.id, 'lgbdfqpnlvjxdlalhnbk', '2acaf89c-10ad-4b2b-80c9-dc26a54d5c86', 'waynes-pizza',
  'Contacts are the platform customers (the one CRM contact maps to its POS customer by phone). The CRM keeps sending Wayne''s texts over the HMAC bridge until cut-over.'
from public.workspaces workspace
where workspace.slug = 'waynes-pizza'
on conflict (workspace_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Messaging connections and sender identities (§19.1, §19.2)
-- ---------------------------------------------------------------------------
create table if not exists public.messaging_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  channel text not null default 'sms' check (channel in ('sms')),
  provider text not null check (provider in ('aws_end_user_messaging')),
  status text not null default 'provisioning' check (status in ('provisioning', 'sandbox', 'active', 'suspended', 'error')),
  aws_region text check (aws_region is null or aws_region ~ '^[a-z]{2}(-gov)?-[a-z]+-[0-9]$'),
  provider_account_ref text check (provider_account_ref is null or char_length(provider_account_ref) <= 200),
  registration_status text check (registration_status is null or registration_status in ('not_started', 'submitted', 'approved', 'rejected', 'not_required')),
  production_access_status text check (production_access_status is null or production_access_status in ('sandbox', 'requested', 'granted', 'denied')),
  -- Who actually sends for this workspace.  'legacy_crm_bridge' = the old
  -- Hanafy CRM project still sends; the platform dispatcher never touches it.
  dispatch_mode text not null default 'platform' check (dispatch_mode in ('platform', 'legacy_crm_bridge')),
  -- false = the platform dispatcher simulates every send (no AWS call).
  live_sending boolean not null default false,
  -- Names server environment variables, never holds a secret: env:PREFIX →
  -- PREFIX_ACCESS_KEY_ID / PREFIX_SECRET_ACCESS_KEY on the server.
  secret_reference text check (secret_reference is null or secret_reference ~ '^env:[A-Z][A-Z0-9_]{1,40}$'),
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, channel, provider)
);

create table if not exists public.messaging_origination_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  location_id uuid,
  messaging_connection_id uuid not null,
  channel text not null default 'sms' check (channel in ('sms')),
  phone_number text not null check (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  provider_identity_arn text check (provider_identity_arn is null or char_length(provider_identity_arn) between 3 and 300),
  identity_type text check (identity_type is null or identity_type in ('long_code', 'ten_dlc', 'toll_free', 'short_code')),
  message_type text not null default 'PROMOTIONAL' check (message_type in ('PROMOTIONAL', 'TRANSACTIONAL')),
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended', 'retired')),
  is_default boolean not null default false,
  legacy_crm_identity_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (messaging_connection_id, workspace_id) references public.messaging_connections(id, workspace_id) on delete restrict,
  foreign key (location_id, workspace_id) references public.locations(id, workspace_id) on delete restrict
);
-- A phone number belongs to one business, ever (while not retired).
create unique index if not exists messaging_identities_number_owner
  on public.messaging_origination_identities(channel, phone_number) where status <> 'retired';
create unique index if not exists messaging_identities_one_default
  on public.messaging_origination_identities(workspace_id, channel, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_default and status in ('pending', 'active');

comment on table public.messaging_connections is 'Phase 7 (§19.1): one messaging provider connection per workspace + channel. No secrets are stored here.';
comment on table public.messaging_origination_identities is 'Phase 7 (§19.2): sending numbers. A number belongs to exactly one workspace; sends never fall back to another workspace''s number.';
comment on table public.workspace_messaging_identities is 'Deprecated by Phase 7: display-only sender name/address from Phase 4. Sending resolves from messaging_origination_identities.';

-- Wayne's: the real AWS number from the Hanafy CRM (sms_aws_sending_identities
-- e2b628fc…, us-east-1, PROMOTIONAL).  The CRM still sends, so the platform
-- dispatcher stays off for Wayne's (dispatch_mode legacy_crm_bridge).
insert into public.messaging_connections (workspace_id, channel, provider, status, aws_region, dispatch_mode, live_sending, production_access_status)
select workspace.id, 'sms', 'aws_end_user_messaging', 'active', 'us-east-1', 'legacy_crm_bridge', false, null
from public.workspaces workspace
where workspace.slug = 'waynes-pizza'
on conflict (workspace_id, channel, provider) do nothing;

insert into public.messaging_origination_identities (
  workspace_id, messaging_connection_id, channel, phone_number, provider_identity_arn, message_type, status, is_default, legacy_crm_identity_id
)
select connection.workspace_id, connection.id, 'sms', '+15136764597', 'phone-ae22e45ef42b420b8e7096b9e67daf7b', 'PROMOTIONAL', 'active', true,
  'e2b628fc-4788-4df8-adf2-cc256f5333ef'
from public.messaging_connections connection
join public.workspaces workspace on workspace.id = connection.workspace_id and workspace.slug = 'waynes-pizza'
where connection.channel = 'sms'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 4. Suppressions (§19.5)
-- ---------------------------------------------------------------------------
create table if not exists public.suppression_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  channel text not null check (channel in ('sms', 'email')),
  address text not null check (char_length(address) between 3 and 320),
  customer_id uuid,
  reason text not null check (reason in ('stop_keyword', 'manual', 'carrier_block', 'hard_bounce', 'complaint', 'crm_removal')),
  source text not null default 'platform' check (char_length(source) between 1 and 80),
  note text not null default '' check (char_length(note) <= 500),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by_user_id uuid references auth.users(id) on delete set null,
  lift_reason text check (lift_reason is null or char_length(lift_reason) between 1 and 500),
  check ((lifted_at is null) = (lift_reason is null)),
  foreign key (customer_id, workspace_id) references public.customers(id, workspace_id) on delete restrict
);
create unique index if not exists suppression_entries_active
  on public.suppression_entries(workspace_id, channel, address) where lifted_at is null;
create index if not exists suppression_entries_workspace_idx on public.suppression_entries(workspace_id, created_at desc);

-- True when the address may not be messaged on that channel in that workspace.
create or replace function public.hanafy_is_suppressed(target_workspace_id uuid, target_channel text, target_address text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.suppression_entries entry
    where entry.workspace_id = target_workspace_id
      and entry.channel = target_channel
      and entry.address = target_address
      and entry.lifted_at is null
  );
$$;
revoke all on function public.hanafy_is_suppressed(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Templates and campaigns (§17.1 Campaign Manager, §17.3)
-- ---------------------------------------------------------------------------
create table if not exists public.message_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  channel text not null default 'sms' check (channel in ('sms', 'email')),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  body text not null check (char_length(body) between 1 and 1600),
  message_type text not null default 'marketing' check (message_type in ('marketing', 'transactional')),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index if not exists message_templates_name
  on public.message_templates(workspace_id, channel, lower(btrim(name))) where status = 'active';

create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  channel text not null default 'sms' check (channel in ('sms', 'email')),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  audience_type text not null default 'all_subscribers' check (audience_type in ('all_subscribers', 'segment')),
  segment_id uuid,
  template_id uuid,
  body text not null default '' check (char_length(body) <= 1600),
  origin_identity_id uuid,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  cancelled_at timestamptz,
  recipients_total integer not null default 0 check (recipients_total >= 0),
  recipients_skipped integer not null default 0 check (recipients_skipped >= 0),
  messages_sent integer not null default 0 check (messages_sent >= 0),
  messages_failed integer not null default 0 check (messages_failed >= 0),
  test_sends integer not null default 0 check (test_sends between 0 and 10),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  check ((audience_type = 'segment') = (segment_id is not null)),
  foreign key (segment_id, workspace_id) references public.customer_segments(id, workspace_id) on delete restrict,
  foreign key (template_id, workspace_id) references public.message_templates(id, workspace_id) on delete restrict,
  foreign key (origin_identity_id, workspace_id) references public.messaging_origination_identities(id, workspace_id) on delete restrict
);
create index if not exists marketing_campaigns_workspace_idx on public.marketing_campaigns(workspace_id, created_at desc);

create table if not exists public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  campaign_id uuid not null,
  customer_id uuid not null,
  recipient text not null,
  status text not null default 'queued' check (status in ('queued', 'skipped', 'sent', 'delivered', 'failed', 'cancelled')),
  skip_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, customer_id),
  unique (id, workspace_id),
  foreign key (campaign_id, workspace_id) references public.marketing_campaigns(id, workspace_id) on delete restrict,
  foreign key (customer_id, workspace_id) references public.customers(id, workspace_id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- 6. Message jobs (§19.4)
-- ---------------------------------------------------------------------------
create table if not exists public.message_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  location_id uuid,
  customer_id uuid,
  campaign_id uuid,
  campaign_recipient_id uuid,
  automation_run_id uuid,
  channel text not null check (channel in ('sms', 'email')),
  message_type text not null check (message_type in ('marketing', 'transactional')),
  origin_identity_id uuid not null,
  recipient text not null check (char_length(recipient) between 3 and 320),
  body text not null check (char_length(body) between 1 and 1600),
  is_test boolean not null default false,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'cancelled', 'unknown')),
  skip_reason text check (skip_reason is null or skip_reason in ('service_disabled', 'customer_not_in_workspace', 'customer_removed', 'no_consent', 'suppressed', 'no_recipient')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_message_id text,
  provider_status text,
  simulated boolean not null default false,
  segments_count integer check (segments_count is null or segments_count between 1 and 20),
  cost_cents integer check (cost_cents is null or cost_cents >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  unique (workspace_id, idempotency_key),
  unique (id, workspace_id),
  foreign key (location_id, workspace_id) references public.locations(id, workspace_id) on delete restrict,
  foreign key (customer_id, workspace_id) references public.customers(id, workspace_id) on delete restrict,
  foreign key (campaign_id, workspace_id) references public.marketing_campaigns(id, workspace_id) on delete restrict,
  foreign key (campaign_recipient_id, workspace_id) references public.campaign_recipients(id, workspace_id) on delete restrict,
  foreign key (origin_identity_id, workspace_id) references public.messaging_origination_identities(id, workspace_id) on delete restrict
);
create index if not exists message_jobs_due_idx on public.message_jobs(next_attempt_at) where status = 'queued';
create index if not exists message_jobs_workspace_idx on public.message_jobs(workspace_id, created_at desc);
create unique index if not exists message_jobs_provider_message on public.message_jobs(provider_message_id) where provider_message_id is not null;

create table if not exists public.message_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  workspace_id uuid references public.workspaces(id) on delete restrict,
  message_job_id uuid references public.message_jobs(id) on delete restrict,
  event_type text not null check (char_length(event_type) between 1 and 80),
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

-- Guards and updated_at for every new tenant table.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'messaging_connections', 'messaging_origination_identities', 'suppression_entries', 'message_templates',
    'marketing_campaigns', 'campaign_recipients', 'message_jobs'
  ] loop
    execute format('drop trigger if exists aa_hanafy_guard_platform_row on public.%I', table_name);
    execute format('create trigger aa_hanafy_guard_platform_row before insert or update on public.%I for each row execute function public.hanafy_guard_platform_row()', table_name);
  end loop;
  foreach table_name in array array[
    'messaging_connections', 'messaging_origination_identities', 'message_templates', 'marketing_campaigns', 'campaign_recipients'
  ] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_set_updated_at', table_name);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', table_name || '_set_updated_at', table_name);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS: members read their own workspace; every write goes through RPCs
-- ---------------------------------------------------------------------------
alter table public.crm_legacy_business_links enable row level security;
alter table public.messaging_connections enable row level security;
alter table public.messaging_origination_identities enable row level security;
alter table public.suppression_entries enable row level security;
alter table public.message_templates enable row level security;
alter table public.marketing_campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.message_jobs enable row level security;
alter table public.message_provider_events enable row level security;

revoke all on public.crm_legacy_business_links, public.messaging_connections, public.messaging_origination_identities,
  public.suppression_entries, public.message_templates, public.marketing_campaigns, public.campaign_recipients,
  public.message_jobs, public.message_provider_events from anon, authenticated;
grant select on public.messaging_connections, public.messaging_origination_identities, public.suppression_entries,
  public.message_templates, public.marketing_campaigns, public.campaign_recipients, public.message_jobs to authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'messaging_connections', 'messaging_origination_identities', 'message_templates', 'marketing_campaigns',
    'campaign_recipients', 'message_jobs'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_workspace_read', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.hanafy_can_access_workspace_data(workspace_id, array[''campaigns.view'', ''campaigns.manage'']))',
      table_name || '_workspace_read', table_name
    );
  end loop;
end;
$$;
drop policy if exists suppression_entries_workspace_read on public.suppression_entries;
create policy suppression_entries_workspace_read on public.suppression_entries
for select to authenticated using (public.hanafy_can_access_workspace_data(workspace_id, array['messaging.manage', 'campaigns.view']));

-- ---------------------------------------------------------------------------
-- 8. The one send path (§19.3)
-- ---------------------------------------------------------------------------

-- Why a message may not go out, or null when it may.  Called when the job is
-- created AND again when the dispatcher claims it.
create or replace function public.hanafy_message_block_reason(
  target_workspace_id uuid, target_customer_id uuid, target_channel text, target_message_type text, target_recipient text, is_test boolean default false
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare customer_row public.customers%rowtype;
begin
  if not public.hanafy_service_active(target_workspace_id, target_channel) then
    return 'service_disabled';
  end if;
  if target_recipient is null or btrim(target_recipient) = '' then
    return 'no_recipient';
  end if;
  if target_customer_id is not null then
    select * into customer_row from public.customers customer
    where customer.id = target_customer_id and customer.workspace_id = target_workspace_id;
    if not found then return 'customer_not_in_workspace'; end if;
    if customer_row.removed_at is not null then return 'customer_removed'; end if;
    if target_message_type = 'marketing' and not is_test and (
      (target_channel = 'sms' and not customer_row.sms_marketing_opt_in)
      or (target_channel = 'email' and not customer_row.email_marketing_opt_in)
    ) then
      return 'no_consent';
    end if;
  elsif target_message_type = 'marketing' and not is_test then
    -- Marketing needs a known, consenting customer of this workspace.
    return 'no_consent';
  end if;
  if public.hanafy_is_suppressed(target_workspace_id, target_channel, target_recipient) then
    return 'suppressed';
  end if;
  return null;
end;
$$;
revoke all on function public.hanafy_message_block_reason(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;

-- The sender for this workspace.  Raises instead of falling back (§19.3).
create or replace function public.hanafy_resolve_sender(
  target_workspace_id uuid, target_location_id uuid, target_channel text, requested_identity_id uuid default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  chosen uuid;
  connection_status text;
begin
  if requested_identity_id is not null then
    select identity.id into chosen
    from public.messaging_origination_identities identity
    where identity.id = requested_identity_id and identity.workspace_id = target_workspace_id
      and identity.channel = target_channel and identity.status = 'active';
    if chosen is null then
      raise exception 'SENDER_NOT_IN_WORKSPACE: that sending number does not belong to this business or is not active'
        using errcode = '42501';
    end if;
  else
    select identity.id into chosen
    from public.messaging_origination_identities identity
    where identity.workspace_id = target_workspace_id and identity.channel = target_channel and identity.status = 'active'
      and (identity.location_id is null or identity.location_id = target_location_id)
    order by (identity.location_id is not null and identity.location_id = target_location_id) desc, identity.is_default desc, identity.created_at
    limit 1;
    if chosen is null then
      raise exception 'NO_SENDER: this business has no active % sending number', target_channel
        using errcode = 'P0001', hint = 'Add one in Platform Admin → Messaging. Messages never fall back to another business''s number.';
    end if;
  end if;

  select connection.status into connection_status
  from public.messaging_origination_identities identity
  join public.messaging_connections connection
    on connection.id = identity.messaging_connection_id and connection.workspace_id = identity.workspace_id
  where identity.id = chosen;
  if connection_status not in ('active', 'sandbox') then
    raise exception 'SENDER_CONNECTION_INACTIVE: the messaging connection is %', connection_status using errcode = 'P0001';
  end if;
  return chosen;
end;
$$;
revoke all on function public.hanafy_resolve_sender(uuid, uuid, text, uuid) from public, anon, authenticated;

-- Creates (or returns) one message job.  Internal: callable only from other
-- SECURITY DEFINER functions and the service role.  Every ownership check is
-- repeated here; nothing the caller passes is trusted.
create or replace function public.hanafy_enqueue_message(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid := (payload ->> 'workspace_id')::uuid;
  target_location uuid := nullif(payload ->> 'location_id', '')::uuid;
  target_customer uuid := nullif(payload ->> 'customer_id', '')::uuid;
  target_channel text := coalesce(payload ->> 'channel', 'sms');
  target_type text := coalesce(payload ->> 'message_type', 'marketing');
  test_flag boolean := coalesce((payload ->> 'is_test')::boolean, false);
  key text := payload ->> 'idempotency_key';
  body_text text := payload ->> 'body';
  recipient_value text := nullif(btrim(coalesce(payload ->> 'recipient', '')), '');
  sender uuid;
  mode text;
  block text;
  existing public.message_jobs%rowtype;
  created public.message_jobs%rowtype;
begin
  if target_workspace is null or key is null or body_text is null or btrim(body_text) = '' then
    raise exception 'workspace_id, idempotency_key and body are required' using errcode = '22023';
  end if;
  if target_channel <> 'sms' then
    raise exception 'EMAIL_NOT_AVAILABLE: no email provider is connected for this business' using errcode = 'P0001';
  end if;

  select * into existing from public.message_jobs job where job.workspace_id = target_workspace and job.idempotency_key = key;
  if found then
    return jsonb_build_object('job_id', existing.id, 'status', existing.status, 'skip_reason', existing.skip_reason, 'duplicate', true);
  end if;

  if target_customer is not null then
    select customer.phone_normalized into recipient_value
    from public.customers customer
    where customer.id = target_customer and customer.workspace_id = target_workspace;
    if not found then
      raise exception 'CUSTOMER_NOT_IN_WORKSPACE' using errcode = '42501';
    end if;
  elsif recipient_value is not null and recipient_value !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Recipient must be an E.164 phone number' using errcode = '22023';
  end if;

  if target_location is not null and not exists (
    select 1 from public.locations location where location.id = target_location and location.workspace_id = target_workspace
  ) then
    raise exception 'LOCATION_NOT_IN_WORKSPACE' using errcode = '42501';
  end if;

  sender := public.hanafy_resolve_sender(target_workspace, target_location, target_channel, nullif(payload ->> 'origin_identity_id', '')::uuid);
  select connection.dispatch_mode into mode
  from public.messaging_origination_identities identity
  join public.messaging_connections connection on connection.id = identity.messaging_connection_id
  where identity.id = sender;
  if mode <> 'platform' then
    raise exception 'LEGACY_CRM_SENDS: this business still sends texts from the Hanafy CRM console'
      using errcode = 'P0001', hint = 'Switch its messaging to the platform sender in Platform Admin → Messaging first.';
  end if;

  block := public.hanafy_message_block_reason(target_workspace, target_customer, target_channel, target_type, recipient_value, test_flag);

  insert into public.message_jobs (
    workspace_id, location_id, customer_id, campaign_id, campaign_recipient_id, automation_run_id, channel, message_type,
    origin_identity_id, recipient, body, is_test, idempotency_key, status, skip_reason, next_attempt_at, created_by_user_id
  ) values (
    target_workspace, target_location, target_customer, nullif(payload ->> 'campaign_id', '')::uuid,
    nullif(payload ->> 'campaign_recipient_id', '')::uuid, nullif(payload ->> 'automation_run_id', '')::uuid,
    target_channel, target_type, sender, coalesce(recipient_value, 'none'), left(body_text, 1600), test_flag, key,
    case when block is null then 'queued' else 'skipped' end, block,
    coalesce(nullif(payload ->> 'send_at', '')::timestamptz, now()), auth.uid()
  )
  on conflict (workspace_id, idempotency_key) do nothing
  returning * into created;

  if created.id is null then
    select * into existing from public.message_jobs job where job.workspace_id = target_workspace and job.idempotency_key = key;
    return jsonb_build_object('job_id', existing.id, 'status', existing.status, 'skip_reason', existing.skip_reason, 'duplicate', true);
  end if;
  return jsonb_build_object('job_id', created.id, 'status', created.status, 'skip_reason', created.skip_reason, 'duplicate', false);
end;
$$;
revoke all on function public.hanafy_enqueue_message(jsonb) from public, anon, authenticated;
grant execute on function public.hanafy_enqueue_message(jsonb) to service_role;

-- Renders {{placeholders}} from a flat jsonb context; unknown ones become ''.
create or replace function public.hanafy_render_template(body text, context jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  result text := body;
  item record;
begin
  for item in select key, value from jsonb_each_text(coalesce(context, '{}'::jsonb)) loop
    result := replace(result, '{{' || item.key || '}}', coalesce(item.value, ''));
  end loop;
  return regexp_replace(result, '\{\{[a-z_][a-z0-9_]*\}\}', '', 'g');
end;
$$;

-- Personalisation context for one customer of one workspace.
create or replace function public.hanafy_customer_message_context(target_workspace_id uuid, target_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'business_name', workspace.name,
    'first_name', coalesce(nullif(btrim(customer.first_name), ''), 'there'),
    'last_name', customer.last_name,
    'offer_link_key', customer.offer_link_key
  )
  from public.workspaces workspace
  left join public.customers customer on customer.id = target_customer_id and customer.workspace_id = workspace.id
  where workspace.id = target_workspace_id;
$$;
revoke all on function public.hanafy_customer_message_context(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Dispatcher contract (service role only)
-- ---------------------------------------------------------------------------

-- Claims due jobs for connections the platform sends for.  Consent,
-- suppression and service are checked again at this moment.  A job whose
-- lease expired while 'sending' is marked 'unknown', never re-sent: the
-- provider may already have delivered it (§18.4 — no duplicate messages).
create or replace function public.hanafy_message_jobs_claim(max_jobs integer default 25, lease_seconds integer default 120)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed jsonb := '[]'::jsonb;
  job record;
  block text;
  lease uuid;
begin
  update public.message_jobs set status = 'unknown', last_error = 'The send was interrupted; outcome unknown, not retried automatically.', lease_token = null
  where status = 'sending' and lease_expires_at < now();

  for job in
    select message_job.*, connection.aws_region, connection.live_sending, connection.secret_reference, connection.id as connection_id,
      identity.phone_number as sender_number, identity.provider_identity_arn, identity.message_type as identity_message_type
    from public.message_jobs message_job
    join public.messaging_origination_identities identity
      on identity.id = message_job.origin_identity_id and identity.workspace_id = message_job.workspace_id
    join public.messaging_connections connection
      on connection.id = identity.messaging_connection_id and connection.workspace_id = message_job.workspace_id
    where message_job.status = 'queued' and message_job.next_attempt_at <= now()
      and connection.dispatch_mode = 'platform' and connection.status in ('active', 'sandbox') and identity.status = 'active'
    order by message_job.next_attempt_at, message_job.created_at
    limit greatest(1, least(max_jobs, 200))
    for update of message_job skip locked
  loop
    block := public.hanafy_message_block_reason(job.workspace_id, job.customer_id, job.channel, job.message_type, job.recipient, job.is_test);
    if block is not null then
      update public.message_jobs set status = 'skipped', skip_reason = block where id = job.id;
      update public.campaign_recipients set status = 'skipped', skip_reason = block where id = job.campaign_recipient_id;
      continue;
    end if;
    lease := gen_random_uuid();
    update public.message_jobs
    set status = 'sending', lease_token = lease, lease_expires_at = now() + make_interval(secs => greatest(30, least(lease_seconds, 900))), attempts = attempts + 1
    where id = job.id;
    claimed := claimed || jsonb_build_object(
      'job_id', job.id, 'lease_token', lease, 'workspace_id', job.workspace_id, 'recipient', job.recipient, 'body', job.body,
      'message_type', case when job.message_type = 'transactional' then 'TRANSACTIONAL' else 'PROMOTIONAL' end,
      'origination_identity', coalesce(job.provider_identity_arn, job.sender_number), 'sender_number', job.sender_number,
      'aws_region', job.aws_region, 'live_sending', job.live_sending, 'secret_reference', job.secret_reference,
      'connection_id', job.connection_id, 'attempt', job.attempts + 1
    );
  end loop;
  return claimed;
end;
$$;
revoke all on function public.hanafy_message_jobs_claim(integer, integer) from public, anon, authenticated;
grant execute on function public.hanafy_message_jobs_claim(integer, integer) to service_role;

create or replace function public.hanafy_message_job_finish(
  target_job_id uuid, target_lease uuid, outcome text, provider_message_value text default null,
  error_value text default null, simulated_value boolean default false, segments_value integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.message_jobs%rowtype;
  connection_id uuid;
begin
  if outcome not in ('sent', 'retry', 'failed', 'unknown') then
    raise exception 'outcome must be sent, retry, failed or unknown' using errcode = '22023';
  end if;
  select * into job from public.message_jobs where id = target_job_id for update;
  if not found or job.status <> 'sending' or job.lease_token is distinct from target_lease then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;
  select identity.messaging_connection_id into connection_id
  from public.messaging_origination_identities identity where identity.id = job.origin_identity_id;

  if outcome = 'sent' then
    update public.message_jobs set status = 'sent', sent_at = now(), provider_message_id = provider_message_value,
      provider_status = case when simulated_value then 'SIMULATED' else 'ACCEPTED' end, simulated = simulated_value,
      segments_count = segments_value, lease_token = null, lease_expires_at = null, last_error = null
    where id = job.id;
    update public.campaign_recipients set status = 'sent' where id = job.campaign_recipient_id;
    update public.marketing_campaigns set messages_sent = messages_sent + 1 where id = job.campaign_id;
    update public.messaging_connections set last_success_at = now() where id = connection_id;
  elsif outcome = 'unknown' then
    -- The request left but no answer came back: never re-sent automatically.
    update public.message_jobs set status = 'unknown', lease_token = null, lease_expires_at = null, last_error = left(error_value, 1000)
    where id = job.id;
    update public.messaging_connections set last_error_at = now(), last_error_summary = left(error_value, 500) where id = connection_id;
  elsif outcome = 'retry' and job.attempts < 5 then
    update public.message_jobs set status = 'queued', lease_token = null, lease_expires_at = null,
      next_attempt_at = now() + make_interval(secs => 30 * power(2, job.attempts)::integer), last_error = left(error_value, 1000)
    where id = job.id;
    update public.messaging_connections set last_error_at = now(), last_error_summary = left(error_value, 500) where id = connection_id;
  else
    update public.message_jobs set status = 'failed', failed_at = now(), lease_token = null, lease_expires_at = null, last_error = left(error_value, 1000)
    where id = job.id;
    update public.campaign_recipients set status = 'failed' where id = job.campaign_recipient_id;
    update public.marketing_campaigns set messages_failed = messages_failed + 1 where id = job.campaign_id;
    update public.messaging_connections set last_error_at = now(), last_error_summary = left(error_value, 500) where id = connection_id;
  end if;

  -- A campaign is finished when none of its jobs are still waiting.
  if job.campaign_id is not null then
    update public.marketing_campaigns campaign set status = 'sent', finished_at = now()
    where campaign.id = job.campaign_id and campaign.status = 'sending'
      and not exists (select 1 from public.message_jobs other where other.campaign_id = campaign.id and other.status in ('queued', 'sending'));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.hanafy_message_job_finish(uuid, uuid, text, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.hanafy_message_job_finish(uuid, uuid, text, text, text, boolean, integer) to service_role;

-- Provider delivery receipts, deduplicated by provider event id (§18.4).
create or replace function public.hanafy_message_delivery_status(
  provider_value text, provider_event_value text, provider_message_value text, status_value text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare job public.message_jobs%rowtype;
begin
  select * into job from public.message_jobs where provider_message_id = provider_message_value;
  insert into public.message_provider_events (provider, provider_event_id, workspace_id, message_job_id, event_type)
  values (provider_value, provider_event_value, job.workspace_id, job.id, status_value)
  on conflict (provider, provider_event_id) do nothing;
  if not found then return jsonb_build_object('duplicate', true); end if;
  if job.id is null then return jsonb_build_object('matched', false); end if;
  if status_value in ('DELIVERED', 'delivered') then
    update public.message_jobs set status = 'delivered', delivered_at = now(), provider_status = status_value where id = job.id and status in ('sent', 'unknown');
    update public.campaign_recipients set status = 'delivered' where id = job.campaign_recipient_id;
  elsif status_value in ('FAILED', 'failed', 'BLOCKED', 'CARRIER_BLOCKED', 'INVALID', 'OPTED_OUT', 'TTL_EXPIRED', 'UNREACHABLE') then
    update public.message_jobs set status = 'failed', failed_at = now(), provider_status = status_value where id = job.id and status in ('sent', 'unknown');
    update public.campaign_recipients set status = 'failed' where id = job.campaign_recipient_id;
  else
    update public.message_jobs set provider_status = status_value where id = job.id;
  end if;
  return jsonb_build_object('matched', true, 'workspace_id', job.workspace_id);
end;
$$;
revoke all on function public.hanafy_message_delivery_status(text, text, text, text) from public, anon, authenticated;
grant execute on function public.hanafy_message_delivery_status(text, text, text, text) to service_role;

-- Inbound STOP / START / HELP to a platform number.  The destination number
-- decides the workspace, so a STOP to business A never touches business B.
create or replace function public.hanafy_messaging_inbound(
  destination_number text, sender_number text, message_body text, provider_event_value text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  identity public.messaging_origination_identities%rowtype;
  keyword text := upper(btrim(regexp_replace(coalesce(message_body, ''), '[^A-Za-z]', '', 'g')));
  action text := 'none';
  customer_row public.customers%rowtype;
begin
  select * into identity from public.messaging_origination_identities
  where channel = 'sms' and phone_number = destination_number and status <> 'retired';
  if not found then return jsonb_build_object('matched', false); end if;
  if sender_number !~ '^\+[1-9][0-9]{7,14}$' then return jsonb_build_object('matched', true, 'action', 'ignored'); end if;
  if provider_event_value is not null then
    insert into public.message_provider_events (provider, provider_event_id, workspace_id, event_type)
    values ('aws_end_user_messaging', provider_event_value, identity.workspace_id, 'inbound')
    on conflict (provider, provider_event_id) do nothing;
    if not found then return jsonb_build_object('matched', true, 'duplicate', true); end if;
  end if;

  select * into customer_row from public.customers
  where workspace_id = identity.workspace_id and phone_normalized = sender_number;

  if keyword in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE') then
    action := 'opted_out';
    insert into public.suppression_entries (workspace_id, channel, address, customer_id, reason, source, note)
    values (identity.workspace_id, 'sms', sender_number, customer_row.id, 'stop_keyword', 'inbound_sms', 'Replied ' || keyword)
    on conflict (workspace_id, channel, address) where lifted_at is null do nothing;
    if customer_row.id is not null and customer_row.sms_marketing_opt_in then
      insert into public.marketing_consents (workspace_id, customer_id, channel, status, source, consent_text_version, metadata)
      values (identity.workspace_id, customer_row.id, 'sms', 'opted_out', 'sms_stop_keyword', 'n/a', jsonb_build_object('keyword', keyword, 'to', destination_number));
      update public.customers set sms_marketing_opt_in = false where id = customer_row.id;
    end if;
    update public.message_jobs set status = 'skipped', skip_reason = 'suppressed'
    where workspace_id = identity.workspace_id and channel = 'sms' and recipient = sender_number and status = 'queued';
  elsif keyword in ('START', 'UNSTOP', 'YES', 'SUBSCRIBE') then
    action := 'opted_in';
    update public.suppression_entries set lifted_at = now(), lift_reason = 'Replied ' || keyword
    where workspace_id = identity.workspace_id and channel = 'sms' and address = sender_number and lifted_at is null and reason = 'stop_keyword';
    if customer_row.id is not null and not customer_row.sms_marketing_opt_in then
      insert into public.marketing_consents (workspace_id, customer_id, channel, status, source, consent_text_version, metadata)
      values (identity.workspace_id, customer_row.id, 'sms', 'opted_in', 'sms_start_keyword', 'keyword-start-v1', jsonb_build_object('keyword', keyword, 'to', destination_number));
      update public.customers set sms_marketing_opt_in = true where id = customer_row.id;
    end if;
  elsif keyword in ('HELP', 'INFO') then
    action := 'help';
  end if;
  return jsonb_build_object('matched', true, 'workspace_id', identity.workspace_id, 'action', action);
end;
$$;
revoke all on function public.hanafy_messaging_inbound(text, text, text, text) from public, anon, authenticated;
grant execute on function public.hanafy_messaging_inbound(text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Workspace RPCs: Campaign Manager, templates, suppressions
-- ---------------------------------------------------------------------------

-- Everything the Marketing screens need, for one workspace.
create or replace function public.hanafy_marketing_overview(target_workspace_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'campaigns.view');
begin
  return jsonb_build_object(
    'workspace_id', target,
    'can_manage', public.hanafy_has_workspace_permission(target, 'campaigns.manage'),
    'can_manage_suppressions', public.hanafy_has_workspace_permission(target, 'messaging.manage'),
    'connection', (
      select jsonb_build_object('id', connection.id, 'status', connection.status, 'dispatch_mode', connection.dispatch_mode,
        'live_sending', connection.live_sending, 'aws_region', connection.aws_region,
        'registration_status', connection.registration_status, 'production_access_status', connection.production_access_status,
        'last_success_at', connection.last_success_at, 'last_error_at', connection.last_error_at)
      from public.messaging_connections connection
      where connection.workspace_id = target and connection.channel = 'sms'
    ),
    'senders', coalesce((
      select jsonb_agg(jsonb_build_object('id', identity.id, 'phone_number', identity.phone_number, 'status', identity.status,
        'is_default', identity.is_default, 'message_type', identity.message_type) order by identity.is_default desc, identity.created_at)
      from public.messaging_origination_identities identity where identity.workspace_id = target
    ), '[]'::jsonb),
    'subscribers', (select count(*) from public.customers customer
      where customer.workspace_id = target and customer.sms_marketing_opt_in and customer.removed_at is null),
    'suppressed', (select count(*) from public.suppression_entries entry where entry.workspace_id = target and entry.lifted_at is null),
    'suppressions', case when public.hanafy_has_workspace_permission(target, 'messaging.manage') then coalesce((
      select jsonb_agg(jsonb_build_object('id', entry.id, 'address', entry.address, 'reason', entry.reason, 'note', entry.note,
        'created_at', entry.created_at) order by entry.created_at desc)
      from (select * from public.suppression_entries e where e.workspace_id = target and e.lifted_at is null order by e.created_at desc limit 100) entry
    ), '[]'::jsonb) else '[]'::jsonb end,
    'segments', coalesce((
      select jsonb_agg(jsonb_build_object('id', segment.id, 'name', segment.name,
        'members', (select count(*) from public.customer_segment_memberships member where member.segment_id = segment.id and member.active))
        order by segment.sort_order, segment.name)
      from public.customer_segments segment where segment.workspace_id = target and segment.active
    ), '[]'::jsonb),
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object('id', template.id, 'name', template.name, 'body', template.body, 'channel', template.channel,
        'message_type', template.message_type, 'updated_at', template.updated_at) order by template.name)
      from public.message_templates template where template.workspace_id = target and template.status = 'active'
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object('id', campaign.id, 'name', campaign.name, 'status', campaign.status, 'channel', campaign.channel,
        'audience_type', campaign.audience_type, 'segment_id', campaign.segment_id, 'template_id', campaign.template_id,
        'body', campaign.body, 'scheduled_at', campaign.scheduled_at, 'started_at', campaign.started_at, 'finished_at', campaign.finished_at,
        'recipients_total', campaign.recipients_total, 'recipients_skipped', campaign.recipients_skipped,
        'messages_sent', campaign.messages_sent, 'messages_failed', campaign.messages_failed, 'created_at', campaign.created_at)
        order by campaign.created_at desc)
      from (select * from public.marketing_campaigns c where c.workspace_id = target order by c.created_at desc limit 100) campaign
    ), '[]'::jsonb),
    'recent_messages', coalesce((
      select jsonb_agg(jsonb_build_object('id', job.id, 'status', job.status, 'skip_reason', job.skip_reason,
        'recipient_last4', right(job.recipient, 4), 'message_type', job.message_type, 'campaign_id', job.campaign_id,
        'automation_run_id', job.automation_run_id, 'is_test', job.is_test, 'simulated', job.simulated,
        'created_at', job.created_at, 'sent_at', job.sent_at, 'last_error', job.last_error) order by job.created_at desc)
      from (select * from public.message_jobs j where j.workspace_id = target order by j.created_at desc limit 50) job
    ), '[]'::jsonb),
    'legacy_crm', (select jsonb_build_object('business_slug', link.legacy_business_slug) from public.crm_legacy_business_links link where link.workspace_id = target)
  );
end;
$$;
revoke all on function public.hanafy_marketing_overview(text) from public, anon, authenticated;
grant execute on function public.hanafy_marketing_overview(text) to authenticated;

create or replace function public.hanafy_template_save(target_workspace_slug text, payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'campaigns.manage');
  template_id uuid := nullif(payload ->> 'id', '')::uuid;
  saved uuid;
begin
  if template_id is null then
    insert into public.message_templates (workspace_id, channel, name, body, message_type, created_by_user_id)
    values (target, coalesce(payload ->> 'channel', 'sms'), btrim(payload ->> 'name'), payload ->> 'body',
      coalesce(payload ->> 'message_type', 'marketing'), auth.uid())
    returning id into saved;
  else
    update public.message_templates set name = btrim(payload ->> 'name'), body = payload ->> 'body',
      message_type = coalesce(payload ->> 'message_type', message_type),
      status = case when payload ->> 'status' = 'archived' then 'archived' else status end
    where id = template_id and workspace_id = target
    returning id into saved;
    if saved is null then raise exception 'Template not found' using errcode = 'P0002'; end if;
  end if;
  return saved;
end;
$$;
revoke all on function public.hanafy_template_save(text, jsonb) from public, anon, authenticated;
grant execute on function public.hanafy_template_save(text, jsonb) to authenticated;

-- Saves a draft campaign.  Only drafts are editable.
create or replace function public.hanafy_campaign_save(target_workspace_slug text, payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'campaigns.manage');
  campaign_id uuid := nullif(payload ->> 'id', '')::uuid;
  audience text := coalesce(payload ->> 'audience_type', 'all_subscribers');
  segment uuid := case when audience = 'segment' then nullif(payload ->> 'segment_id', '')::uuid else null end;
  template uuid := nullif(payload ->> 'template_id', '')::uuid;
  body_text text := coalesce(payload ->> 'body', '');
  saved uuid;
begin
  -- The composite foreign keys reject another workspace's segment/template;
  -- these checks just give a readable message first.
  if segment is not null and not exists (select 1 from public.customer_segments s where s.id = segment and s.workspace_id = target) then
    raise exception 'That segment does not belong to this business' using errcode = '42501';
  end if;
  if template is not null then
    if not exists (select 1 from public.message_templates t where t.id = template and t.workspace_id = target and t.status = 'active') then
      raise exception 'That template does not belong to this business' using errcode = '42501';
    end if;
    if btrim(body_text) = '' then select t.body into body_text from public.message_templates t where t.id = template; end if;
  end if;

  if campaign_id is null then
    insert into public.marketing_campaigns (workspace_id, name, channel, audience_type, segment_id, template_id, body, created_by_user_id)
    values (target, btrim(payload ->> 'name'), 'sms', audience, segment, template, body_text, auth.uid())
    returning id into saved;
  else
    update public.marketing_campaigns set name = btrim(payload ->> 'name'), audience_type = audience, segment_id = segment,
      template_id = template, body = body_text
    where id = campaign_id and workspace_id = target and status = 'draft'
    returning id into saved;
    if saved is null then raise exception 'Only draft campaigns in this business can be edited' using errcode = 'P0001'; end if;
  end if;
  return saved;
end;
$$;
revoke all on function public.hanafy_campaign_save(text, jsonb) from public, anon, authenticated;
grant execute on function public.hanafy_campaign_save(text, jsonb) to authenticated;

-- The audience of a campaign, always inside the campaign's own workspace.
create or replace function public.hanafy_campaign_audience_rows(target_campaign_id uuid)
returns table (customer_id uuid, recipient text, block_reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select customer.id, customer.phone_normalized,
    public.hanafy_message_block_reason(campaign.workspace_id, customer.id, campaign.channel, 'marketing', customer.phone_normalized)
  from public.marketing_campaigns campaign
  join public.customers customer on customer.workspace_id = campaign.workspace_id
  where campaign.id = target_campaign_id
    and customer.removed_at is null
    and (
      (campaign.audience_type = 'all_subscribers' and customer.sms_marketing_opt_in)
      or (campaign.audience_type = 'segment' and exists (
        select 1 from public.customer_segment_memberships member
        where member.segment_id = campaign.segment_id and member.customer_id = customer.id
          and member.workspace_id = campaign.workspace_id and member.active
      ))
    );
$$;
revoke all on function public.hanafy_campaign_audience_rows(uuid) from public, anon, authenticated;

create or replace function public.hanafy_campaign_audience(target_workspace_slug text, target_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'campaigns.view');
begin
  if not exists (select 1 from public.marketing_campaigns c where c.id = target_campaign_id and c.workspace_id = target) then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;
  return (
    select jsonb_build_object(
      'total', count(*),
      'eligible', count(*) filter (where audience.block_reason is null),
      'skipped', coalesce(jsonb_object_agg(audience.block_reason, audience.n) filter (where audience.block_reason is not null), '{}'::jsonb)
    )
    from (
      select rows.block_reason, count(*) over (partition by rows.block_reason) as n
      from public.hanafy_campaign_audience_rows(target_campaign_id) rows
    ) audience
  );
end;
$$;
revoke all on function public.hanafy_campaign_audience(text, uuid) from public, anon, authenticated;
grant execute on function public.hanafy_campaign_audience(text, uuid) to authenticated;

-- Sends (or schedules) a draft.  Recipients and jobs are created in one
-- transaction; the dispatcher re-checks consent before each send.
create or replace function public.hanafy_campaign_send(target_workspace_slug text, target_campaign_id uuid, send_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'campaigns.manage');
  campaign public.marketing_campaigns%rowtype;
  sender uuid;
  mode text;
  audience record;
  recipient_id uuid;
  total integer := 0;
  skipped integer := 0;
  release_at timestamptz := greatest(coalesce(send_at, now()), now());
begin
  select * into campaign from public.marketing_campaigns where id = target_campaign_id and workspace_id = target for update;
  if not found then raise exception 'Campaign not found' using errcode = 'P0002'; end if;
  if campaign.status <> 'draft' then raise exception 'This campaign was already sent or scheduled' using errcode = 'P0001'; end if;
  if btrim(campaign.body) = '' then raise exception 'Write the message first' using errcode = 'P0001'; end if;
  if not public.hanafy_service_active(target, campaign.channel) then
    raise exception 'SERVICE_DISABLED:%', campaign.channel using errcode = '42501';
  end if;

  sender := public.hanafy_resolve_sender(target, null, campaign.channel, campaign.origin_identity_id);
  select connection.dispatch_mode into mode
  from public.messaging_origination_identities identity
  join public.messaging_connections connection on connection.id = identity.messaging_connection_id
  where identity.id = sender;
  if mode <> 'platform' then
    raise exception 'LEGACY_CRM_SENDS: this business still sends texts from the Hanafy CRM console'
      using errcode = 'P0001', hint = 'Send this campaign from the Hanafy CRM, or ask Hanafy to switch messaging to the platform sender.';
  end if;

  for audience in select * from public.hanafy_campaign_audience_rows(campaign.id) loop
    total := total + 1;
    insert into public.campaign_recipients (workspace_id, campaign_id, customer_id, recipient, status, skip_reason)
    values (target, campaign.id, audience.customer_id, audience.recipient,
      case when audience.block_reason is null then 'queued' else 'skipped' end, audience.block_reason)
    returning id into recipient_id;
    if audience.block_reason is not null then
      skipped := skipped + 1;
      continue;
    end if;
    perform public.hanafy_enqueue_message(jsonb_build_object(
      'workspace_id', target, 'customer_id', audience.customer_id, 'channel', campaign.channel, 'message_type', 'marketing',
      'body', public.hanafy_render_template(campaign.body, public.hanafy_customer_message_context(target, audience.customer_id)),
      'origin_identity_id', sender, 'campaign_id', campaign.id, 'campaign_recipient_id', recipient_id,
      'idempotency_key', 'campaign:' || campaign.id || ':' || audience.customer_id, 'send_at', release_at
    ));
  end loop;

  update public.marketing_campaigns set
    status = case when total - skipped = 0 then 'sent' when release_at > now() + interval '1 minute' then 'scheduled' else 'sending' end,
    origin_identity_id = sender, scheduled_at = release_at, started_at = now(),
    finished_at = case when total - skipped = 0 then now() else null end,
    recipients_total = total, recipients_skipped = skipped
  where id = campaign.id;

  insert into public.audit_log (workspace_id, location_id, actor_user_id, actor_name, action, entity_type, entity_id, summary, changes, metadata)
  select target, location.id, auth.uid(), coalesce((select profile.display_name from public.profiles profile where profile.id = auth.uid()), 'Staff'),
    'campaign.sent', 'marketing_campaign', campaign.id::text,
    format('Campaign "%s" %s to %s customers (%s skipped)', campaign.name, case when release_at > now() + interval '1 minute' then 'scheduled' else 'sent' end, total - skipped, skipped),
    '{}'::jsonb, jsonb_build_object('scheduled_at', release_at)
  from public.locations location where location.workspace_id = target order by location.created_at limit 1;

  return jsonb_build_object('campaign_id', campaign.id, 'recipients', total, 'queued', total - skipped, 'skipped', skipped, 'scheduled_at', release_at);
end;
$$;
revoke all on function public.hanafy_campaign_send(text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.hanafy_campaign_send(text, uuid, timestamptz) to authenticated;

-- Scheduled campaigns become 'sending' once their time comes (called by the dispatcher).
create or replace function public.hanafy_campaigns_release_due()
returns integer
language sql
security definer
set search_path = ''
as $$
  with released as (
    update public.marketing_campaigns set status = 'sending'
    where status = 'scheduled' and scheduled_at <= now()
    returning 1
  )
  select count(*)::integer from released;
$$;
revoke all on function public.hanafy_campaigns_release_due() from public, anon, authenticated;
grant execute on function public.hanafy_campaigns_release_due() to service_role;

create or replace function public.hanafy_campaign_cancel(target_workspace_slug text, target_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'campaigns.manage');
  cancelled integer;
begin
  update public.marketing_campaigns set status = 'cancelled', cancelled_at = now()
  where id = target_campaign_id and workspace_id = target and status in ('draft', 'scheduled', 'sending');
  if not found then raise exception 'Only a draft, scheduled or sending campaign can be cancelled' using errcode = 'P0001'; end if;
  with stopped as (
    update public.message_jobs set status = 'cancelled' where campaign_id = target_campaign_id and workspace_id = target and status = 'queued' returning campaign_recipient_id
  )
  update public.campaign_recipients recipient set status = 'cancelled' from stopped where recipient.id = stopped.campaign_recipient_id;
  get diagnostics cancelled = row_count;
  return jsonb_build_object('cancelled_messages', cancelled);
end;
$$;
revoke all on function public.hanafy_campaign_cancel(text, uuid) from public, anon, authenticated;
grant execute on function public.hanafy_campaign_cancel(text, uuid) to authenticated;

-- A test text to a staff phone.  Suppression still applies; at most 10 per campaign.
create or replace function public.hanafy_campaign_test_send(target_workspace_slug text, target_campaign_id uuid, test_phone text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'campaigns.manage');
  campaign public.marketing_campaigns%rowtype;
begin
  select * into campaign from public.marketing_campaigns where id = target_campaign_id and workspace_id = target for update;
  if not found then raise exception 'Campaign not found' using errcode = 'P0002'; end if;
  if campaign.test_sends >= 10 then raise exception 'This campaign already has 10 test texts' using errcode = 'P0001'; end if;
  if test_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' then raise exception 'Enter a valid US mobile number' using errcode = '22023'; end if;
  update public.marketing_campaigns set test_sends = test_sends + 1 where id = campaign.id;
  return public.hanafy_enqueue_message(jsonb_build_object(
    'workspace_id', target, 'recipient', test_phone, 'channel', campaign.channel, 'message_type', 'marketing', 'is_test', true,
    'body', '[TEST] ' || public.hanafy_render_template(campaign.body, public.hanafy_customer_message_context(target, null)),
    'origin_identity_id', campaign.origin_identity_id, 'campaign_id', campaign.id,
    'idempotency_key', 'campaign-test:' || campaign.id || ':' || (campaign.test_sends + 1)
  ));
end;
$$;
revoke all on function public.hanafy_campaign_test_send(text, uuid, text) from public, anon, authenticated;
grant execute on function public.hanafy_campaign_test_send(text, uuid, text) to authenticated;

create or replace function public.hanafy_suppression_set(target_workspace_slug text, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'messaging.manage');
  address_value text := btrim(coalesce(payload ->> 'address', ''));
  customer_match uuid;
begin
  if payload ->> 'action' = 'lift' then
    update public.suppression_entries set lifted_at = now(), lifted_by_user_id = auth.uid(), lift_reason = left(btrim(payload ->> 'reason'), 500)
    where id = (payload ->> 'id')::uuid and workspace_id = target and lifted_at is null;
    if not found then raise exception 'Opt-out not found' using errcode = 'P0002'; end if;
    return jsonb_build_object('lifted', true);
  end if;
  if address_value !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Enter the phone number in +1 format' using errcode = '22023'; end if;
  select customer.id into customer_match from public.customers customer where customer.workspace_id = target and customer.phone_normalized = address_value;
  insert into public.suppression_entries (workspace_id, channel, address, customer_id, reason, source, note, created_by_user_id)
  values (target, 'sms', address_value, customer_match, 'manual', 'staff', left(coalesce(payload ->> 'note', ''), 500), auth.uid())
  on conflict (workspace_id, channel, address) where lifted_at is null do nothing;
  update public.message_jobs set status = 'skipped', skip_reason = 'suppressed'
  where workspace_id = target and channel = 'sms' and recipient = address_value and status = 'queued';
  return jsonb_build_object('suppressed', true, 'customer_matched', customer_match is not null);
end;
$$;
revoke all on function public.hanafy_suppression_set(text, jsonb) from public, anon, authenticated;
grant execute on function public.hanafy_suppression_set(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Platform Admin → Messaging (§11.3)
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_platform_workspace_messaging(target_workspace_slug text)
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
    'connection', (
      select jsonb_build_object('id', connection.id, 'provider', connection.provider, 'status', connection.status,
        'aws_region', connection.aws_region, 'provider_account_ref', connection.provider_account_ref,
        'registration_status', connection.registration_status, 'production_access_status', connection.production_access_status,
        'dispatch_mode', connection.dispatch_mode, 'live_sending', connection.live_sending,
        'secret_reference', connection.secret_reference, 'last_success_at', connection.last_success_at,
        'last_error_at', connection.last_error_at, 'last_error_summary', connection.last_error_summary, 'updated_at', connection.updated_at)
      from public.messaging_connections connection where connection.workspace_id = target and connection.channel = 'sms'
    ),
    'identities', coalesce((
      select jsonb_agg(jsonb_build_object('id', identity.id, 'phone_number', identity.phone_number, 'provider_identity_arn', identity.provider_identity_arn,
        'identity_type', identity.identity_type, 'message_type', identity.message_type, 'status', identity.status,
        'is_default', identity.is_default, 'location_id', identity.location_id, 'legacy', identity.legacy_crm_identity_id is not null)
        order by identity.is_default desc, identity.created_at)
      from public.messaging_origination_identities identity where identity.workspace_id = target
    ), '[]'::jsonb),
    'usage', jsonb_build_object(
      'sent_24h', (select count(*) from public.message_jobs job where job.workspace_id = target and job.sent_at > now() - interval '24 hours'),
      'sent_30d', (select count(*) from public.message_jobs job where job.workspace_id = target and job.sent_at > now() - interval '30 days'),
      'simulated_30d', (select count(*) from public.message_jobs job where job.workspace_id = target and job.simulated and job.sent_at > now() - interval '30 days'),
      'failed_30d', (select count(*) from public.message_jobs job where job.workspace_id = target and job.status = 'failed' and job.created_at > now() - interval '30 days'),
      'skipped_30d', (select count(*) from public.message_jobs job where job.workspace_id = target and job.status = 'skipped' and job.created_at > now() - interval '30 days'),
      'unknown', (select count(*) from public.message_jobs job where job.workspace_id = target and job.status = 'unknown'),
      'queued', (select count(*) from public.message_jobs job where job.workspace_id = target and job.status = 'queued')
    ),
    'recent_failures', coalesce((
      select jsonb_agg(jsonb_build_object('id', job.id, 'at', coalesce(job.failed_at, job.created_at), 'status', job.status,
        'recipient_last4', right(job.recipient, 4), 'error', job.last_error) order by coalesce(job.failed_at, job.created_at) desc)
      from (select * from public.message_jobs j where j.workspace_id = target and j.status in ('failed', 'unknown') order by coalesce(j.failed_at, j.created_at) desc limit 10) job
    ), '[]'::jsonb),
    'opt_outs', (select count(*) from public.suppression_entries entry where entry.workspace_id = target and entry.lifted_at is null),
    'subscribers', (select count(*) from public.customers customer where customer.workspace_id = target and customer.sms_marketing_opt_in and customer.removed_at is null),
    'campaigns', (select count(*) from public.marketing_campaigns campaign where campaign.workspace_id = target),
    'legacy_crm', (select jsonb_build_object('project_ref', link.legacy_project_ref, 'business_id', link.legacy_business_id,
      'business_slug', link.legacy_business_slug, 'notes', link.notes) from public.crm_legacy_business_links link where link.workspace_id = target),
    'can_manage', public.hanafy_platform_role() in ('platform_owner', 'platform_admin')
  );
end;
$$;
revoke all on function public.hanafy_platform_workspace_messaging(text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspace_messaging(text) to authenticated;

-- Audited connection / sender changes.  Moving a business to the platform
-- sender or turning on live sending asks for confirmation first.
create or replace function public.hanafy_platform_save_messaging(target_workspace_slug text, payload jsonb, change_reason text, confirmed boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
  target_name text;
  before_connection public.messaging_connections%rowtype;
  after_connection public.messaging_connections%rowtype;
  warnings jsonb := '[]'::jsonb;
  identity_payload jsonb := payload -> 'identity';
  identity_before jsonb;
  identity_after public.messaging_origination_identities%rowtype;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if change_reason is null or char_length(btrim(change_reason)) < 5 then
    raise exception 'Give a reason (at least 5 characters)' using errcode = '22023';
  end if;
  select workspace.id, workspace.name into target, target_name from public.workspaces workspace where workspace.slug = target_workspace_slug;
  if target is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;

  select * into before_connection from public.messaging_connections where workspace_id = target and channel = 'sms' for update;
  if before_connection.id is null then
    insert into public.messaging_connections (workspace_id, channel, provider, status)
    values (target, 'sms', 'aws_end_user_messaging', 'provisioning')
    returning * into before_connection;
  end if;

  if payload ? 'dispatch_mode' and payload ->> 'dispatch_mode' = 'platform' and before_connection.dispatch_mode <> 'platform' then
    warnings := warnings || to_jsonb(format('%s''s texts will be sent by the Hanafy Platform. Pause every live automation for %s in the old Hanafy CRM first, or customers can get two texts.', target_name, target_name));
  end if;
  if coalesce((payload ->> 'live_sending')::boolean, before_connection.live_sending) and not before_connection.live_sending then
    warnings := warnings || to_jsonb(format('Real texts will go to %s''s customers through AWS and will be billed.', target_name));
  end if;
  if jsonb_array_length(warnings) > 0 and not confirmed then
    return jsonb_build_object('status', 'needs_confirmation', 'warnings', warnings);
  end if;

  update public.messaging_connections set
    status = coalesce(payload ->> 'status', status),
    aws_region = case when payload ? 'aws_region' then nullif(payload ->> 'aws_region', '') else aws_region end,
    provider_account_ref = case when payload ? 'provider_account_ref' then nullif(payload ->> 'provider_account_ref', '') else provider_account_ref end,
    registration_status = case when payload ? 'registration_status' then nullif(payload ->> 'registration_status', '') else registration_status end,
    production_access_status = case when payload ? 'production_access_status' then nullif(payload ->> 'production_access_status', '') else production_access_status end,
    dispatch_mode = coalesce(payload ->> 'dispatch_mode', dispatch_mode),
    live_sending = coalesce((payload ->> 'live_sending')::boolean, live_sending),
    secret_reference = case when payload ? 'secret_reference' then nullif(payload ->> 'secret_reference', '') else secret_reference end
  where id = before_connection.id
  returning * into after_connection;

  if identity_payload is not null and jsonb_typeof(identity_payload) = 'object' then
    if nullif(identity_payload ->> 'id', '') is not null then
      select to_jsonb(identity) into identity_before from public.messaging_origination_identities identity
      where identity.id = (identity_payload ->> 'id')::uuid and identity.workspace_id = target;
      if identity_before is null then raise exception 'Sending number not found for this business' using errcode = 'P0002'; end if;
      if coalesce((identity_payload ->> 'is_default')::boolean, false) then
        update public.messaging_origination_identities set is_default = false where workspace_id = target and channel = 'sms' and id <> (identity_payload ->> 'id')::uuid;
      end if;
      update public.messaging_origination_identities set
        status = coalesce(identity_payload ->> 'status', status),
        provider_identity_arn = case when identity_payload ? 'provider_identity_arn' then nullif(identity_payload ->> 'provider_identity_arn', '') else provider_identity_arn end,
        identity_type = case when identity_payload ? 'identity_type' then nullif(identity_payload ->> 'identity_type', '') else identity_type end,
        message_type = coalesce(identity_payload ->> 'message_type', message_type),
        is_default = coalesce((identity_payload ->> 'is_default')::boolean, is_default)
      where id = (identity_payload ->> 'id')::uuid and workspace_id = target
      returning * into identity_after;
    else
      if coalesce(btrim(identity_payload ->> 'phone_number'), '') = '' then
        raise exception 'Enter the new number in +1 format' using errcode = '22023';
      end if;
      if coalesce((identity_payload ->> 'is_default')::boolean, true) then
        update public.messaging_origination_identities set is_default = false where workspace_id = target and channel = 'sms';
      end if;
      insert into public.messaging_origination_identities (workspace_id, messaging_connection_id, channel, phone_number, provider_identity_arn,
        identity_type, message_type, status, is_default)
      values (target, after_connection.id, 'sms', btrim(identity_payload ->> 'phone_number'), nullif(identity_payload ->> 'provider_identity_arn', ''),
        nullif(identity_payload ->> 'identity_type', ''), coalesce(identity_payload ->> 'message_type', 'PROMOTIONAL'),
        coalesce(identity_payload ->> 'status', 'pending'), coalesce((identity_payload ->> 'is_default')::boolean, true))
      returning * into identity_after;
    end if;
  end if;

  perform public.hanafy_platform_write_audit(
    'platform.messaging.updated', target, 'messaging_connection', after_connection.id::text,
    format('Messaging for %s updated (%s, %s)', target_name, after_connection.dispatch_mode, case when after_connection.live_sending then 'live sending' else 'simulated sending' end),
    jsonb_build_object('connection', to_jsonb(before_connection) - 'secret_reference', 'identity', identity_before),
    jsonb_build_object('connection', to_jsonb(after_connection) - 'secret_reference', 'identity', to_jsonb(identity_after)),
    btrim(change_reason), null
  );
  return jsonb_build_object('status', 'saved', 'warnings', warnings);
end;
$$;
revoke all on function public.hanafy_platform_save_messaging(text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.hanafy_platform_save_messaging(text, jsonb, text, boolean) to authenticated;
