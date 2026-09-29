-- Wayne's Pizza POS — phone-line build, Phase 6 (order synchronization and
-- reliability), Phase 7 preparation (printable order documents) and Phase 9
-- preparation (the store pilot checklist).
--
--   * pos_drafts: tickets in progress, mirrored from each register so another
--     register can see a held ticket and take it over (§22, §36), and so a
--     register that dies does not take its tickets with it (§30).
--   * wayne_pos_print_document: everything a receipt or kitchen ticket needs,
--     protocol-free (§23); the printer layer decides how to put it on paper.
--   * pilot_checks: the side-by-side pilot with Thrive (§40 Phase 9, §57),
--     ticked off by the owner or a manager with a go / no-go answer.

-- ---------------------------------------------------------------------------
-- 0. Permission for the pilot checklist: owner and manager.
-- ---------------------------------------------------------------------------
insert into public.permissions (id, code, description) values
  ('20000000-0000-4000-8000-000000000028', 'pilot.manage', 'Record store-pilot test results and the go-live decision')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
  from public.roles role
  join public.permissions permission on permission.code = 'pilot.manage'
 where role.code in ('owner', 'manager')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 1. Drafts shared between registers (Phase 6).
-- ---------------------------------------------------------------------------
create table if not exists public.pos_drafts (
  id uuid primary key,
  idempotency_key text not null unique check (char_length(idempotency_key) between 16 and 160),
  -- The register holding the ticket. A browser-generated id, not the staff
  -- login, because two registers are often signed in as the same person.
  device_id text not null check (char_length(device_id) between 8 and 80),
  terminal text not null default '' check (char_length(terminal) <= 60),
  owner_profile_id uuid references public.profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'held', 'submitted', 'discarded')),
  label text not null default '' check (char_length(label) <= 120),
  item_count integer not null default 0 check (item_count between 0 and 200),
  phone_line smallint check (phone_line is null or phone_line between 1 and 8),
  phone_call_id uuid references public.phone_calls(id) on delete set null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 200000),
  version integer not null default 1 check (version >= 1),
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists pos_drafts_live_idx on public.pos_drafts (updated_at desc) where status in ('open', 'held');
create index if not exists pos_drafts_device_idx on public.pos_drafts (device_id, updated_at desc);

comment on table public.pos_drafts is
  'Tickets in progress on each register, mirrored so they can be seen and taken over from another register.';

alter table public.pos_drafts enable row level security;
revoke all on table public.pos_drafts from anon, authenticated;
-- Readable by POS staff so Supabase Realtime can tell every register when a
-- ticket is held, taken over or sent.  Writes go through the functions below.
grant select on table public.pos_drafts to authenticated;
drop policy if exists pos_drafts_pos_read on public.pos_drafts;
create policy pos_drafts_pos_read on public.pos_drafts for select to authenticated
  using (public.wayne_has_permission('pos.access'));

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pos_drafts') then
    alter publication supabase_realtime add table public.pos_drafts;
  end if;
end $$;

create or replace function public.wayne_pos_draft_json(target_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', draft.id, 'idempotency_key', draft.idempotency_key, 'device_id', draft.device_id,
    'terminal', draft.terminal, 'owner_name', owner.display_name, 'status', draft.status,
    'label', draft.label, 'item_count', draft.item_count, 'phone_line', draft.phone_line,
    'phone_call_id', draft.phone_call_id, 'payload', draft.payload, 'version', draft.version,
    'order_id', draft.order_id, 'created_at', draft.created_at, 'updated_at', draft.updated_at
  )
  from public.pos_drafts draft
  left join public.profiles owner on owner.id = draft.owner_profile_id
  where draft.id = target_id;
$$;
revoke all on function public.wayne_pos_draft_json(uuid) from public, anon, authenticated;

