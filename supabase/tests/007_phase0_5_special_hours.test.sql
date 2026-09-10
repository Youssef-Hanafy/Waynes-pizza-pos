begin;
set local search_path = public, extensions;
select plan(4);

update public.store_settings
set ordering_open = true,
    timezone = 'America/New_York',
    business_hours = '{
      "sunday":{"closed":true,"open":"","close":""},
      "monday":{"closed":true,"open":"","close":""},
      "tuesday":{"closed":true,"open":"","close":""},
      "wednesday":{"closed":true,"open":"","close":""},
      "thursday":{"closed":true,"open":"","close":""},
      "friday":{"closed":true,"open":"","close":""},
      "saturday":{"closed":true,"open":"","close":""}
    }'::jsonb;
insert into public.store_special_hours(service_date, label, closed, opens_at, closes_at, public_note)
values (current_date - 1, 'Late overnight', false, '20:00', '02:00', '');

select ok(public.wayne_store_is_open((current_date::timestamp + time '01:00') at time zone 'America/New_York'), 'Yesterday overnight special hours keep ordering open at 1 AM');
select ok(not public.wayne_store_is_open((current_date::timestamp + time '02:00') at time zone 'America/New_York'), 'Yesterday overnight special hours close at 2 AM');
set local role anon;
select is((public.wayne_public_store_settings() -> 'special_hours' -> 0 ->> 'service_date'), (current_date - 1)::text, 'public store settings include yesterday special hours for overnight display logic');
reset role;
select is((select count(*) from public.store_special_hours where service_date = current_date - 1), 1::bigint, 'special-hours fixture exists only inside this test transaction');

select * from finish();
rollback;
