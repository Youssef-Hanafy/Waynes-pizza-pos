-- Notifications contain identifiers/revisions only. Screen contents, answers,
-- signatures, payment settings and customer details remain behind existing RPCs.
create table public.pos_refresh_signals (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  topic text not null check (topic in ('runtime','display')),
  signal_key text not null default '',
  revision bigint not null default 1,
  primary key (workspace_id, topic, signal_key)
);
alter table public.pos_refresh_signals enable row level security;
revoke all on public.pos_refresh_signals from public, anon, authenticated;
grant select on public.pos_refresh_signals to authenticated;
create policy pos_refresh_signals_read on public.pos_refresh_signals for select to authenticated
  using (public.hanafy_has_workspace_permission(workspace_id, 'pos.access'));

create function public.wayne_notify_pos_refresh() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  scope_id uuid;
  topic_value text := tg_argv[0];
  key_value text := '';
begin
  if topic_value = 'display' then
    -- Reads update seen_at and heartbeats update published_at. Neither is a
    -- content change: notifying them would cause a read/publish feedback loop.
    if tg_op = 'UPDATE' and new.state = old.state and new.response = old.response and new.publisher_id = old.publisher_id then return null; end if;
    key_value := row_data->>'display_key';
  elsif tg_op = 'UPDATE' and (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return null;
  end if;
  scope_id := coalesce((row_data->>'workspace_id')::uuid, public.hanafy_legacy_workspace_id());
  insert into public.pos_refresh_signals(workspace_id, topic, signal_key)
    values (scope_id, topic_value, key_value)
    on conflict (workspace_id, topic, signal_key) do update
      set revision = public.pos_refresh_signals.revision + 1;
  return null;
end;
$$;
revoke all on function public.wayne_notify_pos_refresh() from public, anon, authenticated;
create trigger pos_display_refresh after insert or update on public.pos_customer_displays
  for each row execute function public.wayne_notify_pos_refresh('display');

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'menu_categories','menu_items','menu_item_variants','modifier_groups','modifier_choices',
    'menu_item_modifier_groups','modifier_choice_variant_prices','menu_item_included_choices','modifier_group_size_rules',
    'store_settings','workspace_settings','location_settings','pos_hardware_settings','payment_provider_settings',
    'location_hardware_configurations','location_payment_configurations','workspace_services','workspace_members'
  ] loop
    execute format('create trigger pos_runtime_refresh after insert or update or delete on public.%I for each row execute function public.wayne_notify_pos_refresh(''runtime'')', table_name);
  end loop;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.pos_refresh_signals;
  end if;
end;
$$;

-- A healthy event connection only needs a 30-second liveness read. Keep three
-- missed heartbeats of tolerance; old clients' faster heartbeats still work.
do $$
declare fn regprocedure;
begin
  foreach fn in array array['public.wayne_display_publish(text,jsonb)'::regprocedure,
    'public.wayne_display_publish(text,jsonb,text,boolean)'::regprocedure] loop
    execute replace(pg_get_functiondef(fn), 'interval ''15 seconds''', 'interval ''90 seconds''');
  end loop;
end;
$$;