-- Save one register's ticket.  The register that holds it may always save it.
-- Another register gets a conflict back instead of silently overwriting — the
-- ticket may have been taken over while this one was offline.
create or replace function public.wayne_pos_sync_draft(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  draft_id uuid := (payload ->> 'id')::uuid;
  device text := left(btrim(coalesce(payload ->> 'device_id', '')), 80);
  status_value text := coalesce(payload ->> 'status', 'open');
  body jsonb := payload -> 'payload';
  existing public.pos_drafts;
  key_value text := btrim(coalesce(payload ->> 'idempotency_key', ''));
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if draft_id is null or char_length(device) < 8 then raise exception 'A draft id and register id are required' using errcode = '22023'; end if;
  if status_value not in ('open', 'held') then raise exception 'Only open or held tickets can be saved' using errcode = '22023'; end if;
  if body is null or jsonb_typeof(body) <> 'object' then raise exception 'The ticket body is missing' using errcode = '22023'; end if;

  select * into existing from public.pos_drafts where id = draft_id for update;
  if found then
    if existing.status in ('submitted', 'discarded') then
      return jsonb_build_object('ok', false, 'reason', 'closed', 'draft', public.wayne_pos_draft_json(draft_id));
    end if;
    if existing.device_id <> device then
      return jsonb_build_object('ok', false, 'reason', 'taken', 'draft', public.wayne_pos_draft_json(draft_id));
    end if;
    update public.pos_drafts set
      terminal = left(btrim(coalesce(payload ->> 'terminal', terminal)), 60),
      owner_profile_id = auth.uid(),
      status = status_value,
      label = left(coalesce(payload ->> 'label', label), 120),
      item_count = least(greatest(coalesce((payload ->> 'item_count')::integer, 0), 0), 200),
      phone_line = nullif(payload ->> 'phone_line', '')::smallint,
      phone_call_id = (select id from public.phone_calls where id = nullif(payload ->> 'phone_call_id', '')::uuid),
      payload = body,
      version = version + 1,
      updated_at = now()
    where id = draft_id;
  else
    if char_length(key_value) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;
    -- A ticket already sent (its order exists) is never resurrected as a draft.
    if exists (select 1 from public.orders where idempotency_key = key_value) then
      return jsonb_build_object('ok', false, 'reason', 'closed', 'draft', null);
    end if;
    insert into public.pos_drafts (id, idempotency_key, device_id, terminal, owner_profile_id, status, label, item_count, phone_line, phone_call_id, payload)
    values (
      draft_id, key_value, device, left(btrim(coalesce(payload ->> 'terminal', '')), 60), auth.uid(), status_value,
      left(coalesce(payload ->> 'label', ''), 120),
      least(greatest(coalesce((payload ->> 'item_count')::integer, 0), 0), 200),
      nullif(payload ->> 'phone_line', '')::smallint,
      (select id from public.phone_calls where id = nullif(payload ->> 'phone_call_id', '')::uuid),
      body
    );
  end if;
  return jsonb_build_object('ok', true, 'draft', public.wayne_pos_draft_json(draft_id) - 'payload');
end;
$$;

-- Tickets in progress on every register in the last day.  A ticket whose
-- order already exists is closed here, so a sent ticket never lingers.
create or replace function public.wayne_pos_open_drafts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  update public.pos_drafts draft
     set status = 'submitted', order_id = order_row.id, closed_at = now(), updated_at = now(), version = draft.version + 1
    from public.orders order_row
   where order_row.idempotency_key = draft.idempotency_key
     and draft.status in ('open', 'held');
  return coalesce((
    select jsonb_agg(public.wayne_pos_draft_json(draft.id) - 'payload' order by draft.updated_at desc)
      from public.pos_drafts draft
     where draft.status in ('open', 'held')
       and draft.updated_at > now() - interval '24 hours'
  ), '[]'::jsonb);
end;
$$;

-- Take a ticket over from another register (§36: another employee takes the
-- order).  Returns the full ticket so this register can carry on with it.
create or replace function public.wayne_pos_take_draft(target_id uuid, device text, terminal text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  existing public.pos_drafts;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(device, ''))) < 8 then raise exception 'A register id is required' using errcode = '22023'; end if;
  select * into existing from public.pos_drafts where id = target_id for update;
  if not found then raise exception 'That ticket was not found' using errcode = 'P0002'; end if;
  if existing.status in ('submitted', 'discarded') then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'draft', public.wayne_pos_draft_json(target_id));
  end if;
  update public.pos_drafts
     set device_id = left(btrim(device), 80), terminal = left(btrim(coalesce(terminal, '')), 60),
         owner_profile_id = auth.uid(), status = 'open', version = version + 1, updated_at = now()
   where id = target_id;
  perform public.wayne_write_audit('pos.ticket_taken_over', 'pos_draft', target_id::text,
    'Ticket moved to ' || coalesce(nullif(btrim(terminal), ''), 'another register'),
    jsonb_build_object('from_terminal', existing.terminal, 'to_terminal', btrim(coalesce(terminal, ''))));
  return jsonb_build_object('ok', true, 'draft', public.wayne_pos_draft_json(target_id));
