-- Counter-device diagnostics (2026-10-08).
--
-- The Stripe Reader M2 runs through the POS Android app on an Elo tablet,
-- where nobody can open developer tools.  Every step of connecting the reader
-- and taking a card (and any script error on the POS page) is written here by
-- /api/pos/device-log and by the Stripe Terminal routes, so a failure at the
-- counter can be read back exactly instead of guessed at.
--
-- Written only by the server (service role).  Owners/managers with
-- hardware.manage can read their own workspace's rows.  Rows older than 30
-- days are pruned on insert.

create table if not exists public.pos_device_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id uuid,
  source text not null default 'client' check (source in ('client', 'server')),
  kind text not null check (char_length(kind) between 1 and 80),
  message text not null default '' check (char_length(message) <= 2000),
  detail jsonb not null default '{}'::jsonb,
  user_agent text check (char_length(user_agent) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists pos_device_events_workspace_created_idx
  on public.pos_device_events (workspace_id, created_at desc);

alter table public.pos_device_events enable row level security;

drop policy if exists pos_device_events_manager_read on public.pos_device_events;
create policy pos_device_events_manager_read on public.pos_device_events
  for select to authenticated
  using (public.hanafy_has_workspace_permission(workspace_id, 'hardware.manage') or public.hanafy_has_platform_access());

revoke all on public.pos_device_events from anon;
grant select on public.pos_device_events to authenticated;

comment on table public.pos_device_events is
  'Diagnostics from counter devices (Stripe Reader M2 steps, POS page script errors). Server-written; 30-day retention.';
