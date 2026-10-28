-- Tips are saved the moment they are typed (owner, 2026-10-28: "he enters tip
-- amounts … exits … later when returning to finalize or close out the tips,
-- the amounts he previously entered are missing").
--
-- Before this, a tip typed in POS → Tips or Deliveries → cash-out lived only in
-- the screen's memory until Charge / Cash out was pressed, so leaving the
-- screen, a call auto-opening the Phone screen, or a page reload erased it.
--
-- pos_tip_drafts keeps the tip written on each slip, per order, until the card
-- is charged / the driver is cashed out.  It is ONLY a saved entry: nothing here
-- charges a card or records a tip on an order — Charge / Cash out still does
-- that, exactly as before (captures keep their fixed idempotency keys).
--
--   * newest edit wins: an older copy (a register that was offline, a second
--     register) never overwrites a newer one (client_updated_at, capped to
--     "now + 2 minutes" so a tablet with a wrong clock can't lock a tip)
--   * read back only while the order still waits for its tip (card still
--     held, or still on a driver's run that wasn't cashed out)
--   * no table access for app roles at all; only these functions
--
-- Rollback (safe at any time, nothing else depends on it):
--   drop function if exists public.wayne_pos_tip_drafts();
--   drop function if exists public.wayne_pos_save_tip_drafts(jsonb);
--   drop function if exists public.wayne_pos_clear_tip_drafts(uuid[]);
--   drop table if exists public.pos_tip_drafts;

create table if not exists public.pos_tip_drafts (
  order_id uuid primary key references public.orders(id) on delete cascade,
  workspace_id uuid,
  tip_cents integer not null check (tip_cents between 0 and 100000),
  raw text not null default '' check (char_length(raw) <= 20),
  screen text not null default 'tips' check (screen in ('tips', 'delivery')),
  client_updated_at timestamptz not null,
  device_id text not null default '' check (char_length(device_id) <= 80),
  terminal text not null default '' check (char_length(terminal) <= 60),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create index if not exists pos_tip_drafts_workspace_idx on public.pos_tip_drafts (workspace_id);

alter table public.pos_tip_drafts enable row level security;
revoke all on table public.pos_tip_drafts from public, anon, authenticated;

-- Is this order still waiting for the tip on its slip?
create or replace function public.wayne_pos_tip_draft_open(target_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
      select 1 from public.payments p
       where p.order_id = target_order_id and p.status = 'authorized' and p.method = 'card'
    )
    or exists (
      select 1 from public.delivery_assignments a
       where a.order_id = target_order_id and a.status <> 'released' and a.cashout_id is null
    );
$$;

create or replace function public.wayne_pos_tip_drafts()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'order_id', d.order_id, 'tip_cents', d.tip_cents, 'raw', d.raw, 'screen', d.screen,
      'client_updated_at', d.client_updated_at, 'terminal', d.terminal, 'updated_at', d.updated_at
    ) order by d.updated_at)
    from public.pos_tip_drafts d
    join public.orders o on o.id = d.order_id
    where o.status not in ('cancelled', 'draft')
      and public.wayne_has_permission(o.workspace_id, 'pos.access')
      and public.wayne_pos_tip_draft_open(d.order_id)
  ), '[]'::jsonb);
end;
$$;

-- drafts: [{ order_id, tip_cents, raw, screen, client_updated_at, device_id, terminal }]
-- Returns every listed order's saved value after the save: applied=false means
-- a newer value was already there (that newer value is what is returned).
create or replace function public.wayne_pos_save_tip_drafts(drafts jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  entry jsonb;
  target_order public.orders%rowtype;
  cents integer;
  stamp timestamptz;
  did_apply boolean;
  results jsonb := '[]'::jsonb;
  saved public.pos_tip_drafts%rowtype;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if drafts is null or jsonb_typeof(drafts) <> 'array' then raise exception 'Send a list of tips' using errcode = '22023'; end if;
  if jsonb_array_length(drafts) > 200 then raise exception 'Too many tips at once' using errcode = '22023'; end if;

  for entry in select value from jsonb_array_elements(drafts) loop
    select * into target_order from public.orders where id = nullif(entry ->> 'order_id', '')::uuid;
    if not found then continue; end if;
    if not public.wayne_has_permission(target_order.workspace_id, 'pos.access') then continue; end if;
    cents := coalesce((entry ->> 'tip_cents')::integer, 0);
    if cents < 0 or cents > 100000 then raise exception 'A tip must be between $0 and $1,000' using errcode = '22023'; end if;
    stamp := least(coalesce((entry ->> 'client_updated_at')::timestamptz, now()), now() + interval '2 minutes');

    insert into public.pos_tip_drafts as d (order_id, workspace_id, tip_cents, raw, screen, client_updated_at, device_id, terminal, updated_by, updated_at)
    values (
      target_order.id, target_order.workspace_id, cents, left(coalesce(entry ->> 'raw', ''), 20),
      case when entry ->> 'screen' = 'delivery' then 'delivery' else 'tips' end,
      stamp, left(coalesce(entry ->> 'device_id', ''), 80), left(coalesce(entry ->> 'terminal', ''), 60), auth.uid(), now()
    )
    on conflict (order_id) do update set
      tip_cents = excluded.tip_cents, raw = excluded.raw, screen = excluded.screen,
      client_updated_at = excluded.client_updated_at, device_id = excluded.device_id,
      terminal = excluded.terminal, updated_by = excluded.updated_by, updated_at = now()
    where d.client_updated_at <= excluded.client_updated_at
    returning true into did_apply;

    select * into saved from public.pos_tip_drafts where order_id = target_order.id;
    results := results || jsonb_build_object(
      'order_id', saved.order_id, 'tip_cents', saved.tip_cents, 'raw', saved.raw, 'screen', saved.screen,
      'client_updated_at', saved.client_updated_at, 'terminal', saved.terminal, 'updated_at', saved.updated_at,
      'applied', coalesce(did_apply, false)
    );
    did_apply := null;
  end loop;
  return results;
end;
$$;

-- After Charge / Cash out: the entries for the orders that were charged go.
create or replace function public.wayne_pos_clear_tip_drafts(order_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  removed integer;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  delete from public.pos_tip_drafts d
   using public.orders o
   where o.id = d.order_id and d.order_id = any(coalesce(order_ids, '{}'::uuid[]))
     and public.wayne_has_permission(o.workspace_id, 'pos.access');
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.wayne_pos_tip_draft_open(uuid) from public, anon, authenticated;
revoke all on function public.wayne_pos_tip_drafts() from public, anon;
revoke all on function public.wayne_pos_save_tip_drafts(jsonb) from public, anon;
revoke all on function public.wayne_pos_clear_tip_drafts(uuid[]) from public, anon;
grant execute on function public.wayne_pos_tip_drafts() to authenticated;
grant execute on function public.wayne_pos_save_tip_drafts(jsonb) to authenticated;
grant execute on function public.wayne_pos_clear_tip_drafts(uuid[]) to authenticated;
