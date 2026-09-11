-- Wayne's Pizza POS — Phase 10 only: Delivery Driver Module.
--
-- Master build sheet §19 (delivery operations) and §34 Phase 10:
--   driver role/screen, assign delivery, accept, pickup, navigation hand-off,
--   delivered, cash collected, owner delivery metrics.
--
-- Card-at-door stays disabled: a driver may record CASH only. Phase 11 adds the
-- card-present flow once the processor and hardware are confirmed.
--
-- Every statement is idempotent so the migration is safe on a fresh database and on
-- the hosted project.

-- ============================================================================
-- Permission: who may dispatch (assign / reassign / release) a delivery
-- ============================================================================
insert into public.permissions (id, code, description)
values ('20000000-0000-4000-8000-000000000024', 'delivery.dispatch', 'Assign and release delivery orders to drivers')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code = 'delivery.dispatch'
where role.code in ('owner', 'manager', 'cashier')
on conflict do nothing;

-- ============================================================================
-- Assignment ledger. One active assignment per order; history is kept forever so
-- "who had this order, when, and what cash came back" is always answerable.
-- ============================================================================
create table if not exists public.delivery_assignments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  driver_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'assigned' check (status in ('assigned', 'accepted', 'picked_up', 'delivered', 'released')),
  assigned_by_user_id uuid references public.profiles(id) on delete restrict,
  self_claimed boolean not null default false,
  assigned_at timestamptz not null default now(),
  accepted_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  released_at timestamptz,
  release_reason text not null default '' check (char_length(release_reason) <= 500),
  amount_due_cents integer not null default 0 check (amount_due_cents >= 0),
  cash_collected_cents integer not null default 0 check (cash_collected_cents >= 0),
  cash_collected_at timestamptz,
  delivery_note text not null default '' check (char_length(delivery_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists delivery_assignments_active_order_idx
  on public.delivery_assignments(order_id) where status <> 'released';
create index if not exists delivery_assignments_driver_idx
  on public.delivery_assignments(driver_id, status, assigned_at desc);
create index if not exists delivery_assignments_delivered_idx
  on public.delivery_assignments(delivered_at) where delivered_at is not null;

drop trigger if exists delivery_assignments_set_updated_at on public.delivery_assignments;
create trigger delivery_assignments_set_updated_at
before update on public.delivery_assignments
for each row execute function public.set_updated_at();

alter table public.delivery_assignments enable row level security;

drop policy if exists delivery_assignments_dispatch_select on public.delivery_assignments;
create policy delivery_assignments_dispatch_select on public.delivery_assignments
  for select to authenticated
  using (public.wayne_has_permission('delivery.dispatch') or public.wayne_has_permission('reports.view'));

drop policy if exists delivery_assignments_driver_select on public.delivery_assignments;
create policy delivery_assignments_driver_select on public.delivery_assignments
  for select to authenticated
  using (driver_id = auth.uid());

revoke all on public.delivery_assignments from anon, authenticated;
grant select on public.delivery_assignments to authenticated;

comment on table public.delivery_assignments is
  'Delivery hand-off ledger: dispatch assigns, the driver accepts/picks up/delivers, and cash collected at the door is recorded here and mirrored into payments and the audit log.';

-- ============================================================================
-- Shared helper: what a driver or dispatcher must see for one delivery order
-- ============================================================================
create or replace function public.wayne_delivery_order_payload(order_row public.orders)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'order_id', order_row.id,
    'order_number', order_row.order_number,
    'customer_name', order_row.customer_name_snapshot,
    'customer_phone', order_row.customer_phone_snapshot,
    'address', coalesce(order_row.delivery_address_snapshot, '{}'::jsonb),
    'delivery_instructions', coalesce(order_row.delivery_address_snapshot ->> 'delivery_instructions', ''),
    'order_instructions', order_row.special_instructions,
    'status', order_row.status,
    'payment_method', order_row.payment_method,
    'payment_status', order_row.payment_status,
    'total_cents', order_row.total_cents,
    'amount_due_cents', case when order_row.payment_status = 'paid' then 0 else order_row.total_cents end,
    'placed_at', order_row.placed_at,
    'promised_at', order_row.promised_at,
    'ready_at', order_row.ready_at,
    'out_for_delivery_at', order_row.out_for_delivery_at,
    'completed_at', order_row.completed_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', item.item_name_snapshot, 'variant', item.variant_name_snapshot, 'quantity', item.quantity) order by item.created_at)
      from public.order_items item where item.order_id = order_row.id), '[]'::jsonb)
  );
