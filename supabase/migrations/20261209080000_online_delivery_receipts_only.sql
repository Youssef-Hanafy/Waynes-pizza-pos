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
  if not found then return new; end if;

  if o.fulfillment_type = 'pickup' then
    if o.source = 'online' then
      delete from public.print_jobs
      where order_id = o.id and destination = 'receipt' and job_type = 'online_order' and status = 'pending';
    end if;
    return new;
  end if;

  if o.placed_at is null or o.status not in ('placed', 'accepted', 'in_kitchen', 'ready')
    or o.offline_printed_at is not null then
    return new;
  end if;

  select receipt_printer into printer from public.pos_hardware_settings where id;
  if o.source = 'online' then
    if coalesce((printer ->> 'online_order_slips')::boolean, true) then kind := 'online_order'; end if;
  elsif coalesce((printer ->> 'auto_delivery_receipts')::boolean, true) then
    kind := 'delivery_receipt';
  end if;
  if kind is null then return new; end if;

  insert into public.print_jobs(order_id, destination, job_type, payload)
  values (o.id, 'receipt', kind, jsonb_build_object(
    'order_number', o.order_number, 'customer_name', o.customer_name_snapshot,
    'fulfillment_type', o.fulfillment_type, 'payment_method', o.payment_method))
  on conflict (order_id, destination, job_type) do nothing;
  return new;
end;
$$;

-- Clear pickup slips already waiting in the automatic queue.
delete from public.print_jobs as job
using public.orders as o
where job.order_id = o.id
  and job.destination = 'receipt'
  and job.job_type = 'online_order'
  and job.status = 'pending'
  and o.source = 'online'
  and o.fulfillment_type = 'pickup';
