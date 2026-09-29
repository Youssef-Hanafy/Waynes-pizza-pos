-- Wayne's real printers + the print station (phone build Phase 7, continued).
--
-- Printers photographed at the counter:
--   * Epson TM-T20III L (M352A), thermal, Ethernet: customer receipts, every
--     online order slip + a tip & signature slip, cash drawer on its DK port.
--   * Epson TM-U220B (M188B) with UB-E04 Ethernet card, impact: kitchen
--     tickets only.
-- Both speak ESC/POS on TCP 9100.  They are seeded switched OFF: they can only
-- be turned on once their IP addresses are entered in Admin -> Hardware.
--
-- Printing runs on one register marked "Print station" (the Android app),
-- which claims jobs from print_jobs with the existing lease RPCs.

-- 1. Online order slips share the durable queue with kitchen tickets.
alter table public.print_jobs drop constraint print_jobs_job_type_check;
alter table public.print_jobs add constraint print_jobs_job_type_check
  check (job_type in ('kitchen_ticket', 'online_order'));

create or replace function public.wayne_queue_online_order_print()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders%rowtype;
  slips_on boolean;
begin
  select * into o from public.orders where id = new.id;
  if not found or o.source <> 'online' or o.placed_at is null
     or o.status not in ('placed', 'accepted', 'in_kitchen', 'ready') then
    return new;
  end if;
  select coalesce((receipt_printer ->> 'online_order_slips')::boolean, true)
    into slips_on from public.pos_hardware_settings where id;
  if not coalesce(slips_on, true) then return new; end if;
  -- One slip set per order, ever: the unique key makes a status change a no-op.
  insert into public.print_jobs(order_id, destination, job_type, payload)
  values (o.id, 'receipt', 'online_order', jsonb_build_object(
    'order_number', o.order_number, 'customer_name', o.customer_name_snapshot,
    'fulfillment_type', o.fulfillment_type, 'payment_method', o.payment_method))
  on conflict (order_id, destination, job_type) do nothing;
  return new;
end;
$$;
revoke all on function public.wayne_queue_online_order_print() from public, anon, authenticated;

-- Deferred like the kitchen sync, so the order's items exist when it fires.
create constraint trigger orders_online_order_print
after insert or update of status on public.orders
deferrable initially deferred
for each row execute function public.wayne_queue_online_order_print();

-- 2. The register that is the print station is usually signed in as a
--    cashier: it may claim and finish jobs (printing.process), not retry or
--    manage them (printing.manage stays with owner and manager).
insert into public.role_permissions(role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.code = 'cashier' and p.code = 'printing.process'
on conflict do nothing;

drop policy if exists print_jobs_read on public.print_jobs;
create policy print_jobs_read on public.print_jobs for select to authenticated
using (public.wayne_has_permission('printing.manage') or public.wayne_has_permission('printing.process'));

-- The print station hears new jobs at once instead of polling.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'print_jobs') then
    alter publication supabase_realtime add table public.print_jobs;
  end if;
end $$;

-- 3. Seed the two printers (off, no IP yet) unless someone already set them up.
update public.pos_hardware_settings set
  receipt_printer = jsonb_build_object(
    'name', 'Front counter', 'model', 'Epson TM-T20III L (M352A), Ethernet', 'model_key', 'epson-tm-t20iii',
    'ip', '', 'port', 9100, 'protocol', 'escpos', 'enabled', false, 'paper_width_mm', 80, 'columns', null,
    'online_order_slips', true, 'tip_slip', 'always'),
  updated_at = now()
where id and (receipt_printer = '{}'::jsonb or receipt_printer is null);

update public.pos_hardware_settings set
  kitchen_printers = jsonb_build_array(jsonb_build_object(
    'name', 'Kitchen', 'model', 'Epson TM-U220B (M188B) + UB-E04 Ethernet', 'model_key', 'epson-tm-u220b',
    'ip', '', 'port', 9100, 'protocol', 'escpos', 'enabled', false, 'paper_width_mm', 76, 'columns', null,
    'two_color', false, 'routing_categories', '[]'::jsonb)),
  updated_at = now()
where id and (kitchen_printers = '[]'::jsonb or kitchen_printers is null);

update public.pos_hardware_settings set
  cash_drawer = jsonb_build_object('connection', 'receipt_printer', 'model', 'Cash drawer on the TM-T20III DK port'),
  updated_at = now()
where id and (cash_drawer = '{}'::jsonb or cash_drawer is null);

comment on table public.print_jobs is 'Durable print queue: kitchen tickets (destination = station) and online order slips (destination receipt). Claimed by the register marked Print station. Expired leases require staff inspection before retry to avoid unobserved duplicate physical prints.';