$$;

create or replace function public.wayne_delivery_assignment_payload(assignment public.delivery_assignments)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'assignment_id', assignment.id,
    'driver_id', assignment.driver_id,
    'driver_name', (select profile.display_name from public.profiles profile where profile.id = assignment.driver_id),
    'assignment_status', assignment.status,
    'self_claimed', assignment.self_claimed,
    'assigned_at', assignment.assigned_at,
    'accepted_at', assignment.accepted_at,
    'picked_up_at', assignment.picked_up_at,
    'delivered_at', assignment.delivered_at,
    'cash_collected_cents', assignment.cash_collected_cents,
    'amount_due_cents', assignment.amount_due_cents,
    'delivery_note', assignment.delivery_note
  );
$$;

-- ============================================================================
-- Dispatch board — counter/manager view of every live delivery
-- ============================================================================
create or replace function public.wayne_delivery_dispatch()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare open_statuses constant text[] := array['placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery'];
begin
  if not public.wayne_has_permission('delivery.dispatch') then
    raise exception 'Delivery dispatch permission required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'drivers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id', profile.id,
        'display_name', profile.display_name,
        'active_count', (select count(*) from public.delivery_assignments assignment
          where assignment.driver_id = profile.id and assignment.status in ('assigned', 'accepted', 'picked_up'))
      ) order by profile.display_name)
      from public.profiles profile
      join public.roles role on role.id = profile.role_id and role.active
      join public.role_permissions role_permission on role_permission.role_id = role.id
      join public.permissions permission on permission.id = role_permission.permission_id and permission.code = 'driver.access'
      where profile.active), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(entry order by entry ->> 'placed_at')
      from (
        select public.wayne_delivery_order_payload(order_row)
          || jsonb_build_object('assignment', (
              select public.wayne_delivery_assignment_payload(assignment)
              from public.delivery_assignments assignment
              where assignment.order_id = order_row.id and assignment.status <> 'released'
              limit 1)) entry
        from public.orders order_row
        where order_row.fulfillment_type = 'delivery'
          and (order_row.status = any(open_statuses)
            or (order_row.status = 'completed' and order_row.completed_at > now() - interval '3 hours'))
          and coalesce(order_row.placed_at, order_row.created_at) > now() - interval '2 days'
      ) rows), '[]'::jsonb)
  );
end;
$$;

