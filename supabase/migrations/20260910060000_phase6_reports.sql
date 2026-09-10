-- Wayne's Pizza POS — Phase 6 only: authoritative dashboard and core reports.

insert into public.permissions (id, code, description)
values ('20000000-0000-4000-8000-000000000016', 'reports.view', 'View authoritative sales and operational reports');

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role join public.permissions permission on permission.code = 'reports.view'
where role.code in ('owner', 'manager');

-- These durable ledger interfaces intentionally predate processor integration. Phase 11
-- will populate them from a provider; reports must already account for their history.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  provider text not null check (char_length(provider) between 1 and 80),
  provider_payment_id text,
  method text not null check (method in ('test_manual', 'cash', 'card')),
  amount_cents integer not null check (amount_cents > 0),
  status text not null check (status in ('authorized', 'captured', 'failed', 'voided')),
  authorized_at timestamptz,
  captured_at timestamptz,
  failed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique nulls not distinct (provider, provider_payment_id)
);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  reason text not null check (char_length(btrim(reason)) between 3 and 1000),
  provider_refund_id text,
  created_by_user_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique nulls not distinct (payment_id, provider_refund_id)
);

alter table public.order_items add column category_name_snapshot text;
update public.order_items item
set category_name_snapshot = category.name
from public.menu_items menu_item join public.menu_categories category on category.id = menu_item.category_id
where menu_item.id = item.menu_item_id and item.category_name_snapshot is null;
alter table public.order_items alter column category_name_snapshot set not null;

create or replace function public.wayne_snapshot_order_item_category()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.category_name_snapshot is null then
    select category.name into new.category_name_snapshot
    from public.menu_items menu_item join public.menu_categories category on category.id = menu_item.category_id
    where menu_item.id = new.menu_item_id;
  end if;
  if new.category_name_snapshot is null then raise exception 'Order item category snapshot is required' using errcode = '23502'; end if;
  return new;
end;
$$;
create trigger order_items_snapshot_category before insert on public.order_items for each row execute function public.wayne_snapshot_order_item_category();

alter table public.payments enable row level security;
alter table public.refunds enable row level security;
create policy payments_admin_select on public.payments for select to authenticated using (public.wayne_has_permission('reports.view'));
create policy refunds_admin_select on public.refunds for select to authenticated using (public.wayne_has_permission('reports.view'));
create index payments_order_idx on public.payments(order_id, created_at);
create index refunds_order_created_idx on public.refunds(order_id, created_at);
create index refunds_created_idx on public.refunds(created_at);

