-- Independent online ordering schedule; physical store hours remain unchanged.
alter table public.store_settings
  add column online_ordering_hours jsonb
  check (online_ordering_hours is null or jsonb_typeof(online_ordering_hours) = 'object');
comment on column public.store_settings.online_ordering_hours is
  'Online pickup and delivery hours. Null follows business_hours. Special hours and ordering_open take precedence.';

-- The existing configuration mirror also copies the new column to location settings.
update public.store_settings
set online_ordering_hours = (
  select jsonb_object_agg(day, jsonb_build_object('closed', false,
    'open', case when day = 'sunday' then '13:00' else '11:00' end,
    'close', case when day = 'sunday' then '19:30' else '21:30' end))
  from unnest(array['sunday','monday','tuesday','wednesday','thursday','friday','saturday']) day
)
where workspace_id = public.hanafy_legacy_workspace_id();

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
  hours := coalesce(settings.online_ordering_hours, settings.business_hours) -> day_name;
  yesterday_hours := coalesce(settings.online_ordering_hours, settings.business_hours) -> yesterday_name;

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

