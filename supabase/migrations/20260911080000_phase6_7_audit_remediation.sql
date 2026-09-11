-- Wayne's Pizza POS — Phase 6/7 audit remediation.
-- Accounting policy: cancelled orders are excluded entirely. A refund is reported on
-- the business day it was issued only while its related order remains reportable.

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
    select r.* from public.refunds r join public.orders o on o.id = r.order_id
    where r.created_at >= (from_date::timestamp at time zone store_timezone)
      and r.created_at < ((through_date + 1)::timestamp at time zone store_timezone) and o.status <> 'cancelled'
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
    select (r.created_at at time zone store_timezone)::date service_date, sum(r.amount_cents)::bigint refund_cents from public.refunds r join public.orders o on o.id = r.order_id
    where r.created_at >= (from_date::timestamp at time zone store_timezone) and r.created_at < ((through_date + 1)::timestamp at time zone store_timezone) and o.status <> 'cancelled' group by 1
  ) select coalesce(jsonb_agg(jsonb_build_object('service_date', days.service_date, 'order_count', coalesce(orders_by_day.order_count, 0), 'sales_cents', coalesce(orders_by_day.sales_cents, 0), 'refund_cents', coalesce(refunds_by_day.refund_cents, 0), 'net_sales_cents', coalesce(orders_by_day.sales_cents, 0) - coalesce(refunds_by_day.refund_cents, 0)) order by days.service_date), '[]'::jsonb) from days left join orders_by_day using (service_date) left join refunds_by_day using (service_date));
end;
$$;