end;
$$;

-- Close a ticket: it was sent (the order exists) or cleared on purpose.
create or replace function public.wayne_pos_close_draft(target_id uuid, device text, outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.pos_drafts;
  linked_order uuid;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if outcome not in ('submitted', 'discarded') then raise exception 'Unknown outcome' using errcode = '22023'; end if;
  select * into existing from public.pos_drafts where id = target_id for update;
  if not found then return jsonb_build_object('ok', true, 'draft', null); end if;
  if existing.status in ('submitted', 'discarded') then return jsonb_build_object('ok', true, 'draft', public.wayne_pos_draft_json(target_id) - 'payload'); end if;
  -- Only the holding register may discard; anyone may record that it was sent.
  if outcome = 'discarded' and existing.device_id <> btrim(coalesce(device, '')) then
    return jsonb_build_object('ok', false, 'reason', 'taken', 'draft', public.wayne_pos_draft_json(target_id) - 'payload');
  end if;
  select id into linked_order from public.orders where idempotency_key = existing.idempotency_key;
  if outcome = 'submitted' and linked_order is null then
    raise exception 'That ticket has not been sent yet' using errcode = 'P0001';
  end if;
  update public.pos_drafts
     set status = outcome, order_id = linked_order, closed_at = now(), updated_at = now(), version = version + 1
   where id = target_id;
  return jsonb_build_object('ok', true, 'draft', public.wayne_pos_draft_json(target_id) - 'payload');
end;
$$;

revoke all on function public.wayne_pos_sync_draft(jsonb) from public, anon;
revoke all on function public.wayne_pos_open_drafts() from public, anon;
revoke all on function public.wayne_pos_take_draft(uuid, text, text) from public, anon;
revoke all on function public.wayne_pos_close_draft(uuid, text, text) from public, anon;
grant execute on function public.wayne_pos_sync_draft(jsonb) to authenticated;
grant execute on function public.wayne_pos_open_drafts() to authenticated;
grant execute on function public.wayne_pos_take_draft(uuid, text, text) to authenticated;
grant execute on function public.wayne_pos_close_draft(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. What a receipt or kitchen ticket needs (Phase 7 preparation, §23).
--    Plain data: no printer protocol, no layout.
-- ---------------------------------------------------------------------------
create or replace function public.wayne_pos_print_document(target_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  settings public.store_settings%rowtype;
begin
  if not (public.wayne_has_permission('pos.access') or public.wayne_has_permission('printing.manage')) then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  select * into settings from public.store_settings where id = true;
  return (
    select jsonb_build_object(
      'store', jsonb_build_object(
        'name', settings.store_name, 'address_line1', settings.address_line1, 'address_line2', settings.address_line2,
        'city', settings.city, 'state', settings.state, 'postal_code', settings.postal_code,
        'phone', settings.public_phone, 'timezone', settings.timezone),
      'order', jsonb_build_object(
        'id', order_row.id, 'order_number', order_row.order_number, 'source', order_row.source,
        'fulfillment_type', order_row.fulfillment_type, 'status', order_row.status,
        'payment_status', order_row.payment_status, 'payment_method', order_row.payment_method,
        'placed_at', order_row.placed_at, 'promised_at', order_row.promised_at,
        'phone_line', order_row.phone_line,
        'customer_name', order_row.customer_name_snapshot, 'customer_phone', order_row.customer_phone_snapshot,
        'delivery_address', order_row.delivery_address_snapshot,
        'special_instructions', order_row.special_instructions,
        'subtotal_cents', order_row.subtotal_cents, 'discount_cents', order_row.discount_cents,
        'delivery_fee_cents', order_row.delivery_fee_cents, 'tax_cents', order_row.tax_cents,
        'tip_cents', order_row.tip_cents, 'total_cents', order_row.total_cents,
        'taken_by', staff.display_name),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', item.id, 'name', item.item_name_snapshot, 'variant', item.variant_name_snapshot,
          'category', item.category_name_snapshot, 'station', coalesce(item.kitchen_route_snapshot, 'kitchen'),
          'quantity', item.quantity, 'line_total_cents', item.line_total_cents,
          'instructions', item.special_instructions,
          'modifiers', coalesce((
            select jsonb_agg(jsonb_build_object('name', modifier.modifier_name_snapshot, 'group', modifier.modifier_group_name_snapshot, 'quantity', modifier.quantity) order by modifier.created_at, modifier.id)
              from public.order_item_modifiers modifier where modifier.order_item_id = item.id), '[]'::jsonb)
        ) order by item.created_at, item.id)
          from public.order_items item where item.order_id = order_row.id), '[]'::jsonb)
    )
    from public.orders order_row
    left join public.profiles staff on staff.id = order_row.created_by_user_id
    where order_row.id = target_order_id
  );
