-- Hanafy Platform Phase 8: unify the event / automation architecture.
--
-- Build sheet §17.2, §17.3, §18, §40 Phase 8.
--
--   * domain_events: the §18.1 envelope, written in the SAME transaction as
--     the operational change (a trigger copies every integration_outbox row),
--     so the POS keeps its outbox reliability and never waits on marketing.
--     Unique event_id: a duplicate event is stored once.
--   * automations + immutable automation_versions (trigger, conditions,
--     timing, actions, frequency/cooldown), workspace-scoped.
--   * automation_runs: UNIQUE (automation_id, event_id), so a duplicate or
--     replayed event can never create a second run; each action step is
--     unique per run and its message uses the idempotency key
--     automation:<run>:<step>, so a retried action cannot send twice.
--   * automation_run_log: plain-language explanation of every evaluation
--     (matched, which condition failed, cooldown, sent, skipped because…).
--   * hanafy_automation_tick(): the durable worker (pg_cron every minute).
--     It re-verifies workspace ownership before every action and only
--     matches automations of the event's own workspace.
--   * Wayne's three CRM automations are imported for visibility with
--     executor = 'legacy_crm': the old CRM keeps running them; the platform
--     worker never does until a Hanafy admin adopts them at cut-over.

-- ---------------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (id, code, description) values
  ('20000000-0000-4000-8000-000000000032', 'automations.view', 'See automations, their versions and run history'),
  ('20000000-0000-4000-8000-000000000033', 'automations.manage', 'Create, change, pause and replay automations')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code in ('automations.view', 'automations.manage')
where role.code in ('owner', 'manager')
on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code = 'automations.view'
where role.code = 'marketing_readonly'
on conflict do nothing;

insert into public.service_permissions (service_id, permission_id)
select service.id, permission.id
from public.service_catalog service
join public.permissions permission on permission.code in ('automations.view', 'automations.manage')
where service.code = 'automations'
on conflict do nothing;

