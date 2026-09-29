-- Hanafy Platform Phase 11: Hanafy billing + equipment balances (manual v1).
--
-- Build sheet §23, §38, §11.1, §11.3 (Billing, Equipment), §40 Phase 11.
--
-- This is money owed TO HANAFY MEDIA by a business for Hanafy services and
-- Hanafy-supplied equipment.  It is never mixed with a restaurant's own
-- customer payments (orders/payments/payment_connections), and every table
-- is named platform_* / equipment_* to keep that obvious (§38).
--
--   * platform_plans + plan_services: optional standard plans.  Custom
--     agreements are first-class (a subscription can have no plan).
--   * workspace_subscriptions: the agreement(s) a business is on — base plan
--     or add-on, monthly-equivalent price in integer cents, interval, dates,
--     custom terms.
--   * platform_invoices / _items / _payments: manual invoices.  Draft →
--     open (issued, lines locked) → paid (automatically when the balance is
--     zero) or void (only with no payments).  Payments are recorded by hand
--     and voided, never deleted.  Totals and balances are derived from the
--     lines and payments, never typed twice.
--   * equipment_assets / equipment_charges / equipment_payments: what
--     Hanafy supplied, what it charged, what was paid; balance = charges −
--     payments (§23.4 "calculated from authoritative charges/payments").
--     An asset can point at its hardware_devices row (Phase 10).
--   * No Stripe, no automatic billing (§23.5).
--
-- Nothing is invented for Wayne's: no agreement or price is seeded (Hanafy
-- records the real one in Platform Admin → Billing).  Wayne's store
-- equipment is owned by the business, so it carries no equipment balance.

-- ---------------------------------------------------------------------------
-- 1. Plans and subscriptions
-- ---------------------------------------------------------------------------
create table if not exists public.platform_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  active boolean not null default true,
  base_monthly_price_cents bigint check (base_monthly_price_cents is null or base_monthly_price_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plan_services (
  plan_id uuid not null references public.platform_plans(id) on delete cascade,
  service_id uuid not null references public.service_catalog(id) on delete restrict,
  primary key (plan_id, service_id)
);

insert into public.platform_plans (code, name, description, base_monthly_price_cents)
values ('custom', 'Custom agreement', 'Price and services agreed with the business directly. Use for any client not on a standard plan.', null)
on conflict (code) do nothing;

create table if not exists public.workspace_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  plan_id uuid references public.platform_plans(id) on delete restrict,
  kind text not null default 'base' check (kind in ('base', 'addon')),
  label text not null check (char_length(btrim(label)) between 1 and 120),
  status text not null default 'active' check (status in ('trial', 'active', 'paused', 'cancelled')),
  -- Always the price per billing interval, in cents.
  price_cents bigint not null check (price_cents >= 0),
  billing_interval text not null default 'monthly' check (billing_interval in ('monthly', 'quarterly', 'yearly')),
  start_date date not null,
  end_date date,
  custom_terms text check (custom_terms is null or char_length(custom_terms) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  check (end_date is null or end_date >= start_date)
);
create index if not exists workspace_subscriptions_workspace_idx on public.workspace_subscriptions(workspace_id, status);
-- One live base agreement per business; add-ons are unlimited.
create unique index if not exists workspace_subscriptions_one_base on public.workspace_subscriptions(workspace_id)
  where kind = 'base' and status in ('trial', 'active', 'paused');

comment on table public.workspace_subscriptions is
  'Phase 11 (§23.2): what a business pays HANAFY for. Not restaurant customer payments.';

-- Monthly-equivalent of one subscription (cents, rounded half up).
create or replace function public.hanafy_monthly_equivalent_cents(price bigint, billing_interval text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case billing_interval when 'monthly' then price when 'quarterly' then (price + 1) / 3 when 'yearly' then (price + 6) / 12 else price end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Invoices
-- ---------------------------------------------------------------------------
create sequence if not exists public.platform_invoice_number_seq;

create table if not exists public.platform_invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  invoice_number text not null unique,
  status text not null default 'draft' check (status in ('draft', 'open', 'paid', 'void')),
  issue_date date,
  due_date date,
  period_start date,
  period_end date,
  total_cents bigint not null default 0 check (total_cents >= 0),
  notes text check (notes is null or char_length(notes) <= 2000),
  void_reason text check (void_reason is null or char_length(void_reason) <= 500),
  issued_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  check (status = 'draft' or (issue_date is not null and due_date is not null)),
  check (due_date is null or issue_date is null or due_date >= issue_date),
  check (period_end is null or period_start is null or period_end >= period_start),
  check ((status = 'void') = (voided_at is not null))
);
create index if not exists platform_invoices_workspace_idx on public.platform_invoices(workspace_id, status, due_date);

create table if not exists public.platform_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null,
  workspace_id uuid not null,
  kind text not null default 'service' check (kind in ('subscription', 'service', 'setup', 'adjustment')),
  description text not null check (char_length(btrim(description)) between 1 and 300),
  quantity integer not null default 1 check (quantity between 1 and 10000),
  unit_price_cents bigint not null,
  amount_cents bigint generated always as (quantity * unit_price_cents) stored,
  subscription_id uuid,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  -- Only adjustments (credits) may be negative.
  check (unit_price_cents >= 0 or kind = 'adjustment'),
  foreign key (invoice_id, workspace_id) references public.platform_invoices(id, workspace_id) on delete cascade,
  foreign key (subscription_id, workspace_id) references public.workspace_subscriptions(id, workspace_id) on delete restrict
);
create index if not exists platform_invoice_items_invoice_idx on public.platform_invoice_items(invoice_id, position);

create table if not exists public.platform_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null,
  workspace_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  paid_on date not null,
  method text not null check (method in ('cash', 'check', 'ach', 'card', 'zelle', 'other')),
  reference text check (reference is null or char_length(reference) <= 120),
  notes text check (notes is null or char_length(notes) <= 500),
  recorded_by uuid,
  voided_at timestamptz,
  void_reason text check (void_reason is null or char_length(void_reason) <= 500),
  created_at timestamptz not null default now(),
  foreign key (invoice_id, workspace_id) references public.platform_invoices(id, workspace_id) on delete restrict,
  check ((voided_at is null) = (void_reason is null))
);
create index if not exists platform_invoice_payments_invoice_idx on public.platform_invoice_payments(invoice_id);

comment on table public.platform_invoices is
  'Phase 11 (§23.3): HANAFY''s invoices to a business (manual v1). Not restaurant customer payments.';

create or replace function public.hanafy_invoice_paid_cents(target_invoice_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(payment.amount_cents), 0)::bigint from public.platform_invoice_payments payment
  where payment.invoice_id = target_invoice_id and payment.voided_at is null;
