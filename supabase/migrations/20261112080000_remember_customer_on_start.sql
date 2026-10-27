-- Save the customer the moment their details are in, not only when an order is
-- sent (owner, 2026-10-27): "saves the name even when not placing a real order,
-- test order, or just adding a customer, and have it save automatically when
-- taking an order, or if you're just adding it add a small save button."
--
-- wayne_pos_remember_customer(payload) is an upsert by phone number, so the
-- order screen can call it every time without ever creating a second profile:
--   * a number already saved (main or extra number) → that profile; a typed
--     name replaces the old one, a blank name never wipes it, and a
--     "Customer" placeholder takes the caller ID name;
--   * a new number → a new profile, named as typed, else from caller ID;
--   * a typed delivery address is added once (the same street is never added
--     twice), with the store's city/state/ZIP filling any blanks.
-- Returns the customer exactly as the POS customer search does.

create or replace function public.wayne_pos_remember_customer(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  phone_value text := public.wayne_normalize_phone(payload ->> 'phone');
  first_value text := left(btrim(coalesce(payload ->> 'first_name', '')), 100);
  last_value text := left(btrim(coalesce(payload ->> 'last_name', '')), 100);
  email_value text := nullif(lower(btrim(coalesce(payload ->> 'email', ''))), '');
  street text := left(btrim(coalesce(payload #>> '{address,address1}', '')), 200);
  settings public.store_settings%rowtype;
  target_id uuid;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if phone_value is null then raise exception 'Enter a valid 10-digit US phone number' using errcode = '22023'; end if;
  if email_value is not null and (char_length(email_value) > 254 or email_value !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    email_value := null; -- a half-typed email never blocks saving the customer
  end if;

  select id into target_id from public.customers where phone_normalized = phone_value for update;
  if target_id is null then
    select extra.customer_id into target_id from public.customer_phones extra
      join public.customers owner on owner.id = extra.customer_id and owner.removed_at is null
     where extra.phone_normalized = phone_value
     limit 1;
  end if;

  if target_id is null then
    insert into public.customers (first_name, last_name, phone_normalized, email_normalized)
    values (coalesce(nullif(first_value, ''), public.wayne_caller_id_name_for(phone_value, null), 'Customer'),
            case when first_value = '' then '' else last_value end, phone_value, email_value)
    returning id into target_id;
  else
    update public.customers saved
       set first_name = coalesce(nullif(first_value, ''),
             case when lower(btrim(saved.first_name)) in ('customer', 'phone caller') and btrim(saved.last_name) = ''
                  then public.wayne_caller_id_name_for(phone_value, null) end,
             saved.first_name),
           last_name = case when first_value = '' then saved.last_name else last_value end,
           email_normalized = coalesce(email_value, saved.email_normalized),
           updated_at = now()
     where saved.id = target_id;
  end if;

  if street <> '' and not exists (
    select 1 from public.customer_addresses saved
     where saved.customer_id = target_id and lower(btrim(saved.address1)) = lower(street)
       and lower(btrim(saved.address2)) = lower(btrim(coalesce(payload #>> '{address,address2}', '')))
  ) then
    select * into settings from public.store_settings where id = true;
    insert into public.customer_addresses (customer_id, address1, address2, city, state, postal_code, delivery_instructions, is_default)
    values (target_id, street,
      left(btrim(coalesce(payload #>> '{address,address2}', '')), 200),
      left(coalesce(nullif(btrim(coalesce(payload #>> '{address,city}', '')), ''), settings.city, ''), 120),
      upper(left(coalesce(nullif(btrim(coalesce(payload #>> '{address,state}', '')), ''), settings.state, ''), 80)),
      left(coalesce(nullif(btrim(coalesce(payload #>> '{address,postal_code}', '')), ''), settings.postal_code, ''), 20),
      left(btrim(coalesce(payload #>> '{address,delivery_instructions}', '')), 1000),
      not exists (select 1 from public.customer_addresses existing where existing.customer_id = target_id));
  end if;

  return public.wayne_pos_customer_json(target_id);
end;
$$;

revoke all on function public.wayne_pos_remember_customer(jsonb) from public, anon;
grant execute on function public.wayne_pos_remember_customer(jsonb) to authenticated, service_role;

comment on function public.wayne_pos_remember_customer(jsonb) is
  'POS: save a customer by phone the moment their details are in (owner, 2026-10-27). Upsert, never a second profile; blank fields never wipe saved ones.';
