-- How Wayne's actually prints (owner, 2026-09-22):
--   * Delivery orders: the receipt prints by itself on the front printer (the
--     driver takes it), as well as the kitchen ticket.
--   * Pickup / takeout: only the kitchen ticket prints.  A customer receipt
--     prints only when someone asks for one (Print receipt button).
--   * Online orders: unchanged - order slip + tip & signature slip.
--
-- Both new kinds of job go through the durable print queue, so they print on
-- the front printer from the print station whichever register asked.

alter table public.print_jobs drop constraint print_jobs_job_type_check;
alter table public.print_jobs add constraint print_jobs_job_type_check
  check (job_type in ('kitchen_ticket', 'online_order', 'delivery_receipt', 'receipt_request'));

-- Same trigger (orders_online_order_print), now also queueing the receipt for
-- register and phone delivery orders.
create or replace function public.wayne_queue_online_order_print()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders%rowtype;
  printer jsonb;
  kind text;
begin
  select * into o from public.orders where id = new.id;
  if not found or o.placed_at is null or o.status not in ('placed', 'accepted', 'in_kitchen', 'ready') then
    return new;
  end if;
  select receipt_printer into printer from public.pos_hardware_settings where id;
  if o.source = 'online' then
    if coalesce((printer ->> 'online_order_slips')::boolean, true) then kind := 'online_order'; end if;
  elsif o.fulfillment_type = 'delivery' then
    if coalesce((printer ->> 'auto_delivery_receipts')::boolean, true) then kind := 'delivery_receipt'; end if;
  end if;
  if kind is null then return new; end if;
  -- One per order, ever: the unique key makes a status change a no-op.
  insert into public.print_jobs(order_id, destination, job_type, payload)
  values (o.id, 'receipt', kind, jsonb_build_object(
    'order_number', o.order_number, 'customer_name', o.customer_name_snapshot,
    'fulfillment_type', o.fulfillment_type, 'payment_method', o.payment_method))
  on conflict (order_id, destination, job_type) do nothing;
  return new;
end;
$$;
revoke all on function public.wayne_queue_online_order_print() from public, anon, authenticated;

-- "Print receipt" from any register: queue it for the front printer.  One
-- request row per order is reused, so asking again after it printed prints
-- another copy, and asking twice before it prints doesn't print two.
create or replace function public.wayne_request_receipt_print(target_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders%rowtype;
  job public.print_jobs%rowtype;
begin
  if not (public.wayne_has_permission('pos.access') or public.wayne_has_permission('printing.manage')) then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  select * into o from public.orders where id = target_order_id;
  if not found or o.placed_at is null or o.status in ('draft', 'payment_pending') then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  select * into job from public.print_jobs
   where order_id = o.id and destination = 'receipt' and job_type = 'receipt_request' for update;
  if found and job.status in ('pending', 'processing') then
    return jsonb_build_object('ok', true, 'status', 'already_queued');
  end if;
  if found then
    update public.print_jobs set status = 'pending', lease_token = null, lease_expires_at = null,
      claimed_by = null, worker_id = null, last_error = null, printed_at = null,
      created_at = now(), updated_at = now()
    where id = job.id;
  else
    insert into public.print_jobs(order_id, destination, job_type, payload)
    values (o.id, 'receipt', 'receipt_request', jsonb_build_object(
      'order_number', o.order_number, 'customer_name', o.customer_name_snapshot,
      'fulfillment_type', o.fulfillment_type, 'payment_method', o.payment_method));
  end if;
  insert into public.order_events(order_id, event_type, actor_user_id, metadata)
  values (o.id, 'print.receipt_requested', auth.uid(), '{}'::jsonb);
  return jsonb_build_object('ok', true, 'status', 'queued');
end;
$$;
revoke all on function public.wayne_request_receipt_print(uuid) from public, anon;
grant execute on function public.wayne_request_receipt_print(uuid) to authenticated;

update public.pos_hardware_settings
set receipt_printer = receipt_printer || jsonb_build_object('auto_delivery_receipts', true), updated_at = now()
where id and not (receipt_printer ? 'auto_delivery_receipts');
