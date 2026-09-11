-- Wayne's Pizza POS — Phase 9 support: database-native Hanafy outbox delivery.
--
-- Phase 8 shipped a Next.js worker route that needs an external scheduler. Wayne's
-- has no always-on scheduler yet, so this migration lets Supabase deliver the
-- outbox itself: pg_cron runs every minute, pg_net sends the HMAC-signed request,
-- and a collector records the HTTP result through the same lease/finish path the
-- Next worker uses. Either worker can run; leases keep them from colliding.
--
-- It also fixes a Phase 8 defect: an event whose worker died mid-delivery stayed
-- in `processing` forever. Expired leases are now reclaimed and logged.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter table public.integration_outbox
  add column if not exists http_request_id bigint,
  add column if not exists dispatched_at timestamptz;

create or replace function public.wayne_claim_hanafy_outbox(worker_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare row_value public.integration_outbox%rowtype;
begin
  select * into row_value from public.integration_outbox
  where destination = 'hanafy'
    and ((status in ('pending','failed') and next_attempt_at <= now())
      or (status = 'processing' and lease_expires_at <= now()))
  order by created_at
  for update skip locked
  limit 1;
  if not found then return null; end if;

  -- A lease that expired without a recorded result is a lost attempt: log it so
  -- the delivery history stays complete, then retry the same event_id (Hanafy
  -- dedupes on event_id, so a request that did land is harmless to resend).
  if row_value.status = 'processing' then
    insert into public.integration_delivery_logs(outbox_id, attempt_number, request_status, error_message)
    values (row_value.id, row_value.attempts, 'failed', 'Delivery lease expired before a result was recorded.')
    on conflict (outbox_id, attempt_number) do nothing;
  end if;

  update public.integration_outbox
  set status = 'processing', attempts = attempts + 1, lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '5 minutes', last_error = null,
      http_request_id = null, dispatched_at = null
  where id = row_value.id
  returning * into row_value;
  return to_jsonb(row_value);
end;
$$;

create or replace function public.wayne_finish_hanafy_outbox(outbox_id uuid, token uuid, succeeded boolean, response_code_value integer default null, response_body_value text default null, error_value text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare row_value public.integration_outbox%rowtype;
begin
  select * into row_value from public.integration_outbox where id = outbox_id for update;
  if not found or row_value.status <> 'processing' or row_value.lease_token is distinct from token or row_value.lease_expires_at <= now() then
    raise exception 'Stale integration outbox lease' using errcode = '40001';
  end if;
  insert into public.integration_delivery_logs(outbox_id, attempt_number, request_status, response_code, response_body_truncated, error_message)
  values (row_value.id, row_value.attempts, case when succeeded then 'delivered' else 'failed' end, response_code_value, left(response_body_value, 2000), left(error_value, 2000));
  update public.integration_outbox
  set status = case when succeeded then 'delivered' else 'failed' end,
      delivered_at = case when succeeded then now() else null end,
      next_attempt_at = case when succeeded then next_attempt_at else now() + least(interval '24 hours', interval '1 minute' * power(2, least(attempts, 10))) end,
      last_error = case when succeeded then null else left(error_value, 2000) end,
      lease_token = null, lease_expires_at = null, http_request_id = null
  where id = row_value.id;
end;
$$;

-- Byte-for-byte the same signature as src/lib/integrations/hanafy.ts:
-- sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
create or replace function public.wayne_sign_hanafy_body(secret text, timestamp_value text, body text)
returns text language sql immutable set search_path = '' as $$
  select 'sha256=' || encode(extensions.hmac(convert_to(timestamp_value || '.' || body, 'UTF8'), convert_to(secret, 'UTF8'), 'sha256'), 'hex');
$$;

-- pg_net serialises a jsonb body with jsonb::text, so the signature is computed
-- over exactly that text.
create or replace function public.wayne_dispatch_hanafy_outbox(batch_size integer default 25)
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
    job := public.wayne_claim_hanafy_outbox('pg-net-dispatcher');
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

-- Records pg_net results. Rows whose lease expired are left for the claim step,
-- which logs the lost attempt and retries.
create or replace function public.wayne_collect_hanafy_responses()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  row_value record;
  response record;
  delivered integer := 0;
  failed integer := 0;
begin
  if to_regclass('net._http_response') is null then
    return jsonb_build_object('ok', false, 'reason', 'pg_net is not installed');
  end if;
  for row_value in
    select id, lease_token, http_request_id from public.integration_outbox
    where status = 'processing' and http_request_id is not null and lease_expires_at > now()
    order by dispatched_at
    for update skip locked
  loop
    execute 'select status_code, content, timed_out, error_msg from net._http_response where id = $1'
      into response using row_value.http_request_id;
    continue when response is null;
    begin
      if response.status_code between 200 and 299 then
        perform public.wayne_finish_hanafy_outbox(row_value.id, row_value.lease_token, true, response.status_code, response.content, null);
        delivered := delivered + 1;
      else
        perform public.wayne_finish_hanafy_outbox(row_value.id, row_value.lease_token, false, response.status_code, response.content,
          coalesce(nullif(response.error_msg, ''), case when response.timed_out then 'Hanafy request timed out.' end, 'Hanafy returned HTTP ' || coalesce(response.status_code::text, 'no status') || '.'));
        failed := failed + 1;
      end if;
    exception when others then
      -- Never let one bad row stop the collector; the lease expiry retries it.
      null;
    end;
    response := null;
  end loop;
  return jsonb_build_object('ok', true, 'delivered', delivered, 'failed', failed);
end;
$$;

-- Segment events now carry the segment's display name so Hanafy can target and
-- tag "VIP", "30-day inactive", etc. without a second lookup. Exit events need
-- this because the customer's active-segment list no longer contains it.
create or replace function public.wayne_outbox_from_customer_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.wayne_enqueue_hanafy_event(
    new.event_type,
    coalesce(public.wayne_customer_hanafy_properties(new.customer_id), '{}'::jsonb)
      || jsonb_build_object(
        'segment_id', new.segment_id,
        'segment', (select jsonb_build_object('id', segment.id, 'name', segment.name) from public.customer_segments segment where segment.id = new.segment_id),
        'event_metadata', new.metadata),
    new.occurred_at);
  return new;
end;
$$;

revoke all on function public.wayne_claim_hanafy_outbox(text), public.wayne_finish_hanafy_outbox(uuid,uuid,boolean,integer,text,text),
  public.wayne_sign_hanafy_body(text,text,text), public.wayne_dispatch_hanafy_outbox(integer), public.wayne_collect_hanafy_responses(),
  public.wayne_outbox_from_customer_event()
  from public, anon, authenticated;

-- Schedule delivery where the platform provides pg_net + pg_cron (Supabase).
-- Local/PGlite databases skip this block; the Next worker route still works.
do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_net;
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'wayne-hanafy-outbox-delivery';
    perform cron.schedule('wayne-hanafy-outbox-delivery', '* * * * *',
      'select public.wayne_collect_hanafy_responses(); select public.wayne_dispatch_hanafy_outbox(50);');
  end if;
exception when insufficient_privilege then
  raise notice 'pg_net/pg_cron need a project administrator; outbox delivery falls back to the worker route.';
end;
$outer$;