create or replace function public.wayne_report_summary(from_date date, through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare store_timezone text;
begin
  if not public.wayne_has_permission('reports.view') then raise exception 'Report viewing permission required' using errcode = '42501'; end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 3660 then raise exception 'Invalid report date range' using errcode = '22023'; end if;
  select settings.timezone into store_timezone from public.store_settings settings where settings.id = true;
  return (with scoped_orders as (
    select * from public.orders o where o.placed_at >= (from_date::timestamp at time zone store_timezone)
      and o.placed_at < ((through_date + 1)::timestamp at time zone store_timezone) and o.status <> 'cancelled'
  ), scoped_refunds as (
    select r.* from public.refunds r where r.created_at >= (from_date::timestamp at time zone store_timezone)
      and r.created_at < ((through_date + 1)::timestamp at time zone store_timezone)
  ) select jsonb_build_object(
    'order_count', (select count(*)::integer from scoped_orders),
    'gross_sales_cents', (select coalesce(sum(subtotal_cents + delivery_fee_cents + tax_cents + tip_cents), 0)::bigint from scoped_orders),
    'discount_cents', (select coalesce(sum(discount_cents), 0)::bigint from scoped_orders),
    'refund_cents', (select coalesce(sum(amount_cents), 0)::bigint from scoped_refunds),
    'net_sales_cents', (select coalesce(sum(total_cents), 0)::bigint from scoped_orders) - (select coalesce(sum(amount_cents), 0)::bigint from scoped_refunds),
    'average_order_cents', (select coalesce(round(avg(total_cents)), 0)::bigint from scoped_orders),
    'source_rows', coalesce((select jsonb_agg(jsonb_build_object('key', source, 'order_count', order_count, 'total_cents', total_cents) order by source) from (select source, count(*)::integer order_count, sum(total_cents)::bigint total_cents from scoped_orders group by source) rows), '[]'::jsonb),
    'fulfillment_rows', coalesce((select jsonb_agg(jsonb_build_object('key', fulfillment_type, 'order_count', order_count, 'total_cents', total_cents) order by fulfillment_type) from (select fulfillment_type, count(*)::integer order_count, sum(total_cents)::bigint total_cents from scoped_orders group by fulfillment_type) rows), '[]'::jsonb),
    'payment_rows', coalesce((select jsonb_agg(jsonb_build_object('key', payment_method, 'order_count', order_count, 'total_cents', total_cents) order by payment_method) from (select payment_method, count(*)::integer order_count, sum(total_cents)::bigint total_cents from scoped_orders group by payment_method) rows), '[]'::jsonb)
  ));
end;
$$;

create or replace function public.wayne_report_daily_sales(from_date date, through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare store_timezone text;
begin
  if not public.wayne_has_permission('reports.view') then raise exception 'Report viewing permission required' using errcode = '42501'; end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 3660 then raise exception 'Invalid report date range' using errcode = '22023'; end if;
  select settings.timezone into store_timezone from public.store_settings settings where settings.id = true;
  return (with days as (select d::date service_date from generate_series(from_date, through_date, interval '1 day') d), orders_by_day as (
    select (placed_at at time zone store_timezone)::date service_date, count(*)::integer order_count, sum(total_cents)::bigint sales_cents from public.orders
    where placed_at >= (from_date::timestamp at time zone store_timezone) and placed_at < ((through_date + 1)::timestamp at time zone store_timezone) and status <> 'cancelled' group by 1
  ), refunds_by_day as (
    select (created_at at time zone store_timezone)::date service_date, sum(amount_cents)::bigint refund_cents from public.refunds
    where created_at >= (from_date::timestamp at time zone store_timezone) and created_at < ((through_date + 1)::timestamp at time zone store_timezone) group by 1
  ) select coalesce(jsonb_agg(jsonb_build_object('service_date', days.service_date, 'order_count', coalesce(orders_by_day.order_count, 0), 'sales_cents', coalesce(orders_by_day.sales_cents, 0), 'refund_cents', coalesce(refunds_by_day.refund_cents, 0), 'net_sales_cents', coalesce(orders_by_day.sales_cents, 0) - coalesce(refunds_by_day.refund_cents, 0)) order by days.service_date), '[]'::jsonb) from days left join orders_by_day using (service_date) left join refunds_by_day using (service_date));
end;
$$;

create or replace function public.wayne_report_items(from_date date, through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare store_timezone text;
begin
  if not public.wayne_has_permission('reports.view') then raise exception 'Report viewing permission required' using errcode = '42501'; end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 3660 then raise exception 'Invalid report date range' using errcode = '22023'; end if;
  select settings.timezone into store_timezone from public.store_settings settings where settings.id = true;
  return (select coalesce(jsonb_agg(jsonb_build_object('category_name', category_name_snapshot, 'item_name', item_name_snapshot, 'quantity', quantity, 'sales_cents', sales_cents) order by sales_cents desc, item_name_snapshot), '[]'::jsonb)
    from (select item.category_name_snapshot, item.item_name_snapshot, sum(item.quantity)::integer quantity, sum(item.line_total_cents)::bigint sales_cents
      from public.order_items item join public.orders o on o.id = item.order_id
      where o.placed_at >= (from_date::timestamp at time zone store_timezone) and o.placed_at < ((through_date + 1)::timestamp at time zone store_timezone) and o.status <> 'cancelled'
      group by item.category_name_snapshot, item.item_name_snapshot) rows);
end;
$$;

revoke all on function public.wayne_report_summary(date, date), public.wayne_report_daily_sales(date, date), public.wayne_report_items(date, date), public.wayne_snapshot_order_item_category() from public;
grant execute on function public.wayne_report_summary(date, date), public.wayne_report_daily_sales(date, date), public.wayne_report_items(date, date) to authenticated;
