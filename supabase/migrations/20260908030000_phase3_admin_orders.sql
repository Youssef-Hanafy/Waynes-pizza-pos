-- Wayne's Pizza POS — Phase 3 only: admin order search, detail, timeline, and calendar queries.

insert into public.permissions (id, code, description)
values ('20000000-0000-4000-8000-000000000010', 'orders.view', 'View order history, details, timelines, and calendar summaries');

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code = 'orders.view'
where role.code in ('owner', 'manager');

create or replace function public.wayne_admin_orders(
  search_text text default null,
  from_date date default null,
  through_date date default null,
  fulfillment_filter text default null,
  source_filter text default null,
  status_filter text default null,
  payment_filter text default null,
  page_size integer default 100,
  page_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  store_timezone text;
  normalized_search text := btrim(coalesce(search_text, ''));
  normalized_phone_search text := regexp_replace(coalesce(search_text, ''), '[^0-9+]', '', 'g');
begin
  if not public.wayne_has_permission('orders.view') then raise exception 'Order viewing permission required' using errcode = '42501'; end if;
  if page_size not between 1 and 250 or page_offset < 0 then raise exception 'Invalid pagination' using errcode = '22023'; end if;
  select timezone into store_timezone from public.store_settings where id = true;

  return jsonb_build_object(
    'orders', coalesce((
      select jsonb_agg(to_jsonb(result_row) order by result_row.placed_at desc)
      from (
        select order_row.id, order_row.order_number, order_row.customer_id, order_row.customer_name_snapshot,
          order_row.customer_phone_snapshot, order_row.fulfillment_type, order_row.source, order_row.status,
          order_row.payment_status, order_row.payment_method, order_row.total_cents, order_row.discount_cents,
          order_row.placed_at, order_row.promised_at
        from public.orders order_row
        where
          (from_date is null or order_row.placed_at >= (from_date::timestamp at time zone store_timezone))
          and (through_date is null or order_row.placed_at < ((through_date + 1)::timestamp at time zone store_timezone))
          and (nullif(fulfillment_filter, '') is null or order_row.fulfillment_type = fulfillment_filter)
          and (nullif(source_filter, '') is null or order_row.source = source_filter)
          and (nullif(status_filter, '') is null or order_row.status = status_filter)
          and (nullif(payment_filter, '') is null or order_row.payment_method = payment_filter)
          and (normalized_search = '' or order_row.order_number ilike '%' || normalized_search || '%'
            or order_row.customer_name_snapshot ilike '%' || normalized_search || '%'
            or (normalized_phone_search <> '' and order_row.customer_phone_snapshot ilike '%' || normalized_phone_search || '%'))
        order by order_row.placed_at desc
        limit page_size offset page_offset
      ) result_row
    ), '[]'::jsonb),
    'total_count', (
      select count(*)
      from public.orders order_row
      where
        (from_date is null or order_row.placed_at >= (from_date::timestamp at time zone store_timezone))
        and (through_date is null or order_row.placed_at < ((through_date + 1)::timestamp at time zone store_timezone))
        and (nullif(fulfillment_filter, '') is null or order_row.fulfillment_type = fulfillment_filter)
        and (nullif(source_filter, '') is null or order_row.source = source_filter)
        and (nullif(status_filter, '') is null or order_row.status = status_filter)
        and (nullif(payment_filter, '') is null or order_row.payment_method = payment_filter)
        and (normalized_search = '' or order_row.order_number ilike '%' || normalized_search || '%'
          or order_row.customer_name_snapshot ilike '%' || normalized_search || '%'
          or (normalized_phone_search <> '' and order_row.customer_phone_snapshot ilike '%' || normalized_phone_search || '%'))
    )
  );
end;
$$;

create or replace function public.wayne_admin_order_calendar(target_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  store_timezone text;
  month_start date := date_trunc('month', target_month)::date;
  month_end date := (date_trunc('month', target_month) + interval '1 month')::date;
begin
  if not public.wayne_has_permission('orders.view') then raise exception 'Order viewing permission required' using errcode = '42501'; end if;
  select timezone into store_timezone from public.store_settings where id = true;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'service_date', daily.service_date,
      'order_count', daily.order_count,
      'active_total_cents', daily.active_total_cents,
      'pickup_count', daily.pickup_count,
      'delivery_count', daily.delivery_count
    ) order by daily.service_date)
    from (
      select (order_row.placed_at at time zone store_timezone)::date service_date,
        count(*)::integer order_count,
        coalesce(sum(order_row.total_cents) filter (where order_row.status <> 'cancelled'), 0)::bigint active_total_cents,
        count(*) filter (where order_row.fulfillment_type = 'pickup')::integer pickup_count,
        count(*) filter (where order_row.fulfillment_type = 'delivery')::integer delivery_count
      from public.orders order_row
      where order_row.placed_at >= (month_start::timestamp at time zone store_timezone)
        and order_row.placed_at < (month_end::timestamp at time zone store_timezone)
      group by 1
    ) daily
  ), '[]'::jsonb);
end;
$$;

create or replace function public.wayne_admin_order_detail(target_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.wayne_has_permission('orders.view') then raise exception 'Order viewing permission required' using errcode = '42501'; end if;
  return (
    select (to_jsonb(order_row) - 'public_access_token' - 'idempotency_key') || jsonb_build_object(
      'items', coalesce((select jsonb_agg((to_jsonb(item) - 'order_id') || jsonb_build_object(
        'modifiers', coalesce((select jsonb_agg(to_jsonb(modifier) - 'order_item_id' order by modifier.created_at) from public.order_item_modifiers modifier where modifier.order_item_id = item.id), '[]'::jsonb)
      ) order by item.created_at) from public.order_items item where item.order_id = order_row.id), '[]'::jsonb),
      'discounts', coalesce((select jsonb_agg(to_jsonb(discount_row) - 'order_id' order by discount_row.created_at) from public.order_discounts discount_row where discount_row.order_id = order_row.id), '[]'::jsonb),
      'events', coalesce((select jsonb_agg((to_jsonb(event_row) - 'order_id') || jsonb_build_object('actor_name', profile.display_name) order by event_row.created_at) from public.order_events event_row left join public.profiles profile on profile.id = event_row.actor_user_id where event_row.order_id = order_row.id), '[]'::jsonb)
    )
    from public.orders order_row
    where order_row.id = target_order_id
  );
end;
$$;

revoke all on function public.wayne_admin_orders(text, date, date, text, text, text, text, integer, integer) from public;
revoke all on function public.wayne_admin_order_calendar(date) from public;
revoke all on function public.wayne_admin_order_detail(uuid) from public;
grant execute on function public.wayne_admin_orders(text, date, date, text, text, text, text, integer, integer) to authenticated;
grant execute on function public.wayne_admin_order_calendar(date) to authenticated;
grant execute on function public.wayne_admin_order_detail(uuid) to authenticated;

comment on function public.wayne_admin_orders(text, date, date, text, text, text, text, integer, integer) is 'Phase 3 server-authorized order search using the configured Wayne local timezone.';
comment on function public.wayne_admin_order_calendar(date) is 'Phase 3 monthly order summaries grouped by the configured Wayne local business date.';
