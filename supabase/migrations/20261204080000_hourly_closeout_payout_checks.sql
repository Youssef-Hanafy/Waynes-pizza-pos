-- Check queued card batches once per hour, at the top of the hour.
-- Preserve the existing worker, job identity, and enabled/disabled state.
do $cron$
declare payout_job bigint;
begin
  if to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is not null then
    select jobid into payout_job from cron.job where jobname='wayne-closeout-bank-payouts';
    if payout_job is not null then
      perform cron.alter_job(job_id := payout_job, schedule := '0 * * * *');
    end if;
  end if;
exception when undefined_table or undefined_function or invalid_schema_name then
  raise notice 'pg_cron unavailable; configure hourly closeout payout checks when enabled.';
end $cron$;
