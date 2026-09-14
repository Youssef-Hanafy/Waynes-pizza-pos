-- An erased customer keeps their row so their orders still have something to
-- hang from, but it should not sit in the customer list looking like a ghost
-- with a removed: identifier where the phone used to be. They are hidden by
-- default and can be brought back into view with a filter; their orders and
-- totals keep counting toward every report either way.
drop function if exists public.wayne_admin_customers(text, uuid, integer, integer);

create or replace function public.wayne_admin_customers(
  search_text text default null,
  segment_filter uuid default null,
  page_size integer default 50,
  page_offset integer default 0,
  include_removed boolean default false
)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare normalized_search text := btrim(coalesce(search_text,''));
begin
  if not public.wayne_has_permission('customers.view') then
    raise exception 'Customer viewing permission required' using errcode = '42501';
  end if;
  if page_size not between 1 and 250 or page_offset < 0 then
    raise exception 'Invalid pagination' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'customers', coalesce((
      select jsonb_agg(to_jsonb(row) order by row.last_order_at desc nulls last, row.created_at desc)
      from (
        select customer.id, customer.first_name, customer.last_name, customer.phone_normalized,
               customer.email_normalized, customer.first_order_at, customer.last_order_at,
               customer.order_count, customer.lifetime_spend_cents, customer.average_order_value_cents,
               customer.sms_marketing_opt_in, customer.email_marketing_opt_in, customer.created_at,
               coalesce((
                 select jsonb_agg(jsonb_build_object('id', segment.id, 'name', segment.name) order by segment.name)
                 from public.customer_segment_memberships membership
                 join public.customer_segments segment on segment.id = membership.segment_id
                 where membership.customer_id = customer.id and membership.active
               ), '[]'::jsonb) segments
        from public.customers customer
        where (include_removed or customer.removed_at is null)
          and (normalized_search = ''
               or customer.first_name || ' ' || customer.last_name ilike '%'||normalized_search||'%'
               or customer.phone_normalized ilike '%'||regexp_replace(normalized_search,'[^0-9+]','','g')||'%'
               or coalesce(customer.email_normalized,'') ilike '%'||normalized_search||'%')
          and (segment_filter is null or exists(
                select 1 from public.customer_segment_memberships m
                where m.customer_id = customer.id and m.segment_id = segment_filter and m.active))
        order by customer.last_order_at desc nulls last, customer.created_at desc
        limit page_size offset page_offset
      ) row
    ), '[]'::jsonb),
    'total_count', (
      select count(*) from public.customers customer
      where (include_removed or customer.removed_at is null)
        and (normalized_search = ''
             or customer.first_name || ' ' || customer.last_name ilike '%'||normalized_search||'%'
             or customer.phone_normalized ilike '%'||regexp_replace(normalized_search,'[^0-9+]','','g')||'%'
             or coalesce(customer.email_normalized,'') ilike '%'||normalized_search||'%')
        and (segment_filter is null or exists(
              select 1 from public.customer_segment_memberships m
              where m.customer_id = customer.id and m.segment_id = segment_filter and m.active))
    )
  );
end;
$function$;