$$;
revoke all on function public.hanafy_invoice_paid_cents(uuid) from public, anon, authenticated;

-- Lines change only while the invoice is a draft; the total follows the lines.
create or replace function public.hanafy_invoice_item_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
  invoice_status text;
begin
  select status into invoice_status from public.platform_invoices where id = target_invoice;
  if invoice_status is not null and invoice_status <> 'draft' then
    raise exception 'Invoice lines can only change while the invoice is a draft' using errcode = '22023';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.hanafy_invoice_item_rules() from public, anon, authenticated;
drop trigger if exists ab_hanafy_invoice_item_rules on public.platform_invoice_items;
create trigger ab_hanafy_invoice_item_rules before insert or update or delete on public.platform_invoice_items
for each row execute function public.hanafy_invoice_item_rules();

create or replace function public.hanafy_invoice_item_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare target_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update public.platform_invoices set total_cents = greatest(0, (select coalesce(sum(item.amount_cents), 0) from public.platform_invoice_items item where item.invoice_id = target_invoice))
  where id = target_invoice;
  return null;
end;
$$;
revoke all on function public.hanafy_invoice_item_total() from public, anon, authenticated;
drop trigger if exists zz_hanafy_invoice_item_total on public.platform_invoice_items;
create trigger zz_hanafy_invoice_item_total after insert or update or delete on public.platform_invoice_items
for each row execute function public.hanafy_invoice_item_total();

-- Payments: only on open/paid invoices, never more than what is owed; the
-- invoice becomes paid (or open again after a void) by itself.
create or replace function public.hanafy_invoice_payment_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare invoice public.platform_invoices%rowtype;
begin
  select * into invoice from public.platform_invoices where id = new.invoice_id for update;
  if tg_op = 'INSERT' then
    if invoice.status not in ('open') then
      raise exception 'Payments can only be recorded on an issued (open) invoice' using errcode = '22023';
    end if;
    if new.amount_cents > invoice.total_cents - public.hanafy_invoice_paid_cents(invoice.id) then
      raise exception 'That is more than the % still owed on invoice %', to_char((invoice.total_cents - public.hanafy_invoice_paid_cents(invoice.id)) / 100.0, 'FM$999,999,990.00'), invoice.invoice_number
        using errcode = '22023';
    end if;
  elsif tg_op = 'UPDATE' then
    if (old.amount_cents, old.paid_on, old.method, old.invoice_id) is distinct from (new.amount_cents, new.paid_on, new.method, new.invoice_id) then
      raise exception 'A recorded payment cannot be changed; void it and record it again' using errcode = '22023';
    end if;
    if old.voided_at is not null and new.voided_at is null then
      raise exception 'A voided payment stays voided' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_invoice_payment_rules() from public, anon, authenticated;
drop trigger if exists ab_hanafy_invoice_payment_rules on public.platform_invoice_payments;
create trigger ab_hanafy_invoice_payment_rules before insert or update on public.platform_invoice_payments
for each row execute function public.hanafy_invoice_payment_rules();

create or replace function public.hanafy_invoice_payment_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare invoice public.platform_invoices%rowtype; paid bigint;
begin
  select * into invoice from public.platform_invoices where id = new.invoice_id;
  paid := public.hanafy_invoice_paid_cents(invoice.id);
  if invoice.status = 'open' and paid >= invoice.total_cents then
    update public.platform_invoices set status = 'paid', paid_at = now() where id = invoice.id;
  elsif invoice.status = 'paid' and paid < invoice.total_cents then
    update public.platform_invoices set status = 'open', paid_at = null where id = invoice.id;
  end if;
  return null;
end;
$$;
revoke all on function public.hanafy_invoice_payment_status() from public, anon, authenticated;
drop trigger if exists zz_hanafy_invoice_payment_status on public.platform_invoice_payments;
create trigger zz_hanafy_invoice_payment_status after insert or update on public.platform_invoice_payments
for each row execute function public.hanafy_invoice_payment_status();

-- Payments are voided, never deleted; issued invoices are voided, never deleted.
create or replace function public.hanafy_refuse_billing_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'platform_invoices' and to_jsonb(old) ->> 'status' = 'draft' then return old; end if;
  raise exception '% records are kept for the books; void instead of deleting', replace(tg_table_name, '_', ' ') using errcode = '42501';
end;
$$;
revoke all on function public.hanafy_refuse_billing_delete() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Equipment (§23.4)
-- ---------------------------------------------------------------------------
create table if not exists public.equipment_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  hardware_device_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  vendor text check (vendor is null or char_length(vendor) <= 120),
  model text check (model is null or char_length(model) <= 160),
  serial_number text check (serial_number is null or char_length(serial_number) <= 120),
  ownership_type text not null check (ownership_type in ('customer_owned', 'hanafy_owned', 'financed', 'leased')),
  hanafy_cost_cents bigint check (hanafy_cost_cents is null or hanafy_cost_cents >= 0),
  customer_price_cents bigint check (customer_price_cents is null or customer_price_cents >= 0),
  payment_schedule text check (payment_schedule is null or char_length(payment_schedule) <= 300),
  purchased_at date,
  assigned_at date,
  status text not null default 'active' check (status in ('active', 'returned', 'written_off')),
  notes text check (notes is null or char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (hardware_device_id, workspace_id) references public.hardware_devices(id, workspace_id) on delete restrict
);
create unique index if not exists equipment_assets_one_per_device on public.equipment_assets(hardware_device_id) where hardware_device_id is not null;
create index if not exists equipment_assets_workspace_idx on public.equipment_assets(workspace_id, status);

create table if not exists public.equipment_charges (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null,
  workspace_id uuid not null,
  amount_cents bigint not null check (amount_cents <> 0),
  charged_on date not null,
  description text not null check (char_length(btrim(description)) between 1 and 300),
  created_at timestamptz not null default now(),
  foreign key (asset_id, workspace_id) references public.equipment_assets(id, workspace_id) on delete restrict
);

create table if not exists public.equipment_payments (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null,
  workspace_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  paid_on date not null,
  method text not null check (method in ('cash', 'check', 'ach', 'card', 'zelle', 'other')),
  reference text check (reference is null or char_length(reference) <= 120),
  notes text check (notes is null or char_length(notes) <= 500),
  recorded_by uuid,
  voided_at timestamptz,
  void_reason text check (void_reason is null or char_length(void_reason) <= 500),
  created_at timestamptz not null default now(),
  foreign key (asset_id, workspace_id) references public.equipment_assets(id, workspace_id) on delete restrict,
  check ((voided_at is null) = (void_reason is null))
);

