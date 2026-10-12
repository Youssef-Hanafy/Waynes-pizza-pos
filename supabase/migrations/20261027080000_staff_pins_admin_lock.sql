-- Staff PINs, PIN-locked Admin, and driver clock-in (owner, 2026-10-12).
--
--   * Staff are added with a name, a role and a 4-6 digit PIN — no email or
--     password.  Each PIN person still gets a profile (every ticket, delivery
--     and cash-out points at profiles), backed by a hidden auth account that
--     can never sign in (no password, banned).
--   * Admin opens only after an owner or manager types their PIN.  The unlock
--     belongs to the signed-in device account, lives 15 idle minutes and is
--     dropped as soon as the POS is opened again.
--   * Drivers (and anyone else) clock in and out at the POS with their PIN.
--     The Deliveries tab offers only clocked-in drivers, and a driver can take
--     orders out by typing their PIN — the deliveries are assigned to him.
--   * Wrong PINs are counted per device account: 8 misses in 5 minutes locks
--     PIN entry for 5 minutes.

create table if not exists public.staff_pins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  pin_hash text not null,
  set_by_user_id uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.staff_pins enable row level security;
revoke all on public.staff_pins from anon, authenticated;

create table if not exists public.staff_pin_attempts (
  id bigint generated always as identity primary key,
  device_user_id uuid not null,
  purpose text not null,
  succeeded boolean not null,
  matched_profile_id uuid,
  attempted_at timestamptz not null default now()
);
create index if not exists staff_pin_attempts_device_idx on public.staff_pin_attempts (device_user_id, attempted_at desc);
alter table public.staff_pin_attempts enable row level security;
revoke all on public.staff_pin_attempts from anon, authenticated;