create or replace function public.hanafy_support_permission_allowed(platform_role_value text, required_permission text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when platform_role_value in ('platform_owner', 'platform_admin') then true
    when platform_role_value = 'platform_support' then required_permission = any(array[
      'admin.access', 'orders.view', 'reports.view', 'customers.view', 'staff.view', 'audit.view', 'campaigns.view', 'automations.view'
    ])
    else false
  end;
$$;
revoke all on function public.hanafy_support_permission_allowed(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Domain events (§18.1)
-- ---------------------------------------------------------------------------
create table if not exists public.domain_events (
  event_id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  location_id uuid,
  event_type text not null check (event_type ~ '^[a-z]+(\.[a-z_]+)+$'),
  occurred_at timestamptz not null,
  source_module text not null default 'pos' check (source_module ~ '^[a-z_]{1,40}$'),
  version integer not null default 1 check (version between 1 and 100),
  subject_type text check (subject_type is null or subject_type in ('customer', 'order', 'promotion', 'delivery')),
  subject_id uuid,
  customer_id uuid,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  recorded_at timestamptz not null default now(),
  automation_status text not null default 'pending' check (automation_status in ('pending', 'processed', 'skipped')),
  automation_note text,
  automation_processed_at timestamptz,
  unique (event_id, workspace_id),
  foreign key (location_id, workspace_id) references public.locations(id, workspace_id) on delete restrict
);
create index if not exists domain_events_pending_idx on public.domain_events(recorded_at) where automation_status = 'pending';
create index if not exists domain_events_workspace_idx on public.domain_events(workspace_id, occurred_at desc);
create index if not exists domain_events_customer_idx on public.domain_events(workspace_id, customer_id, occurred_at desc) where customer_id is not null;

comment on table public.domain_events is
  'Phase 8 (§18): workspace-aware domain events, recorded in the same transaction as the business change (copied from integration_outbox). The outbox to the old CRM is kept unchanged.';

-- Builds the envelope from an outbox payload.
create or replace function public.hanafy_domain_event_from_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload_data jsonb := coalesce(new.payload -> 'data', '{}'::jsonb);
  customer_value uuid;
  subject_type_value text;
  subject_value uuid;
begin
  begin
    customer_value := nullif(payload_data ->> 'customer_id', '')::uuid;
  exception when invalid_text_representation then
    customer_value := null;
  end;
  if new.event_type like 'order.%' then
    subject_type_value := 'order';
    begin subject_value := nullif(payload_data ->> 'order_id', '')::uuid; exception when invalid_text_representation then subject_value := null; end;
  elsif new.event_type like 'delivery.%' then
    subject_type_value := 'delivery';
    begin subject_value := nullif(payload_data ->> 'order_id', '')::uuid; exception when invalid_text_representation then subject_value := null; end;
  elsif new.event_type like 'customer.%' or new.event_type like 'promo.%' then
    subject_type_value := 'customer';
    subject_value := customer_value;
  end if;

  -- A customer id that is not this workspace's customer is dropped, never trusted.
  if customer_value is not null and not exists (
    select 1 from public.customers customer where customer.id = customer_value and customer.workspace_id = new.workspace_id
  ) then
    customer_value := null;
  end if;

  -- Recording the event must never cost the business its order: any problem
  -- here is reported and the operational transaction carries on (§45 #2).
  begin
    insert into public.domain_events (event_id, workspace_id, event_type, occurred_at, source_module, version, subject_type, subject_id, customer_id, data)
    values (
      new.event_id, new.workspace_id, new.event_type, new.occurred_at,
      left(coalesce(nullif(regexp_replace(lower(coalesce(new.payload ->> 'source', 'pos')), '[^a-z_]', '_', 'g'), ''), 'pos'), 40),
      case when (new.payload ->> 'version') ~ '^[0-9]{1,3}$' then greatest(1, least((new.payload ->> 'version')::integer, 100)) else 1 end,
      subject_type_value, subject_value, customer_value, payload_data
    )
    on conflict (event_id) do nothing;
  exception when others then
    raise warning 'domain event % not recorded: %', new.event_id, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.hanafy_domain_event_from_outbox() from public, anon, authenticated;

drop trigger if exists zz_hanafy_domain_event on public.integration_outbox;
create trigger zz_hanafy_domain_event after insert on public.integration_outbox
for each row execute function public.hanafy_domain_event_from_outbox();

-- History is recorded but never triggers automations retroactively.
insert into public.domain_events (event_id, workspace_id, event_type, occurred_at, source_module, subject_type, subject_id, customer_id, data,
  automation_status, automation_note, automation_processed_at)
select outbox.event_id, outbox.workspace_id, outbox.event_type, outbox.occurred_at, 'pos',
  case when outbox.event_type like 'order.%' then 'order' when outbox.event_type like 'customer.%' then 'customer' else null end,
  case when outbox.event_type like 'order.%' and (outbox.payload -> 'data' ->> 'order_id') ~ '^[0-9a-f-]{36}$' then (outbox.payload -> 'data' ->> 'order_id')::uuid
       when (outbox.payload -> 'data' ->> 'customer_id') ~ '^[0-9a-f-]{36}$' then (outbox.payload -> 'data' ->> 'customer_id')::uuid end,
  (select customer.id from public.customers customer
    where (outbox.payload -> 'data' ->> 'customer_id') ~ '^[0-9a-f-]{36}$'
      and customer.id = (outbox.payload -> 'data' ->> 'customer_id')::uuid and customer.workspace_id = outbox.workspace_id),
  coalesce(outbox.payload -> 'data', '{}'::jsonb),
  'skipped', 'Recorded before Phase 8; history does not trigger automations.', now()
from public.integration_outbox outbox
on conflict (event_id) do nothing;

-- Platform-native events (no old-CRM delivery).  Service role only.
create or replace function public.hanafy_record_domain_event(envelope jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_value uuid := coalesce(nullif(envelope ->> 'event_id', '')::uuid, gen_random_uuid());
  workspace_value uuid := (envelope ->> 'workspace_id')::uuid;
  customer_value uuid := nullif(envelope ->> 'customer_id', '')::uuid;
begin
  if workspace_value is null or not exists (select 1 from public.workspaces workspace where workspace.id = workspace_value) then
    raise exception 'workspace_id is required' using errcode = '22023';
  end if;
  if customer_value is not null and not exists (select 1 from public.customers customer where customer.id = customer_value and customer.workspace_id = workspace_value) then
    raise exception 'CUSTOMER_NOT_IN_WORKSPACE' using errcode = '42501';
  end if;
  insert into public.domain_events (event_id, workspace_id, location_id, event_type, occurred_at, source_module, version, subject_type, subject_id, customer_id, data)
  values (event_value, workspace_value, nullif(envelope ->> 'location_id', '')::uuid, envelope ->> 'event_type',
    coalesce(nullif(envelope ->> 'occurred_at', '')::timestamptz, now()), coalesce(envelope ->> 'source_module', 'platform'),
    coalesce((envelope ->> 'version')::integer, 1), envelope ->> 'subject_type', nullif(envelope ->> 'subject_id', '')::uuid,
    customer_value, coalesce(envelope -> 'data', '{}'::jsonb))
  on conflict (event_id) do nothing;
  return event_value;
end;
$$;
revoke all on function public.hanafy_record_domain_event(jsonb) from public, anon, authenticated;
grant execute on function public.hanafy_record_domain_event(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Customer tags (automation action target)
-- ---------------------------------------------------------------------------
create table if not exists public.customer_tags (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  customer_id uuid not null,
  tag text not null check (tag ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  source text not null default 'staff' check (char_length(source) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (workspace_id, customer_id, tag),
  foreign key (customer_id, workspace_id) references public.customers(id, workspace_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 4. Automations (§17.2, §17.3)
-- ---------------------------------------------------------------------------
create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  -- 'legacy_crm' = mirrored from the old Hanafy CRM, which still runs it.
  executor text not null default 'platform' check (executor in ('platform', 'legacy_crm')),
  legacy_crm_automation_id uuid unique,
  current_version_id uuid,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create table if not exists public.automation_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  automation_id uuid not null,
  version integer not null check (version >= 1),
  trigger_event_type text not null check (trigger_event_type ~ '^[a-z]+(\.[a-z_]+)+$'),
  trigger_filters jsonb not null default '{}'::jsonb check (jsonb_typeof(trigger_filters) = 'object'),
  conditions jsonb not null default '[]'::jsonb check (jsonb_typeof(conditions) = 'array' and jsonb_array_length(conditions) <= 10),
  delay_minutes integer not null default 0 check (delay_minutes between 0 and 43200),
  actions jsonb not null check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) between 1 and 5),
  cooldown_hours integer not null default 0 check (cooldown_hours between 0 and 8760),
  once_per_customer boolean not null default false,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (automation_id, version),
  unique (id, workspace_id),
  foreign key (automation_id, workspace_id) references public.automations(id, workspace_id) on delete restrict
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'automations_current_version_fk') then
    alter table public.automations add constraint automations_current_version_fk
      foreign key (current_version_id, workspace_id) references public.automation_versions(id, workspace_id) on delete restrict;
  end if;
end;
$$;

-- Versions are history: a change is a new version, never an edit.
create or replace function public.hanafy_automation_version_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Automation versions cannot be changed; save a new version' using errcode = '42501';
end;
$$;
drop trigger if exists automation_versions_immutable on public.automation_versions;
create trigger automation_versions_immutable before update or delete on public.automation_versions
for each row execute function public.hanafy_automation_version_immutable();

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  automation_id uuid not null,
  version_id uuid not null,
  event_id uuid not null,
  customer_id uuid,
  status text not null default 'waiting' check (status in ('waiting', 'running', 'completed', 'skipped', 'failed', 'cancelled')),
  due_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  outcome text check (outcome is null or char_length(outcome) <= 1000),
  replayed_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (automation_id, event_id),
  unique (id, workspace_id),
  foreign key (automation_id, workspace_id) references public.automations(id, workspace_id) on delete restrict,
  foreign key (version_id, workspace_id) references public.automation_versions(id, workspace_id) on delete restrict,
  foreign key (event_id, workspace_id) references public.domain_events(event_id, workspace_id) on delete restrict,
  foreign key (customer_id, workspace_id) references public.customers(id, workspace_id) on delete restrict
);
create index if not exists automation_runs_due_idx on public.automation_runs(due_at) where status = 'waiting';
create index if not exists automation_runs_customer_idx on public.automation_runs(automation_id, customer_id, created_at desc);
create index if not exists automation_runs_workspace_idx on public.automation_runs(workspace_id, created_at desc);

create table if not exists public.automation_run_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  run_id uuid not null,
  step_index integer not null check (step_index between 0 and 9),
  action_type text not null check (action_type in ('send_sms', 'send_email', 'add_tag', 'remove_tag')),
  status text not null check (status in ('completed', 'skipped', 'failed')),
  message_job_id uuid,
  detail text check (detail is null or char_length(detail) <= 1000),
  created_at timestamptz not null default now(),
  unique (run_id, step_index),
  foreign key (run_id, workspace_id) references public.automation_runs(id, workspace_id) on delete restrict,
  foreign key (message_job_id, workspace_id) references public.message_jobs(id, workspace_id) on delete restrict
);

create table if not exists public.automation_run_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  automation_id uuid,
  run_id uuid,
  event_id uuid,
  logged_at timestamptz not null default now(),
  level text not null check (level in ('info', 'skip', 'error')),
  code text not null check (code ~ '^[a-z_]{2,40}$'),
  message text not null check (char_length(message) between 1 and 1000)
);
create index if not exists automation_run_log_workspace_idx on public.automation_run_log(workspace_id, logged_at desc);
create index if not exists automation_run_log_run_idx on public.automation_run_log(run_id);

-- The message job now points at its run, inside the same workspace.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'message_jobs_automation_run_fk') then
    alter table public.message_jobs add constraint message_jobs_automation_run_fk
      foreign key (automation_run_id, workspace_id) references public.automation_runs(id, workspace_id) on delete restrict;
  end if;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array['domain_events', 'customer_tags', 'automations', 'automation_versions', 'automation_runs', 'automation_run_steps', 'automation_run_log'] loop
    execute format('drop trigger if exists aa_hanafy_guard_platform_row on public.%I', table_name);
    execute format('create trigger aa_hanafy_guard_platform_row before insert or update on public.%I for each row execute function public.hanafy_guard_platform_row()', table_name);
  end loop;
end;
$$;
drop trigger if exists automations_set_updated_at on public.automations;
create trigger automations_set_updated_at before update on public.automations for each row execute function public.set_updated_at();

-- RLS: read own workspace; writes only through the functions below.
alter table public.domain_events enable row level security;
alter table public.customer_tags enable row level security;
alter table public.automations enable row level security;
alter table public.automation_versions enable row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_run_steps enable row level security;
alter table public.automation_run_log enable row level security;
revoke all on public.domain_events, public.customer_tags, public.automations, public.automation_versions, public.automation_runs,
  public.automation_run_steps, public.automation_run_log from anon, authenticated;
grant select on public.domain_events, public.customer_tags, public.automations, public.automation_versions, public.automation_runs,
  public.automation_run_steps, public.automation_run_log to authenticated;

drop policy if exists domain_events_workspace_read on public.domain_events;
create policy domain_events_workspace_read on public.domain_events for select to authenticated
using (public.hanafy_can_access_workspace_data(workspace_id, array['automations.view', 'integrations.manage']));
drop policy if exists customer_tags_workspace_read on public.customer_tags;
create policy customer_tags_workspace_read on public.customer_tags for select to authenticated
using (public.hanafy_can_access_workspace_data(workspace_id, array['customers.view', 'automations.view']));
do $$
declare table_name text;
begin
  foreach table_name in array array['automations', 'automation_versions', 'automation_runs', 'automation_run_steps', 'automation_run_log'] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_workspace_read', table_name);
    execute format('create policy %I on public.%I for select to authenticated using (public.hanafy_can_access_workspace_data(workspace_id, array[''automations.view'', ''automations.manage'']))',
      table_name || '_workspace_read', table_name);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Evaluation helpers
-- ---------------------------------------------------------------------------

-- Validates the builder's JSON before a version is stored.
create or replace function public.hanafy_automation_definition_problem(definition jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
begin
  if coalesce(definition ->> 'trigger_event_type', '') !~ '^[a-z]+(\.[a-z_]+)+$' then return 'Pick what starts the automation.'; end if;
  if jsonb_typeof(coalesce(definition -> 'actions', 'null'::jsonb)) <> 'array' or jsonb_array_length(definition -> 'actions') = 0 then return 'Add at least one action.'; end if;
  for item in select value from jsonb_array_elements(definition -> 'actions') loop
    if item ->> 'type' not in ('send_sms', 'add_tag', 'remove_tag') then return 'Unknown action: ' || coalesce(item ->> 'type', '?'); end if;
    if item ->> 'type' = 'send_sms' and coalesce(btrim(item ->> 'body'), '') = '' then return 'Write the text message.'; end if;
    if item ->> 'type' = 'send_sms' and char_length(item ->> 'body') > 1600 then return 'Keep the text under 1,600 characters.'; end if;
    if item ->> 'type' in ('add_tag', 'remove_tag') and coalesce(item ->> 'tag', '') !~ '^[a-z0-9][a-z0-9_-]{0,39}$' then return 'Tags are lowercase letters, numbers, - or _.'; end if;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(definition -> 'conditions', '[]'::jsonb)) loop
    if item ->> 'field' not in ('sms_marketing_opt_in', 'order_count', 'lifetime_spend_cents', 'days_since_last_order', 'has_tag', 'in_segment') then
      return 'Unknown condition: ' || coalesce(item ->> 'field', '?');
    end if;
    if item ->> 'operator' not in ('=', '!=', '>=', '<=', '>', '<') then return 'Unknown comparison: ' || coalesce(item ->> 'operator', '?'); end if;
  end loop;
  return null;
end;
$$;

-- One condition against one customer, with a readable explanation.
create or replace function public.hanafy_automation_check(target_workspace_id uuid, target_customer_id uuid, condition jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  customer_row public.customers%rowtype;
  field text := condition ->> 'field';
  operator text := condition ->> 'operator';
  expected text := condition ->> 'value';
  actual numeric;
  actual_text text;
  passed boolean;
begin
  select * into customer_row from public.customers where id = target_customer_id and workspace_id = target_workspace_id;
  if not found then return jsonb_build_object('passed', false, 'explain', 'no customer in this business'); end if;
  if field = 'sms_marketing_opt_in' then
    actual_text := customer_row.sms_marketing_opt_in::text;
    passed := case operator when '=' then actual_text = lower(expected) when '!=' then actual_text <> lower(expected) else false end;
  elsif field = 'has_tag' then
    actual_text := (exists (select 1 from public.customer_tags tag where tag.workspace_id = target_workspace_id and tag.customer_id = target_customer_id and tag.tag = expected))::text;
    passed := case operator when '=' then actual_text = 'true' when '!=' then actual_text = 'false' else false end;
  elsif field = 'in_segment' then
    actual_text := (exists (select 1 from public.customer_segment_memberships member
      where member.workspace_id = target_workspace_id and member.customer_id = target_customer_id and member.active and member.segment_id::text = expected))::text;
    passed := case operator when '=' then actual_text = 'true' when '!=' then actual_text = 'false' else false end;
  else
    actual := case field
      when 'order_count' then customer_row.order_count
      when 'lifetime_spend_cents' then customer_row.lifetime_spend_cents
      when 'days_since_last_order' then case when customer_row.last_order_at is null then null else floor(extract(epoch from now() - customer_row.last_order_at) / 86400) end
    end;
    actual_text := coalesce(actual::text, 'none');
    if actual is null or expected !~ '^-?[0-9]+(\.[0-9]+)?$' then
      passed := false;
    else
      passed := case operator
        when '=' then actual = expected::numeric when '!=' then actual <> expected::numeric
        when '>=' then actual >= expected::numeric when '<=' then actual <= expected::numeric
        when '>' then actual > expected::numeric when '<' then actual < expected::numeric else false end;
    end if;
  end if;
  return jsonb_build_object('passed', coalesce(passed, false), 'explain', format('%s %s %s (was %s)', field, operator, expected, actual_text));
end;
$$;
revoke all on function public.hanafy_automation_check(uuid, uuid, jsonb) from public, anon, authenticated;

-- Per-message fields from the event (e.g. {{reward_code}}) plus the customer's.
create or replace function public.hanafy_event_message_context(target_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.hanafy_customer_message_context(event.workspace_id, event.customer_id)
    || coalesce((select jsonb_object_agg(item.key, item.value) from jsonb_each_text(event.data) item
        where jsonb_typeof(event.data -> item.key) in ('string', 'number', 'boolean') and item.key ~ '^[a-z_][a-z0-9_]*$'), '{}'::jsonb)
    || case when jsonb_typeof(event.data -> 'reward') = 'object' then jsonb_strip_nulls(jsonb_build_object(
        'reward_code', event.data -> 'reward' ->> 'code',
        'reward_amount', case when (event.data -> 'reward' ->> 'discount_cents') ~ '^[0-9]+$' then to_char((event.data -> 'reward' ->> 'discount_cents')::numeric / 100, 'FM$999,990.00') end,
        'reward_minimum', case when (event.data -> 'reward' ->> 'minimum_order_cents') ~ '^[0-9]+$' then to_char((event.data -> 'reward' ->> 'minimum_order_cents')::numeric / 100, 'FM$999,990.00') end,
        'reward_expires', case when (event.data -> 'reward' ->> 'expires_at') is not null then to_char(((event.data -> 'reward' ->> 'expires_at')::timestamptz at time zone workspace.timezone), 'Mon FMDD') end
      )) else '{}'::jsonb end
  from public.domain_events event
  join public.workspaces workspace on workspace.id = event.workspace_id
  where event.event_id = target_event_id;
$$;
revoke all on function public.hanafy_event_message_context(uuid) from public, anon, authenticated;

create or replace function public.hanafy_automation_log(
  target_workspace_id uuid, target_automation_id uuid, target_run_id uuid, target_event_id uuid, level_value text, code_value text, message_value text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.automation_run_log (workspace_id, automation_id, run_id, event_id, level, code, message)
  values (target_workspace_id, target_automation_id, target_run_id, target_event_id, level_value, code_value, left(message_value, 1000));
$$;
revoke all on function public.hanafy_automation_log(uuid, uuid, uuid, uuid, text, text, text) from public, anon, authenticated;

-- Evaluates one event against one automation.  Creates at most one run
-- (unique automation + event).  Returns the run id or null.
create or replace function public.hanafy_automation_evaluate(target_automation_id uuid, target_event_id uuid, replayed_by uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  automation public.automations%rowtype;
  version_row public.automation_versions%rowtype;
  event public.domain_events%rowtype;
  filter_item record;
  condition jsonb;
  check_result jsonb;
  failed_reason text;
  run_id uuid;
begin
  select * into automation from public.automations where id = target_automation_id;
  select * into event from public.domain_events where event_id = target_event_id;
  -- Never across businesses.
  if automation.id is null or event.event_id is null or automation.workspace_id <> event.workspace_id then return null; end if;
  select * into version_row from public.automation_versions where id = automation.current_version_id and workspace_id = automation.workspace_id;
  if version_row.id is null or version_row.trigger_event_type <> event.event_type then return null; end if;

  for filter_item in select key, value from jsonb_each_text(version_row.trigger_filters) loop
    if coalesce(event.data ->> filter_item.key, '') <> filter_item.value then
      perform public.hanafy_automation_log(automation.workspace_id, automation.id, null, event.event_id, 'skip', 'filter_mismatch',
        format('%s: event %s had %s = %s, needs %s', automation.name, event.event_type, filter_item.key, coalesce(event.data ->> filter_item.key, 'none'), filter_item.value));
      return null;
    end if;
  end loop;

  if event.customer_id is null then
    failed_reason := 'the event has no customer of this business';
  else
    for condition in select value from jsonb_array_elements(version_row.conditions) loop
      check_result := public.hanafy_automation_check(automation.workspace_id, event.customer_id, condition);
      if not (check_result ->> 'passed')::boolean then
        failed_reason := 'condition not met: ' || (check_result ->> 'explain');
        exit;
      end if;
    end loop;
  end if;

  if failed_reason is null and version_row.once_per_customer and exists (
    select 1 from public.automation_runs run where run.automation_id = automation.id and run.customer_id = event.customer_id and run.status in ('waiting', 'running', 'completed')
  ) then
    failed_reason := 'already ran for this customer (once per customer)';
  end if;
  if failed_reason is null and version_row.cooldown_hours > 0 and exists (
    select 1 from public.automation_runs run where run.automation_id = automation.id and run.customer_id = event.customer_id
      and run.status in ('waiting', 'running', 'completed') and run.created_at > now() - make_interval(hours => version_row.cooldown_hours)
  ) then
    failed_reason := format('cooldown: already ran for this customer in the last %s hours', version_row.cooldown_hours);
  end if;

  insert into public.automation_runs (workspace_id, automation_id, version_id, event_id, customer_id, status, due_at, outcome, finished_at, replayed_by_user_id)
  values (automation.workspace_id, automation.id, version_row.id, event.event_id, event.customer_id,
    case when failed_reason is null then 'waiting' else 'skipped' end,
    now() + make_interval(mins => version_row.delay_minutes),
    failed_reason, case when failed_reason is null then null else now() end, replayed_by)
  on conflict (automation_id, event_id) do nothing
  returning id into run_id;

  if run_id is null then
    perform public.hanafy_automation_log(automation.workspace_id, automation.id, null, event.event_id, 'skip', 'duplicate_event',
      format('%s: event %s was already handled; no second run', automation.name, event.event_id));
    return null;
  end if;
  perform public.hanafy_automation_log(automation.workspace_id, automation.id, run_id, event.event_id,
    case when failed_reason is null then 'info' else 'skip' end,
    case when failed_reason is null then 'matched' else 'not_run' end,
    case when failed_reason is null
      then format('%s (v%s) matched %s; runs %s', automation.name, version_row.version, event.event_type,
        case when version_row.delay_minutes = 0 then 'now' else 'in ' || version_row.delay_minutes || ' minutes' end)
      else format('%s (v%s) did not run: %s', automation.name, version_row.version, failed_reason) end);
  return run_id;
end;
$$;
revoke all on function public.hanafy_automation_evaluate(uuid, uuid, uuid) from public, anon, authenticated;

-- Runs one due run's actions.  Re-verifies the workspace before every action.
create or replace function public.hanafy_automation_execute(target_run_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  run public.automation_runs%rowtype;
  automation public.automations%rowtype;
  version_row public.automation_versions%rowtype;
  action jsonb;
  step integer := -1;
  job jsonb;
  step_status text;
  step_detail text;
  job_id uuid;
  any_sent boolean := false;
  all_skipped boolean := true;
  context jsonb;
begin
  select * into run from public.automation_runs where id = target_run_id for update;
  if run.id is null or run.status not in ('waiting', 'running') then return 'not_due'; end if;
  select * into automation from public.automations where id = run.automation_id and workspace_id = run.workspace_id;
  select * into version_row from public.automation_versions where id = run.version_id and workspace_id = run.workspace_id;
  if automation.id is null or version_row.id is null or version_row.automation_id <> automation.id then
    update public.automation_runs set status = 'failed', finished_at = now(), outcome = 'workspace check failed' where id = run.id;
    return 'failed';
  end if;
  if automation.status = 'archived' then
    update public.automation_runs set status = 'cancelled', finished_at = now(), outcome = 'automation archived before it ran' where id = run.id;
    return 'cancelled';
  end if;
  if run.customer_id is not null and exists (select 1 from public.customers c where c.id = run.customer_id and c.workspace_id = run.workspace_id and c.removed_at is not null) then
    update public.automation_runs set status = 'cancelled', finished_at = now(), outcome = 'customer was erased' where id = run.id;
    return 'cancelled';
  end if;

  update public.automation_runs set status = 'running', started_at = coalesce(started_at, now()) where id = run.id;
  context := public.hanafy_event_message_context(run.event_id);

  for action in select value from jsonb_array_elements(version_row.actions) loop
    step := step + 1;
    select s.status into step_status from public.automation_run_steps s where s.run_id = run.id and s.step_index = step;
    if found then
      -- Finished on an earlier attempt: never repeated, but still counted.
      if step_status <> 'skipped' then all_skipped := false; end if;
      if step_status = 'completed' and action ->> 'type' = 'send_sms' then any_sent := true; end if;
      continue;
    end if;
    job_id := null;
    step_detail := null;
    -- Re-verify the business before every action (§17.3).
    if not exists (select 1 from public.automations a where a.id = automation.id and a.workspace_id = run.workspace_id) then
      raise exception 'workspace mismatch';
    end if;
    if action ->> 'type' = 'send_sms' then
      begin
        job := public.hanafy_enqueue_message(jsonb_build_object(
          'workspace_id', run.workspace_id, 'customer_id', run.customer_id, 'channel', 'sms',
          'message_type', coalesce(action ->> 'message_type', 'marketing'),
          'body', public.hanafy_render_template(action ->> 'body', context),
          'automation_run_id', run.id, 'idempotency_key', 'automation:' || run.id || ':' || step
        ));
        job_id := (job ->> 'job_id')::uuid;
        if job ->> 'status' = 'skipped' then
          step_status := 'skipped';
          step_detail := 'text not sent: ' || coalesce(job ->> 'skip_reason', 'skipped');
        else
          step_status := 'completed';
          step_detail := 'text queued';
          any_sent := true;
        end if;
      exception when others then
        step_status := 'failed';
        step_detail := left(sqlerrm, 900);
      end;
    elsif action ->> 'type' = 'add_tag' then
      insert into public.customer_tags (workspace_id, customer_id, tag, source)
      values (run.workspace_id, run.customer_id, action ->> 'tag', 'automation')
      on conflict do nothing;
      step_status := 'completed';
      step_detail := 'tag added: ' || (action ->> 'tag');
    elsif action ->> 'type' = 'remove_tag' then
      delete from public.customer_tags where workspace_id = run.workspace_id and customer_id = run.customer_id and tag = action ->> 'tag';
      step_status := 'completed';
      step_detail := 'tag removed: ' || (action ->> 'tag');
    else
      step_status := 'failed';
      step_detail := 'unsupported action';
    end if;
    if step_status <> 'skipped' then all_skipped := false; end if;

    insert into public.automation_run_steps (workspace_id, run_id, step_index, action_type, status, message_job_id, detail)
    values (run.workspace_id, run.id, step, coalesce(action ->> 'type', 'send_sms'), step_status, job_id, step_detail);
    perform public.hanafy_automation_log(run.workspace_id, automation.id, run.id, run.event_id,
      case step_status when 'failed' then 'error' when 'skipped' then 'skip' else 'info' end,
      'step_' || step_status, format('step %s (%s): %s', step + 1, action ->> 'type', step_detail));
    if step_status = 'failed' then
      update public.automation_runs set status = 'failed', finished_at = now(), outcome = format('step %s failed: %s', step + 1, step_detail) where id = run.id;
      return 'failed';
    end if;
  end loop;

  update public.automation_runs set
    status = case when all_skipped then 'skipped' else 'completed' end,
    finished_at = now(),
    outcome = case when all_skipped then 'nothing sent: ' || coalesce((select string_agg(s.detail, '; ' order by s.step_index) from public.automation_run_steps s where s.run_id = run.id), 'no actions')
                   when any_sent then 'completed; text queued' else 'completed' end
  where id = run.id;
  return 'completed';
end;
$$;
revoke all on function public.hanafy_automation_execute(uuid) from public, anon, authenticated;

-- The durable worker (pg_cron, every minute).
create or replace function public.hanafy_automation_tick(max_events integer default 200, max_runs integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  event record;
  automation record;
  run record;
  matched integer := 0;
  events_done integer := 0;
  executed integer := 0;
begin
  for event in
    select * from public.domain_events
    where automation_status = 'pending'
    order by recorded_at
    limit greatest(1, least(max_events, 1000))
    for update skip locked
  loop
    events_done := events_done + 1;
    if not public.hanafy_service_active(event.workspace_id, 'automations') then
      update public.domain_events set automation_status = 'skipped', automation_note = 'Automations are off for this business.', automation_processed_at = now()
      where event_id = event.event_id;
      continue;
    end if;
    for automation in
      select candidate.id from public.automations candidate
      join public.automation_versions version_row on version_row.id = candidate.current_version_id and version_row.workspace_id = candidate.workspace_id
      where candidate.workspace_id = event.workspace_id and candidate.status = 'active' and candidate.executor = 'platform'
        and version_row.trigger_event_type = event.event_type
    loop
      if public.hanafy_automation_evaluate(automation.id, event.event_id) is not null then matched := matched + 1; end if;
    end loop;
    update public.domain_events set automation_status = 'processed', automation_processed_at = now() where event_id = event.event_id;
  end loop;

  for run in
    select candidate.id from public.automation_runs candidate
    join public.automations automation_row on automation_row.id = candidate.automation_id and automation_row.workspace_id = candidate.workspace_id
    where candidate.status = 'waiting' and candidate.due_at <= now()
      and automation_row.executor = 'platform' and automation_row.status in ('active', 'archived')
      and public.hanafy_service_active(candidate.workspace_id, 'automations')
    order by candidate.due_at
    limit greatest(1, least(max_runs, 1000))
    for update of candidate skip locked
  loop
    perform public.hanafy_automation_execute(run.id);
    executed := executed + 1;
  end loop;
  return jsonb_build_object('events', events_done, 'runs_created', matched, 'runs_executed', executed);
end;
$$;
revoke all on function public.hanafy_automation_tick(integer, integer) from public, anon, authenticated;
grant execute on function public.hanafy_automation_tick(integer, integer) to service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'hanafy-automation-tick';
    perform cron.schedule('hanafy-automation-tick', '* * * * *', 'select public.hanafy_automation_tick(200, 100)');
  end if;
exception when others then
  raise notice 'pg_cron not available (%); call hanafy_automation_tick from a scheduler.', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Workspace RPCs
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_automations_overview(target_workspace_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'automations.view');
begin
  return jsonb_build_object(
    'can_manage', public.hanafy_has_workspace_permission(target, 'automations.manage'),
    'dispatch_mode', (select connection.dispatch_mode from public.messaging_connections connection where connection.workspace_id = target and connection.channel = 'sms'),
    'automations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', automation.id, 'name', automation.name, 'description', automation.description, 'status', automation.status,
        'executor', automation.executor, 'updated_at', automation.updated_at,
        'version', version_row.version, 'trigger_event_type', version_row.trigger_event_type,
        'trigger_filters', version_row.trigger_filters, 'conditions', version_row.conditions,
        'delay_minutes', version_row.delay_minutes, 'actions', version_row.actions,
        'cooldown_hours', version_row.cooldown_hours, 'once_per_customer', version_row.once_per_customer,
        'runs_30d', (select jsonb_object_agg(counts.status, counts.n) from (
          select run.status, count(*) as n from public.automation_runs run
          where run.automation_id = automation.id and run.created_at > now() - interval '30 days' group by run.status) counts)
      ) order by automation.status = 'archived', automation.name)
      from public.automations automation
      left join public.automation_versions version_row on version_row.id = automation.current_version_id
      where automation.workspace_id = target
    ), '[]'::jsonb),
    'event_types', coalesce((
      select jsonb_agg(distinct event.event_type) from public.domain_events event
      where event.workspace_id = target and event.recorded_at > now() - interval '90 days'
    ), '[]'::jsonb),
    'segments', coalesce((select jsonb_agg(jsonb_build_object('id', segment.id, 'name', segment.name) order by segment.sort_order, segment.name)
      from public.customer_segments segment where segment.workspace_id = target and segment.active), '[]'::jsonb),
    'recent_events', coalesce((
      select jsonb_agg(jsonb_build_object('event_id', event.event_id, 'event_type', event.event_type, 'occurred_at', event.occurred_at,
        'automation_status', event.automation_status, 'has_customer', event.customer_id is not null) order by event.recorded_at desc)
      from (select * from public.domain_events e where e.workspace_id = target order by e.recorded_at desc limit 25) event
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.hanafy_automations_overview(text) from public, anon, authenticated;
grant execute on function public.hanafy_automations_overview(text) to authenticated;

create or replace function public.hanafy_automation_detail(target_workspace_slug text, target_automation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'automations.view');
begin
  if not exists (select 1 from public.automations a where a.id = target_automation_id and a.workspace_id = target) then
    raise exception 'Automation not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'versions', (select jsonb_agg(jsonb_build_object('id', v.id, 'version', v.version, 'trigger_event_type', v.trigger_event_type,
        'trigger_filters', v.trigger_filters, 'conditions', v.conditions, 'delay_minutes', v.delay_minutes, 'actions', v.actions,
        'cooldown_hours', v.cooldown_hours, 'once_per_customer', v.once_per_customer, 'created_at', v.created_at) order by v.version desc)
      from public.automation_versions v where v.automation_id = target_automation_id and v.workspace_id = target),
    'runs', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'event_id', r.event_id,
        'event_type', (select e.event_type from public.domain_events e where e.event_id = r.event_id),
        'customer_name', (select btrim(c.first_name || ' ' || left(c.last_name, 1)) from public.customers c where c.id = r.customer_id),
        'version', (select v.version from public.automation_versions v where v.id = r.version_id),
        'due_at', r.due_at, 'finished_at', r.finished_at, 'outcome', r.outcome, 'created_at', r.created_at, 'replayed', r.replayed_by_user_id is not null,
        'steps', coalesce((select jsonb_agg(jsonb_build_object('step', s.step_index + 1, 'action', s.action_type, 'status', s.status, 'detail', s.detail) order by s.step_index)
          from public.automation_run_steps s where s.run_id = r.id), '[]'::jsonb)) order by r.created_at desc)
      from (select * from public.automation_runs x where x.automation_id = target_automation_id and x.workspace_id = target order by x.created_at desc limit 50) r), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', l.logged_at, 'level', l.level, 'code', l.code, 'message', l.message) order by l.id desc)
      from (select * from public.automation_run_log x where x.automation_id = target_automation_id and x.workspace_id = target order by x.id desc limit 100) l), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.hanafy_automation_detail(text, uuid) from public, anon, authenticated;
