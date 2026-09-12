-- Wayne's Pizza POS — Phase 12: cash drawers, shifts and day close.
--
-- Master build sheet §21 and §34 Phase 12: register/drawer identity, shift open,
-- opening cash, cash sales, paid-ins, paid-outs, refunds, expected cash, counted
-- cash, variance, shift/day close, and a manager closeout report.
--
-- Every cash adjustment carries an actor and a reason, and every one of them is
-- written to the immutable audit log. Expected cash is derived from the ledger, never
-- typed in, so a drawer can only reconcile by being counted.
--
-- Every statement is idempotent so the migration is safe on a fresh database and on
-- the hosted project.

-- ============================================================================
-- Permission: who may manage registers, close another person's drawer, and read
-- the closeout report.
-- ============================================================================
insert into public.permissions (id, code, description)
values ('20000000-0000-4000-8000-000000000026', 'cash.manage', 'Manage registers, close any drawer, and read closeout reports')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code = 'cash.manage'
where role.code in ('owner', 'manager')
on conflict do nothing;

-- ============================================================================
-- Registers. A drawer has an identity so two tills never share a count.
-- ============================================================================
create table if not exists public.registers (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 120),
  location_note text not null default '' check (char_length(location_note) <= 200),
  active boolean not null default true,
  created_by_user_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists registers_label_idx on public.registers(lower(btrim(label)));

drop trigger if exists registers_set_updated_at on public.registers;
create trigger registers_set_updated_at
before update on public.registers
for each row execute function public.set_updated_at();

