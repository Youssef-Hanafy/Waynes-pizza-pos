-- A published offer is a one-time customer communication.  Re-publishing an
-- offer is useful for customers who joined later, but it must never text the
-- same customer a second copy of that offer.

create table if not exists public.promotion_deliveries (
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  channel text not null default 'sms' check (channel = 'sms'),
  event_id uuid,
  created_at timestamptz not null default now(),
  primary key (promotion_id, customer_id, channel)
);

alter table public.promotion_deliveries enable row level security;
revoke all on public.promotion_deliveries from public, anon, authenticated;

-- A personal promotion has one code per customer, period.  The previous
-- reissue window could send the same promotion again after enough time had
-- elapsed, which is surprising for customers and defeats the one-time offer
-- promise.
create or replace function public.wayne_issue_offer_code(offer_id uuid, target_customer_id uuid, reason text default null)
returns table (code_id uuid, created boolean) language plpgsql security definer set search_path = '' as $$
declare
  template public.promotions%rowtype;
  existing public.promotions%rowtype;
  code_value text;
  expires_value timestamptz;
  attempt integer := 0;
  new_id uuid;
begin
  select * into template from public.promotions where id = offer_id for update;
  if not found or template.code_mode <> 'personal' or template.parent_promotion_id is not null
     or not template.active or template.archived_at is not null
     or (template.ends_at is not null and template.ends_at <= now()) then
    return;
  end if;
  if not exists (select 1 from public.customers where id = target_customer_id and removed_at is null) then return; end if;

  select * into existing from public.promotions
  where parent_promotion_id = template.id and customer_id = target_customer_id
  order by created_at desc limit 1;
  if found then
    code_id := existing.id; created := false; return next; return;
  end if;

  loop
    attempt := attempt + 1;
    code_value := left(template.code, 30) || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    exit when not exists (select 1 from public.promotions where code = code_value and archived_at is null);
    if attempt >= 10 then raise exception 'Could not allocate a unique offer code'; end if;
  end loop;

  expires_value := case
    when template.code_valid_days is not null
      then least(coalesce(template.ends_at, 'infinity'::timestamptz), now() + make_interval(days => template.code_valid_days))
    else template.ends_at end;

  insert into public.promotions (
    code, description, discount_type, discount_value, minimum_order_cents, fulfillment_type,
    starts_at, ends_at, total_usage_limit, per_customer_limit, active, private, members_only,
    code_mode, parent_promotion_id, customer_id, delivery, issued_reason
  ) values (
    code_value, template.description, template.discount_type, template.discount_value, template.minimum_order_cents, template.fulfillment_type,
    now(), expires_value, 1, 1, true, true, template.members_only,
    'personal', template.id, target_customer_id, template.delivery, coalesce(reason, template.delivery)
  ) returning id into new_id;

  code_id := new_id; created := true; return next;
end;
$$;

-- Queue exactly one CRM event for this offer/customer pair.  The CRM still
-- decides whether an active automation may send the SMS, but it now receives
-- the actual coupon code as reward.code plus the personal-link key separately.
create or replace function public.wayne_queue_offer_text_once(target_customer_id uuid, offer_id uuid, code_id uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  customer_row public.customers%rowtype;
  offer public.promotions%rowtype;
  code_row public.promotions%rowtype;
  key_value text;
  queued_event_id uuid;
begin
  select * into customer_row from public.customers where id = target_customer_id and removed_at is null for update;
  if not found or not customer_row.sms_marketing_opt_in or customer_row.phone_normalized is null then return false; end if;
  select * into offer from public.promotions where id = offer_id and parent_promotion_id is null;
  if not found or not offer.active or offer.archived_at is not null then return false; end if;
  if exists (select 1 from public.promotion_deliveries where promotion_id = offer_id and customer_id = target_customer_id and channel = 'sms') then
    return false;
  end if;

  if code_id is not null then
    select * into code_row from public.promotions
    where id = code_id and parent_promotion_id = offer_id and customer_id = target_customer_id;
    if not found then return false; end if;
  end if;

  key_value := public.wayne_customer_offer_link_key(target_customer_id);
  queued_event_id := public.wayne_enqueue_hanafy_event(
    'customer.offers.published',
    coalesce(public.wayne_customer_hanafy_properties(target_customer_id), '{}'::jsonb)
      || jsonb_build_object('reward', jsonb_build_object(
        'kind', case when code_id is null then 'member_offer' else 'personal_offer' end,
        'code', coalesce(code_row.code, offer.code),
        'link_key', key_value,
        'offer_id', offer.id,
        'offer_code', offer.code,
        'description', coalesce(code_row.description, offer.description),
        'discount_type', coalesce(code_row.discount_type, offer.discount_type),
        'discount_value', coalesce(code_row.discount_value, offer.discount_value),
        'discount_cents', case when coalesce(code_row.discount_type, offer.discount_type) = 'fixed' then coalesce(code_row.discount_value, offer.discount_value) end,
        'minimum_order_cents', coalesce(code_row.minimum_order_cents, offer.minimum_order_cents),
        'expires_at', coalesce(code_row.ends_at, offer.ends_at))),
    now());
  if queued_event_id is null then return false; end if;

  insert into public.promotion_deliveries(promotion_id, customer_id, channel, event_id)
  values (offer_id, target_customer_id, 'sms', queued_event_id);
  update public.customers set last_offers_texted_at = now() where id = target_customer_id;
  return true;
end;
$$;

create or replace function public.wayne_publish_offer(offer_id uuid, send_text boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  offer public.promotions%rowtype;
  member_id uuid;
  issued_id uuid;
  issued_new boolean;
  issued_count integer := 0;
  texted_count integer := 0;
begin
  if not public.wayne_has_permission('promotions.manage') then
    raise exception 'Promotion permission required' using errcode = '42501';
  end if;
  select * into offer from public.promotions where id = offer_id and parent_promotion_id is null;
  if not found or offer.archived_at is not null then raise exception 'Offer not found' using errcode = 'P0002'; end if;
  if offer.ends_at is not null and offer.ends_at <= now() then raise exception 'This offer has already ended' using errcode = 'P0001'; end if;
  if offer.delivery = 'segment_entered' and (offer.audience_segment_id is null or offer.crm_event_name is null) then
    raise exception 'An automatic offer needs a segment and a CRM event name' using errcode = '22023';
  end if;

  update public.promotions set active = true, published_at = coalesce(published_at, now()) where id = offer_id;

  for member_id in select audience from public.wayne_offer_audience(offer_id) audience loop
    if offer.code_mode = 'personal' and offer.delivery = 'segment_entered' then
      if public.wayne_deliver_auto_offer(offer_id, member_id, 'published') then
        issued_count := issued_count + 1; texted_count := texted_count + 1;
      end if;
      continue;
    end if;
    issued_id := null;
    if offer.code_mode = 'personal' then
      select issued.code_id, issued.created into issued_id, issued_new
      from public.wayne_issue_offer_code(offer_id, member_id, 'published') issued;
      if coalesce(issued_new, false) then issued_count := issued_count + 1; end if;
    end if;
    if send_text and public.wayne_queue_offer_text_once(member_id, offer_id, issued_id) then
      texted_count := texted_count + 1;
    end if;
  end loop;

  if texted_count > 0 and offer.delivery = 'publish' then
    update public.promotions set texts_queued = texts_queued + texted_count where id = offer_id;
  end if;
  return jsonb_build_object('issued', issued_count, 'texted', texted_count);
end;
$$;

revoke all on function public.wayne_queue_offer_text_once(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.wayne_issue_offer_code(uuid, uuid, text) from public, anon, authenticated;