create or replace function public.hanafy_equipment_balance(target_asset_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'charged_cents', coalesce((select sum(charge.amount_cents) from public.equipment_charges charge where charge.asset_id = target_asset_id), 0),
    'paid_cents', coalesce((select sum(payment.amount_cents) from public.equipment_payments payment where payment.asset_id = target_asset_id and payment.voided_at is null), 0),
    'balance_due_cents', coalesce((select sum(charge.amount_cents) from public.equipment_charges charge where charge.asset_id = target_asset_id), 0)
      - coalesce((select sum(payment.amount_cents) from public.equipment_payments payment where payment.asset_id = target_asset_id and payment.voided_at is null), 0));
$$;
revoke all on function public.hanafy_equipment_balance(uuid) from public, anon, authenticated;

create or replace function public.hanafy_equipment_payment_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare owed bigint;
begin
  perform 1 from public.equipment_assets where id = new.asset_id for update;
  if tg_op = 'INSERT' then
    owed := (public.hanafy_equipment_balance(new.asset_id) ->> 'balance_due_cents')::bigint;
    if new.amount_cents > owed then
      raise exception 'That is more than the % still owed on this equipment', to_char(owed / 100.0, 'FM$999,999,990.00') using errcode = '22023';
    end if;
  elsif (old.amount_cents, old.paid_on, old.method, old.asset_id) is distinct from (new.amount_cents, new.paid_on, new.method, new.asset_id)
     or (old.voided_at is not null and new.voided_at is null) then
    raise exception 'A recorded payment cannot be changed; void it and record it again' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.hanafy_equipment_payment_rules() from public, anon, authenticated;
drop trigger if exists ab_hanafy_equipment_payment_rules on public.equipment_payments;
create trigger ab_hanafy_equipment_payment_rules before insert or update on public.equipment_payments
for each row execute function public.hanafy_equipment_payment_rules();

-- Guards, timestamps, no deletes, no browser access.
do $$
declare table_name text;
begin
  foreach table_name in array array['workspace_subscriptions', 'platform_invoices', 'platform_invoice_items', 'platform_invoice_payments',
    'equipment_assets', 'equipment_charges', 'equipment_payments'] loop
    execute format('drop trigger if exists aa_hanafy_guard_platform_row on public.%I', table_name);
    execute format('create trigger aa_hanafy_guard_platform_row before insert or update on public.%I for each row execute function public.hanafy_guard_platform_row()', table_name);
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
  end loop;
  foreach table_name in array array['workspace_subscriptions', 'platform_invoices', 'equipment_assets'] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_set_updated_at', table_name);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', table_name || '_set_updated_at', table_name);
  end loop;
  foreach table_name in array array['platform_invoices', 'platform_invoice_payments', 'equipment_charges', 'equipment_payments', 'equipment_assets', 'workspace_subscriptions'] loop
    execute format('drop trigger if exists zz_hanafy_refuse_delete on public.%I', table_name);
    execute format('create trigger zz_hanafy_refuse_delete before delete on public.%I for each row execute function public.hanafy_refuse_billing_delete()', table_name);
  end loop;
end;
$$;
alter table public.platform_plans enable row level security;
alter table public.plan_services enable row level security;
revoke all on public.platform_plans, public.plan_services from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Balances used everywhere
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_workspace_billing_totals(target_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone coalesce((select workspace.timezone from public.workspaces workspace where workspace.id = target_workspace_id), 'UTC'))::date;
  base public.workspace_subscriptions%rowtype;
begin
  select * into base from public.workspace_subscriptions subscription
  where subscription.workspace_id = target_workspace_id and subscription.kind = 'base' and subscription.status in ('trial', 'active', 'paused')
  order by subscription.start_date desc limit 1;
  return jsonb_build_object(
    'agreement', case when base.id is null then null else jsonb_build_object('label', base.label, 'status', base.status,
      'plan_name', (select plan.name from public.platform_plans plan where plan.id = base.plan_id)) end,
    'monthly_recurring_cents', coalesce((select sum(public.hanafy_monthly_equivalent_cents(subscription.price_cents, subscription.billing_interval))
      from public.workspace_subscriptions subscription
      where subscription.workspace_id = target_workspace_id and subscription.status in ('active')
        and subscription.start_date <= today and (subscription.end_date is null or subscription.end_date >= today)), 0),
    'open_invoices', (select count(*) from public.platform_invoices invoice where invoice.workspace_id = target_workspace_id and invoice.status = 'open'),
    'open_balance_cents', coalesce((select sum(invoice.total_cents - public.hanafy_invoice_paid_cents(invoice.id))
      from public.platform_invoices invoice where invoice.workspace_id = target_workspace_id and invoice.status = 'open'), 0),
    'overdue_invoices', (select count(*) from public.platform_invoices invoice where invoice.workspace_id = target_workspace_id and invoice.status = 'open' and invoice.due_date < today),
    'overdue_balance_cents', coalesce((select sum(invoice.total_cents - public.hanafy_invoice_paid_cents(invoice.id))
      from public.platform_invoices invoice where invoice.workspace_id = target_workspace_id and invoice.status = 'open' and invoice.due_date < today), 0),
    'equipment_balance_cents', coalesce((select sum((public.hanafy_equipment_balance(asset.id) ->> 'balance_due_cents')::bigint)
      from public.equipment_assets asset where asset.workspace_id = target_workspace_id and asset.status <> 'written_off'), 0),
    'equipment_assets', (select count(*) from public.equipment_assets asset where asset.workspace_id = target_workspace_id)
  );
end;
$$;
revoke all on function public.hanafy_workspace_billing_totals(uuid) from public, anon, authenticated;

-- Workspace summary + health now carry billing (dashboard §11.1, overview §11.3).
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
    'billing', public.hanafy_workspace_billing_totals(workspace.id)
  )
  from public.workspaces workspace
  where workspace.id = target_workspace_id;