end;
$$;
revoke all on function public.wayne_pos_print_document(uuid) from public, anon;
grant execute on function public.wayne_pos_print_document(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The store pilot (Phase 9 preparation): run beside Thrive, tick every
--    check, and only then retire Thrive (§40 Phase 9, §39 native tests, §57).
-- ---------------------------------------------------------------------------
create table if not exists public.pilot_checks (
  key text primary key check (key ~ '^[a-z0-9_]{3,60}$'),
  section text not null check (char_length(section) between 1 and 60),
  label text not null check (char_length(label) between 1 and 300),
  detail text not null default '' check (char_length(detail) <= 600),
  required boolean not null default true,
  sort_order integer not null default 0,
  result text check (result is null or result in ('pass', 'fail', 'not_applicable')),
  note text not null default '' check (char_length(note) <= 1000),
  checked_by uuid references public.profiles(id) on delete set null,
  checked_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.pilot_checks enable row level security;
revoke all on table public.pilot_checks from anon, authenticated;

insert into public.pilot_checks (key, section, label, detail, required, sort_order) values
  ('net_tablet_wifi', 'Network', 'Tablet is on Wayne''s POS Wi-Fi (not a guest network) and has internet', 'Build sheet §56–57. Settings → Wi-Fi on the tablet.', true, 10),
  ('net_tablet_ip', 'Network', 'Tablet received an IP address on the same subnet as the caller ID box and printers', 'Write the subnet in the note, e.g. 192.168.88.x.', true, 20),
  ('net_isolation_off', 'Network', 'Client / AP isolation is not blocking the tablet from wired devices', 'EnGenius SSID settings. Do not disable security blindly — only for the POS SSID.', true, 30),
  ('net_callerid_reachable', 'Network', 'CallerID.com box is on the reachable LAN (Admin → Hardware shows its packets)', 'Leave the DIP switches alone while Thrive still uses it (§2.1).', true, 40),
  ('net_printers_reachable', 'Network', 'Receipt and kitchen printers are on the reachable LAN with reserved IPs', 'DHCP reservations on the MikroTik (§48).', true, 50),
  ('call_line1', 'Caller ID', 'Real call on Line 1 shows as Line 1', '', true, 110),
  ('call_line2', 'Caller ID', 'Real call on Line 2 shows as Line 2', '', true, 120),
  ('call_number_name', 'Caller ID', 'Caller number is correct and the caller name appears when the carrier sends it', '', true, 130),
  ('call_no_refresh', 'Caller ID', 'Phone badge and card appear with no refresh, within about a second', '', true, 140),
  ('call_two_close', 'Caller ID', 'Two calls close together land on their own lines', '', true, 150),
  ('call_duplicates', 'Caller ID', 'Repeated packets do not make a second card', '', true, 160),
  ('call_lookup', 'Caller ID', 'A known customer''s card fills in; an unknown number shows New caller', '', true, 170),
  ('call_thrive_parallel', 'Caller ID', 'Thrive still shows the same calls while the new POS runs beside it', 'Proves the box is shared, not taken over.', true, 180),
  ('app_reconnect', 'Reliability', 'Wi-Fi off and on: the POS reconnects and no ticket is lost', '', true, 210),
  ('app_restart', 'Reliability', 'App restart mid-ticket: the ticket comes back', '', true, 220),
  ('app_offline_submit', 'Reliability', 'Order submitted during a dropout is sent once the connection returns — exactly once', '', true, 230),
  ('app_background', 'Reliability', 'App in the background still receives calls when brought back', '', true, 240),
  ('order_menu', 'Orders', 'Full dinner-rush menu entry: sizes, toppings, NO toppings, notes', '', true, 310),
  ('order_phone_pickup', 'Orders', 'Phone pickup order from a real call, customer carried in', '', true, 320),
  ('order_delivery', 'Orders', 'Delivery order with saved address prefilled', '', true, 330),
  ('order_hold_two_lines', 'Orders', 'Taking Line 2 while Line 1''s order is open — both orders correct', '', true, 340),
  ('order_second_register', 'Orders', 'Held ticket taken over on a second register', '', false, 350),
  ('print_receipt', 'Printing', 'Receipt prints correctly on the real receipt printer', 'Phase 7 — needs the printer model.', true, 410),
  ('print_kitchen', 'Printing', 'Kitchen ticket prints on the kitchen printer, routed by category', 'Phase 7 — needs the printer model.', true, 420),
  ('print_drawer', 'Printing', 'Cash drawer opens from the POS through the receipt printer', '', true, 430),
  ('pay_cash', 'Payments', 'Cash payment recorded and change correct; drawer counts balance at close', '', true, 510),
  ('pay_card_terminal', 'Payments', 'Card-terminal workflow: amount run on the terminal and matched to the order', '', true, 520),
  ('shift_full_day', 'Operation', 'A full shift / day run on the new POS beside Thrive with no missed orders', '', true, 610),
  ('shift_totals_match', 'Operation', 'End-of-day totals match Thrive / the processor for the pilot day', '', true, 620),
  ('shift_staff_ok', 'Operation', 'Staff can take orders without help', '', true, 630)
on conflict (key) do nothing;

create or replace function public.wayne_pilot_checklist()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.wayne_has_permission('pilot.manage') or public.wayne_has_permission('admin.access')) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'key', check_row.key, 'section', check_row.section, 'label', check_row.label, 'detail', check_row.detail,
      'required', check_row.required, 'result', check_row.result, 'note', check_row.note,
      'checked_by', checker.display_name, 'checked_at', check_row.checked_at
    ) order by check_row.sort_order, check_row.key)
      from public.pilot_checks check_row
      left join public.profiles checker on checker.id = check_row.checked_by
  ), '[]'::jsonb);
