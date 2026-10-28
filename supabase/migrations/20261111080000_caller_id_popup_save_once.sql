-- Caller ID like a saved contact; save a customer once, never twice (owner, 2026-10-27).
--
-- "When the customer calls, their profile with the name, phone number and
-- address pops up automatically before you accept the line … so in the end you
-- only have to save a customer once, never twice, unless it's a new customer."
--
-- What was going wrong in the live data:
--   * 16 of 63 customers were saved as "Customer" because no name was typed on
--     a phone order, so a returning caller's card said "Customer".
--   * Since 2026-10-26 the caller ID box reports every call on BOTH lines half a
--     second apart ($01 and $02, same number), giving two cards per caller.
--   * A phone order started from Pickup instead of the ringing line could be
--     saved with no number at all, so that caller was never recognised.
--
-- Changes:
--   1. wayne_caller_id_person_name(): the phone company's name when it reads as
--      a person ("DAVID STRUB" → "David Strub"), never "WIRELESS CALLER" or a
--      town ("NORTHFIELD MA").  Mirrors src/lib/phone/caller-display.ts.
--   2. wayne_create_pos_order(): a customer saved with no typed name takes the
--      caller ID name; a "Customer" profile is renamed the same way on their next
--      order; a phone order linked to a call takes the call's number when none
--      was typed; the order's name snapshot uses the saved name.
--   3. wayne_record_phone_call(): the same number on another line within five
--      seconds is the same call, not a second caller.
--   4. Backfill: "Customer" profiles get their caller ID name where one exists.
--
-- The two functions are patched in place from their live definitions, and every
-- patch must apply, so nothing else in them changes.

create or replace function public.wayne_caller_id_person_name(raw text)
returns text
language plpgsql
immutable
set search_path to ''
as $$
declare
  cleaned text := upper(btrim(regexp_replace(coalesce(raw, ''), '[_[:space:]]+', ' ', 'g')));
begin
  if char_length(regexp_replace(cleaned, '[^A-Z]', '', 'g')) < 2 then return null; end if;
  if cleaned ~ '[0-9]' then return null; end if;
  if cleaned ~ '^(WIRELESS CALLER|WIRELESS|CELL PHONE|CELLULAR|UNKNOWN|UNKNOWN CALLER|UNKNOWN NAME|UNAVAILABLE|NAME UNAVAILABLE|NOT AVAILABLE|PRIVATE|PRIVATE CALLER|PRIVATE NUMBER|ANONYMOUS|RESTRICTED|BLOCKED|TOLL FREE|TOLL FREE CALLER|OUT OF AREA|O|P)$' then return null; end if;
  -- "CITY ST": the carrier had no name for the number.
  if cleaned ~ ' (A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$' then return null; end if;
  -- "PEREZ,KEVIN" / "BOTSIS, JOHN": the carrier's LAST,FIRST order.
  if position(',' in cleaned) > 0 then
    cleaned := btrim(btrim(split_part(cleaned, ',', 2)) || ' ' || btrim(split_part(cleaned, ',', 1)));
  end if;
  return left(initcap(lower(cleaned)), 100);
end;
$$;

comment on function public.wayne_caller_id_person_name(text) is
  'Caller ID name when it reads as a person or business; null for WIRELESS CALLER, CITY ST, digits. Mirrors src/lib/phone/caller-display.ts.';

-- The caller ID name for a number: from the call the order came from, else the
-- newest ring from that number that carried a usable name.
create or replace function public.wayne_caller_id_name_for(phone text, call_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (select public.wayne_caller_id_person_name(call_row.caller_name) from public.phone_calls call_row where call_row.id = call_id),
    (select public.wayne_caller_id_person_name(call_row.caller_name)
       from public.phone_calls call_row
      where phone is not null and call_row.caller_number = phone
        and public.wayne_caller_id_person_name(call_row.caller_name) is not null
      order by call_row.started_at desc
      limit 1)
  );
$$;

revoke all on function public.wayne_caller_id_name_for(text, uuid) from public, anon;
grant execute on function public.wayne_caller_id_name_for(text, uuid) to authenticated, service_role;

do $patch$
declare
  def text;
  patched text;

