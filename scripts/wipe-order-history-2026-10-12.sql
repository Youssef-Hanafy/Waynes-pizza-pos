-- One-off: clear the whole order history again (owner, 2026-10-12: an order
-- was taken for real by accident; everything else was testing).
--
-- Removes: all orders (+ items, modifiers, discounts, events, payments,
-- refunds, kitchen tickets, print jobs, delivery assignments), driver
-- cash-outs, every cash drawer shift and cash movement, open/held POS tickets
-- and the phone-call log.
-- Keeps: customer profiles (order count / lifetime spend reset to 0), Wayne's
-- Rewards members and codes, the menu, settings, registers, staff, PINs and
-- clock-ins.  A copy of what is removed is kept in the private "archive" schema.

begin;

create schema if not exists archive;
revoke all on schema archive from public, anon, authenticated;
create table archive.orders_20261012 as select * from public.orders;
create table archive.order_items_20261012 as select * from public.order_items;
create table archive.payments_20261012 as select * from public.payments;
create table archive.driver_cashouts_20261012 as select * from public.driver_cashouts;
create table archive.register_shifts_20261012 as select * from public.register_shifts;
create table archive.cash_movements_20261012 as select * from public.cash_movements;

select public.wayne_purge_orders(array(select id from public.orders));

delete from public.driver_cashouts;
delete from public.print_jobs;          -- any left without an order (no-sale kicks)
delete from public.cash_movements;
delete from public.register_shifts;
delete from public.pos_drafts;
delete from public.phone_calls;

-- Every customer back to zero orders / $0 lifetime.
select public.wayne_rebuild_customer_metrics(id) from public.customers;

select
  (select count(*) from public.orders) as orders_left,
  (select count(*) from public.payments) as payments_left,
  (select count(*) from public.driver_cashouts) as cashouts_left,
  (select count(*) from public.register_shifts) as drawer_shifts_left,
  (select coalesce(sum(lifetime_spend_cents), 0) from public.customers) as customer_spend_left;

commit;
