-- The print station hands a job back when its printer is not answering, so
-- the ticket waits and prints once the printer is back, instead of being
-- marked failed and needing a manager to retry it.  Only the station holding
-- the lease can do this, and only while the lease is live: a job whose
-- outcome is unknown is never released (it must be inspected, as before).
create or replace function public.wayne_release_print_job(target_job_id uuid, target_lease_token uuid, release_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare job public.print_jobs%rowtype;
begin
  if not public.wayne_has_permission('printing.process') then
    raise exception 'Print processing permission required' using errcode = '42501';
  end if;
  select * into job from public.print_jobs where id = target_job_id for update;
  if not found then raise exception 'Print job not found' using errcode = 'P0002'; end if;
  if target_lease_token is null or job.lease_token is distinct from target_lease_token
     or job.claimed_by is distinct from auth.uid() then
    raise exception 'Stale print lease' using errcode = '40001';
  end if;
  if job.status <> 'processing' or job.lease_expires_at <= now() then
    raise exception 'Print job is not held by this station' using errcode = '40001';
  end if;
  update public.print_jobs set
    status = 'pending', lease_token = null, lease_expires_at = null, claimed_by = null, worker_id = null,
    last_error = left(coalesce(nullif(btrim(release_reason), ''), 'Printer not answering'), 500),
    updated_at = now()
  where id = job.id;
end;
$$;
revoke all on function public.wayne_release_print_job(uuid, uuid, text) from public, anon;
grant execute on function public.wayne_release_print_job(uuid, uuid, text) to authenticated;