grant execute on function public.hanafy_automation_detail(text, uuid) to authenticated;

-- Creates an automation or stores a new version of it (versions are never edited).
create or replace function public.hanafy_automation_save(target_workspace_slug text, payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'automations.manage');
  saved_automation uuid := nullif(payload ->> 'id', '')::uuid;
  existing public.automations%rowtype;
  next_version integer := 1;
  version_id uuid;
  problem text := public.hanafy_automation_definition_problem(payload);
  segment_filter text := payload -> 'trigger_filters' ->> 'segment_id';
begin
  if problem is not null then raise exception '%', problem using errcode = '22023'; end if;
  if segment_filter is not null and not exists (select 1 from public.customer_segments s where s.id::text = segment_filter and s.workspace_id = target) then
    raise exception 'That segment does not belong to this business' using errcode = '42501';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(payload -> 'conditions', '[]'::jsonb)) c
    where c ->> 'field' = 'in_segment' and not exists (select 1 from public.customer_segments s where s.id::text = c ->> 'value' and s.workspace_id = target)) then
    raise exception 'That segment does not belong to this business' using errcode = '42501';
  end if;

  if saved_automation is null then
    insert into public.automations (workspace_id, name, description, status, created_by_user_id)
    values (target, btrim(payload ->> 'name'), coalesce(payload ->> 'description', ''), 'draft', auth.uid())
    returning id into saved_automation;
  else
    select * into existing from public.automations where id = saved_automation and workspace_id = target for update;
    if existing.id is null then raise exception 'Automation not found' using errcode = 'P0002'; end if;
    if existing.executor = 'legacy_crm' then
      raise exception 'This automation runs in the Hanafy CRM; change it there until Hanafy moves it to the platform' using errcode = 'P0001';
    end if;
    update public.automations set name = btrim(payload ->> 'name'), description = coalesce(payload ->> 'description', description) where id = saved_automation;
    select coalesce(max(v.version), 0) + 1 into next_version from public.automation_versions v where v.automation_id = saved_automation;
  end if;

  insert into public.automation_versions (workspace_id, automation_id, version, trigger_event_type, trigger_filters, conditions, delay_minutes, actions,
    cooldown_hours, once_per_customer, created_by_user_id)
  values (target, saved_automation, next_version, payload ->> 'trigger_event_type', coalesce(payload -> 'trigger_filters', '{}'::jsonb),
    coalesce(payload -> 'conditions', '[]'::jsonb), coalesce((payload ->> 'delay_minutes')::integer, 0), payload -> 'actions',
    coalesce((payload ->> 'cooldown_hours')::integer, 0), coalesce((payload ->> 'once_per_customer')::boolean, false), auth.uid())
  returning id into version_id;
  update public.automations set current_version_id = version_id where id = saved_automation;
  return saved_automation;
