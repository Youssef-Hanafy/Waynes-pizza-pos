-- Cash in a partial payment stays in the transaction until the whole bill is covered.
-- The final payment may be cash or card; card-only orders do not open the drawer.
create or replace function public.wayne_payment_opens_drawer()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.status not in ('captured', 'authorized')
     or (tg_op = 'UPDATE' and old.status in ('captured', 'authorized')) then
    return new;
  end if;
  if exists (
    select 1 from public.payments p
    where p.order_id = new.order_id and p.method = 'cash' and p.status = 'captured'
      and coalesce(p.metadata ->> 'offline', '') <> 'true'
  ) and exists (
    select 1 from public.orders o where o.id = new.order_id and o.status <> 'cancelled'
      and public.wayne_order_paid_cents(o.id) >= o.total_cents
  ) then
    perform public.wayne_queue_drawer_kick(new.order_id, 'cash transaction completed');
  end if;
  return new;
end;
$$;
revoke all on function public.wayne_payment_opens_drawer() from public, anon, authenticated;
