-- Owner tips come out of the cash drawer at close out (owner, 2026-10-20:
-- "the tips he gets paid from closing out the store should be deducted from
-- the cash in the cash drawer because now he was short tonight").
--
-- Close out now records the day's owner tips (card + cash tips on every order
-- that isn't a delivery — the "Pay the owner" figure) as a paid out on the
-- open drawer before it is closed, the same way a driver's cash-out records
-- "Driver tips · <name>".  Expected cash therefore drops by those tips.
--
-- Closing out again the same day pays only the difference (e.g. a tip added
-- after the first close out), so the tips are never taken out twice.

create or replace function public.wayne_save_day_closeout(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  zone text;
  day date;
  counted integer := (payload ->> 'counted_cash_cents')::integer;
  clean_note text := left(btrim(coalesce(payload ->> 'note', '')), 1000);
  close_drawer boolean := coalesce((payload ->> 'close_drawer')::boolean, true);
  open_count integer;
  open_shift uuid;
  closed_shift jsonb;
  expected integer;
  report jsonb;
  owner_tips integer;
  tip_reason text;
  already_paid integer;
  to_pay integer := 0;
  unrecorded integer := 0;
  saved public.day_closeouts%rowtype;
begin
  if not public.wayne_has_permission('cash.manage') then
    raise exception 'Only a manager can close out the day' using errcode = '42501';
  end if;
  if counted is null or counted < 0 or counted > 10000000 then
    raise exception 'Count the cash before closing out' using errcode = '22023';
  end if;
  select coalesce(nullif(timezone, ''), 'America/New_York') into zone from public.store_settings where id = true;
  zone := coalesce(zone, 'America/New_York');
  day := coalesce(nullif(payload ->> 'business_date', '')::date, (now() at time zone zone)::date);

  select count(*), (array_agg(id order by opened_at desc))[1] into open_count, open_shift
    from public.register_shifts where status = 'open';
  if open_count > 1 then
    raise exception 'More than one drawer is open. Close the other registers'' drawers first.' using errcode = 'P0001';
  end if;

  -- The owner's tips for the day, less what earlier close outs already took out.
  report := public.wayne_day_closeout(day);
  owner_tips := coalesce((report #>> '{tip_payout,owner_card_tips_cents}')::integer, 0)
              + coalesce((report #>> '{tip_payout,owner_cash_tips_cents}')::integer, 0);
  tip_reason := 'Owner tips · ' || day::text;
  select coalesce(sum(case when kind = 'paid_out' then amount_cents when kind = 'paid_in' then -amount_cents else 0 end), 0)
    into already_paid from public.cash_movements where reason = tip_reason;
  to_pay := owner_tips - already_paid;

  if close_drawer and open_count = 1 then
    if to_pay <> 0 then
      -- A tip refunded after an earlier close out puts the money back in.
      insert into public.cash_movements (shift_id, kind, amount_cents, reason, actor_user_id)
      values (open_shift, case when to_pay > 0 then 'paid_out' else 'paid_in' end, abs(to_pay), tip_reason, auth.uid());
    end if;
    closed_shift := public.wayne_close_shift(jsonb_build_object('shift_id', open_shift, 'counted_cash_cents', counted, 'close_note', clean_note));
    expected := (closed_shift ->> 'expected_cash_cents')::integer;
  else
    -- No drawer to record it on: still take the tips out of what is expected.
    unrecorded := to_pay;
  end if;

  report := public.wayne_day_closeout(day);
  if expected is null then
    expected := coalesce(
      nullif((select sum((shift ->> 'expected_cash_cents')::integer) from jsonb_array_elements(report #> '{drawer,closed_today}') shift), 0),
      (report #>> '{tenders,cash_cents}')::integer - (report #>> '{refunds,cash_cents}')::integer) - unrecorded;
  end if;

  insert into public.day_closeouts (business_date, counted_cash_cents, expected_cash_cents, variance_cents, denominations, report, note, closed_by_user_id, closed_at)
  values (day, counted, expected, counted - expected, coalesce(payload -> 'denominations', '{}'::jsonb), report, clean_note, auth.uid(), now())
  on conflict (location_id, business_date) do update set
    counted_cash_cents = excluded.counted_cash_cents, expected_cash_cents = excluded.expected_cash_cents,
    variance_cents = excluded.variance_cents, denominations = excluded.denominations, report = excluded.report,
    note = excluded.note, closed_by_user_id = excluded.closed_by_user_id, closed_at = excluded.closed_at
  returning * into saved;

  perform public.wayne_write_audit('cash.day_closed', 'day_closeouts', saved.id::text,
    'Closed out ' || day::text || ': counted ' || (counted / 100.0)::numeric(12,2)::text
      || ', expected ' || (expected / 100.0)::numeric(12,2)::text
      || case when to_pay <> 0 then ', owner tips paid out ' || (to_pay / 100.0)::numeric(12,2)::text else '' end,
    '{}'::jsonb, jsonb_build_object('counted_cash_cents', counted, 'expected_cash_cents', expected, 'variance_cents', counted - expected,
      'owner_tips_paid_out_cents', to_pay));

  return to_jsonb(saved) - 'report' - 'workspace_id' - 'location_id';
end;
$$;

revoke all on function public.wayne_save_day_closeout(jsonb) from public, anon;
grant execute on function public.wayne_save_day_closeout(jsonb) to authenticated;

-- What earlier close outs already paid the owner out of the drawer for a day,
-- so the Close Out screen shows the same Expected the save will use.
create or replace function public.wayne_owner_tips_paid_out(target_day date)
returns integer language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.wayne_has_permission('cash.manage') or public.wayne_has_permission('reports.view')) then
    raise exception 'Manager permission required' using errcode = '42501';
  end if;
  return (select coalesce(sum(case when kind = 'paid_out' then amount_cents when kind = 'paid_in' then -amount_cents else 0 end), 0)::integer
    from public.cash_movements where reason = 'Owner tips · ' || target_day::text);
end;
$$;

revoke all on function public.wayne_owner_tips_paid_out(date) from public, anon;
grant execute on function public.wayne_owner_tips_paid_out(date) to authenticated;