end;
$$;
revoke all on function public.hanafy_automation_save(text, jsonb) from public, anon, authenticated;
grant execute on function public.hanafy_automation_save(text, jsonb) to authenticated;

create or replace function public.hanafy_automation_set_status(target_workspace_slug text, target_automation_id uuid, new_status text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'automations.manage');
  automation public.automations%rowtype;
  sends_sms boolean;
  mode text;
begin
  if new_status not in ('active', 'paused', 'archived', 'draft') then raise exception 'Unknown status' using errcode = '22023'; end if;
  select * into automation from public.automations where id = target_automation_id and workspace_id = target for update;
  if automation.id is null then raise exception 'Automation not found' using errcode = 'P0002'; end if;
  if automation.executor = 'legacy_crm' then
    raise exception 'This automation runs in the Hanafy CRM; switch it on or off there until Hanafy moves it to the platform' using errcode = 'P0001';
  end if;
  if new_status = 'active' then
    select exists (select 1 from public.automation_versions v, jsonb_array_elements(v.actions) a where v.id = automation.current_version_id and a ->> 'type' = 'send_sms')
    into sends_sms;
    select connection.dispatch_mode into mode from public.messaging_connections connection where connection.workspace_id = target and connection.channel = 'sms';
    if sends_sms and coalesce(mode, 'none') <> 'platform' then
      raise exception 'LEGACY_CRM_SENDS: this business''s texts still go out from the Hanafy CRM, so a texting automation can''t be switched on here yet' using errcode = 'P0001';
    end if;
  end if;
  update public.automations set status = new_status where id = automation.id;
  if new_status = 'archived' then
    update public.automation_runs set status = 'cancelled', finished_at = now(), outcome = 'automation archived before it ran'
    where automation_id = automation.id and status = 'waiting';
  end if;
  return new_status;
