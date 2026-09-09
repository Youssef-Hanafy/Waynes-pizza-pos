-- Phase 0–5 reliability fixes: rate limiting, consistent overnight hours, and
-- server-enforced scheduled availability for every sellable order source.

create table public.order_request_rate_limits (
  client_key text not null check (char_length(client_key) = 64),
  window_started timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  primary key (client_key, window_started)
);

alter table public.order_request_rate_limits enable row level security;

create or replace function public.wayne_consume_public_order_rate_limit(client_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_window timestamptz := date_trunc('hour', now()) + floor(extract(minute from now()) / 5)::integer * interval '5 minutes';
  new_count integer;
begin
  if client_key !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid rate limit key' using errcode = '22023';
  end if;
  -- Keep the fixed-window table bounded without a separate operational job.
  delete from public.order_request_rate_limits
  where window_started < now() - interval '1 day';

  insert into public.order_request_rate_limits (client_key, window_started, request_count)
  values (client_key, active_window, 1)
  on conflict (client_key, window_started) do update
    set request_count = public.order_request_rate_limits.request_count + 1
    where public.order_request_rate_limits.request_count < 8
  returning request_count into strict new_count;

  return true;
exception
  when no_data_found then return false;
end;
$$;

revoke all on table public.order_request_rate_limits from public, anon, authenticated;
revoke all on function public.wayne_consume_public_order_rate_limit(text) from public;
grant execute on function public.wayne_consume_public_order_rate_limit(text) to anon;

create or replace function public.wayne_store_is_open(check_at timestamptz default now())
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  settings public.store_settings%rowtype;
  local_moment timestamp;
  day_name text;
  yesterday_name text;
  hours jsonb;
  yesterday_hours jsonb;
  special public.store_special_hours%rowtype;
begin
  select * into settings from public.store_settings where id = true;
  if not settings.ordering_open then return false; end if;
  local_moment := check_at at time zone settings.timezone;
  select * into special from public.store_special_hours where service_date = local_moment::date and archived_at is null limit 1;
  if found then
    if special.closed or special.opens_at is null or special.closes_at is null then return false; end if;
    if special.opens_at <= special.closes_at then
      return local_moment::time >= special.opens_at and local_moment::time < special.closes_at;
    end if;
    return local_moment::time >= special.opens_at;
  end if;
  day_name := (array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[extract(dow from local_moment)::integer + 1];
  yesterday_name := (array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[(extract(dow from local_moment)::integer + 6) % 7 + 1];
  hours := settings.business_hours -> day_name;
  yesterday_hours := settings.business_hours -> yesterday_name;
  if not coalesce((hours ->> 'closed')::boolean, true)
    and (hours ->> 'open') is not null and (hours ->> 'close') is not null then
    if (hours ->> 'open')::time <= (hours ->> 'close')::time
      and local_moment::time >= (hours ->> 'open')::time and local_moment::time < (hours ->> 'close')::time then return true; end if;
    if (hours ->> 'open')::time > (hours ->> 'close')::time
      and local_moment::time >= (hours ->> 'open')::time then return true; end if;
  end if;
  return not coalesce((yesterday_hours ->> 'closed')::boolean, true)
    and (yesterday_hours ->> 'open') is not null and (yesterday_hours ->> 'close') is not null
    and (yesterday_hours ->> 'open')::time > (yesterday_hours ->> 'close')::time
    and local_moment::time < (yesterday_hours ->> 'close')::time;
end;
$$;