begin
  -- 2. wayne_create_pos_order ------------------------------------------------
  def := pg_get_functiondef('public.wayne_create_pos_order(jsonb)'::regprocedure);
  patched := def;

  -- a. A phone order linked to a call keeps the call's number when none was typed.
  --    (2026-10-28) The live function has no comment between these two lines, but a
  --    database built from the migrations does (20261024080000 adds one); drop it
  --    first so this migration also replays on a fresh database.  No effect live.
  patched := replace(patched,
    $old$    normalized_phone := public.wayne_normalize_phone(payload ->> 'phone');
    -- Nothing is required in a rush; a phone that was typed must still be a real number.
    if normalized_phone is null and char_length$old$,
    $new$    normalized_phone := public.wayne_normalize_phone(payload ->> 'phone');
    if normalized_phone is null and char_length$new$);
  patched := replace(patched,
    $old$    normalized_phone := public.wayne_normalize_phone(payload ->> 'phone');
    if normalized_phone is null and char_length$old$,
    $new$    normalized_phone := coalesce(public.wayne_normalize_phone(payload ->> 'phone'),
      case when linked_call_id is not null and char_length(regexp_replace(coalesce(payload ->> 'phone', ''), '[^0-9]', '', 'g')) = 0
           then (select call_row.caller_number from public.phone_calls call_row where call_row.id = linked_call_id) end);
    if normalized_phone is null and char_length$new$);
  if patched = def then raise exception 'caller-id patch: phone fallback anchor not found in wayne_create_pos_order'; end if;
  def := patched;

  -- b. A new customer with no typed name is saved under the caller ID name.
  patched := replace(patched,
    $old$values (coalesce(nullif(btrim(coalesce(payload ->> 'first_name', '')), ''), 'Customer'), btrim(coalesce(payload ->> 'last_name', '')), normalized_phone, normalized_email)$old$,
    $new$values (coalesce(nullif(btrim(coalesce(payload ->> 'first_name', '')), ''), public.wayne_caller_id_name_for(normalized_phone, linked_call_id), 'Customer'), btrim(coalesce(payload ->> 'last_name', '')), normalized_phone, normalized_email)$new$);
  if patched = def then raise exception 'caller-id patch: new-customer name anchor not found in wayne_create_pos_order'; end if;
  def := patched;

  -- c. A "Customer" profile is renamed from caller ID on its next order.
  patched := replace(patched,
    $old$update public.customers set first_name = coalesce(nullif(btrim(coalesce(payload ->> 'first_name', '')), ''), first_name),$old$,
    $new$update public.customers set first_name = coalesce(nullif(btrim(coalesce(payload ->> 'first_name', '')), ''),
        case when lower(btrim(first_name)) in ('customer', 'phone caller') and btrim(last_name) = '' then public.wayne_caller_id_name_for(normalized_phone, linked_call_id) end,
        first_name),$new$);
  if patched = def then raise exception 'caller-id patch: customer update anchor not found in wayne_create_pos_order'; end if;
  def := patched;

  -- d. The order (and its kitchen slip) carries the saved name, not "Phone caller".
  patched := replace(patched,
    $old$  normalized_phone := coalesce(normalized_phone, '');
  if is_test_order then customer_name$old$,
    $new$  if customer_name = 'Phone caller' and created_customer_id is not null then
    customer_name := coalesce((select left(nullif(btrim(saved.first_name || ' ' || saved.last_name), ''), 200)
                                 from public.customers saved
                                where saved.id = created_customer_id
                                  and lower(btrim(saved.first_name)) not in ('customer', 'phone caller')), 'Phone caller');
  end if;
  normalized_phone := coalesce(normalized_phone, '');
  if is_test_order then customer_name$new$);
  if patched = def then raise exception 'caller-id patch: name snapshot anchor not found in wayne_create_pos_order'; end if;
  execute patched;

  -- 3. wayne_record_phone_call -----------------------------------------------
  def := pg_get_functiondef('public.wayne_record_phone_call(jsonb)'::regprocedure);
  patched := replace(def,
    $old$  select array_agg(match_id) into matched_ids from public.wayne_phone_matches(normalized) match_id;$old$,
    $new$  -- One call reported on both lines (owner, 2026-10-27): since 2026-10-26 the
  -- caller ID box sends $01 and $02 for the same ring half a second apart.  One
  -- number cannot really ring two lines in the same five seconds, so the second
  -- report is the same call and never becomes a second card.
  if normalized is not null and direction_value = 'inbound' then
    select * into call_row
      from public.phone_calls other_line
     where other_line.caller_number = normalized
       and other_line.direction = 'inbound'
       and other_line.line_number <> line
       and other_line.started_at between occurred - interval '5 seconds' and occurred + interval '5 seconds'
     order by other_line.started_at
     limit 1;
    if call_row.id is not null then
      return jsonb_build_object('ok', true, 'duplicate', true, 'call_id', call_row.id, 'event', 'start',
        'line_number', call_row.line_number, 'caller_number', call_row.caller_number, 'matched', call_row.customer_id is not null);
    end if;
  end if;

  select array_agg(match_id) into matched_ids from public.wayne_phone_matches(normalized) match_id;$new$);
  if patched = def then raise exception 'caller-id patch: matching anchor not found in wayne_record_phone_call'; end if;
  execute patched;
end;
$patch$;

-- 4. Backfill: "Customer" profiles take the caller ID name their calls carried.
update public.customers customer
   set first_name = named.caller_name, updated_at = now()
  from (
    select distinct on (customer_row.id) customer_row.id, public.wayne_caller_id_person_name(call_row.caller_name) caller_name
      from public.customers customer_row
      join public.phone_calls call_row on call_row.caller_number = customer_row.phone_normalized
     where lower(btrim(customer_row.first_name)) in ('customer', 'phone caller')
       and btrim(customer_row.last_name) = ''
       and public.wayne_caller_id_person_name(call_row.caller_name) is not null
     order by customer_row.id, call_row.started_at desc
  ) named
 where customer.id = named.id;