create table if not exists public.admin_unlocks (
  token_hash text primary key,
  device_user_id uuid not null,
  unlocked_by_profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists admin_unlocks_device_idx on public.admin_unlocks (device_user_id);
alter table public.admin_unlocks enable row level security;
revoke all on public.admin_unlocks from anon, authenticated;

create table if not exists public.staff_time_punches (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  clocked_in_at timestamptz not null default now(),
  clocked_out_at timestamptz,
  device_user_id uuid,
  constraint staff_time_punches_order check (clocked_out_at is null or clocked_out_at >= clocked_in_at)
);
create unique index if not exists staff_time_punches_one_open on public.staff_time_punches (profile_id) where clocked_out_at is null;
alter table public.staff_time_punches enable row level security;
revoke all on public.staff_time_punches from anon, authenticated;

-- Which active profile a PIN belongs to (null = nobody).  Records the attempt
-- and refuses while the device is locked out.  Internal only.
create or replace function public.wayne_pin_match(pin_value text, purpose_value text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  device uuid := auth.uid();
  misses integer;
  found_id uuid;
begin
  if device is null then return jsonb_build_object('ok', false, 'error', 'Sign in first.'); end if;
  select count(*) into misses from public.staff_pin_attempts
   where device_user_id = device and not succeeded and attempted_at > now() - interval '5 minutes';
  if misses >= 8 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Wait 5 minutes and try again.');
  end if;
  if pin_value is null or pin_value !~ '^[0-9]{4,6}$' then
    insert into public.staff_pin_attempts (device_user_id, purpose, succeeded) values (device, purpose_value, false);
    return jsonb_build_object('ok', false, 'error', 'Wrong PIN.');
  end if;
  select pin.profile_id into found_id
    from public.staff_pins pin join public.profiles profile on profile.id = pin.profile_id
   where profile.active and pin.pin_hash = extensions.crypt(pin_value, pin.pin_hash)
   limit 1;
  insert into public.staff_pin_attempts (device_user_id, purpose, succeeded, matched_profile_id)
  values (device, purpose_value, found_id is not null, found_id);
  if found_id is null then return jsonb_build_object('ok', false, 'error', 'Wrong PIN.'); end if;
  return jsonb_build_object('ok', true, 'profile_id', found_id);
end;
$$;
revoke all on function public.wayne_pin_match(text, text) from public, anon, authenticated;

-- True when the profile's role carries the permission.
create or replace function public.wayne_profile_has_permission(target_profile_id uuid, permission_code text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1 from public.profiles profile
      join public.roles role on role.id = profile.role_id and role.active
      join public.role_permissions rp on rp.role_id = role.id
      join public.permissions permission on permission.id = rp.permission_id and permission.code = permission_code
     where profile.id = target_profile_id and profile.active);
$$;
revoke all on function public.wayne_profile_has_permission(uuid, text) from public, anon, authenticated;

create or replace function public.wayne_profile_name(target_profile_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(nullif(profile.display_name, ''), nullif(btrim(coalesce(profile.first_name, '') || ' ' || coalesce(profile.last_name, '')), ''), 'Staff')
    from public.profiles profile where profile.id = target_profile_id;
$$;
revoke all on function public.wayne_profile_name(uuid) from public, anon, authenticated;

-- Save a PIN for a profile, refusing one somebody else already uses.
create or replace function public.wayne_store_staff_pin(target_profile_id uuid, pin_value text)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  holder uuid;
begin
  if pin_value is null or pin_value !~ '^[0-9]{4,6}$' then
    raise exception 'The PIN must be 4 to 6 numbers' using errcode = '22023';
  end if;
  select pin.profile_id into holder from public.staff_pins pin
   where pin.profile_id <> target_profile_id and pin.pin_hash = extensions.crypt(pin_value, pin.pin_hash) limit 1;
  if holder is not null then
    raise exception 'That PIN is already used by %. Pick another one', public.wayne_profile_name(holder) using errcode = '23505';
  end if;
  insert into public.staff_pins (profile_id, pin_hash, set_by_user_id, updated_at)
  values (target_profile_id, extensions.crypt(pin_value, extensions.gen_salt('bf', 8)), auth.uid(), now())
  on conflict (profile_id) do update set pin_hash = excluded.pin_hash, set_by_user_id = excluded.set_by_user_id, updated_at = now();
end;
$$;
revoke all on function public.wayne_store_staff_pin(uuid, text) from public, anon, authenticated;

-- Admin → Staff: add a person with just a name, a role and a PIN.
create or replace function public.wayne_admin_create_pin_staff(display_name_value text, role_code text, pin_value text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  clean_name text := btrim(coalesce(display_name_value, ''));
  new_role public.roles%rowtype;
  new_id uuid := gen_random_uuid();
begin
  if not public.wayne_has_permission('staff.manage') then raise exception 'Staff management permission required' using errcode = '42501'; end if;
  if clean_name = '' or char_length(clean_name) > 120 then raise exception 'Display name is required (120 characters or fewer)' using errcode = '22023'; end if;
  select * into new_role from public.roles where code = role_code and active;
  if not found then raise exception 'Unknown role' using errcode = '22023'; end if;
  if pin_value is null or pin_value !~ '^[0-9]{4,6}$' then raise exception 'The PIN must be 4 to 6 numbers' using errcode = '22023'; end if;

  -- Hidden auth account: no password and banned, so it can never sign in.
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, banned_until, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', new_id, 'authenticated', 'authenticated',
          'pin-' || new_id::text || '@staff.hanafy.invalid', '', now(),
          jsonb_build_object('provider', 'pin', 'providers', jsonb_build_array('pin'), 'pin_only', true),
          jsonb_build_object('display_name', clean_name, 'pin_only', true),
          '2999-01-01 00:00:00+00', now(), now());

  perform public.wayne_store_staff_pin(new_id, pin_value);
  update public.profiles set role_id = new_role.id, active = true, display_name = clean_name where id = new_id;

  perform public.wayne_write_audit('staff.pin_member_created', 'profiles', new_id::text,
    'Added staff member with a PIN: ' || clean_name || ' (' || new_role.name || ')', '{}'::jsonb, jsonb_build_object('role', new_role.code));

  return jsonb_build_object('id', new_id, 'display_name', clean_name, 'role', new_role.code);
end;
$$;
revoke all on function public.wayne_admin_create_pin_staff(text, text, text) from public, anon;
grant execute on function public.wayne_admin_create_pin_staff(text, text, text) to authenticated;

-- Admin → Staff: set or change anyone's PIN.
create or replace function public.wayne_admin_set_staff_pin(target_profile_id uuid, pin_value text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not public.wayne_has_permission('staff.manage') then raise exception 'Staff management permission required' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = target_profile_id) then raise exception 'Staff member not found' using errcode = 'P0002'; end if;
  perform public.wayne_store_staff_pin(target_profile_id, pin_value);
  perform public.wayne_write_audit('staff.pin_changed', 'profiles', target_profile_id::text,
    'Changed PIN: ' || public.wayne_profile_name(target_profile_id), '{}'::jsonb, '{}'::jsonb);
  return jsonb_build_object('saved', true);
end;
$$;
revoke all on function public.wayne_admin_set_staff_pin(uuid, text) from public, anon;
grant execute on function public.wayne_admin_set_staff_pin(uuid, text) to authenticated;

-- Which profiles have a PIN, and which are PIN-only (for the Staff page).
create or replace function public.wayne_admin_staff_pins()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  if not public.wayne_has_permission('staff.view') then raise exception 'Staff permission required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'profile_id', profile.id,
      'has_pin', exists (select 1 from public.staff_pins pin where pin.profile_id = profile.id),
      'pin_only', coalesce((u.raw_app_meta_data ->> 'pin_only')::boolean, false),
      'clocked_in_at', (select punch.clocked_in_at from public.staff_time_punches punch where punch.profile_id = profile.id and punch.clocked_out_at is null)))
    from public.profiles profile left join auth.users u on u.id = profile.id), '[]'::jsonb);