create or replace function public.wayne_report_orders(from_date date, through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare store_timezone text;
begin
  if not public.wayne_has_permission('reports.view') then raise exception 'Report viewing permission required' using errcode = '42501'; end if;
  if from_date is null or through_date is null or through_date < from_date or through_date - from_date > 3660 then raise exception 'Invalid report date range' using errcode = '22023'; end if;
  select settings.timezone into store_timezone from public.store_settings settings where settings.id = true;
  return coalesce((select jsonb_agg(jsonb_build_object('order_number',o.order_number,'placed_at',o.placed_at,'source',o.source,'fulfillment_type',o.fulfillment_type,'status',o.status,'payment_method',o.payment_method,'discount_cents',o.discount_cents,'total_cents',o.total_cents) order by o.placed_at,o.order_number)
    from public.orders o where o.placed_at >= (from_date::timestamp at time zone store_timezone) and o.placed_at < ((through_date + 1)::timestamp at time zone store_timezone) and o.status <> 'cancelled'), '[]'::jsonb);
end;
$$;

create or replace function public.wayne_apply_customer_segments(target_customer_id uuid, evaluated_at_value timestamptz default now())
returns void language plpgsql security definer set search_path = '' as $$
declare customer_row public.customers%rowtype; segment_row public.customer_segments%rowtype; condition jsonb; metrics jsonb; matches boolean; condition_matches boolean; active_membership_id uuid;
begin
  select * into customer_row from public.customers where id = target_customer_id for update;
  if not found then return; end if;
  select jsonb_build_object('lifetime_spend_cents', customer_row.lifetime_spend_cents, 'order_count', customer_row.order_count, 'average_order_value_cents', customer_row.average_order_value_cents, 'orders_last_30_days', (select count(*) from public.orders o where o.customer_id = customer_row.id and o.placed_at >= evaluated_at_value - interval '30 days' and o.placed_at <= evaluated_at_value and o.status not in ('draft','cancelled')), 'days_since_last_order', case when customer_row.last_order_at is null then null else floor(extract(epoch from (evaluated_at_value - customer_row.last_order_at)) / 86400)::integer end, 'sms_marketing_opt_in', customer_row.sms_marketing_opt_in, 'email_marketing_opt_in', customer_row.email_marketing_opt_in) into metrics;
  for segment_row in select * from public.customer_segments order by sort_order, id loop
    matches := segment_row.active;
    if matches then
      for condition in select value from jsonb_array_elements(segment_row.rules_json -> 'all') loop
        if condition ->> 'field' in ('sms_marketing_opt_in','email_marketing_opt_in') then condition_matches := case condition ->> 'operator' when '=' then (metrics ->> (condition ->> 'field'))::boolean = (condition ->> 'value')::boolean else (metrics ->> (condition ->> 'field'))::boolean <> (condition ->> 'value')::boolean end;
        elsif (metrics ->> (condition ->> 'field')) is null then condition_matches := false;
        else condition_matches := case condition ->> 'operator' when '>=' then (metrics ->> (condition ->> 'field'))::numeric >= (condition ->> 'value')::numeric when '<=' then (metrics ->> (condition ->> 'field'))::numeric <= (condition ->> 'value')::numeric when '=' then (metrics ->> (condition ->> 'field'))::numeric = (condition ->> 'value')::numeric else (metrics ->> (condition ->> 'field'))::numeric <> (condition ->> 'value')::numeric end;
        end if;
        if not condition_matches then matches := false; exit; end if;
      end loop;
    end if;
    active_membership_id := null;
    select id into active_membership_id from public.customer_segment_memberships where customer_id = customer_row.id and segment_id = segment_row.id and active for update;
    if matches and active_membership_id is null then insert into public.customer_segment_memberships(customer_id,segment_id,entered_at,evaluated_at) values(target_customer_id,segment_row.id,evaluated_at_value,evaluated_at_value); insert into public.customer_events(customer_id,segment_id,event_type,occurred_at,metadata) values(target_customer_id,segment_row.id,'customer.segment.entered',evaluated_at_value,jsonb_build_object('segment_name',segment_row.name,'metrics',metrics));
    elsif not matches and active_membership_id is not null then update public.customer_segment_memberships set active=false,exited_at=evaluated_at_value,evaluated_at=evaluated_at_value where id=active_membership_id; insert into public.customer_events(customer_id,segment_id,event_type,occurred_at,metadata) values(target_customer_id,segment_row.id,'customer.segment.exited',evaluated_at_value,jsonb_build_object('segment_name',segment_row.name,'metrics',metrics));
    end if;
  end loop;
end;
$$;

create or replace function public.wayne_refresh_refund_customer_metrics()
returns trigger language plpgsql security definer set search_path = '' as $$
declare old_customer_id uuid; new_customer_id uuid;
begin
  if tg_op in ('UPDATE','DELETE') then select customer_id into old_customer_id from public.orders where id=old.order_id; end if;
  if tg_op in ('INSERT','UPDATE') then select customer_id into new_customer_id from public.orders where id=new.order_id; end if;
  if old_customer_id is not null then perform public.wayne_rebuild_customer_metrics(old_customer_id); end if;
  if new_customer_id is not null and new_customer_id is distinct from old_customer_id then perform public.wayne_rebuild_customer_metrics(new_customer_id); end if;
  return coalesce(new,old);
end;
$$;
drop trigger if exists refunds_refresh_customer_metrics on public.refunds;
create trigger refunds_refresh_customer_metrics after insert or update or delete on public.refunds for each row execute function public.wayne_refresh_refund_customer_metrics();

create table public.customer_segment_evaluation_runs (
  id uuid primary key default gen_random_uuid(), started_at timestamptz not null default now(), completed_at timestamptz,
  status text not null check (status in ('running','succeeded','failed')), customers_evaluated integer not null default 0,
  error_message text
);
alter table public.customer_segment_evaluation_runs enable row level security;
create policy customer_segment_evaluation_runs_view on public.customer_segment_evaluation_runs for select to authenticated using (public.wayne_has_permission('segments.manage'));

create or replace function public.wayne_run_scheduled_inactivity_evaluator(reference_at timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare customer_id uuid; run_id uuid; count_value integer := 0;
begin
  insert into public.customer_segment_evaluation_runs(status) values ('running') returning id into run_id;
  begin
    for customer_id in select id from public.customers where order_count >= 2 loop perform public.wayne_apply_customer_segments(customer_id,reference_at); count_value := count_value + 1; end loop;
    update public.customer_segment_evaluation_runs set status='succeeded',completed_at=now(),customers_evaluated=count_value where id=run_id;
    return count_value;
  exception when others then
    update public.customer_segment_evaluation_runs set status='failed',completed_at=now(),customers_evaluated=count_value,error_message=sqlerrm where id=run_id;
    -- Do not re-raise here: a re-raised exception rolls back this log update.
    -- The durable failed row is the scheduler's alert signal.
    return null;
  end;
end;
$$;

create or replace function public.wayne_run_nightly_inactivity_evaluator(reference_at timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('segments.manage') then raise exception 'Segment management permission required' using errcode = '42501'; end if;
  return public.wayne_run_scheduled_inactivity_evaluator(reference_at);
end;
$$;

-- The job is created on Supabase projects where pg_cron is enabled. It runs at
-- 05:05 UTC (midnight/01:05 New York) and records every success or failure.
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    if exists (select 1 from cron.job where jobname = 'waynes-nightly-inactivity-evaluator') then perform cron.unschedule(jobid) from cron.job where jobname = 'waynes-nightly-inactivity-evaluator'; end if;
    perform cron.schedule('waynes-nightly-inactivity-evaluator', '5 5 * * *', 'select public.wayne_run_scheduled_inactivity_evaluator();');
  end if;
exception when undefined_table or undefined_function then
  raise notice 'pg_cron is not enabled; enable it and run the documented scheduler setup.';
end;
$$;

revoke all on function public.wayne_rebuild_customer_metrics(uuid), public.wayne_refresh_refund_customer_metrics(), public.wayne_run_scheduled_inactivity_evaluator(timestamptz) from public, anon, authenticated;
revoke all on function public.wayne_report_orders(date,date) from public;
grant execute on function public.wayne_report_orders(date,date), public.wayne_run_nightly_inactivity_evaluator(timestamptz) to authenticated;
comment on function public.wayne_report_summary(date,date) is 'Cancelled orders and their refunds are excluded. Eligible refunds reduce net sales on the business date issued.';
