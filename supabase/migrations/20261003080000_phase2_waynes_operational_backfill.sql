-- Hanafy Platform Phase 2: add nullable tenant ownership to Wayne's existing
-- operational data and backfill it to the Phase 1 Wayne's / Worcester seed.
--
-- No tenant scope is made NOT NULL here. Phase 3 will first rewrite every
-- application mutation and RLS policy, then tighten those constraints after a
-- production validation window.

-- Workspace-owned data.
alter table public.store_settings add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.store_special_hours add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.customers add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.customer_phones add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.customer_addresses add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.marketing_consents add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.promotions add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.menu_categories add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.menu_items add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.menu_item_variants add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.modifier_groups add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.modifier_choices add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.menu_item_modifier_groups add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.modifier_choice_variant_prices add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.menu_item_included_choices add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.customer_segments add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.customer_segment_memberships add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.customer_events add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.customer_segment_evaluation_runs add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.order_idempotency add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.integration_destinations add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.integration_outbox add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.integration_delivery_logs add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.payment_provider_settings add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.payment_webhook_events add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.reward_grants add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.audit_log add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;

-- Location-operational data also belongs to the workspace.
alter table public.store_settings add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.store_special_hours add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.orders add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.orders add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.order_items add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.order_items add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.order_item_modifiers add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.order_item_modifiers add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.order_discounts add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.order_discounts add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.order_events add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.order_events add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.payments add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.payments add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.refunds add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.refunds add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.delivery_assignments add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.delivery_assignments add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.kitchen_tickets add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.kitchen_tickets add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.print_jobs add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.print_jobs add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.registers add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.registers add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.register_shifts add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.register_shifts add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.cash_movements add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.cash_movements add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.payment_terminals add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.payment_terminals add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.payment_webhook_events add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.store_phone_lines add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.store_phone_lines add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.phone_calls add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.phone_calls add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.pos_drafts add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.pos_drafts add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.pos_hardware_settings add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.pos_hardware_settings add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.pilot_checks add column if not exists workspace_id uuid references public.workspaces(id) on delete restrict;
alter table public.pilot_checks add column if not exists location_id uuid references public.locations(id) on delete restrict;
alter table public.audit_log add column if not exists location_id uuid references public.locations(id) on delete restrict;

-- `audit_log` is intentionally immutable. The only permitted update is this
-- one-time, simultaneous classification of legacy rows; every pre-existing
-- audit value must remain byte-for-byte unchanged.
create or replace function public.wayne_prevent_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and (old.workspace_id is null or old.location_id is null)
    and new.workspace_id is not null
    and new.location_id is not null
    and (to_jsonb(new) - array['workspace_id', 'location_id']::text[])
      = (to_jsonb(old) - array['workspace_id', 'location_id']::text[]) then
    return new;
  end if;

  raise exception 'Audit log entries are immutable' using errcode = '42501';
end;
$$;

do $$
declare
  waynes_workspace_id uuid;
  worcester_location_id uuid;
  table_name text;
  unassigned_count bigint;
  workspace_scoped_tables text[] := array[
    'store_settings', 'store_special_hours', 'customers', 'customer_phones',
    'customer_addresses', 'marketing_consents', 'promotions', 'menu_categories',
    'menu_items', 'menu_item_variants', 'modifier_groups', 'modifier_choices',
    'menu_item_modifier_groups', 'modifier_choice_variant_prices', 'menu_item_included_choices',
    'customer_segments', 'customer_segment_memberships', 'customer_events',
    'customer_segment_evaluation_runs', 'order_idempotency', 'integration_destinations',
    'integration_outbox', 'integration_delivery_logs', 'payment_provider_settings',
    'payment_webhook_events', 'reward_grants', 'orders', 'order_items',
    'order_item_modifiers', 'order_discounts', 'order_events', 'payments', 'refunds',
    'delivery_assignments', 'kitchen_tickets', 'print_jobs', 'registers',
    'register_shifts', 'cash_movements', 'payment_terminals', 'store_phone_lines',
    'phone_calls', 'pos_drafts', 'pos_hardware_settings', 'pilot_checks'
  ];
  location_scoped_tables text[] := array[
    'store_settings', 'store_special_hours', 'orders', 'order_items',
    'order_item_modifiers', 'order_discounts', 'order_events', 'payments', 'refunds',
    'delivery_assignments', 'kitchen_tickets', 'print_jobs', 'registers',
    'register_shifts', 'cash_movements', 'payment_terminals', 'payment_webhook_events',
    'store_phone_lines', 'phone_calls', 'pos_drafts', 'pos_hardware_settings',
    'pilot_checks'
  ];