end;
$$;
revoke all on function public.wayne_admin_staff_pins() from public, anon;
grant execute on function public.wayne_admin_staff_pins() to authenticated;

-- Unlock Admin with an owner's or manager's PIN.  Returns a one-time token for
-- an httpOnly cookie; only its hash is stored.
create or replace function public.wayne_admin_pin_unlock(pin_value text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  match jsonb;
  who uuid;
  token text;
begin
  if not public.wayne_has_permission('admin.access') then raise exception 'Admin access required' using errcode = '42501'; end if;
  match := public.wayne_pin_match(pin_value, 'admin_unlock');
  if not (match ->> 'ok')::boolean then return match; end if;
  who := (match ->> 'profile_id')::uuid;
  if not public.wayne_profile_has_permission(who, 'admin.access') then
    return jsonb_build_object('ok', false, 'error', public.wayne_profile_name(who) || ' can''t open Admin. A manager or the owner has to enter their PIN.');
  end if;
  delete from public.admin_unlocks where device_user_id = auth.uid() or expires_at < now();
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.admin_unlocks (token_hash, device_user_id, unlocked_by_profile_id, expires_at)
  values (encode(extensions.digest(token, 'sha256'), 'hex'), auth.uid(), who, now() + interval '15 minutes');
  perform public.wayne_write_audit('admin.pin_unlocked', 'profiles', who::text,
    'Admin unlocked with PIN: ' || public.wayne_profile_name(who), '{}'::jsonb, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'token', token, 'name', public.wayne_profile_name(who));
end;
$$;
revoke all on function public.wayne_admin_pin_unlock(text) from public, anon;
grant execute on function public.wayne_admin_pin_unlock(text) to authenticated;

-- Is this device's Admin unlocked?  Slides the 15-minute idle window.
create or replace function public.wayne_admin_unlock_check(token_value text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  row_found public.admin_unlocks%rowtype;
begin
  if auth.uid() is null or coalesce(token_value, '') = '' then return jsonb_build_object('unlocked', false); end if;
  update public.admin_unlocks set expires_at = now() + interval '15 minutes'
   where token_hash = encode(extensions.digest(token_value, 'sha256'), 'hex') and device_user_id = auth.uid() and expires_at > now()
   returning * into row_found;
  if not found then return jsonb_build_object('unlocked', false); end if;
  return jsonb_build_object('unlocked', true, 'name', public.wayne_profile_name(row_found.unlocked_by_profile_id));
end;
$$;
revoke all on function public.wayne_admin_unlock_check(text) from public, anon;
grant execute on function public.wayne_admin_unlock_check(text) to authenticated;

create or replace function public.wayne_admin_lock()
returns void
language sql
security definer
set search_path to ''
as $$
  delete from public.admin_unlocks where device_user_id = auth.uid();
$$;
revoke all on function public.wayne_admin_lock() from public, anon;
grant execute on function public.wayne_admin_lock() to authenticated;

-- POS: clock in or out with a PIN (it flips whatever the person is now).
create or replace function public.wayne_pos_pin_clock(pin_value text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  match jsonb;
  who uuid;
  open_punch public.staff_time_punches%rowtype;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  match := public.wayne_pin_match(pin_value, 'clock');
  if not (match ->> 'ok')::boolean then return match; end if;
  who := (match ->> 'profile_id')::uuid;
  select * into open_punch from public.staff_time_punches where profile_id = who and clocked_out_at is null for update;
  if found then
    update public.staff_time_punches set clocked_out_at = now() where id = open_punch.id;
    return jsonb_build_object('ok', true, 'name', public.wayne_profile_name(who), 'clocked_in', false,
      'minutes', greatest(0, round(extract(epoch from (now() - open_punch.clocked_in_at)) / 60)));
  end if;
  insert into public.staff_time_punches (profile_id, device_user_id) values (who, auth.uid());
  return jsonb_build_object('ok', true, 'name', public.wayne_profile_name(who), 'clocked_in', true,
    'is_driver', public.wayne_profile_has_permission(who, 'driver.access'));
end;
$$;
revoke all on function public.wayne_pos_pin_clock(text) from public, anon;
grant execute on function public.wayne_pos_pin_clock(text) to authenticated;

-- POS Deliveries: the driver types his PIN and the chosen orders go out with
-- him.  Clocks him in if he wasn't.
create or replace function public.wayne_pos_send_out_with_pin(target_order_ids uuid[], pin_value text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  match jsonb;
  who uuid;
  order_id uuid;
begin
  if not public.wayne_has_permission('delivery.dispatch') then raise exception 'Delivery dispatch permission required' using errcode = '42501'; end if;
  if coalesce(array_length(target_order_ids, 1), 0) = 0 then raise exception 'Choose the orders first' using errcode = '22023'; end if;
  match := public.wayne_pin_match(pin_value, 'send_out');
  if not (match ->> 'ok')::boolean then return match; end if;
  who := (match ->> 'profile_id')::uuid;
  if not public.wayne_profile_has_permission(who, 'driver.access') then
    return jsonb_build_object('ok', false, 'error', public.wayne_profile_name(who) || ' is not set up as a driver (Admin → Staff → role Driver).');
  end if;
  insert into public.staff_time_punches (profile_id, device_user_id)
  select who, auth.uid() where not exists (select 1 from public.staff_time_punches where profile_id = who and clocked_out_at is null);
  foreach order_id in array target_order_ids loop
    perform public.wayne_pos_send_out(order_id, who);
  end loop;
  return jsonb_build_object('ok', true, 'name', public.wayne_profile_name(who), 'count', array_length(target_order_ids, 1));
end;
$$;
revoke all on function public.wayne_pos_send_out_with_pin(uuid[], text) from public, anon;
grant execute on function public.wayne_pos_send_out_with_pin(uuid[], text) to authenticated;

-- Deliveries board: drivers who are clocked in, plus anyone still holding
-- orders that haven't been cashed out.
create or replace function public.wayne_pos_delivery_board()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not public.wayne_has_permission('delivery.dispatch') then raise exception 'Delivery dispatch permission required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'waiting', coalesce((
      select jsonb_agg(public.wayne_pos_delivery_order_json(o.id) order by o.placed_at)
      from public.orders o
      where o.fulfillment_type = 'delivery' and o.status in ('placed', 'accepted', 'in_kitchen', 'ready')
        and o.placed_at > now() - interval '36 hours'
        and not exists (select 1 from public.delivery_assignments a where a.order_id = o.id and a.status <> 'released')), '[]'::jsonb),
    'drivers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id', d.id,
        'name', d.name,
        'clocked_in', d.clocked_in,
        'last_cashout_at', (select max(c.created_at) from public.driver_cashouts c where c.driver_id = d.id),
        'orders', d.orders)
        order by d.name)
      from (
        select profile.id,
          coalesce(nullif(profile.display_name, ''), nullif(btrim(coalesce(profile.first_name, '') || ' ' || coalesce(profile.last_name, '')), ''), 'Driver') as name,
          exists (select 1 from public.staff_time_punches punch where punch.profile_id = profile.id and punch.clocked_out_at is null) as clocked_in,
          coalesce((
            select jsonb_agg(public.wayne_pos_delivery_order_json(a.order_id) || jsonb_build_object(
                'assignment_status', a.status, 'assigned_at', a.assigned_at, 'delivered_at', a.delivered_at,
                'cash_collected_cents', a.cash_collected_cents) order by a.assigned_at)
            from public.delivery_assignments a join public.orders o on o.id = a.order_id
            where a.driver_id = profile.id and a.status <> 'released' and a.cashout_id is null
              and o.status <> 'cancelled' and a.assigned_at > now() - interval '6 days'), '[]'::jsonb) as orders
        from public.profiles profile
        where profile.active and public.wayne_profile_has_permission(profile.id, 'driver.access')
      ) d
      where d.clocked_in or jsonb_array_length(d.orders) > 0), '[]'::jsonb));
end;
$function$;