end;
$$;

create or replace function public.wayne_record_pilot_check(target_key text, result_value text, note_value text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous public.pilot_checks;
begin
  if not public.wayne_has_permission('pilot.manage') then
    raise exception 'Only the owner or a manager can record pilot results' using errcode = '42501';
  end if;
  if result_value is not null and result_value not in ('pass', 'fail', 'not_applicable') then
    raise exception 'Unknown result' using errcode = '22023';
  end if;
  select * into previous from public.pilot_checks where key = target_key for update;
  if not found then raise exception 'Unknown pilot check' using errcode = 'P0002'; end if;
  if result_value = 'not_applicable' and previous.required then
    raise exception 'A required check cannot be marked not applicable' using errcode = '22023';
  end if;
  update public.pilot_checks
     set result = result_value, note = left(btrim(coalesce(note_value, '')), 1000),
         checked_by = case when result_value is null then null else auth.uid() end,
         checked_at = case when result_value is null then null else now() end,
         updated_at = now()
   where key = target_key;
  perform public.wayne_write_audit('pilot.check_recorded', 'pilot_check', target_key,
    previous.label || ': ' || coalesce(result_value, 'cleared'),
    jsonb_build_object('before', previous.result, 'after', result_value));
  return public.wayne_pilot_checklist();
end;
$$;

revoke all on function public.wayne_pilot_checklist() from public, anon;
revoke all on function public.wayne_record_pilot_check(text, text, text) from public, anon;
grant execute on function public.wayne_pilot_checklist() to authenticated;
grant execute on function public.wayne_record_pilot_check(text, text, text) to authenticated;
