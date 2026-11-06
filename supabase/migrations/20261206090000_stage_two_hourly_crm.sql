-- Hourly routine CRM delivery with prompt consent, ordered snapshots and minute acknowledgments.
alter table public.integration_outbox add column routine_ready boolean not null default false;

create or replace function public.wayne_claim_hanafy_outbox(worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare row_value public.integration_outbox%rowtype; consent jsonb;
begin
  -- Serialize claims, including the immediate consent trigger and manual worker.
  -- A busy dispatcher leaves the durable row for the next pass.
  if not pg_try_advisory_xact_lock(862104, 2) then return null; end if;
  if not exists (select 1 from public.integration_destinations where id = 'hanafy' and active) then
    return null;
  end if;

  select * into row_value from public.integration_outbox candidate
  where destination = 'hanafy'
    and ((status in ('pending','failed') and next_attempt_at <= now())
      or (status = 'processing' and lease_expires_at <= now()))
    and public.hanafy_service_active(workspace_id, 'crm')
    and (worker_id <> 'pg-net-consent' or event_type = 'customer.consent.changed')
    and (worker_id <> 'pg-net-dispatcher' or routine_ready or event_type = 'customer.consent.changed')
    -- Keep each customer's HTTP deliveries in order, so a consent change
    -- cannot be overtaken by an already-dispatched customer snapshot.
    and not exists (
      select 1 from public.integration_outbox active_job
      where active_job.id <> candidate.id and active_job.workspace_id = candidate.workspace_id
        and active_job.status = 'processing' and active_job.lease_expires_at > now()
        and coalesce(candidate.payload->'data'->>'customer_id', '') <> ''
        and active_job.payload->'data'->>'customer_id' = candidate.payload->'data'->>'customer_id'
    )
  order by (event_type = 'customer.consent.changed') desc, created_at, id
  for update skip locked
  limit 1;
  if not found then return null; end if;

  if row_value.status = 'processing' then
    insert into public.integration_delivery_logs(outbox_id, attempt_number, request_status, error_message)
    values (row_value.id, row_value.attempts, 'failed', 'Delivery lease expired before a result was recorded.')
    on conflict (outbox_id, attempt_number) do nothing;
  end if;

  -- Hour-old snapshots must never restore consent after a prompt opt-out.
  -- Refresh only consent fields, preserving the event identity and business data.
  select jsonb_build_object('sms_marketing_opt_in', c.sms_marketing_opt_in,
      'email_marketing_opt_in', c.email_marketing_opt_in) into consent
    from public.customers c where c.workspace_id = row_value.workspace_id
      and c.id::text = row_value.payload->'data'->>'customer_id';
  if consent is not null and (row_value.payload->'data' ? 'sms_marketing_opt_in'
      or row_value.payload->'data' ? 'email_marketing_opt_in') then
    row_value.payload := jsonb_set(row_value.payload, '{data}', (row_value.payload->'data') || consent);
  end if;
  update public.integration_outbox
  set payload = row_value.payload, status = 'processing', attempts = attempts + 1, lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '5 minutes', last_error = null,
      http_request_id = null, dispatched_at = null
  where id = row_value.id
  returning * into row_value;
  return to_jsonb(row_value);
end;
$$;

create or replace function public.wayne_dispatch_hanafy_priority(batch_size integer, consent_only boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job jsonb;
  destination_row public.integration_destinations%rowtype;
  body_text text;
  timestamp_value text;
  request_id bigint;
  dispatched integer := 0;
  failed integer := 0;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return jsonb_build_object('ok', false, 'reason', 'pg_net is not installed');
  end if;
  for i in 1..least(greatest(coalesce(batch_size, 25), 1), 100) loop
    job := public.wayne_claim_hanafy_outbox(case when consent_only then 'pg-net-consent' else 'pg-net-dispatcher' end);
    exit when job is null;
    select * into destination_row from public.integration_destinations where id = 'hanafy';
    if not found or not destination_row.active then
      perform public.wayne_finish_hanafy_outbox((job->>'id')::uuid, (job->>'lease_token')::uuid, false, null, null, 'Hanafy destination is not configured or inactive.');
      failed := failed + 1;
      continue;
    end if;
    body_text := (job->'payload')::text;
    timestamp_value := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 15000)'
      into request_id
      using destination_row.endpoint_url, job->'payload', jsonb_build_object(
        'content-type', 'application/json',
        'x-waynes-event-id', job->'payload'->>'event_id',
        'x-waynes-timestamp', timestamp_value,
        'x-waynes-signature', public.wayne_sign_hanafy_body(destination_row.signing_secret, timestamp_value, body_text));
    update public.integration_outbox set http_request_id = request_id, dispatched_at = now()
    where id = (job->>'id')::uuid and lease_token = (job->>'lease_token')::uuid;
    dispatched := dispatched + 1;
  end loop;
  return jsonb_build_object('ok', true, 'dispatched', dispatched, 'failed', failed);
end;
$$;

create or replace function public.wayne_dispatch_hanafy_outbox(batch_size integer default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  -- Freeze the hourly cohort. Maintenance may finish/retry these deliveries;
  -- new routine events continue waiting for the next hourly pass.
  update public.integration_outbox set routine_ready = true
    where destination = 'hanafy' and not routine_ready
      and ((status in ('pending','failed') and next_attempt_at <= now())
        or (status = 'processing' and lease_expires_at <= now()));
  return public.wayne_dispatch_hanafy_priority(batch_size, false);
end;
$$;
revoke all on function public.wayne_dispatch_hanafy_priority(integer,boolean) from public, anon, authenticated;

create function public.wayne_prompt_hanafy_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.destination = 'hanafy' and new.event_type = 'customer.consent.changed' then
    begin
      perform public.wayne_dispatch_hanafy_priority(25, true);
    exception when others then
      -- Never fail the customer's opt-out because an HTTP extension is down.
      -- The committed outbox row is retried by the minute maintenance job.
      null;
    end;
  end if;
  return null;
end;
$$;
revoke all on function public.wayne_prompt_hanafy_consent() from public, anon, authenticated;
create trigger hanafy_prompt_consent after insert on public.integration_outbox
  for each row execute function public.wayne_prompt_hanafy_consent();

create index integration_outbox_consent_ready on public.integration_outbox(next_attempt_at)
  where event_type = 'customer.consent.changed' and status in ('pending','failed','processing');
create index integration_outbox_customer_processing on public.integration_outbox(workspace_id, (payload->'data'->>'customer_id'))
  where status = 'processing';

-- This minute job is DB-only when there is no consent delivery to retry. It
-- collects asynchronous responses inside the existing five-minute lease;
-- it does NOT call the Next/Vercel worker. Only the hourly cohort and urgent
-- consent can be delivered; newly queued routine events keep waiting.
create function public.wayne_hanafy_delivery_maintenance() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.wayne_collect_hanafy_responses();
  perform public.wayne_dispatch_hanafy_priority(50, false);
end;
$$;
revoke all on function public.wayne_hanafy_delivery_maintenance() from public, anon, authenticated;

do $$
declare job_id bigint;
begin
  if to_regclass('cron.job') is null then return; end if;
  select jobid into job_id from cron.job where jobname = 'wayne-hanafy-outbox-delivery';
  if job_id is not null then
    perform cron.alter_job(job_id := job_id, schedule := '0 * * * *',
      command := 'select public.wayne_collect_hanafy_responses(); select public.wayne_dispatch_hanafy_outbox(50);');
  end if;
  if not exists (select 1 from cron.job where jobname = 'wayne-hanafy-delivery-maintenance') then
    perform cron.schedule('wayne-hanafy-delivery-maintenance', '* * * * *',
      'select public.wayne_hanafy_delivery_maintenance();');
  end if;
end;
$$;
