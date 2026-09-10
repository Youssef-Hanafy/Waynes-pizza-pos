-- Preserve an overnight special-hours override after midnight and expose the
-- preceding service date to the public store-status calculation.

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
  yesterday_special public.store_special_hours%rowtype;
begin
  select * into settings from public.store_settings where id = true;
  if not settings.ordering_open then return false; end if;

  local_moment := check_at at time zone settings.timezone;
  select * into special
  from public.store_special_hours
  where service_date = local_moment::date and archived_at is null
  limit 1;
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

  select * into yesterday_special
  from public.store_special_hours
  where service_date = local_moment::date - 1 and archived_at is null
  limit 1;
  if found then
    return not yesterday_special.closed
      and yesterday_special.opens_at is not null
      and yesterday_special.closes_at is not null
      and yesterday_special.opens_at > yesterday_special.closes_at
      and local_moment::time < yesterday_special.closes_at;
  end if;

  return not coalesce((yesterday_hours ->> 'closed')::boolean, true)
    and (yesterday_hours ->> 'open') is not null and (yesterday_hours ->> 'close') is not null
    and (yesterday_hours ->> 'open')::time > (yesterday_hours ->> 'close')::time
    and local_moment::time < (yesterday_hours ->> 'close')::time;
end;
$$;

create or replace function public.wayne_public_store_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select (to_jsonb(settings) - 'created_at' - 'updated_at') || jsonb_build_object(
    'special_hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', special.id,
        'service_date', special.service_date,
        'label', special.label,
        'closed', special.closed,
        'opens_at', special.opens_at,
        'closes_at', special.closes_at,
        'public_note', special.public_note
      ) order by special.service_date)
      from public.store_special_hours special
      where special.archived_at is null and special.service_date >= current_date - 1
    ), '[]'::jsonb)
  )
  from public.store_settings settings
  where id = true;
$$;

revoke all on function public.wayne_store_is_open(timestamptz) from public;
grant execute on function public.wayne_store_is_open(timestamptz) to anon, authenticated;
revoke all on function public.wayne_public_store_settings() from public;
grant execute on function public.wayne_public_store_settings() to anon, authenticated;

comment on function public.wayne_store_is_open(timestamptz) is 'Evaluates regular and special business hours in the configured store timezone, including overnight carry-over.';
