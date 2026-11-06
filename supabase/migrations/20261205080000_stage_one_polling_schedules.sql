-- Stage 1: independent scheduler changes. CRM delivery retains its current
-- schedule until immediate consent delivery and response collection are split.
-- Card payouts, held-card capture and nightly customer evaluation are untouched.
do $cron$
declare task record; target_job bigint;
begin
  if to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is not null then
    for task in select * from (values
      ('wayne-expire-stale-card-orders','0 * * * *'),
      ('hanafy-automation-tick','*/15 * * * *')
    ) as schedules(name,expression)
    loop
      select jobid into target_job from cron.job where jobname=task.name;
      if target_job is not null then
        perform cron.alter_job(job_id:=target_job,schedule:=task.expression);
      end if;
    end loop;
  end if;
exception when undefined_table or undefined_function or invalid_schema_name then
  raise notice 'pg_cron unavailable; apply the Stage 1 schedules when the scheduler is enabled.';
end $cron$;