begin
  select id into waynes_workspace_id from public.workspaces where slug = 'waynes-pizza';
  select id into worcester_location_id from public.locations
  where workspace_id = waynes_workspace_id and slug = 'worcester';

  if waynes_workspace_id is null or worcester_location_id is null then
    raise exception 'Phase 2 requires the Phase 1 Wayne''s Pizza / Worcester seed';
  end if;

  foreach table_name in array workspace_scoped_tables loop
    execute format('update public.%I set workspace_id = $1 where workspace_id is null', table_name)
      using waynes_workspace_id;
  end loop;

  foreach table_name in array location_scoped_tables loop
    execute format('update public.%I set location_id = $1 where location_id is null', table_name)
      using worcester_location_id;
  end loop;

  update public.audit_log
  set workspace_id = waynes_workspace_id,
      location_id = worcester_location_id
  where workspace_id is null or location_id is null;

  foreach table_name in array workspace_scoped_tables loop
    execute format('select count(*) from public.%I where workspace_id is null', table_name)
      into unassigned_count;
    if unassigned_count <> 0 then
      raise exception 'Phase 2 backfill left % workspace-unassigned rows in %', unassigned_count, table_name;
    end if;
  end loop;

  foreach table_name in array location_scoped_tables loop
    execute format('select count(*) from public.%I where location_id is null', table_name)
      into unassigned_count;
    if unassigned_count <> 0 then
      raise exception 'Phase 2 backfill left % location-unassigned rows in %', unassigned_count, table_name;
    end if;
  end loop;

  select count(*) into unassigned_count
  from public.audit_log
  where workspace_id is null or location_id is null;
  if unassigned_count <> 0 then
    raise exception 'Phase 2 backfill left % unassigned audit rows', unassigned_count;
  end if;
end;
$$;

-- The leading tenant columns support the Phase 3 RLS predicates and the common
-- scoped reads without changing existing unique keys or application behavior.
create index if not exists store_settings_workspace_location_idx on public.store_settings(workspace_id, location_id);
create index if not exists store_special_hours_workspace_location_idx on public.store_special_hours(workspace_id, location_id);
create index if not exists customers_workspace_id_idx on public.customers(workspace_id);
create index if not exists customer_phones_workspace_id_idx on public.customer_phones(workspace_id);
create index if not exists customer_addresses_workspace_id_idx on public.customer_addresses(workspace_id);
create index if not exists marketing_consents_workspace_id_idx on public.marketing_consents(workspace_id);
create index if not exists promotions_workspace_id_idx on public.promotions(workspace_id);
create index if not exists menu_categories_workspace_id_idx on public.menu_categories(workspace_id);
create index if not exists menu_items_workspace_id_idx on public.menu_items(workspace_id);
create index if not exists menu_item_variants_workspace_id_idx on public.menu_item_variants(workspace_id);
create index if not exists modifier_groups_workspace_id_idx on public.modifier_groups(workspace_id);
create index if not exists modifier_choices_workspace_id_idx on public.modifier_choices(workspace_id);
create index if not exists menu_item_modifier_groups_workspace_id_idx on public.menu_item_modifier_groups(workspace_id);
create index if not exists customer_segments_workspace_id_idx on public.customer_segments(workspace_id);
create index if not exists orders_workspace_location_idx on public.orders(workspace_id, location_id, created_at desc);
create index if not exists payments_workspace_location_idx on public.payments(workspace_id, location_id, created_at desc);
create index if not exists phone_calls_workspace_location_idx on public.phone_calls(workspace_id, location_id, started_at desc);
create index if not exists print_jobs_workspace_location_idx on public.print_jobs(workspace_id, location_id, created_at desc);
create index if not exists pos_drafts_workspace_location_idx on public.pos_drafts(workspace_id, location_id, updated_at desc);
create index if not exists integration_outbox_workspace_id_idx on public.integration_outbox(workspace_id, created_at desc);
create index if not exists audit_log_workspace_location_idx on public.audit_log(workspace_id, location_id, occurred_at desc);

comment on column public.orders.workspace_id is 'Nullable during Phase 2 backfill; Phase 3 derives this from trusted workspace context.';
comment on column public.orders.location_id is 'Nullable during Phase 2 backfill; historical Wayne''s orders are assigned to Worcester.';