end;
$$;
revoke all on function public.hanafy_automation_set_status(text, uuid, text) from public, anon, authenticated;
grant execute on function public.hanafy_automation_set_status(text, uuid, text) to authenticated;

-- Audited replay: re-evaluates one recorded event for one automation.  The
-- unique (automation, event) key means an event that already produced a run
-- can never produce another.
create or replace function public.hanafy_automation_replay_event(target_workspace_slug text, target_automation_id uuid, target_event_id uuid, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'automations.manage');
  run_id uuid;
begin
  if change_reason is null or char_length(btrim(change_reason)) < 5 then raise exception 'Say why you are replaying this event' using errcode = '22023'; end if;
  if not exists (select 1 from public.automations a where a.id = target_automation_id and a.workspace_id = target and a.executor = 'platform') then
    raise exception 'Automation not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.domain_events e where e.event_id = target_event_id and e.workspace_id = target) then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  run_id := public.hanafy_automation_evaluate(target_automation_id, target_event_id, auth.uid());
  insert into public.audit_log (workspace_id, location_id, actor_user_id, actor_name, action, entity_type, entity_id, summary, changes, metadata, reason)
  select target, location.id, auth.uid(), coalesce((select profile.display_name from public.profiles profile where profile.id = auth.uid()), 'Staff'),
    'automation.replayed', 'automation', target_automation_id::text,
    case when run_id is null then 'Replay of an event created no run (already handled or did not match)' else 'Replayed an event into an automation' end,
    '{}'::jsonb, jsonb_build_object('event_id', target_event_id, 'run_id', run_id), btrim(change_reason)
  from public.locations location where location.workspace_id = target order by location.created_at limit 1;
  return jsonb_build_object('run_id', run_id, 'created', run_id is not null);