$$;

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
    'billing', jsonb_build_object(
      'monthly_recurring_cents', coalesce((select sum((summary #>> '{billing,monthly_recurring_cents}')::bigint) from jsonb_array_elements(summaries) summary), 0),
      'open_balance_cents', coalesce((select sum((summary #>> '{billing,open_balance_cents}')::bigint) from jsonb_array_elements(summaries) summary), 0),
      'overdue_balance_cents', coalesce((select sum((summary #>> '{billing,overdue_balance_cents}')::bigint) from jsonb_array_elements(summaries) summary), 0),
      'overdue_invoices', coalesce((select sum((summary #>> '{billing,overdue_invoices}')::bigint) from jsonb_array_elements(summaries) summary), 0),
      'equipment_balance_cents', coalesce((select sum((summary #>> '{billing,equipment_balance_cents}')::bigint) from jsonb_array_elements(summaries) summary), 0),
      'without_agreement', (select count(*) from jsonb_array_elements(summaries) summary
        where summary #> '{billing,agreement}' = 'null'::jsonb and summary ->> 'status' in ('active', 'provisioning'))
    )
  );
end;
$$;

-- Devices show what is still owed on them (Phase 10 view + equipment).
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
    'equipment', (select jsonb_build_object('asset_id', asset.id) || public.hanafy_equipment_balance(asset.id)
      from public.equipment_assets asset where asset.hardware_device_id = device.id limit 1),
    'retired_at', device.retired_at, 'created_at', device.created_at, 'updated_at', device.updated_at);
$$;
revoke all on function public.hanafy_hardware_device_json(public.hardware_devices) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Platform Admin reads
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_platform_can_bill()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.hanafy_platform_role() in ('platform_owner', 'platform_admin', 'platform_billing'), false);
$$;
revoke all on function public.hanafy_platform_can_bill() from public, anon;
grant execute on function public.hanafy_platform_can_bill() to authenticated;

create or replace function public.hanafy_invoice_json(invoice public.platform_invoices)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', invoice.id, 'invoice_number', invoice.invoice_number, 'status', invoice.status,
    'issue_date', invoice.issue_date, 'due_date', invoice.due_date, 'period_start', invoice.period_start, 'period_end', invoice.period_end,
    'total_cents', invoice.total_cents, 'paid_cents', public.hanafy_invoice_paid_cents(invoice.id),
    'balance_due_cents', case when invoice.status in ('open', 'paid') then invoice.total_cents - public.hanafy_invoice_paid_cents(invoice.id) else 0 end,
    'overdue', invoice.status = 'open' and invoice.due_date < (now() at time zone coalesce((select w.timezone from public.workspaces w where w.id = invoice.workspace_id), 'UTC'))::date,
    'notes', invoice.notes, 'void_reason', invoice.void_reason, 'issued_at', invoice.issued_at, 'paid_at', invoice.paid_at, 'voided_at', invoice.voided_at,
    'created_at', invoice.created_at,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', item.id, 'kind', item.kind, 'description', item.description, 'quantity', item.quantity,
        'unit_price_cents', item.unit_price_cents, 'amount_cents', item.amount_cents) order by item.position, item.created_at)
      from public.platform_invoice_items item where item.invoice_id = invoice.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', payment.id, 'amount_cents', payment.amount_cents, 'paid_on', payment.paid_on,
        'method', payment.method, 'reference', payment.reference, 'notes', payment.notes, 'voided_at', payment.voided_at, 'void_reason', payment.void_reason)
        order by payment.paid_on, payment.created_at)
      from public.platform_invoice_payments payment where payment.invoice_id = invoice.id), '[]'::jsonb));
$$;
revoke all on function public.hanafy_invoice_json(public.platform_invoices) from public, anon, authenticated;

create or replace function public.hanafy_platform_workspace_billing(target_workspace_slug text)
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
    'can_manage', public.hanafy_platform_can_bill(),
    'totals', public.hanafy_workspace_billing_totals(target),
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('id', subscription.id, 'kind', subscription.kind, 'label', subscription.label,
        'status', subscription.status, 'plan_id', subscription.plan_id, 'plan_name', plan.name, 'price_cents', subscription.price_cents,
        'billing_interval', subscription.billing_interval,
        'monthly_equivalent_cents', public.hanafy_monthly_equivalent_cents(subscription.price_cents, subscription.billing_interval),
        'start_date', subscription.start_date, 'end_date', subscription.end_date, 'custom_terms', subscription.custom_terms)
        order by subscription.status = 'cancelled', subscription.kind, subscription.start_date)
      from public.workspace_subscriptions subscription left join public.platform_plans plan on plan.id = subscription.plan_id
      where subscription.workspace_id = target), '[]'::jsonb),
    'invoices', coalesce((select jsonb_agg(public.hanafy_invoice_json(invoice) order by invoice.created_at desc)
      from public.platform_invoices invoice where invoice.workspace_id = target), '[]'::jsonb),
    'equipment', coalesce((select jsonb_agg(jsonb_build_object('id', asset.id, 'name', asset.name, 'vendor', asset.vendor, 'model', asset.model,
        'serial_number', asset.serial_number, 'ownership_type', asset.ownership_type, 'hanafy_cost_cents', asset.hanafy_cost_cents,
        'customer_price_cents', asset.customer_price_cents, 'payment_schedule', asset.payment_schedule, 'purchased_at', asset.purchased_at,
        'assigned_at', asset.assigned_at, 'status', asset.status, 'notes', asset.notes, 'hardware_device_id', asset.hardware_device_id,
        'device_name', device.name, 'location_name', location.name,
        'charges', coalesce((select jsonb_agg(jsonb_build_object('id', charge.id, 'amount_cents', charge.amount_cents, 'charged_on', charge.charged_on,
            'description', charge.description) order by charge.charged_on, charge.created_at)
          from public.equipment_charges charge where charge.asset_id = asset.id), '[]'::jsonb),
        'payments', coalesce((select jsonb_agg(jsonb_build_object('id', payment.id, 'amount_cents', payment.amount_cents, 'paid_on', payment.paid_on,
            'method', payment.method, 'reference', payment.reference, 'voided_at', payment.voided_at, 'void_reason', payment.void_reason)
            order by payment.paid_on, payment.created_at)
          from public.equipment_payments payment where payment.asset_id = asset.id), '[]'::jsonb)) || public.hanafy_equipment_balance(asset.id)
        order by asset.status, asset.created_at)
      from public.equipment_assets asset
      left join public.hardware_devices device on device.id = asset.hardware_device_id
      left join public.locations location on location.id = device.location_id
      where asset.workspace_id = target), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('id', device.id, 'name', device.name, 'device_type', device.device_type,
        'ownership_type', device.ownership_type, 'has_asset', exists (select 1 from public.equipment_assets asset where asset.hardware_device_id = device.id))
        order by device.name)
      from public.hardware_devices device where device.workspace_id = target and device.status <> 'retired'), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', plan.id, 'code', plan.code, 'name', plan.name, 'active', plan.active,
        'base_monthly_price_cents', plan.base_monthly_price_cents) order by plan.active desc, plan.name)
      from public.platform_plans plan), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.hanafy_platform_workspace_billing(text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_workspace_billing(text) to authenticated;

-- All businesses, for Platform Admin → Billing.
create or replace function public.hanafy_platform_billing_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_support', 'platform_billing', 'platform_read_only']);
  return jsonb_build_object(
    'can_manage', public.hanafy_platform_can_bill(),
    'workspaces', coalesce((select jsonb_agg(jsonb_build_object('slug', workspace.slug, 'name', workspace.name, 'status', workspace.status)
        || public.hanafy_workspace_billing_totals(workspace.id) order by workspace.name)
      from public.workspaces workspace where workspace.status <> 'archived'), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', plan.id, 'code', plan.code, 'name', plan.name, 'description', plan.description,
        'active', plan.active, 'base_monthly_price_cents', plan.base_monthly_price_cents,
        'services', coalesce((select jsonb_agg(service.code order by service.code) from public.plan_services mapping
          join public.service_catalog service on service.id = mapping.service_id where mapping.plan_id = plan.id), '[]'::jsonb),
        'subscribers', (select count(*) from public.workspace_subscriptions subscription where subscription.plan_id = plan.id and subscription.status in ('trial', 'active', 'paused')))
        order by plan.active desc, plan.name)
      from public.platform_plans plan), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(jsonb_build_object('code', service.code, 'name', service.name) order by service.name)
      from public.service_catalog service where service.active), '[]'::jsonb),
    'overdue', coalesce((select jsonb_agg(public.hanafy_invoice_json(invoice) || jsonb_build_object('workspace_slug', workspace.slug, 'workspace_name', workspace.name)
        order by invoice.due_date)
      from public.platform_invoices invoice join public.workspaces workspace on workspace.id = invoice.workspace_id
      where invoice.status = 'open' and invoice.due_date < (now() at time zone workspace.timezone)::date), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.hanafy_platform_billing_overview() from public, anon, authenticated;
grant execute on function public.hanafy_platform_billing_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Platform Admin writes (owner / admin / billing; reason; audited)
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_billing_guard(change_reason text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.hanafy_require_platform_role(array['platform_owner', 'platform_admin', 'platform_billing']);
  if change_reason is null or char_length(btrim(change_reason)) < 5 then
    raise exception 'Give a reason (at least 5 characters)' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.hanafy_billing_guard(text) from public, anon, authenticated;

create or replace function public.hanafy_billing_workspace(target_workspace_slug text)
returns public.workspaces
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target public.workspaces%rowtype;
begin
  select * into target from public.workspaces workspace where workspace.slug = target_workspace_slug;
  if target.id is null then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  return target;
end;
$$;
revoke all on function public.hanafy_billing_workspace(text) from public, anon, authenticated;

create or replace function public.hanafy_billing_cents(value jsonb, allow_negative boolean default false)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare parsed bigint;
begin
  if value is null or jsonb_typeof(value) = 'null' then return null; end if;
  if jsonb_typeof(value) <> 'number' or (value #>> '{}') !~ '^-?[0-9]{1,12}$' then
    raise exception 'Amounts are whole cents' using errcode = '22023';
  end if;
  parsed := (value #>> '{}')::bigint;
  if parsed < 0 and not allow_negative then raise exception 'Amounts cannot be negative' using errcode = '22023'; end if;
  return parsed;
end;
$$;

create or replace function public.hanafy_platform_save_plan(payload jsonb, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  plan_id uuid := nullif(payload ->> 'id', '')::uuid;
  before_row public.platform_plans%rowtype;
  after_row public.platform_plans%rowtype;
  service_code text;
begin
  perform public.hanafy_billing_guard(change_reason);
  if plan_id is null then
    insert into public.platform_plans (code, name, description, active, base_monthly_price_cents)
    values (payload ->> 'code', payload ->> 'name', coalesce(payload ->> 'description', ''), coalesce((payload ->> 'active')::boolean, true),
      public.hanafy_billing_cents(payload -> 'base_monthly_price_cents'))
    returning * into after_row;
  else
    select * into before_row from public.platform_plans where id = plan_id for update;
    if before_row.id is null then raise exception 'Plan not found' using errcode = 'P0002'; end if;
    update public.platform_plans set
      name = coalesce(nullif(btrim(payload ->> 'name'), ''), name),
      description = coalesce(payload ->> 'description', description),
      active = coalesce((payload ->> 'active')::boolean, active),
      base_monthly_price_cents = case when payload ? 'base_monthly_price_cents' then public.hanafy_billing_cents(payload -> 'base_monthly_price_cents') else base_monthly_price_cents end,
      updated_at = now()
    where id = plan_id returning * into after_row;
  end if;
  if jsonb_typeof(payload -> 'services') = 'array' then
    delete from public.plan_services where plan_services.plan_id = after_row.id;
    for service_code in select value #>> '{}' from jsonb_array_elements(payload -> 'services') loop
      insert into public.plan_services (plan_id, service_id)
      select after_row.id, service.id from public.service_catalog service where service.code = service_code;
      if not found then raise exception 'Unknown service %', service_code using errcode = '22023'; end if;
    end loop;
  end if;
  perform public.hanafy_platform_write_audit(case when plan_id is null then 'platform.billing.plan_created' else 'platform.billing.plan_updated' end,
    null, 'platform_plan', after_row.id::text, format('%s plan %s', case when plan_id is null then 'Added' else 'Changed' end, after_row.name),
    case when before_row.id is null then null else to_jsonb(before_row) end, to_jsonb(after_row), btrim(change_reason), null);
  return jsonb_build_object('status', 'saved', 'id', after_row.id);
end;
$$;
revoke all on function public.hanafy_platform_save_plan(jsonb, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_save_plan(jsonb, text) to authenticated;

create or replace function public.hanafy_platform_save_subscription(target_workspace_slug text, payload jsonb, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  subscription_id uuid := nullif(payload ->> 'id', '')::uuid;
  before_row public.workspace_subscriptions%rowtype;
  after_row public.workspace_subscriptions%rowtype;
  plan public.platform_plans%rowtype;
begin
  perform public.hanafy_billing_guard(change_reason);
  target := public.hanafy_billing_workspace(target_workspace_slug);
  if nullif(payload ->> 'plan_id', '') is not null then
    select * into plan from public.platform_plans where id = (payload ->> 'plan_id')::uuid;
    if plan.id is null then raise exception 'Plan not found' using errcode = 'P0002'; end if;
  end if;
  if subscription_id is null then
    insert into public.workspace_subscriptions (workspace_id, plan_id, kind, label, status, price_cents, billing_interval, start_date, end_date, custom_terms)
    values (target.id, plan.id, coalesce(nullif(payload ->> 'kind', ''), 'base'),
      coalesce(nullif(btrim(payload ->> 'label'), ''), plan.name, 'Custom agreement'), coalesce(nullif(payload ->> 'status', ''), 'active'),
      coalesce(public.hanafy_billing_cents(payload -> 'price_cents'), plan.base_monthly_price_cents, 0),
      coalesce(nullif(payload ->> 'billing_interval', ''), 'monthly'),
      coalesce(nullif(payload ->> 'start_date', '')::date, (now() at time zone target.timezone)::date),
      nullif(payload ->> 'end_date', '')::date, nullif(btrim(payload ->> 'custom_terms'), ''))
    returning * into after_row;
  else
    select * into before_row from public.workspace_subscriptions where id = subscription_id and workspace_id = target.id for update;
    if before_row.id is null then raise exception 'Agreement not found for this business' using errcode = 'P0002'; end if;
    update public.workspace_subscriptions set
      plan_id = case when payload ? 'plan_id' then plan.id else plan_id end,
      label = coalesce(nullif(btrim(payload ->> 'label'), ''), label),
      status = coalesce(nullif(payload ->> 'status', ''), status),
      price_cents = coalesce(public.hanafy_billing_cents(payload -> 'price_cents'), price_cents),
      billing_interval = coalesce(nullif(payload ->> 'billing_interval', ''), billing_interval),
      start_date = coalesce(nullif(payload ->> 'start_date', '')::date, start_date),
      end_date = case when payload ? 'end_date' then nullif(payload ->> 'end_date', '')::date else end_date end,
      custom_terms = case when payload ? 'custom_terms' then nullif(btrim(payload ->> 'custom_terms'), '') else custom_terms end
    where id = subscription_id returning * into after_row;
  end if;
  perform public.hanafy_platform_write_audit(case when subscription_id is null then 'platform.billing.subscription_created' else 'platform.billing.subscription_updated' end,
    target.id, 'workspace_subscription', after_row.id::text,
    format('%s agreement for %s: %s, %s per %s (%s)', case when subscription_id is null then 'Added' else 'Changed' end, target.name, after_row.label,
      to_char(after_row.price_cents / 100.0, 'FM$999,999,990.00'), replace(after_row.billing_interval, 'ly', ''), after_row.status),
    case when before_row.id is null then null else to_jsonb(before_row) end, to_jsonb(after_row), btrim(change_reason), null);
  return jsonb_build_object('status', 'saved', 'id', after_row.id);
end;
$$;
revoke all on function public.hanafy_platform_save_subscription(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_save_subscription(text, jsonb, text) to authenticated;

-- Create a draft (optionally with this period's agreement lines), replace a
-- draft's lines, issue it, or void it.
create or replace function public.hanafy_platform_save_invoice(target_workspace_slug text, payload jsonb, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  invoice_id uuid := nullif(payload ->> 'id', '')::uuid;
  action text := coalesce(nullif(payload ->> 'action', ''), case when nullif(payload ->> 'id', '') is null then 'create' else 'update' end);
  before_row public.platform_invoices%rowtype;
  after_row public.platform_invoices%rowtype;
  today date;
  item jsonb;
  position_value integer := 0;
begin
  perform public.hanafy_billing_guard(change_reason);
  target := public.hanafy_billing_workspace(target_workspace_slug);
  today := (now() at time zone target.timezone)::date;

  if action = 'create' then
    insert into public.platform_invoices (workspace_id, invoice_number, period_start, period_end, notes)
    values (target.id, 'HM-' || to_char(today, 'YYYY') || '-' || lpad(nextval('public.platform_invoice_number_seq')::text, 4, '0'),
      nullif(payload ->> 'period_start', '')::date, nullif(payload ->> 'period_end', '')::date, nullif(btrim(payload ->> 'notes'), ''))
    returning * into after_row;
    if coalesce((payload ->> 'include_agreements')::boolean, false) then
      insert into public.platform_invoice_items (invoice_id, workspace_id, kind, description, quantity, unit_price_cents, subscription_id, position)
      select after_row.id, target.id, 'subscription',
        subscription.label || coalesce(' — ' || to_char(after_row.period_start, 'Mon DD') || ' to ' || to_char(after_row.period_end, 'Mon DD, YYYY'), ''),
        1, subscription.price_cents, subscription.id, row_number() over (order by subscription.kind, subscription.start_date)::integer
      from public.workspace_subscriptions subscription
      where subscription.workspace_id = target.id and subscription.status = 'active' and subscription.price_cents > 0
        and subscription.start_date <= coalesce(after_row.period_end, today)
        and (subscription.end_date is null or subscription.end_date >= coalesce(after_row.period_start, today));
      position_value := (select count(*) from public.platform_invoice_items where platform_invoice_items.invoice_id = after_row.id);
    end if;
  else
    select * into before_row from public.platform_invoices where id = invoice_id and workspace_id = target.id for update;
    if before_row.id is null then raise exception 'Invoice not found for this business' using errcode = 'P0002'; end if;
    after_row := before_row;
  end if;

  if action in ('create', 'update') and jsonb_typeof(payload -> 'items') = 'array' then
    if after_row.status <> 'draft' then raise exception 'Invoice lines can only change while the invoice is a draft' using errcode = '22023'; end if;
    if action = 'update' then delete from public.platform_invoice_items where platform_invoice_items.invoice_id = after_row.id; end if;
    for item in select value from jsonb_array_elements(payload -> 'items') loop
      position_value := position_value + 1;
      insert into public.platform_invoice_items (invoice_id, workspace_id, kind, description, quantity, unit_price_cents, position)
      values (after_row.id, target.id, coalesce(nullif(item ->> 'kind', ''), 'service'), item ->> 'description',
        coalesce(nullif(item ->> 'quantity', '')::integer, 1),
        public.hanafy_billing_cents(item -> 'unit_price_cents', coalesce(item ->> 'kind', '') = 'adjustment'), position_value);
    end loop;
  end if;
  if action = 'update' and after_row.status = 'draft' then
    update public.platform_invoices set
      period_start = case when payload ? 'period_start' then nullif(payload ->> 'period_start', '')::date else period_start end,
      period_end = case when payload ? 'period_end' then nullif(payload ->> 'period_end', '')::date else period_end end,
      notes = case when payload ? 'notes' then nullif(btrim(payload ->> 'notes'), '') else notes end
    where id = after_row.id;
  end if;

  if action = 'issue' then
    if before_row.status <> 'draft' then raise exception 'Only a draft invoice can be issued' using errcode = '22023'; end if;
    if not exists (select 1 from public.platform_invoice_items where platform_invoice_items.invoice_id = before_row.id) then
      raise exception 'Add at least one line before issuing' using errcode = '22023';
    end if;
    update public.platform_invoices set status = 'open', issued_at = now(),
      issue_date = coalesce(nullif(payload ->> 'issue_date', '')::date, today),
      due_date = coalesce(nullif(payload ->> 'due_date', '')::date, coalesce(nullif(payload ->> 'issue_date', '')::date, today) + 15)
    where id = before_row.id;
    -- A zero invoice is settled the moment it is issued.
    update public.platform_invoices set status = 'paid', paid_at = now() where id = before_row.id and total_cents = 0;
  elsif action = 'void' then
    if before_row.status = 'void' then raise exception 'Invoice is already void' using errcode = '22023'; end if;
    if before_row.status = 'draft' then
      delete from public.platform_invoices where id = before_row.id;
    else
      if public.hanafy_invoice_paid_cents(before_row.id) > 0 then
        raise exception 'Void the payments on this invoice first' using errcode = '22023';
      end if;
      update public.platform_invoices set status = 'void', voided_at = now(), void_reason = left(btrim(change_reason), 500) where id = before_row.id;
    end if;
  elsif action not in ('create', 'update') then
    raise exception 'Unknown invoice action' using errcode = '22023';
  end if;

  select * into after_row from public.platform_invoices where id = coalesce(after_row.id, before_row.id);
  perform public.hanafy_platform_write_audit('platform.billing.invoice_' || case action when 'create' then 'created' when 'update' then 'updated' when 'issue' then 'issued' else 'voided' end,
    target.id, 'platform_invoice', coalesce(after_row.id, before_row.id)::text,
    format('%s invoice %s for %s (%s)', initcap(case action when 'create' then 'created' when 'update' then 'changed' when 'issue' then 'issued' else case when before_row.status = 'draft' then 'discarded draft' else 'voided' end end),
      coalesce(after_row.invoice_number, before_row.invoice_number), target.name, to_char(coalesce(after_row.total_cents, before_row.total_cents) / 100.0, 'FM$999,999,990.00')),
    case when before_row.id is null then null else to_jsonb(before_row) end, case when after_row.id is null then null else to_jsonb(after_row) end, btrim(change_reason), null);
  return jsonb_build_object('status', 'saved', 'id', after_row.id, 'invoice_number', coalesce(after_row.invoice_number, before_row.invoice_number));
end;
$$;
revoke all on function public.hanafy_platform_save_invoice(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_save_invoice(text, jsonb, text) to authenticated;

-- Record or void a payment on an invoice or on equipment.
create or replace function public.hanafy_platform_record_payment(target_workspace_slug text, payload jsonb, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  target_kind text := payload ->> 'target';   -- 'invoice' | 'equipment'
  target_id uuid := nullif(payload ->> 'target_id', '')::uuid;
  payment_id uuid := nullif(payload ->> 'void_payment_id', '')::uuid;
  amount bigint;
  new_id uuid;
  label text;
begin
  perform public.hanafy_billing_guard(change_reason);
  target := public.hanafy_billing_workspace(target_workspace_slug);
  if target_kind not in ('invoice', 'equipment') then raise exception 'Unknown payment target' using errcode = '22023'; end if;

  if payment_id is not null then
    if target_kind = 'invoice' then
      update public.platform_invoice_payments set voided_at = now(), void_reason = left(btrim(change_reason), 500)
      where id = payment_id and workspace_id = target.id and voided_at is null returning id into new_id;
    else
      update public.equipment_payments set voided_at = now(), void_reason = left(btrim(change_reason), 500)
      where id = payment_id and workspace_id = target.id and voided_at is null returning id into new_id;
    end if;
    if new_id is null then raise exception 'Payment not found for this business (or already voided)' using errcode = 'P0002'; end if;
    perform public.hanafy_platform_write_audit('platform.billing.payment_voided', target.id, target_kind || '_payment', new_id::text,
      format('Voided a %s payment for %s', target_kind, target.name), null, null, btrim(change_reason), null);
    return jsonb_build_object('status', 'voided', 'id', new_id);
  end if;

  amount := public.hanafy_billing_cents(payload -> 'amount_cents');
  if amount is null or amount <= 0 then raise exception 'Enter the amount paid' using errcode = '22023'; end if;
  if target_kind = 'invoice' then
    select invoice.invoice_number into label from public.platform_invoices invoice where invoice.id = target_id and invoice.workspace_id = target.id;
    if label is null then raise exception 'Invoice not found for this business' using errcode = 'P0002'; end if;
    insert into public.platform_invoice_payments (invoice_id, workspace_id, amount_cents, paid_on, method, reference, notes, recorded_by)
    values (target_id, target.id, amount, coalesce(nullif(payload ->> 'paid_on', '')::date, (now() at time zone target.timezone)::date),
      coalesce(nullif(payload ->> 'method', ''), 'other'), nullif(btrim(payload ->> 'reference'), ''), nullif(btrim(payload ->> 'notes'), ''), auth.uid())
    returning id into new_id;
  else
    select asset.name into label from public.equipment_assets asset where asset.id = target_id and asset.workspace_id = target.id;
    if label is null then raise exception 'Equipment not found for this business' using errcode = 'P0002'; end if;
    insert into public.equipment_payments (asset_id, workspace_id, amount_cents, paid_on, method, reference, notes, recorded_by)
    values (target_id, target.id, amount, coalesce(nullif(payload ->> 'paid_on', '')::date, (now() at time zone target.timezone)::date),
      coalesce(nullif(payload ->> 'method', ''), 'other'), nullif(btrim(payload ->> 'reference'), ''), nullif(btrim(payload ->> 'notes'), ''), auth.uid())
    returning id into new_id;
  end if;
  perform public.hanafy_platform_write_audit('platform.billing.payment_recorded', target.id, target_kind || '_payment', new_id::text,
    format('Recorded %s paid by %s on %s', to_char(amount / 100.0, 'FM$999,999,990.00'), target.name, label), null,
    jsonb_build_object('amount_cents', amount, 'method', payload ->> 'method', 'target', target_kind, 'target_id', target_id), btrim(change_reason), null);
  return jsonb_build_object('status', 'saved', 'id', new_id);
end;
$$;
revoke all on function public.hanafy_platform_record_payment(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_record_payment(text, jsonb, text) to authenticated;

-- Add / change an equipment asset, or add a charge (or credit) to one.
create or replace function public.hanafy_platform_save_equipment(target_workspace_slug text, payload jsonb, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.workspaces%rowtype;
  asset_id uuid := nullif(payload ->> 'id', '')::uuid;
  device_id uuid := nullif(payload ->> 'hardware_device_id', '')::uuid;
  device public.hardware_devices%rowtype;
  before_row public.equipment_assets%rowtype;
  after_row public.equipment_assets%rowtype;
  charge bigint;
  today date;
begin
  perform public.hanafy_billing_guard(change_reason);
  target := public.hanafy_billing_workspace(target_workspace_slug);
  today := (now() at time zone target.timezone)::date;
  if device_id is not null then
    select * into device from public.hardware_devices where id = device_id and workspace_id = target.id;
    if device.id is null then raise exception 'That device does not belong to this business' using errcode = '42501'; end if;
  end if;

  if asset_id is null then
    insert into public.equipment_assets (workspace_id, hardware_device_id, name, vendor, model, serial_number, ownership_type, hanafy_cost_cents,
      customer_price_cents, payment_schedule, purchased_at, assigned_at, notes)
    values (target.id, device.id, coalesce(nullif(btrim(payload ->> 'name'), ''), device.name), coalesce(nullif(btrim(payload ->> 'vendor'), ''), device.vendor),
      coalesce(nullif(btrim(payload ->> 'model'), ''), device.model), coalesce(nullif(btrim(payload ->> 'serial_number'), ''), device.serial_number),
      coalesce(nullif(payload ->> 'ownership_type', ''), 'financed'), public.hanafy_billing_cents(payload -> 'hanafy_cost_cents'),
      public.hanafy_billing_cents(payload -> 'customer_price_cents'), nullif(btrim(payload ->> 'payment_schedule'), ''),
      nullif(payload ->> 'purchased_at', '')::date, coalesce(nullif(payload ->> 'assigned_at', '')::date, today), nullif(btrim(payload ->> 'notes'), ''))
    returning * into after_row;
    -- The agreed price becomes the first charge, so the balance starts right.
    if coalesce(after_row.customer_price_cents, 0) > 0 and coalesce((payload ->> 'charge_price')::boolean, true) then
      insert into public.equipment_charges (asset_id, workspace_id, amount_cents, charged_on, description)
      values (after_row.id, target.id, after_row.customer_price_cents, coalesce(after_row.assigned_at, today), 'Equipment price: ' || after_row.name);
    end if;
    -- Keep the device's ownership in step.
    if device.id is not null and device.ownership_type is distinct from after_row.ownership_type then
      update public.hardware_devices set ownership_type = after_row.ownership_type where id = device.id;
    end if;
  else
    select * into before_row from public.equipment_assets where id = asset_id and workspace_id = target.id for update;
    if before_row.id is null then raise exception 'Equipment not found for this business' using errcode = 'P0002'; end if;
    update public.equipment_assets set
      hardware_device_id = case when payload ? 'hardware_device_id' then device.id else hardware_device_id end,
      name = coalesce(nullif(btrim(payload ->> 'name'), ''), name),
      vendor = case when payload ? 'vendor' then nullif(btrim(payload ->> 'vendor'), '') else vendor end,
      model = case when payload ? 'model' then nullif(btrim(payload ->> 'model'), '') else model end,
      serial_number = case when payload ? 'serial_number' then nullif(btrim(payload ->> 'serial_number'), '') else serial_number end,
      ownership_type = coalesce(nullif(payload ->> 'ownership_type', ''), ownership_type),
      hanafy_cost_cents = case when payload ? 'hanafy_cost_cents' then public.hanafy_billing_cents(payload -> 'hanafy_cost_cents') else hanafy_cost_cents end,
      payment_schedule = case when payload ? 'payment_schedule' then nullif(btrim(payload ->> 'payment_schedule'), '') else payment_schedule end,
      status = coalesce(nullif(payload ->> 'status', ''), status),
      notes = case when payload ? 'notes' then nullif(btrim(payload ->> 'notes'), '') else notes end
    where id = asset_id returning * into after_row;
    -- The price itself changes only through a charge or credit (the ledger is the truth).
    if payload ? 'charge_cents' then
      charge := public.hanafy_billing_cents(payload -> 'charge_cents', true);
      if charge is null or charge = 0 then raise exception 'Enter the charge (or a negative credit)' using errcode = '22023'; end if;
      if charge < 0 and -charge > (public.hanafy_equipment_balance(asset_id) ->> 'balance_due_cents')::bigint then
        raise exception 'A credit cannot be larger than what is still owed' using errcode = '22023';
      end if;
      insert into public.equipment_charges (asset_id, workspace_id, amount_cents, charged_on, description)
      values (asset_id, target.id, charge, coalesce(nullif(payload ->> 'charged_on', '')::date, today),
        coalesce(nullif(btrim(payload ->> 'charge_description'), ''), case when charge < 0 then 'Credit' else 'Charge' end));
    end if;
  end if;

  perform public.hanafy_platform_write_audit(case when asset_id is null then 'platform.billing.equipment_created' when payload ? 'charge_cents' then 'platform.billing.equipment_charged' else 'platform.billing.equipment_updated' end,
    target.id, 'equipment_asset', after_row.id::text,
    format('%s equipment for %s: %s (balance %s)', case when asset_id is null then 'Added' when payload ? 'charge_cents' then 'Charged' else 'Changed' end, target.name, after_row.name,
      to_char(((public.hanafy_equipment_balance(after_row.id) ->> 'balance_due_cents')::bigint) / 100.0, 'FM$999,999,990.00')),
    case when before_row.id is null then null else to_jsonb(before_row) end, to_jsonb(after_row), btrim(change_reason), null);
  return jsonb_build_object('status', 'saved', 'id', after_row.id) || public.hanafy_equipment_balance(after_row.id);
end;
$$;
revoke all on function public.hanafy_platform_save_equipment(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.hanafy_platform_save_equipment(text, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The business can see what it owes Hanafy (owner / settings.manage)
-- ---------------------------------------------------------------------------
create or replace function public.hanafy_workspace_hanafy_billing(target_workspace_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target uuid := public.hanafy_require_workspace_permission(target_workspace_slug, 'settings.manage');
begin
  return jsonb_build_object(
    'totals', public.hanafy_workspace_billing_totals(target),
    'invoices', coalesce((select jsonb_agg(public.hanafy_invoice_json(invoice) - 'notes' order by invoice.issue_date desc nulls last)
      from public.platform_invoices invoice where invoice.workspace_id = target and invoice.status in ('open', 'paid')), '[]'::jsonb),
    'equipment', coalesce((select jsonb_agg(jsonb_build_object('name', asset.name, 'ownership_type', asset.ownership_type,
        'payment_schedule', asset.payment_schedule) || public.hanafy_equipment_balance(asset.id) order by asset.created_at)
      from public.equipment_assets asset where asset.workspace_id = target and asset.status = 'active'), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.hanafy_workspace_hanafy_billing(text) from public, anon, authenticated;
grant execute on function public.hanafy_workspace_hanafy_billing(text) to authenticated;
