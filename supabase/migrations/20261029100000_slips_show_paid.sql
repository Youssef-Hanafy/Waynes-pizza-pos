-- Owner, 2026-10-12: "record if it's paid for already or not" on the slips.
--
-- A counter / phone order's kitchen ticket (and its automatic delivery
-- receipt) used to print the moment the order was sent — before the customer
-- paid a few seconds later — so it always said NOT PAID.  Now it waits for the
-- payment step: it prints as soon as the order is paid (cash, card reader,
-- keyed card) or the cashier taps Pay later / Cash at the door, and never waits
-- more than 2 minutes.  Online orders already print after the card is
-- charged, so their slips show PAID.

alter table public.orders add column if not exists print_hold_until timestamptz;
comment on column public.orders.print_hold_until is
  'Kitchen ticket / delivery receipt wait for the POS payment step until this time (cleared when paid or Pay later).';

create or replace function public._wayne_patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
begin
  if position(new_text in definition) > 0 and position(old_text in new_text) = 0 then
    return; -- already applied
  end if;
  if position(old_text in definition) = 0 then
    raise exception 'Patch for % did not match: %', target, left(old_text, 120);
  end if;
  execute replace(definition, old_text, new_text);
end;
$$;

select public._wayne_patch_function('public.wayne_create_pos_order(jsonb)'::regprocedure,
$o$  -- The drawer opens only when cash is recorded (owner, 2026-10-12).$o$,
$n$  -- The drawer opens only when cash is recorded (owner, 2026-10-12).
  -- The kitchen ticket waits for the payment step so it prints PAID / NOT PAID right (owner, 2026-10-12).
  update public.orders set print_hold_until = now() + interval '2 minutes' where id = created_order_id;$n$);

drop function public._wayne_patch_function(regprocedure, text, text);

-- Let the held slips print now (and wake the print station).
-- True when a held ticket was waiting (it prints now); false when nothing was held.
create or replace function public.wayne_release_order_print(target_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
begin
  update public.orders set print_hold_until = null
   where id = target_order_id and print_hold_until is not null and print_hold_until > now();
  if not found then return false; end if;
  update public.print_jobs set updated_at = now() where order_id = target_order_id and status = 'pending';
  return true;
end;
$$;
revoke all on function public.wayne_release_order_print(uuid) from public, anon, authenticated;

-- Pay later / Cash at the door / the cashier left the payment screen.
create or replace function public.wayne_pos_release_print(target_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  return public.wayne_release_order_print(target_order_id);
end;
$$;
revoke all on function public.wayne_pos_release_print(uuid) from public, anon;
grant execute on function public.wayne_pos_release_print(uuid) to authenticated;

-- Paid (or a delivery card approved): print now.
create or replace function public.wayne_payment_releases_print()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.status in ('captured', 'authorized') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform public.wayne_release_order_print(new.order_id);
  end if;
  return new;
end;
$$;
revoke all on function public.wayne_payment_releases_print() from public, anon, authenticated;

drop trigger if exists payments_release_print on public.payments;
create trigger payments_release_print
after insert or update of status on public.payments
for each row execute function public.wayne_payment_releases_print();

-- The print station skips held kitchen tickets / delivery receipts until released or 2 minutes pass.
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
 select * into job from public.print_jobs pj where pj.destination=target_destination and pj.status='pending'
   and not (pj.job_type in ('kitchen_ticket', 'delivery_receipt')
            and exists (select 1 from public.orders o where o.id = pj.order_id and o.print_hold_until > now()))
 order by (pj.job_type = 'drawer_kick') desc, pj.created_at, pj.id for update of pj skip locked limit 1;
 if not found then return null; end if;
 update public.print_jobs set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),
  lease_expires_at=now()+interval '2 minutes',claimed_by=auth.uid(),worker_id=target_worker_id,updated_at=now()
 where id=job.id returning * into job;
 return to_jsonb(job);
end $$;