end;
$$;
revoke all on function public.hanafy_automation_replay_event(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.hanafy_automation_replay_event(text, uuid, uuid, text) to authenticated;

-- Cut-over: a Hanafy owner/admin moves mirrored CRM automations onto the
-- platform worker, only once the business's texts are sent by the platform.
create or replace function public.hanafy_platform_adopt_legacy_automations(target_workspace_slug text, change_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
  mode text;
  adopted integer;
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin']);
  if change_reason is null or char_length(btrim(change_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)' using errcode = '22023'; end if;
  select workspace.id into target from public.workspaces workspace where workspace.slug = target_workspace_slug;
  if target is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  select connection.dispatch_mode into mode from public.messaging_connections connection where connection.workspace_id = target and connection.channel = 'sms';
  if coalesce(mode, 'none') <> 'platform' then
    raise exception 'Switch this business''s texting to the platform sender first (Messaging tab)' using errcode = 'P0001';
  end if;
  update public.automations set executor = 'platform' where workspace_id = target and executor = 'legacy_crm';
  get diagnostics adopted = row_count;
  perform public.hanafy_platform_write_audit('platform.automations.adopted', target, 'automation', null,
    format('%s old-CRM automations moved to the platform worker', adopted), null, jsonb_build_object('adopted', adopted), btrim(change_reason), null);
  return adopted;
end;
$$;
revoke all on function public.hanafy_platform_adopt_legacy_automations(text, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_adopt_legacy_automations(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Wayne's: mirror the three Hanafy CRM automations (not run by the platform)
-- ---------------------------------------------------------------------------
do $$
declare
  waynes uuid;
  item record;
  automation_id uuid;
  version_id uuid;
begin
  select id into waynes from public.workspaces where slug = 'waynes-pizza';
  if waynes is null then return; end if;
  for item in select * from (values
    ('66fbf70c-461e-4d73-bb8b-d5c00c87b2a0'::uuid, 'Text club welcome', 'active', 'customer.reward.issued',
      '{{business_name}}: You''re in, {{first_name}}! Use code {{reward_code}} for a free small side on orders {{reward_minimum}}+. Good thru {{reward_expires}}. Reply STOP to opt out.'),
    ('ae807912-d4ed-4895-9d39-9fc1326e53c4'::uuid, '30-day win-back (Wayne''s)', 'draft', 'customer.offer.winback',
      '{{business_name}}: We miss you, {{first_name}}! {{reward_amount}} off your next order with code {{reward_code}} (thru {{reward_expires}}). Order: waynespizzaofworcester.com/r/{{reward_code}} Reply STOP to opt out'),
    ('9a10467d-a773-415e-af47-ee4a7c68dc7c'::uuid, 'Weekly Rewards offers (Wayne''s)', 'draft', 'customer.offers.published',
      '{{business_name}}: New Wayne''s Rewards deals are up, {{first_name}}! See your offers: waynespizzaofworcester.com/r/{{reward_code}} Reply STOP to opt out')
  ) as legacy(legacy_id, name, status, event_type, body)
  loop
    if exists (select 1 from public.automations a where a.legacy_crm_automation_id = item.legacy_id) then continue; end if;
    insert into public.automations (workspace_id, name, description, status, executor, legacy_crm_automation_id)
    values (waynes, item.name, 'Mirrored from the Hanafy CRM, which still runs it.', item.status, 'legacy_crm', item.legacy_id)
    returning id into automation_id;
    insert into public.automation_versions (workspace_id, automation_id, version, trigger_event_type, actions, once_per_customer)
    values (waynes, automation_id, 1, item.event_type, jsonb_build_array(jsonb_build_object('type', 'send_sms', 'body', item.body, 'message_type', 'marketing')),
      false)
    returning id into version_id;
    update public.automations set current_version_id = version_id where id = automation_id;
  end loop;
end;
$$;