-- ============================================================================
-- Shifts. One open shift per register, ever.
-- ============================================================================
create table if not exists public.register_shifts (
  id uuid primary key default gen_random_uuid(),
  register_id uuid not null references public.registers(id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_by_user_id uuid references public.profiles(id) on delete restrict,
  opened_at timestamptz not null default now(),
  opening_cash_cents integer not null check (opening_cash_cents >= 0),
  closed_by_user_id uuid references public.profiles(id) on delete restrict,
  closed_at timestamptz,
  counted_cash_cents integer check (counted_cash_cents is null or counted_cash_cents >= 0),
  -- Everything below is a snapshot taken at close so a historical closeout never
  -- changes when later data arrives.
  expected_cash_cents integer,
  cash_sales_cents integer,
  cash_refunds_cents integer,
  paid_in_cents integer,
  paid_out_cents integer,
  driver_cash_cents integer,
  variance_cents integer,
  close_note text not null default '' check (char_length(close_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint register_shifts_closed_fields check (
    status = 'open'
    or (closed_at is not null and counted_cash_cents is not null and expected_cash_cents is not null))
);
create unique index if not exists register_shifts_one_open_idx
  on public.register_shifts(register_id) where status = 'open';
create index if not exists register_shifts_opened_idx on public.register_shifts(opened_at desc);

drop trigger if exists register_shifts_set_updated_at on public.register_shifts;
create trigger register_shifts_set_updated_at
before update on public.register_shifts
for each row execute function public.set_updated_at();

-- ============================================================================
-- Cash movements. Anything that moves money into or out of the drawer other than
-- a sale or a refund. Actor and reason are not optional.
-- ============================================================================
create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.register_shifts(id) on delete restrict,
  kind text not null check (kind in ('paid_in', 'paid_out', 'drop', 'driver_cash')),
  amount_cents integer not null check (amount_cents > 0),
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  actor_user_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists cash_movements_shift_idx on public.cash_movements(shift_id, created_at);

-- Cash taken and cash given back are tied to the drawer they passed through.
alter table public.payments add column if not exists shift_id uuid references public.register_shifts(id) on delete restrict;
alter table public.refunds add column if not exists shift_id uuid references public.register_shifts(id) on delete restrict;
alter table public.payments add column if not exists tendered_cents integer check (tendered_cents is null or tendered_cents >= 0);
alter table public.payments add column if not exists change_cents integer check (change_cents is null or change_cents >= 0);
create index if not exists payments_shift_idx on public.payments(shift_id) where shift_id is not null;
create index if not exists refunds_shift_idx on public.refunds(shift_id) where shift_id is not null;

-- ============================================================================
-- Row level security. Staff who work a drawer can see drawers; nobody writes
-- directly — every change goes through a permission-checked function.
-- ============================================================================
alter table public.registers enable row level security;
alter table public.register_shifts enable row level security;
alter table public.cash_movements enable row level security;

drop policy if exists registers_staff_select on public.registers;
create policy registers_staff_select on public.registers
  for select to authenticated
  using (public.wayne_has_permission('pos.access') or public.wayne_has_permission('cash.manage'));

drop policy if exists register_shifts_staff_select on public.register_shifts;
create policy register_shifts_staff_select on public.register_shifts
  for select to authenticated
  using (public.wayne_has_permission('cash.manage') or opened_by_user_id = auth.uid());

drop policy if exists cash_movements_staff_select on public.cash_movements;
create policy cash_movements_staff_select on public.cash_movements
  for select to authenticated
  using (public.wayne_has_permission('cash.manage')
    or exists (select 1 from public.register_shifts shift
      where shift.id = cash_movements.shift_id and shift.opened_by_user_id = auth.uid()));

revoke all on public.registers, public.register_shifts, public.cash_movements from anon, authenticated;
grant select on public.registers, public.register_shifts, public.cash_movements to authenticated;

drop trigger if exists registers_audit on public.registers;
create trigger registers_audit
after insert or update or delete on public.registers
for each row execute function public.wayne_audit_row_change('id', '');

-- ============================================================================
-- Expected cash, derived. Opening float, plus cash actually taken, minus cash
-- actually given back, plus paid-ins and driver hand-ins, minus paid-outs and drops.
-- ============================================================================
create or replace function public.wayne_shift_cash_totals(target_shift_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with shift as (select * from public.register_shifts where id = target_shift_id),
  sales as (
    select coalesce(sum(payment.amount_cents), 0)::integer cents
    from public.payments payment where payment.shift_id = target_shift_id
      and payment.method = 'cash' and payment.status = 'captured'),
  refunded as (
    select coalesce(sum(refund.amount_cents), 0)::integer cents
    from public.refunds refund where refund.shift_id = target_shift_id and refund.status = 'completed'),
  moved as (
    select
      coalesce(sum(amount_cents) filter (where kind = 'paid_in'), 0)::integer paid_in,
      coalesce(sum(amount_cents) filter (where kind = 'paid_out'), 0)::integer paid_out,
      coalesce(sum(amount_cents) filter (where kind = 'drop'), 0)::integer dropped,
      coalesce(sum(amount_cents) filter (where kind = 'driver_cash'), 0)::integer driver_cash
    from public.cash_movements where shift_id = target_shift_id)
  select jsonb_build_object(
    'opening_cash_cents', (select opening_cash_cents from shift),
    'cash_sales_cents', (select cents from sales),
    'cash_refunds_cents', (select cents from refunded),
    'paid_in_cents', (select paid_in from moved),
    'paid_out_cents', (select paid_out from moved),
    'drop_cents', (select dropped from moved),
    'driver_cash_cents', (select driver_cash from moved),
    'expected_cash_cents',
      (select opening_cash_cents from shift)
      + (select cents from sales)
      - (select cents from refunded)
      + (select paid_in from moved)
      + (select driver_cash from moved)
      - (select paid_out from moved)
      - (select dropped from moved));
$$;

-- ============================================================================
-- Registers
-- ============================================================================
create or replace function public.wayne_save_register(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved public.registers%rowtype; target_id uuid := nullif(payload ->> 'id', '')::uuid;
begin
  if not public.wayne_has_permission('cash.manage') then
    raise exception 'Cash management permission required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(payload ->> 'label', ''))) = 0 then
    raise exception 'Name the register' using errcode = '22023';
  end if;
  if target_id is null then
    insert into public.registers (label, location_note, active, created_by_user_id)
    values (btrim(payload ->> 'label'), btrim(coalesce(payload ->> 'location_note', '')),
      coalesce((payload ->> 'active')::boolean, true), auth.uid())
    returning * into saved;
  else
    update public.registers set
      label = btrim(payload ->> 'label'),
      location_note = btrim(coalesce(payload ->> 'location_note', location_note)),
      active = coalesce((payload ->> 'active')::boolean, active)
    where id = target_id returning * into saved;
    if not found then raise exception 'Register not found' using errcode = 'P0002'; end if;
  end if;
  return to_jsonb(saved);
end;
$$;

-- ============================================================================
-- Shift open and close
-- ============================================================================
create or replace function public.wayne_open_shift(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  register_row public.registers%rowtype;
  created public.register_shifts%rowtype;
  opening integer := coalesce((payload ->> 'opening_cash_cents')::integer, -1);
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  if opening < 0 then raise exception 'Count the opening cash before opening the drawer' using errcode = '22023'; end if;
  if opening > 1000000 then raise exception 'That opening float is too large. Check the count.' using errcode = '22023'; end if;

  select * into register_row from public.registers where id = (payload ->> 'register_id')::uuid and active;
  if not found then raise exception 'Register not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.register_shifts where register_id = register_row.id and status = 'open') then
    raise exception 'That register already has an open drawer' using errcode = '40001';
  end if;

  insert into public.register_shifts (register_id, opened_by_user_id, opening_cash_cents)
  values (register_row.id, auth.uid(), opening)
  returning * into created;

  perform public.wayne_write_audit('cash.shift_opened', 'register_shifts', created.id::text,
    'Opened ' || register_row.label || ' with ' || (opening / 100.0)::numeric(12,2)::text,
    '{}'::jsonb, jsonb_build_object('register', register_row.label, 'opening_cash_cents', opening));

  return to_jsonb(created);
end;
$$;

create or replace function public.wayne_record_cash_movement(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  shift_row public.register_shifts%rowtype;
  register_row public.registers%rowtype;
  created public.cash_movements%rowtype;
  kind_value text := payload ->> 'kind';
  amount integer := (payload ->> 'amount_cents')::integer;
  clean_reason text := nullif(btrim(coalesce(payload ->> 'reason', '')), '');
  totals jsonb;
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  if kind_value is null or kind_value not in ('paid_in', 'paid_out', 'drop', 'driver_cash') then
    raise exception 'Choose what kind of cash movement this is' using errcode = '22023';
  end if;
  if amount is null or amount <= 0 then raise exception 'Enter an amount greater than zero' using errcode = '22023'; end if;
  if clean_reason is null or char_length(clean_reason) not between 3 and 500 then
    raise exception 'A reason of at least 3 characters is required for every cash movement' using errcode = '22023';
  end if;

  select * into shift_row from public.register_shifts where id = (payload ->> 'shift_id')::uuid for update;
  if not found then raise exception 'Drawer not found' using errcode = 'P0002'; end if;
  if shift_row.status <> 'open' then raise exception 'That drawer is already closed' using errcode = '22023'; end if;
  if shift_row.opened_by_user_id is distinct from auth.uid() and not public.wayne_has_permission('cash.manage') then
    raise exception 'Only the person on this drawer or a manager can move cash' using errcode = '42501';
  end if;

  -- Money cannot leave a drawer that does not hold it.
  if kind_value in ('paid_out', 'drop') then
    totals := public.wayne_shift_cash_totals(shift_row.id);
    if amount > (totals ->> 'expected_cash_cents')::integer then
      raise exception 'That is more cash than the drawer is holding' using errcode = '22023';
    end if;
  end if;

  select * into register_row from public.registers where id = shift_row.register_id;

  insert into public.cash_movements (shift_id, kind, amount_cents, reason, actor_user_id)
  values (shift_row.id, kind_value, amount, clean_reason, auth.uid())
  returning * into created;

  perform public.wayne_write_audit('cash.' || kind_value, 'register_shifts', shift_row.id::text,
    replace(initcap(replace(kind_value, '_', ' ')), ' ', ' ') || ' of ' || (amount / 100.0)::numeric(12,2)::text
      || ' on ' || register_row.label || ': ' || clean_reason,
    '{}'::jsonb,
    jsonb_build_object('kind', kind_value, 'amount_cents', amount, 'reason', clean_reason, 'register', register_row.label));

  return to_jsonb(created);
end;
$$;

create or replace function public.wayne_close_shift(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  shift_row public.register_shifts%rowtype;
  register_row public.registers%rowtype;
  totals jsonb;
  counted integer := (payload ->> 'counted_cash_cents')::integer;
  expected integer;
  variance integer;
  clean_note text := btrim(coalesce(payload ->> 'close_note', ''));
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  if counted is null or counted < 0 then raise exception 'Count the drawer before closing it' using errcode = '22023'; end if;

  select * into shift_row from public.register_shifts where id = (payload ->> 'shift_id')::uuid for update;
  if not found then raise exception 'Drawer not found' using errcode = 'P0002'; end if;
  if shift_row.status = 'closed' then
    return to_jsonb(shift_row) || jsonb_build_object('duplicate', true);
  end if;
  if shift_row.opened_by_user_id is distinct from auth.uid() and not public.wayne_has_permission('cash.manage') then
    raise exception 'Only the person on this drawer or a manager can close it' using errcode = '42501';
  end if;
  if exists (select 1 from public.payments payment
    where payment.shift_id = shift_row.id and payment.status = 'pending') then
    raise exception 'A payment on this drawer has not finished. Settle it before closing.' using errcode = '40001';
  end if;

  totals := public.wayne_shift_cash_totals(shift_row.id);
  expected := (totals ->> 'expected_cash_cents')::integer;
  variance := counted - expected;
  -- A drawer that is out by real money must say why.
  if abs(variance) >= 500 and char_length(clean_note) < 3 then
    raise exception 'The drawer is out by more than five dollars. Explain the difference before closing.' using errcode = '22023';
  end if;

  select * into register_row from public.registers where id = shift_row.register_id;

  update public.register_shifts set
    status = 'closed',
    closed_by_user_id = auth.uid(),
    closed_at = now(),
    counted_cash_cents = counted,
    expected_cash_cents = expected,
    cash_sales_cents = (totals ->> 'cash_sales_cents')::integer,
    cash_refunds_cents = (totals ->> 'cash_refunds_cents')::integer,
    paid_in_cents = (totals ->> 'paid_in_cents')::integer,
    paid_out_cents = (totals ->> 'paid_out_cents')::integer + (totals ->> 'drop_cents')::integer,
    driver_cash_cents = (totals ->> 'driver_cash_cents')::integer,
    variance_cents = variance,
    close_note = clean_note
  where id = shift_row.id
  returning * into shift_row;

  perform public.wayne_write_audit('cash.shift_closed', 'register_shifts', shift_row.id::text,
    'Closed ' || register_row.label || ': counted ' || (counted / 100.0)::numeric(12,2)::text
      || ', expected ' || (expected / 100.0)::numeric(12,2)::text
      || ', variance ' || (variance / 100.0)::numeric(12,2)::text,
    jsonb_build_object('status', jsonb_build_object('from', 'open', 'to', 'closed')),
    totals || jsonb_build_object('counted_cash_cents', counted, 'variance_cents', variance,
      'register', register_row.label, 'close_note', clean_note));

  return to_jsonb(shift_row) || jsonb_build_object('duplicate', false);
end;
$$;

-- ============================================================================
-- Taking cash at the counter. This is what makes the drawer real: until now a
-- POS cash order was only a designation, never a recorded payment.
-- ============================================================================
create or replace function public.wayne_take_cash_payment(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  order_row public.orders%rowtype;
  shift_row public.register_shifts%rowtype;
  existing public.payments%rowtype;
  created public.payments%rowtype;
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  tendered integer := (payload ->> 'tendered_cents')::integer;
  due integer;
  change integer;
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  if char_length(request_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;

  select * into existing from public.payments where idempotency_key = request_key;
  if found then
    return jsonb_build_object('payment_id', existing.id, 'duplicate', true,
      'change_cents', coalesce(existing.change_cents, 0));
  end if;

  select * into shift_row from public.register_shifts where id = (payload ->> 'shift_id')::uuid for update;
  if not found then raise exception 'Open a drawer before taking cash' using errcode = 'P0002'; end if;
  if shift_row.status <> 'open' then raise exception 'That drawer is already closed' using errcode = '22023'; end if;

  select * into order_row from public.orders where id = (payload ->> 'order_id')::uuid for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if order_row.status = 'cancelled' then raise exception 'This order was cancelled' using errcode = '22023'; end if;
  if order_row.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = order_row.id and status in ('pending', 'authorized', 'captured')) then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;

  due := order_row.total_cents;
  if tendered is null or tendered < due then
    raise exception 'The cash handed over is less than the amount due' using errcode = '22023';
  end if;
  if tendered > due + 50000 then
    raise exception 'That is far more cash than the amount due. Check the figure.' using errcode = '22023';
  end if;
  change := tendered - due;

  insert into public.payments (order_id, provider, provider_payment_id, method, amount_cents, status,
    idempotency_key, shift_id, tendered_cents, change_cents, captured_at, created_by_user_id, metadata)
  values (order_row.id, 'cash', 'cash-' || request_key, 'cash', due, 'captured',
    request_key, shift_row.id, tendered, change, now(), auth.uid(),
    jsonb_build_object('entry', 'counter', 'register_shift', shift_row.id))
  returning * into created;

  update public.orders set payment_status = 'paid', payment_method = 'cash' where id = order_row.id;

  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (order_row.id, 'payment.captured', auth.uid(),
    jsonb_build_object('payment_id', created.id, 'provider', 'cash', 'amount_cents', due,
      'tendered_cents', tendered, 'change_cents', change, 'shift_id', shift_row.id));

  perform public.wayne_write_audit('cash.payment_taken', 'orders', order_row.id::text,
    'Took ' || (due / 100.0)::numeric(12,2)::text || ' cash for order ' || order_row.order_number,
    '{}'::jsonb,
    jsonb_build_object('order_number', order_row.order_number, 'amount_cents', due,
      'tendered_cents', tendered, 'change_cents', change, 'shift_id', shift_row.id));

  return jsonb_build_object('payment_id', created.id, 'duplicate', false,
    'amount_cents', due, 'tendered_cents', tendered, 'change_cents', change);
end;
$$;

-- ============================================================================
-- What the POS needs: the drawer this person is on, and its running totals.
-- ============================================================================
create or replace function public.wayne_pos_drawer()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare shift_row public.register_shifts%rowtype;
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  select * into shift_row from public.register_shifts
  where status = 'open' and (opened_by_user_id = auth.uid() or public.wayne_has_permission('cash.manage'))
  order by opened_at desc limit 1;

  return jsonb_build_object(
    'registers', coalesce((
      select jsonb_agg(jsonb_build_object('id', register.id, 'label', register.label,
        'open', exists (select 1 from public.register_shifts shift where shift.register_id = register.id and shift.status = 'open'))
        order by register.label)
      from public.registers register where register.active), '[]'::jsonb),
    'shift', case when shift_row.id is null then null else
      to_jsonb(shift_row)
      || public.wayne_shift_cash_totals(shift_row.id)
      || jsonb_build_object(
        'register_label', (select label from public.registers where id = shift_row.register_id),
        'opened_by_name', (select display_name from public.profiles where id = shift_row.opened_by_user_id),
        'movements', coalesce((
          select jsonb_agg(jsonb_build_object('id', movement.id, 'kind', movement.kind,
            'amount_cents', movement.amount_cents, 'reason', movement.reason, 'created_at', movement.created_at,
            'actor_name', profile.display_name) order by movement.created_at desc)
          from public.cash_movements movement
          left join public.profiles profile on profile.id = movement.actor_user_id
          where movement.shift_id = shift_row.id), '[]'::jsonb))
    end);
end;
$$;

-- ============================================================================
-- Closeout report (§21: "Owner/manager receives a closeout report").
-- ============================================================================
create or replace function public.wayne_cash_closeout(from_date date, through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  store_timezone text;
  window_start timestamptz;
  window_end timestamptz;
begin
  if not (public.wayne_has_permission('cash.manage') or public.wayne_has_permission('reports.view')) then
    raise exception 'Cash management permission required' using errcode = '42501';
  end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 3660 then
    raise exception 'Invalid report date range' using errcode = '22023';
  end if;
  select settings.timezone into store_timezone from public.store_settings settings where settings.id = true;
  window_start := from_date::timestamp at time zone store_timezone;
  window_end := (through_date + 1)::timestamp at time zone store_timezone;

  return (
    with scoped as (
      select shift.*, register.label register_label,
        opened.display_name opened_by_name, closed.display_name closed_by_name,
        case when shift.status = 'open' then public.wayne_shift_cash_totals(shift.id) end live_totals
      from public.register_shifts shift
      join public.registers register on register.id = shift.register_id
      left join public.profiles opened on opened.id = shift.opened_by_user_id
      left join public.profiles closed on closed.id = shift.closed_by_user_id
      where shift.opened_at >= window_start and shift.opened_at < window_end
    )
    select jsonb_build_object(
      'totals', jsonb_build_object(
        'shift_count', (select count(*)::integer from scoped),
        'open_count', (select count(*)::integer from scoped where status = 'open'),
        'opening_cash_cents', (select coalesce(sum(opening_cash_cents), 0)::bigint from scoped),
        'cash_sales_cents', (select coalesce(sum(coalesce(cash_sales_cents, (live_totals ->> 'cash_sales_cents')::integer)), 0)::bigint from scoped),
        'cash_refunds_cents', (select coalesce(sum(coalesce(cash_refunds_cents, (live_totals ->> 'cash_refunds_cents')::integer)), 0)::bigint from scoped),
        'paid_in_cents', (select coalesce(sum(coalesce(paid_in_cents, (live_totals ->> 'paid_in_cents')::integer)), 0)::bigint from scoped),
        'paid_out_cents', (select coalesce(sum(coalesce(paid_out_cents, (live_totals ->> 'paid_out_cents')::integer + (live_totals ->> 'drop_cents')::integer)), 0)::bigint from scoped),
        'driver_cash_cents', (select coalesce(sum(coalesce(driver_cash_cents, (live_totals ->> 'driver_cash_cents')::integer)), 0)::bigint from scoped),
        'counted_cash_cents', (select coalesce(sum(counted_cash_cents), 0)::bigint from scoped where status = 'closed'),
        'expected_cash_cents', (select coalesce(sum(expected_cash_cents), 0)::bigint from scoped where status = 'closed'),
        'variance_cents', (select coalesce(sum(variance_cents), 0)::bigint from scoped where status = 'closed'),
        'over_count', (select count(*)::integer from scoped where status = 'closed' and variance_cents > 0),
        'short_count', (select count(*)::integer from scoped where status = 'closed' and variance_cents < 0)),
      'shifts', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'register_label', register_label, 'status', status,
          'opened_by_name', coalesce(opened_by_name, 'Removed staff'), 'opened_at', opened_at,
          'closed_by_name', closed_by_name, 'closed_at', closed_at,
          'opening_cash_cents', opening_cash_cents,
          'cash_sales_cents', coalesce(cash_sales_cents, (live_totals ->> 'cash_sales_cents')::integer),
          'cash_refunds_cents', coalesce(cash_refunds_cents, (live_totals ->> 'cash_refunds_cents')::integer),
          'paid_in_cents', coalesce(paid_in_cents, (live_totals ->> 'paid_in_cents')::integer),
          'paid_out_cents', coalesce(paid_out_cents, (live_totals ->> 'paid_out_cents')::integer + (live_totals ->> 'drop_cents')::integer),
          'driver_cash_cents', coalesce(driver_cash_cents, (live_totals ->> 'driver_cash_cents')::integer),
          'expected_cash_cents', coalesce(expected_cash_cents, (live_totals ->> 'expected_cash_cents')::integer),
          'counted_cash_cents', counted_cash_cents, 'variance_cents', variance_cents, 'close_note', close_note)
          order by opened_at desc)
        from scoped), '[]'::jsonb),
      'movements', coalesce((
        select jsonb_agg(jsonb_build_object('register_label', scoped.register_label, 'kind', movement.kind,
          'amount_cents', movement.amount_cents, 'reason', movement.reason, 'created_at', movement.created_at,
          'actor_name', coalesce(profile.display_name, 'Removed staff')) order by movement.created_at desc)
        from public.cash_movements movement
        join scoped on scoped.id = movement.shift_id
        left join public.profiles profile on profile.id = movement.actor_user_id), '[]'::jsonb)));
end;
$$;

-- ============================================================================
-- Privileges
-- ============================================================================
do $$
declare
  fn text;
  staff_functions constant text[] := array[
    'public.wayne_save_register(jsonb)',
    'public.wayne_open_shift(jsonb)',
    'public.wayne_record_cash_movement(jsonb)',
    'public.wayne_close_shift(jsonb)',
    'public.wayne_take_cash_payment(jsonb)',
    'public.wayne_pos_drawer()',
    'public.wayne_cash_closeout(date, date)'];
  internal_functions constant text[] := array['public.wayne_shift_cash_totals(uuid)'];
  has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  foreach fn in array staff_functions || internal_functions loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    if has_service_role then execute format('grant execute on function %s to service_role', fn); end if;
  end loop;
  foreach fn in array staff_functions loop
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

comment on table public.register_shifts is
  'One cash drawer session. Expected cash is derived from the ledger and snapshotted at close, so a historical closeout never changes when later data arrives.';
comment on function public.wayne_take_cash_payment(jsonb) is
  'Records cash actually taken at the counter against an open drawer, marks the order paid, and returns the change due.';
