-- Applied to the Hanafy Media CRM (lgbdfqpnlvjxdlalhnbk) on 2026-09-23 as
-- migration "waynes_order_mirror_and_text_club_list".
--
-- 1. Wayne's order events carried the order, but nothing wrote them into
--    crm_orders, so every Wayne's contact showed 0 orders / $0 / no last
--    order, and CRM segments on days_since_last_purchase or lifetime value
--    ("30-Day Winback", campaign audiences) could never match.  Each order
--    event now upserts one crm_orders row per Wayne's order; the existing
--    crm_orders rollup trigger refreshes the contact.
create or replace function public.crm_mirror_waynes_order()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  o jsonb := new.payload -> 'order';
  mapped text;
begin
  if new.source <> 'waynes-pos' or new.contact_id is null or jsonb_typeof(o) <> 'object'
     or new.event_type not like 'order.%' or coalesce(o ->> 'order_id', '') = '' then
    return new;
  end if;
  mapped := case
    when o ->> 'payment_status' in ('refunded') then 'refunded'
    when new.event_type = 'order.cancelled' or o ->> 'status' = 'cancelled' then 'cancelled'
    when new.event_type = 'order.completed' or o ->> 'status' = 'completed' then 'completed'
    else 'pending'
  end;
  insert into public.crm_orders (business_id, contact_id, external_id, order_number, occurred_at, status, total, channel, source, metadata)
  values (new.business_id, new.contact_id, o ->> 'order_id', o ->> 'order_number', new.occurred_at, mapped,
          round(coalesce((o ->> 'total_cents')::numeric, 0) / 100, 2),
          nullif(o ->> 'fulfillment_type', ''), 'waynes-pos',
          jsonb_build_object('wayne_source', o ->> 'source', 'payment_status', o ->> 'payment_status', 'last_event_id', new.id))
  on conflict (business_id, source, external_id) where external_id is not null do update
  set contact_id = excluded.contact_id,
      order_number = coalesce(excluded.order_number, crm_orders.order_number),
      occurred_at = least(crm_orders.occurred_at, excluded.occurred_at),
      status = case when excluded.status = 'pending' then crm_orders.status else excluded.status end,
      total = excluded.total,
      channel = coalesce(excluded.channel, crm_orders.channel),
      metadata = crm_orders.metadata || excluded.metadata;
  return new;
end;
$$;
revoke all on function public.crm_mirror_waynes_order() from public, anon, authenticated;
drop trigger if exists crm_events_mirror_waynes_order on public.crm_events;
create trigger crm_events_mirror_waynes_order after insert on public.crm_events
for each row execute function public.crm_mirror_waynes_order();

-- Backfill (one row per order; a completed/cancelled event beats "created").
insert into public.crm_orders (business_id, contact_id, external_id, order_number, occurred_at, status, total, channel, source, metadata)
select distinct on (e.business_id, e.payload #>> '{order,order_id}')
  e.business_id, e.contact_id, e.payload #>> '{order,order_id}', e.payload #>> '{order,order_number}',
  min(e.occurred_at) over (partition by e.business_id, e.payload #>> '{order,order_id}'),
  case when e.payload #>> '{order,payment_status}' = 'refunded' then 'refunded'
       when e.event_type = 'order.cancelled' or e.payload #>> '{order,status}' = 'cancelled' then 'cancelled'
       when e.event_type = 'order.completed' or e.payload #>> '{order,status}' = 'completed' then 'completed'
       else 'pending' end,
  round(coalesce((e.payload #>> '{order,total_cents}')::numeric, 0) / 100, 2),
  nullif(e.payload #>> '{order,fulfillment_type}', ''), 'waynes-pos',
  jsonb_build_object('wayne_source', e.payload #>> '{order,source}', 'payment_status', e.payload #>> '{order,payment_status}', 'last_event_id', e.id)
from public.crm_events e
where e.source = 'waynes-pos' and e.event_type like 'order.%' and e.contact_id is not null
  and jsonb_typeof(e.payload -> 'order') = 'object' and coalesce(e.payload #>> '{order,order_id}', '') <> ''
order by e.business_id, e.payload #>> '{order,order_id}',
  case when e.event_type in ('order.cancelled','order.completed') then 0 else 1 end, e.occurred_at desc
on conflict (business_id, source, external_id) where external_id is not null do nothing;

-- 2. "Waynes Pizza Text Club" list follows SMS consent (it had 0 members).
create or replace function public.crm_sync_waynes_text_club()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare club uuid;
begin
  select l.id into club from public.sms_lists l
  where l.business_id = new.business_id and l.name = 'Waynes Pizza Text Club' limit 1;
  if club is null then return new; end if;
  if new.sms_consent and new.archived_at is null and coalesce(new.status, 'active') <> 'blocked' then
    insert into public.sms_list_members (list_id, contact_id) values (club, new.id) on conflict do nothing;
  else
    delete from public.sms_list_members where list_id = club and contact_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function public.crm_sync_waynes_text_club() from public, anon, authenticated;
drop trigger if exists sms_contacts_sync_waynes_text_club on public.sms_contacts;
create trigger sms_contacts_sync_waynes_text_club
after insert or update of sms_consent, archived_at, status on public.sms_contacts
for each row execute function public.crm_sync_waynes_text_club();

insert into public.sms_list_members (list_id, contact_id)
select l.id, c.id from public.sms_contacts c
join public.sms_lists l on l.business_id = c.business_id and l.name = 'Waynes Pizza Text Club'
where c.sms_consent and c.archived_at is null and coalesce(c.status, 'active') <> 'blocked'
on conflict do nothing;
