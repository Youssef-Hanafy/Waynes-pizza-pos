-- POS -> Today's orders (owner, 2026-10-12): every order of the day — open,
-- done or cancelled — to pull one up, see who ordered, their phone, whether
-- and how it was paid, its status and times, and reprint the receipt.

create or replace function public.wayne_pos_day_orders(target_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  zone text;
  day date;
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  select coalesce(nullif(timezone, ''), 'America/New_York') into zone from public.store_settings where id = true;
  zone := coalesce(zone, 'America/New_York');
  day := coalesce(target_day, (now() at time zone zone)::date);
  return jsonb_build_object(
    'day', day,
    'orders', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.placed_at desc)
      from (
        select o.id, o.order_number,
          o.customer_name_snapshot as customer_name, o.customer_phone_snapshot as customer_phone,
          o.fulfillment_type, o.source, o.phone_line, o.status, o.payment_method, o.payment_status,
          o.subtotal_cents, o.discount_cents, o.delivery_fee_cents, o.tax_cents, o.tip_cents, o.total_cents,
          coalesce(o.placed_at, o.created_at) as placed_at, o.promised_at, o.ready_at,
          o.out_for_delivery_at, o.completed_at, o.cancelled_at, o.is_test,
          o.delivery_address_snapshot as delivery_address, o.special_instructions,
          staff.display_name as taken_by,
          (select coalesce(sum(i.quantity), 0) from public.order_items i where i.order_id = o.id)::integer as item_count,
          paid.method as paid_method, paid.card_brand, paid.card_last4, paid.tendered_cents, paid.change_cents,
          coalesce(paid.captured_at, paid.authorized_at) as paid_at
        from public.orders o
        left join public.profiles staff on staff.id = o.created_by_user_id
        left join lateral (
          select p.method, p.card_brand, p.card_last4, p.tendered_cents, p.change_cents, p.captured_at, p.authorized_at
            from public.payments p
           where p.order_id = o.id and p.status in ('captured', 'authorized')
           order by coalesce(p.captured_at, p.authorized_at, p.created_at) desc
           limit 1
        ) paid on true
        where o.status <> 'draft'
          and (coalesce(o.placed_at, o.created_at) at time zone zone)::date = day
        order by coalesce(o.placed_at, o.created_at) desc
        limit 500
      ) row_data
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.wayne_pos_day_orders(date) from public, anon;
grant execute on function public.wayne_pos_day_orders(date) to authenticated;
