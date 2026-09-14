-- Two ways a customer can be removed, deliberately not the same thing.
--
--   Removed in the Hanafy CRM  -> they stop being marketed to everywhere, but
--                                 Wayne's keeps them: profile, orders, history.
--                                 Re-joining the text club welcomes them back.
--   Removed in Wayne's         -> their personal data is erased here and the
--                                 CRM contact is deleted. Orders survive with
--                                 the person scrubbed out of them, because
--                                 those rows are the store's books.

-- An erased customer keeps their row so orders still have something to hang
-- from, but the phone has to stop being a real number while staying unique.
alter table public.customers
  drop constraint customers_phone_normalized_check;
alter table public.customers
  add constraint customers_phone_normalized_check
  check (
    phone_normalized ~ '^\+1[0-9]{10}$'
    or phone_normalized ~ '^removed:[0-9a-f-]{36}$'
  );

alter table public.customers
  add column if not exists removed_at timestamptz;

comment on column public.customers.removed_at is
  'Set when the customer was erased from Wayne''s. Their orders remain; every personal field is gone.';

/*
 * Marketing removal, requested by the CRM.
 *
 * Consent history is never deleted - it is the proof that the opt-in was real,
 * and an opt-out is itself a record worth keeping. What goes is the permission
 * and the unclaimed welcome offer, so the person is out of every send and comes
 * back clean if they ever join again.
 */
create or replace function public.wayne_remove_customer_marketing(
  target_phone text,
  source_label text default 'hanafy_crm'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  customer_row public.customers%rowtype;
  removed_codes text[];
begin
  select * into customer_row from public.customers
  where phone_normalized = target_phone;
  if not found then
    return jsonb_build_object('ok', true, 'matched', false);
  end if;

  select coalesce(array_agg(p.code), array[]::text[]) into removed_codes
  from public.promotions p
  where p.private and p.uses_count = 0
    and p.id in (select promotion_id from public.reward_grants where customer_id = customer_row.id);

  delete from public.reward_grants where customer_id = customer_row.id;
  delete from public.promotions
  where private and uses_count = 0 and code = any(removed_codes);

  if customer_row.sms_marketing_opt_in or customer_row.email_marketing_opt_in then
    insert into public.marketing_consents
      (customer_id, channel, status, source, consent_text_version, metadata)
    values
      (customer_row.id, 'sms', 'opted_out', source_label, 'n/a',
       jsonb_build_object('reason', 'Removed in the Hanafy Media CRM'));
  end if;

  update public.customers
  set sms_marketing_opt_in = false,
      email_marketing_opt_in = false
  where id = customer_row.id;

  return jsonb_build_object(
    'ok', true,
    'matched', true,
    'customer_id', customer_row.id,
    'codes_revoked', to_jsonb(removed_codes)
  );
end;
$$;

/*
 * Erasing a customer inside Wayne's.
 *
 * Orders are the store's books, so they stay - but the person is scrubbed out
 * of them, snapshots included, because a receipt carrying their name and phone
 * is still their data. The CRM is told first, while the phone is still readable,
 * so it can find and delete the matching contact.
 */
create or replace function public.wayne_erase_customer(target_customer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  customer_row public.customers%rowtype;
  order_total integer;
begin
  select * into customer_row from public.customers where id = target_customer_id;
  if not found then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if customer_row.removed_at is not null then
    return jsonb_build_object('ok', true, 'already_removed', true);
  end if;

  -- Tell the CRM while the identifiers still mean something.
  perform public.wayne_enqueue_hanafy_event(
    'customer.deleted',
    jsonb_build_object(
      'customer_id', customer_row.id,
      'phone', customer_row.phone_normalized,
      'phone_normalized', customer_row.phone_normalized,
      'email', customer_row.email_normalized,
      'reason', 'Erased in the Wayne''s POS'
    ),
    now()
  );

  delete from public.promotions
  where private and uses_count = 0
    and id in (select promotion_id from public.reward_grants where customer_id = customer_row.id);
  delete from public.reward_grants where customer_id = customer_row.id;
  delete from public.customer_addresses where customer_id = customer_row.id;

  -- Orders keep their money and their items; they lose the person.
  update public.orders
  set customer_name_snapshot = 'Removed customer',
      customer_phone_snapshot = '',
      customer_email_snapshot = null,
      delivery_address_snapshot = null
  where customer_id = customer_row.id;
  get diagnostics order_total = row_count;

  update public.customers
  set first_name = 'Removed',
      last_name = 'Customer',
      phone_normalized = 'removed:' || customer_row.id::text,
      email_normalized = null,
      notes = '',
      sms_marketing_opt_in = false,
      email_marketing_opt_in = false,
      removed_at = now()
  where id = customer_row.id;

  return jsonb_build_object(
    'ok', true,
    'customer_id', customer_row.id,
    'orders_scrubbed', order_total
  );
end;
$$;

revoke all on function public.wayne_remove_customer_marketing(text, text) from public, anon, authenticated;
revoke all on function public.wayne_erase_customer(uuid) from public, anon, authenticated;