-- ============================================================================
-- Assign / reassign / release
-- ============================================================================
create or replace function public.wayne_assign_delivery(target_order_id uuid, target_driver_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  order_row public.orders%rowtype;
  driver_row public.profiles%rowtype;
  existing public.delivery_assignments%rowtype;
  new_assignment public.delivery_assignments%rowtype;
  open_statuses constant text[] := array['placed', 'accepted', 'in_kitchen', 'ready', 'out_for_delivery'];
begin
  if not public.wayne_has_permission('delivery.dispatch') then
    raise exception 'Delivery dispatch permission required' using errcode = '42501';
  end if;

  select * into order_row from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if order_row.fulfillment_type <> 'delivery' then raise exception 'Only delivery orders can be assigned to a driver' using errcode = '22023'; end if;
  if not (order_row.status = any(open_statuses)) then raise exception 'Only open orders can be assigned to a driver' using errcode = '22023'; end if;

  select profile.* into driver_row from public.profiles profile where profile.id = target_driver_id and profile.active;
  if not found then raise exception 'Driver not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.profiles profile
    join public.roles role on role.id = profile.role_id and role.active
    join public.role_permissions role_permission on role_permission.role_id = role.id
    join public.permissions permission on permission.id = role_permission.permission_id and permission.code = 'driver.access'
    where profile.id = target_driver_id) then
    raise exception 'That staff member does not have driver access' using errcode = '22023';
  end if;

  select * into existing from public.delivery_assignments
    where order_id = order_row.id and status <> 'released' for update;
  if found and existing.driver_id = target_driver_id then
    return jsonb_build_object('assignment_id', existing.id, 'duplicate', true);
  end if;
  if found then
    if existing.status = 'delivered' then raise exception 'This delivery is already completed' using errcode = '22023'; end if;
    update public.delivery_assignments
      set status = 'released', released_at = now(),
          release_reason = 'Reassigned to ' || driver_row.display_name
      where id = existing.id;
    insert into public.order_events (order_id, event_type, actor_user_id, metadata)
    values (order_row.id, 'delivery.released', auth.uid(),
      jsonb_build_object('driver_id', existing.driver_id, 'reason', 'reassigned', 'assignment_status_at_release', existing.status));
  end if;

  insert into public.delivery_assignments (order_id, driver_id, assigned_by_user_id, amount_due_cents)
  values (order_row.id, target_driver_id, auth.uid(),
    case when order_row.payment_status = 'paid' then 0 else order_row.total_cents end)
  returning * into new_assignment;

  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (order_row.id, 'delivery.assigned', auth.uid(),
    jsonb_build_object('driver_id', target_driver_id, 'driver_name', driver_row.display_name,
      'reassigned_from', case when existing.id is null then null else existing.driver_id end));

  perform public.wayne_write_audit('delivery.assigned', 'orders', order_row.id::text,
    'Assigned order ' || order_row.order_number || ' to ' || driver_row.display_name,
    jsonb_build_object('driver', jsonb_build_object('from', existing.driver_id, 'to', target_driver_id)),
    jsonb_build_object('order_number', order_row.order_number, 'amount_due_cents', new_assignment.amount_due_cents));

  return jsonb_build_object('assignment_id', new_assignment.id, 'duplicate', false);
end;
$$;

create or replace function public.wayne_release_delivery(target_order_id uuid, reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing public.delivery_assignments%rowtype;
  order_row public.orders%rowtype;
  clean_reason text := nullif(btrim(coalesce(reason, '')), '');
begin
  if not public.wayne_has_permission('delivery.dispatch') then
    raise exception 'Delivery dispatch permission required' using errcode = '42501';
  end if;
  if clean_reason is null or char_length(clean_reason) not between 3 and 500 then
    raise exception 'A release reason of at least 3 characters is required' using errcode = '22023';
  end if;

  select * into order_row from public.orders where id = target_order_id;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  select * into existing from public.delivery_assignments
    where order_id = target_order_id and status <> 'released' for update;
  if not found then raise exception 'This order is not assigned to a driver' using errcode = 'P0002'; end if;
  if existing.status = 'delivered' then raise exception 'A delivered order cannot be released' using errcode = '22023'; end if;

  update public.delivery_assignments
    set status = 'released', released_at = now(), release_reason = clean_reason
    where id = existing.id;

  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (order_row.id, 'delivery.released', auth.uid(),
    jsonb_build_object('driver_id', existing.driver_id, 'reason', clean_reason, 'assignment_status_at_release', existing.status));

  perform public.wayne_write_audit('delivery.released', 'orders', order_row.id::text,
    'Released order ' || order_row.order_number || ' from its driver: ' || clean_reason,
    jsonb_build_object('assignment_status', jsonb_build_object('from', existing.status, 'to', 'released')),
    jsonb_build_object('order_number', order_row.order_number, 'driver_id', existing.driver_id));

  return jsonb_build_object('released', true);
end;
$$;

-- ============================================================================
-- Driver board — only what the signed-in driver is allowed to see
-- ============================================================================
create or replace function public.wayne_driver_board()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('driver.access') then
    raise exception 'Driver access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'assignments', coalesce((
      select jsonb_agg(entry order by entry ->> 'assigned_at')
      from (
        select public.wayne_delivery_order_payload(order_row) || public.wayne_delivery_assignment_payload(assignment) entry
        from public.delivery_assignments assignment
        join public.orders order_row on order_row.id = assignment.order_id
        where assignment.driver_id = auth.uid()
          and (assignment.status in ('assigned', 'accepted', 'picked_up')
            or (assignment.status = 'delivered' and assignment.delivered_at > now() - interval '3 hours'))
          and order_row.status <> 'cancelled'
      ) rows), '[]'::jsonb),
    -- Unclaimed, ready-to-go deliveries. Address and phone stay hidden until claimed.
    'available', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', order_row.id, 'order_number', order_row.order_number,
        'customer_name', order_row.customer_name_snapshot,
        'city', coalesce(order_row.delivery_address_snapshot ->> 'city', ''),
        'postal_code', coalesce(order_row.delivery_address_snapshot ->> 'postal_code', ''),
        'total_cents', order_row.total_cents,
        'amount_due_cents', case when order_row.payment_status = 'paid' then 0 else order_row.total_cents end,
        'ready_at', order_row.ready_at, 'promised_at', order_row.promised_at) order by order_row.ready_at, order_row.placed_at)
      from public.orders order_row
      where order_row.fulfillment_type = 'delivery' and order_row.status = 'ready'
        and not exists (select 1 from public.delivery_assignments assignment
          where assignment.order_id = order_row.id and assignment.status <> 'released')), '[]'::jsonb)
  );
