-- Owner, 2026-09-23: "every transaction, no matter what, opens the cash
-- drawer", plus a Payments screen at the POS (cash with change, card reader).
--
-- 1. Every payment taken at the store opens the drawer: when a cash payment,
--    a card-reader payment (integrated reader or a standalone reader such as
--    Boston North's) is captured, a "drawer_kick" job is queued for the
--    receipt printer.  The print station (the Android app at the counter)
--    pulses the drawer through the TM-T20III's DK port, whichever register or
--    phone took the payment.  Online card payments don't open the drawer.
-- 2. wayne_record_card_payment: the cashier ran the total on a standalone card
--    reader (not linked to the POS yet) and it was approved.  Records the
--    card payment with the last 4 digits / approval code so the day's card
--    total can be matched against the processor's report.
-- 3. Drawer kicks jump the print queue, so the drawer never waits behind a
--    long run of receipts.

alter table public.print_jobs drop constraint if exists print_jobs_job_type_check;
alter table public.print_jobs add constraint print_jobs_job_type_check
  check (job_type = any (array['kitchen_ticket', 'online_order', 'delivery_receipt', 'receipt_request', 'drawer_kick']));

create or replace function public.wayne_queue_drawer_kick(target_order_id uuid, kick_reason text)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  job public.print_jobs%rowtype;
  o public.orders%rowtype;
begin
  select * into o from public.orders where id = target_order_id;
  if not found then return; end if;
  select * into job from public.print_jobs
   where order_id = o.id and destination = 'receipt' and job_type = 'drawer_kick' for update;
  if found then
    -- A second payment on the same order (e.g. after a refund) opens it again.
    update public.print_jobs set status = 'pending', attempts = 0, lease_token = null, lease_expires_at = null,
      claimed_by = null, worker_id = null, last_error = null, printed_at = null,
      payload = jsonb_build_object('order_number', o.order_number, 'reason', kick_reason),
      created_at = now(), updated_at = now()
    where id = job.id;
  else
    insert into public.print_jobs (order_id, destination, job_type, payload)
    values (o.id, 'receipt', 'drawer_kick', jsonb_build_object('order_number', o.order_number, 'reason', kick_reason));
  end if;
end;
$$;
revoke all on function public.wayne_queue_drawer_kick(uuid, text) from public, anon, authenticated;

create or replace function public.wayne_payment_opens_drawer()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.status <> 'captured' or (tg_op = 'UPDATE' and old.status = 'captured') then
    return new;
  end if;
  -- Taken at the store: cash, a card reader linked to the POS, or a standalone reader.
  if new.method = 'cash' or new.terminal_id is not null
     or coalesce(new.metadata ->> 'entry', '') in ('counter', 'card_reader', 'terminal') then
    perform public.wayne_queue_drawer_kick(new.order_id, new.method || ' payment');
  end if;
  return new;
end;
$$;
revoke all on function public.wayne_payment_opens_drawer() from public, anon, authenticated;

drop trigger if exists payments_open_drawer on public.payments;
create trigger payments_open_drawer
after insert or update of status on public.payments
for each row execute function public.wayne_payment_opens_drawer();

-- Drawer kicks first, then everything else oldest first.
create or replace function public.wayne_claim_print_job(target_destination text, target_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare job public.print_jobs%rowtype;
begin
 if not public.wayne_has_permission('printing.process') then raise exception 'Print processing permission required' using errcode='42501'; end if;
 if char_length(btrim(coalesce(target_worker_id,''))) not between 1 and 100 then raise exception 'Worker ID required' using errcode='22023'; end if;
 -- Expired leases remain visible for manual inspection, never silently reprint.
 select * into job from public.print_jobs where destination=target_destination and status='pending'
 order by (job_type = 'drawer_kick') desc, created_at, id for update skip locked limit 1;
 if not found then return null; end if;
 update public.print_jobs set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),
  lease_expires_at=now()+interval '2 minutes',claimed_by=auth.uid(),worker_id=target_worker_id,updated_at=now()
 where id=job.id returning * into job;
 return to_jsonb(job);
end $$;

create or replace function public.wayne_record_card_payment(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  order_row public.orders%rowtype;
  existing public.payments%rowtype;
  created public.payments%rowtype;
  open_shift uuid;
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  last4 text := nullif(regexp_replace(coalesce(payload ->> 'card_last4', ''), '\D', '', 'g'), '');
  approval text := nullif(btrim(coalesce(payload ->> 'approval_code', '')), '');
  processor text := coalesce(nullif(btrim(coalesce(payload ->> 'processor', '')), ''), 'Card reader');
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  if char_length(request_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;
  if last4 is not null and char_length(last4) <> 4 then raise exception 'Enter the last 4 digits of the card, or leave it blank' using errcode = '22023'; end if;
  if approval is not null and char_length(approval) > 40 then raise exception 'That approval code is too long' using errcode = '22023'; end if;

  select * into existing from public.payments where idempotency_key = request_key;
  if found then
    return jsonb_build_object('payment_id', existing.id, 'duplicate', true, 'amount_cents', existing.amount_cents);
  end if;

  select * into order_row from public.orders where id = (payload ->> 'order_id')::uuid for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if order_row.status in ('cancelled', 'draft') then raise exception 'This order can''t be paid' using errcode = '22023'; end if;
  if order_row.payment_status = 'paid' then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where order_id = order_row.id and status in ('pending', 'authorized', 'captured')) then
    raise exception 'A payment is already open on this order' using errcode = '40001';
  end if;

  -- The drawer open on the store's registers right now, for the day's report.
  select id into open_shift from public.register_shifts where status = 'open' order by opened_at desc limit 1;

  insert into public.payments (order_id, provider, provider_payment_id, method, amount_cents, status,
    idempotency_key, shift_id, card_last4, captured_at, created_by_user_id, metadata)
  values (order_row.id, 'card_reader', 'reader-' || request_key, 'card', order_row.total_cents, 'captured',
    request_key, open_shift, last4, now(), auth.uid(),
    jsonb_build_object('entry', 'card_reader', 'processor', processor, 'approval_code', approval))
  returning * into created;

  update public.orders set payment_status = 'paid', payment_method = 'card' where id = order_row.id;

  insert into public.order_events (order_id, event_type, actor_user_id, metadata)
  values (order_row.id, 'payment.captured', auth.uid(),
    jsonb_build_object('payment_id', created.id, 'provider', 'card_reader', 'processor', processor,
      'amount_cents', order_row.total_cents, 'card_last4', last4, 'approval_code', approval));

  perform public.wayne_write_audit('card.reader_payment_recorded', 'orders', order_row.id::text,
    'Recorded ' || (order_row.total_cents / 100.0)::numeric(12,2)::text || ' card payment (reader) for order ' || order_row.order_number,
    '{}'::jsonb,
    jsonb_build_object('order_number', order_row.order_number, 'amount_cents', order_row.total_cents,
      'card_last4', last4, 'approval_code', approval, 'processor', processor));

  return jsonb_build_object('payment_id', created.id, 'duplicate', false, 'amount_cents', order_row.total_cents);
end;
$$;
revoke all on function public.wayne_record_card_payment(jsonb) from public, anon;
grant execute on function public.wayne_record_card_payment(jsonb) to authenticated;