end;
$$;

create or replace function public.wayne_driver_claim_delivery(target_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  order_row public.orders%rowtype;
  new_assignment public.delivery_assignments%rowtype;
  driver_name text;
begin
  if not public.wayne_has_permission('driver.access') then
    raise exception 'Driver access required' using errcode = '42501';
  end if;
  select * into order_row from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if order_row.fulfillment_type <> 'delivery' or order_row.status <> 'ready' then
    raise exception 'Only a ready delivery order can be claimed' using errcode = '22023';
  end if;
  if exists (select 1 from public.delivery_assignments assignment
    where assignment.order_id = order_row.id and assignment.status <> 'released') then
    raise exception 'Another driver already has this order' using errcode = '40001';
  end if;

  insert into public.delivery_assignments (order_id, driver_id, status, self_claimed, accepted_at, amount_due_cents)
  values (order_row.id, auth.uid(), 'accepted', true, now(),
    case when order_row.payment_status = 'paid' then 0 else order_row.total_cents end)
  returning * into new_assignment;

  select profile.display_name into driver_name from public.profiles profile where profile.id = auth.uid();
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (order_row.id, 'delivery.assigned', auth.uid(), jsonb_build_object('driver_id', auth.uid(), 'driver_name', driver_name, 'self_claimed', true));
  perform public.wayne_write_audit('delivery.assigned', 'orders', order_row.id::text,
    'Driver ' || coalesce(driver_name, 'Unknown staff') || ' claimed order ' || order_row.order_number,
    '{}'::jsonb, jsonb_build_object('order_number', order_row.order_number, 'self_claimed', true));

  return jsonb_build_object('assignment_id', new_assignment.id);
end;
$$;

-- ============================================================================
-- Driver workflow: accept -> picked up -> delivered (+ cash at the door)
-- ============================================================================
create or replace function public.wayne_driver_update_delivery(
  target_order_id uuid, action text, cash_cents integer default null, note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  assignment public.delivery_assignments%rowtype;
  order_row public.orders%rowtype;
  clean_note text := left(btrim(coalesce(note, '')), 500);
  amount_due integer;
  collected integer;
  driver_name text;
  previous_method text;
begin
  if not public.wayne_has_permission('driver.access') then
    raise exception 'Driver access required' using errcode = '42501';
  end if;
  if action is null or action not in ('accept', 'picked_up', 'delivered') then
    raise exception 'Invalid delivery action' using errcode = '22023';
  end if;

  select * into assignment from public.delivery_assignments
    where order_id = target_order_id and driver_id = auth.uid() and status <> 'released' for update;
  if not found then raise exception 'This delivery is not assigned to you' using errcode = '42501'; end if;
  select * into order_row from public.orders where id = target_order_id for update;
  if order_row.status = 'cancelled' then raise exception 'This order was cancelled' using errcode = '22023'; end if;

  select profile.display_name into driver_name from public.profiles profile where profile.id = auth.uid();

  if action = 'accept' then
    if assignment.status = 'accepted' then return jsonb_build_object('assignment_status', 'accepted', 'duplicate', true); end if;
    if assignment.status <> 'assigned' then raise exception 'This delivery has already moved past accepting' using errcode = '22023'; end if;
    update public.delivery_assignments set status = 'accepted', accepted_at = now() where id = assignment.id;
    insert into public.order_events (order_id, event_type, actor_user_id, metadata)
    values (order_row.id, 'delivery.accepted', auth.uid(), jsonb_build_object('driver_id', auth.uid(), 'driver_name', driver_name));
    return jsonb_build_object('assignment_status', 'accepted', 'duplicate', false);
  end if;

  if action = 'picked_up' then
    if assignment.status = 'picked_up' then return jsonb_build_object('assignment_status', 'picked_up', 'duplicate', true); end if;
    if assignment.status not in ('assigned', 'accepted') then raise exception 'This delivery has already left the store' using errcode = '22023'; end if;
    if order_row.status not in ('ready', 'out_for_delivery') then
      raise exception 'The kitchen has not marked this order ready yet' using errcode = '22023';
    end if;
    update public.delivery_assignments
      set status = 'picked_up', picked_up_at = now(), accepted_at = coalesce(accepted_at, now())
      where id = assignment.id;
    if order_row.status = 'ready' then
      update public.orders set status = 'out_for_delivery', out_for_delivery_at = now() where id = order_row.id;
      insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
      values (order_row.id, 'order.out_for_delivery', order_row.status, 'out_for_delivery', auth.uid(),
        jsonb_build_object('driver_id', auth.uid(), 'driver_name', driver_name, 'via', 'driver_screen'));
    end if;
    insert into public.order_events (order_id, event_type, actor_user_id, metadata)
    values (order_row.id, 'delivery.picked_up', auth.uid(), jsonb_build_object('driver_id', auth.uid(), 'driver_name', driver_name));
    return jsonb_build_object('assignment_status', 'picked_up', 'duplicate', false);
  end if;

  -- action = 'delivered'
  if assignment.status = 'delivered' then return jsonb_build_object('assignment_status', 'delivered', 'duplicate', true); end if;
  if assignment.status <> 'picked_up' then raise exception 'Mark the order picked up before delivering it' using errcode = '22023'; end if;
  if order_row.status not in ('ready', 'out_for_delivery') then
    raise exception 'This order is no longer out for delivery. Refresh and check with the store.' using errcode = '40001';
  end if;

  amount_due := case when order_row.payment_status = 'paid' then 0 else order_row.total_cents end;
  collected := greatest(coalesce(cash_cents, 0), 0);
  if amount_due > 0 and cash_cents is null then
    raise exception 'Record the cash collected at the door before completing this delivery' using errcode = '22023';
  end if;
  if collected > amount_due + 20000 then
    raise exception 'Cash collected is far above the amount due. Check the amount and try again.' using errcode = '22023';
  end if;
  if amount_due = 0 and collected > 0 then
    raise exception 'This order is already paid. Do not collect cash for it.' using errcode = '22023';
  end if;

  update public.delivery_assignments set
    status = 'delivered', delivered_at = now(),
    amount_due_cents = amount_due,
    cash_collected_cents = collected,
    cash_collected_at = case when collected > 0 then now() else null end,
    delivery_note = clean_note
  where id = assignment.id;

  previous_method := order_row.payment_method;
  if collected > 0 then
    insert into public.payments (order_id, provider, provider_payment_id, method, amount_cents, status, captured_at, metadata)
    values (order_row.id, 'cash_on_delivery', assignment.id::text, 'cash', collected, 'captured', now(),
      jsonb_build_object('driver_id', auth.uid(), 'driver_name', driver_name, 'amount_due_cents', amount_due, 'assignment_id', assignment.id))
    on conflict (provider, provider_payment_id) do nothing;
  end if;

  -- Payment first, then completion: the Hanafy outbox trigger emits one event per
  -- update, so a cash delivery produces both order.paid and order.completed.
  if collected > 0 then
    update public.orders set
      payment_method = 'cash',
      payment_status = case when collected >= amount_due then 'paid' else payment_status end
    where id = order_row.id;
  end if;
  update public.orders set status = 'completed', completed_at = now() where id = order_row.id;

  insert into public.order_events (order_id, event_type, from_status, to_status, actor_user_id, metadata)
  values (order_row.id, 'order.completed', order_row.status, 'completed', auth.uid(),
    jsonb_build_object('completed_from', order_row.status, 'skipped_kitchen_steps', false, 'via', 'driver_screen'));
  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (order_row.id, 'delivery.delivered', auth.uid(),
    jsonb_build_object('driver_id', auth.uid(), 'driver_name', driver_name, 'amount_due_cents', amount_due,
      'cash_collected_cents', collected, 'shortfall_cents', greatest(amount_due - collected, 0), 'note', clean_note));

  perform public.wayne_write_audit('delivery.delivered', 'orders', order_row.id::text,
    'Delivered order ' || order_row.order_number || ' · cash collected ' || (collected / 100.0)::numeric(12,2)::text || ' of ' || (amount_due / 100.0)::numeric(12,2)::text,
    jsonb_build_object(
      'status', jsonb_build_object('from', order_row.status, 'to', 'completed'),
      'payment_method', jsonb_build_object('from', previous_method, 'to', case when collected > 0 then 'cash' else previous_method end)),
    jsonb_build_object('order_number', order_row.order_number, 'driver_id', auth.uid(), 'driver_name', driver_name,
      'amount_due_cents', amount_due, 'cash_collected_cents', collected,
      'shortfall_cents', greatest(amount_due - collected, 0), 'note', clean_note));

  return jsonb_build_object('assignment_status', 'delivered', 'duplicate', false,
    'cash_collected_cents', collected, 'shortfall_cents', greatest(amount_due - collected, 0));
end;
$$;

-- ============================================================================
-- Owner delivery analytics (§19 "owner driver analytics")
-- ============================================================================
create or replace function public.wayne_delivery_metrics(from_date date, through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  store_timezone text;
  window_start timestamptz;
  window_end timestamptz;
begin
  if not public.wayne_has_permission('reports.view') then
    raise exception 'Report viewing permission required' using errcode = '42501';
  end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 3660 then
    raise exception 'Invalid report date range' using errcode = '22023';
  end if;
  select settings.timezone into store_timezone from public.store_settings settings where settings.id = true;
  window_start := from_date::timestamp at time zone store_timezone;
  window_end := (through_date + 1)::timestamp at time zone store_timezone;

  return (
    with scoped as (
      select assignment.*, order_row.order_number, order_row.total_cents, order_row.promised_at, order_row.ready_at,
        profile.display_name driver_name,
        extract(epoch from (assignment.delivered_at - assignment.picked_up_at)) / 60 door_minutes,
        extract(epoch from (assignment.delivered_at - assignment.assigned_at)) / 60 assignment_minutes
      from public.delivery_assignments assignment
      join public.orders order_row on order_row.id = assignment.order_id
      left join public.profiles profile on profile.id = assignment.driver_id
      where assignment.assigned_at >= window_start and assignment.assigned_at < window_end
    ), delivered as (select * from scoped where status = 'delivered')
    select jsonb_build_object(
      'totals', jsonb_build_object(
        'assigned_count', (select count(*)::integer from scoped),
        'delivered_count', (select count(*)::integer from delivered),
        'in_progress_count', (select count(*)::integer from scoped where status in ('assigned', 'accepted', 'picked_up')),
        'released_count', (select count(*)::integer from scoped where status = 'released'),
        'delivered_sales_cents', (select coalesce(sum(total_cents), 0)::bigint from delivered),
        'cash_collected_cents', (select coalesce(sum(cash_collected_cents), 0)::bigint from delivered),
        'cash_short_cents', (select coalesce(sum(greatest(amount_due_cents - cash_collected_cents, 0)), 0)::bigint from delivered),
        'average_door_minutes', (select coalesce(round(avg(door_minutes))::integer, 0) from delivered where door_minutes is not null),
        'average_assignment_minutes', (select coalesce(round(avg(assignment_minutes))::integer, 0) from delivered where assignment_minutes is not null),
        'late_count', (select count(*)::integer from delivered where promised_at is not null and delivered_at > promised_at)),
      'drivers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'driver_id', driver_id, 'driver_name', coalesce(driver_name, 'Removed staff'),
          'assigned_count', assigned_count, 'delivered_count', delivered_count, 'released_count', released_count,
          'delivered_sales_cents', delivered_sales_cents, 'cash_collected_cents', cash_collected_cents,
          'cash_short_cents', cash_short_cents, 'average_door_minutes', average_door_minutes, 'late_count', late_count)
          order by delivered_count desc, driver_name)
        from (
          select driver_id, driver_name,
            count(*)::integer assigned_count,
            count(*) filter (where status = 'delivered')::integer delivered_count,
            count(*) filter (where status = 'released')::integer released_count,
            coalesce(sum(total_cents) filter (where status = 'delivered'), 0)::bigint delivered_sales_cents,
            coalesce(sum(cash_collected_cents) filter (where status = 'delivered'), 0)::bigint cash_collected_cents,
            coalesce(sum(greatest(amount_due_cents - cash_collected_cents, 0)) filter (where status = 'delivered'), 0)::bigint cash_short_cents,
            coalesce(round(avg(door_minutes) filter (where status = 'delivered'))::integer, 0) average_door_minutes,
            count(*) filter (where status = 'delivered' and promised_at is not null and delivered_at > promised_at)::integer late_count
          from scoped group by driver_id, driver_name) rows), '[]'::jsonb),
      'exceptions', coalesce((
        select jsonb_agg(jsonb_build_object('order_number', order_number, 'driver_name', coalesce(driver_name, 'Unassigned'),
          'issue', issue, 'detail', detail, 'occurred_at', occurred_at) order by occurred_at desc)
        from (
          select order_number, driver_name, 'Cash short' issue,
            'Collected ' || (cash_collected_cents / 100.0)::numeric(12,2)::text || ' of ' || (amount_due_cents / 100.0)::numeric(12,2)::text detail,
            delivered_at occurred_at
          from delivered where cash_collected_cents < amount_due_cents
          union all
          select order_number, driver_name, 'Released after pickup',
            coalesce(nullif(release_reason, ''), 'No reason recorded'), released_at
          from scoped where status = 'released' and picked_up_at is not null
          union all
          select order_number, driver_name, 'Late delivery',
            'Delivered ' || round(extract(epoch from (delivered_at - promised_at)) / 60)::text || ' minutes past the promise', delivered_at
          from delivered where promised_at is not null and delivered_at > promised_at
          union all
          select order_number, driver_name, 'Still out for delivery',
            'Picked up ' || round(extract(epoch from (now() - picked_up_at)) / 60)::text || ' minutes ago', picked_up_at
          from scoped where status = 'picked_up' and picked_up_at < now() - interval '90 minutes'
        ) rows), '[]'::jsonb)));
end;
$$;

-- ============================================================================
-- Privileges: nothing is callable by default (see Phase 0–8 default privileges)
-- ============================================================================
do $$
declare
  fn text;
  staff_functions constant text[] := array[
    'public.wayne_delivery_dispatch()',
    'public.wayne_assign_delivery(uuid, uuid)',
    'public.wayne_release_delivery(uuid, text)',
    'public.wayne_driver_board()',
    'public.wayne_driver_claim_delivery(uuid)',
    'public.wayne_driver_update_delivery(uuid, text, integer, text)',
    'public.wayne_delivery_metrics(date, date)'];
  internal_functions constant text[] := array[
    'public.wayne_delivery_order_payload(public.orders)',
    'public.wayne_delivery_assignment_payload(public.delivery_assignments)'];
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

comment on function public.wayne_driver_update_delivery(uuid, text, integer, text) is
  'Driver workflow for their own assignment: accept, picked up (moves a ready order to out for delivery), delivered (completes the order and records cash collected at the door). Card-at-door is not available until Phase 11.';
comment on function public.wayne_delivery_metrics(date, date) is
  'Owner delivery analytics: per-driver counts, cash collected, average door time, and delivery exceptions for a local business-date range.';
