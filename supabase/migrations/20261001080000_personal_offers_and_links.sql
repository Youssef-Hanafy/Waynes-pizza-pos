-- Personal offers, personal links and tracked redemptions.
--
-- Every promotion now chooses how its code works:
--   * public   - one code for everyone (what promotions have always been);
--   * personal - the promotion is an offer template.  Each customer who gets it
--                receives their own private, single-use code (WINBACK-7F3A9C),
--                locked to them, so every send and every use can be counted.
--
-- A personal offer goes out one of two ways:
--   * publish         - the owner presses Publish (the weekly Rewards offers).
--                       Codes are made for every member in the audience, and
--                       the members can be texted a link to their own page.
--   * segment_entered - automatic.  When a customer enters the offer's segment
--                       (e.g. "30-day inactive") Wayne's makes their code and
--                       sends `customer.offer.<crm_event_name>` to the Hanafy
--                       CRM, whose automation texts the code and the link.
--
-- Every member has a personal link, /r/<key>, that opens their offers without
-- typing a phone number.  A personal code works as a link key too, so a text
-- can say ".../r/WINBACK-7F3A9C".  The phone-number lookup keeps working.
--
-- When an order that used a code is completed, Wayne's sends
-- `customer.offer.redeemed` (with the order total) so the CRM can count the
-- conversion; Admin -> Promotions shows the same numbers from Wayne's side.

alter table public.promotions
  add column if not exists code_mode text not null default 'public',
  add column if not exists parent_promotion_id uuid references public.promotions(id) on delete cascade,
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists audience_segment_id uuid references public.customer_segments(id) on delete set null,
  add column if not exists delivery text not null default 'publish',
  add column if not exists code_valid_days integer,
  add column if not exists reissue_after_days integer,
  add column if not exists crm_event_name text,
  add column if not exists published_at timestamptz,
  add column if not exists texts_queued integer not null default 0,
  add column if not exists issued_reason text;

alter table public.promotions drop constraint if exists promotions_code_mode_check;
alter table public.promotions add constraint promotions_code_mode_check check (code_mode in ('public', 'personal'));
alter table public.promotions drop constraint if exists promotions_delivery_check;
alter table public.promotions add constraint promotions_delivery_check check (delivery in ('publish', 'segment_entered'));
-- A personal code (a child of an offer) is always private and personal.
alter table public.promotions drop constraint if exists promotions_personal_shape_check;
alter table public.promotions add constraint promotions_personal_shape_check check (
  parent_promotion_id is null or (code_mode = 'personal' and private)
);
alter table public.promotions drop constraint if exists promotions_offer_numbers_check;
alter table public.promotions add constraint promotions_offer_numbers_check check (
  (code_valid_days is null or code_valid_days between 1 and 365)
  and (reissue_after_days is null or reissue_after_days between 1 and 3650)
);
alter table public.promotions drop constraint if exists promotions_crm_event_name_check;
alter table public.promotions add constraint promotions_crm_event_name_check check (
  crm_event_name is null or (crm_event_name ~ '^[a-z][a-z_]{1,39}$' and crm_event_name not in ('redeemed', 'issued', 'published'))
);

create index if not exists promotions_parent_customer_idx on public.promotions (parent_promotion_id, customer_id, created_at desc) where parent_promotion_id is not null;
create index if not exists promotions_customer_idx on public.promotions (customer_id) where customer_id is not null;
create index if not exists promotions_auto_segment_idx on public.promotions (audience_segment_id) where delivery = 'segment_entered' and parent_promotion_id is null;

alter table public.customers
  add column if not exists offer_link_key text,
  add column if not exists last_offers_texted_at timestamptz;
create unique index if not exists customers_offer_link_key_idx on public.customers (offer_link_key) where offer_link_key is not null;

-- ---------------------------------------------------------------------------
-- The member's personal link key: 10 lowercase letters/numbers, made the first
-- time it is needed and kept for good.  No 0/o/1/i/l so it survives being
-- read aloud or typed from a text.
create or replace function public.wayne_customer_offer_link_key(target_customer_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  key_value text;
  bytes bytea;
  attempt integer := 0;
begin
  select offer_link_key into key_value from public.customers where id = target_customer_id and removed_at is null;
  if not found then return null; end if;
  if key_value is not null then return key_value; end if;
  loop
    attempt := attempt + 1;
    bytes := extensions.gen_random_bytes(10);
    key_value := '';
    for position_value in 0..9 loop
      key_value := key_value || substr(alphabet, (get_byte(bytes, position_value) % length(alphabet)) + 1, 1);
    end loop;
    begin
      update public.customers set offer_link_key = key_value
      where id = target_customer_id and offer_link_key is null;
      exit;
    exception when unique_violation then
      if attempt >= 10 then raise; end if;
    end;
  end loop;
  select offer_link_key into key_value from public.customers where id = target_customer_id;
  return key_value;
end;
$$;

-- What the CRM gets in `reward` for one personal code.  The CRM's message
-- variables read reward.code / discount_cents / minimum_order_cents /
-- expires_at / description, so a text can say {{reward_code}}.
create or replace function public.wayne_offer_reward_json(code_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'kind', coalesce(template.crm_event_name, 'offer'),
    'offer_id', template.id,
    'offer_code', template.code,
    'code', code.code,
    'description', code.description,
    'discount_type', code.discount_type,
    'discount_value', code.discount_value,
    'discount_cents', case when code.discount_type = 'fixed' then code.discount_value end,
    'minimum_order_cents', code.minimum_order_cents,
    'expires_at', code.ends_at,
    'link_key', public.wayne_customer_offer_link_key(code.customer_id)
  )
  from public.promotions code
  join public.promotions template on template.id = code.parent_promotion_id
  where code.id = code_id;
$$;

-- Make (or find) one customer's code for one personal offer.
--   publish offers:          one code per customer per offer, ever.
--   segment_entered offers:  a new code only if the last one from this offer is
--                            older than reissue_after_days (default 60), so a
--                            customer who keeps lapsing is not flooded.
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
    if template.delivery = 'publish'
       or existing.created_at > now() - make_interval(days => coalesce(template.reissue_after_days, 60)) then
      code_id := existing.id; created := false; return next; return;
    end if;
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

-- Issue an automatic offer to one customer and tell the CRM, which texts it.
-- Only opted-in members with a phone get one: the code exists to be texted.
create or replace function public.wayne_deliver_auto_offer(offer_id uuid, target_customer_id uuid, reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  template public.promotions%rowtype;
  issued_id uuid;
  issued_new boolean;
begin
  select * into template from public.promotions where id = offer_id;
  if not found or template.delivery <> 'segment_entered' or template.crm_event_name is null then return false; end if;
  if not exists (select 1 from public.customers where id = target_customer_id and removed_at is null
                 and sms_marketing_opt_in and phone_normalized is not null) then
    return false;
  end if;
  select issued.code_id, issued.created into issued_id, issued_new
  from public.wayne_issue_offer_code(offer_id, target_customer_id, reason) issued;
  if issued_id is null or not coalesce(issued_new, false) then return false; end if;
  perform public.wayne_enqueue_hanafy_event(
    'customer.offer.' || template.crm_event_name,
    coalesce(public.wayne_customer_hanafy_properties(target_customer_id), '{}'::jsonb)
      || jsonb_build_object('reward', public.wayne_offer_reward_json(issued_id)),
    now());
  update public.promotions set texts_queued = texts_queued + 1 where id = offer_id;
  return true;
end;
$$;

-- Entering a segment fires every live automatic offer aimed at that segment.
create or replace function public.wayne_offers_on_segment_entered()
returns trigger language plpgsql security definer set search_path = '' as $$
declare offer_row record;
begin
  if not new.active then return new; end if;
  for offer_row in
    select id from public.promotions
    where parent_promotion_id is null and code_mode = 'personal' and delivery = 'segment_entered'
      and audience_segment_id = new.segment_id and active and archived_at is null
      and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
  loop
    perform public.wayne_deliver_auto_offer(offer_row.id, new.customer_id, 'segment_entered');
  end loop;
  return new;
end;
$$;
drop trigger if exists customer_segment_memberships_offers on public.customer_segment_memberships;
create trigger customer_segment_memberships_offers
after insert on public.customer_segment_memberships
for each row execute function public.wayne_offers_on_segment_entered();

-- The customers an offer is for: opted-in members, narrowed to a segment if set.
create or replace function public.wayne_offer_audience(offer_id uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select customer.id
  from public.customers customer
  join public.promotions offer on offer.id = offer_id
  where customer.removed_at is null
    and customer.sms_marketing_opt_in
    and customer.phone_normalized is not null
    and (offer.audience_segment_id is null or exists (
      select 1 from public.customer_segment_memberships membership
      where membership.customer_id = customer.id and membership.segment_id = offer.audience_segment_id and membership.active));
$$;

-- Tell one member "your offers are up" with their personal link.  At most one
-- such text in 20 hours, however many offers are published that day.
create or replace function public.wayne_queue_offers_text(target_customer_id uuid, offer_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  customer_row public.customers%rowtype;
  offer public.promotions%rowtype;
  key_value text;
begin
  select * into customer_row from public.customers where id = target_customer_id and removed_at is null for update;
  if not found or not customer_row.sms_marketing_opt_in then return false; end if;
  if customer_row.last_offers_texted_at is not null and customer_row.last_offers_texted_at > now() - interval '20 hours' then return false; end if;
  select * into offer from public.promotions where id = offer_id;
  key_value := public.wayne_customer_offer_link_key(target_customer_id);
  update public.customers set last_offers_texted_at = now() where id = target_customer_id;
  perform public.wayne_enqueue_hanafy_event(
    'customer.offers.published',
    coalesce(public.wayne_customer_hanafy_properties(target_customer_id), '{}'::jsonb)
      || jsonb_build_object('reward', jsonb_build_object(
        'kind', 'offers_link',
        -- {{reward_code}} in the CRM text is the member's link key: .../r/{{reward_code}}
        'code', key_value,
        'link_key', key_value,
        'offer_id', offer.id,
        'offer_code', offer.code,
        'description', offer.description,
        'discount_type', offer.discount_type,
        'discount_value', offer.discount_value,
        'discount_cents', case when offer.discount_type = 'fixed' then offer.discount_value end,
        'minimum_order_cents', offer.minimum_order_cents,
        'expires_at', offer.ends_at)),
    now());
  return true;
end;
$$;

-- Admin -> Promotions -> Publish.
create or replace function public.wayne_publish_offer(offer_id uuid, send_text boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  offer public.promotions%rowtype;
  member_id uuid;
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
      -- Customers already in the segment get exactly what a new entrant gets.
      if public.wayne_deliver_auto_offer(offer_id, member_id, 'published') then
        issued_count := issued_count + 1; texted_count := texted_count + 1;
      end if;
      continue;
    end if;
    if offer.code_mode = 'personal' then
      select issued.created into issued_new from public.wayne_issue_offer_code(offer_id, member_id, 'published') issued;
      if coalesce(issued_new, false) then issued_count := issued_count + 1; end if;
    end if;
    if send_text and public.wayne_queue_offers_text(member_id, offer_id) then
      texted_count := texted_count + 1;
    end if;
  end loop;

  if texted_count > 0 and offer.delivery = 'publish' then
    update public.promotions set texts_queued = texts_queued + texted_count where id = offer_id;
  end if;
  return jsonb_build_object('issued', issued_count, 'texted', texted_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Checkout rules for personal codes (online and POS both insert order_discounts).
create or replace function public.wayne_enforce_personal_offer_code()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  offer public.promotions%rowtype;
  order_customer uuid;
begin
  if new.promotion_id is null then return new; end if;
  select * into offer from public.promotions where id = new.promotion_id;
  if offer.code_mode = 'personal' and offer.parent_promotion_id is null then
    raise exception 'Code % is a personal offer. Use the code that was sent to you, or open your Wayne''s Rewards offers.', new.code_snapshot
      using errcode = '22023';
  end if;
  if offer.customer_id is not null then
    select customer_id into order_customer from public.orders where id = new.order_id;
    if order_customer is null then
      raise exception 'Code % is a personal code. Add the customer''s phone number to use it.', new.code_snapshot using errcode = '22023';
    end if;
    if order_customer <> offer.customer_id then
      raise exception 'Code % belongs to another Wayne''s Rewards member. Use the phone number the code was sent to.', new.code_snapshot
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists order_discounts_personal_offer on public.order_discounts;
create trigger order_discounts_personal_offer
before insert on public.order_discounts
for each row execute function public.wayne_enforce_personal_offer_code();

-- A completed order that used a code tells the CRM, with the order total.
create or replace function public.wayne_outbox_offer_redeemed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare discount_row record;
begin
  if new.status <> 'completed' or old.status is not distinct from new.status or new.customer_id is null then return new; end if;
  for discount_row in
    select discount.code_snapshot, discount.amount_cents, promotion.id as promotion_id, promotion.parent_promotion_id
    from public.order_discounts discount
    join public.promotions promotion on promotion.id = discount.promotion_id
    where discount.order_id = new.id
  loop
    perform public.wayne_enqueue_hanafy_event(
      'customer.offer.redeemed',
      coalesce(public.wayne_customer_hanafy_properties(new.customer_id), '{}'::jsonb)
        || jsonb_build_object(
          'order_id', new.id, 'order_number', new.order_number, 'status', new.status,
          'payment_status', new.payment_status, 'total_cents', new.total_cents,
          'source', new.source, 'fulfillment_type', new.fulfillment_type,
          'reward', case when discount_row.parent_promotion_id is not null
            then public.wayne_offer_reward_json(discount_row.promotion_id) || jsonb_build_object('discount_applied_cents', discount_row.amount_cents)
            else jsonb_build_object('kind', 'public_code', 'offer_id', discount_row.promotion_id, 'offer_code', discount_row.code_snapshot,
                                    'code', discount_row.code_snapshot, 'discount_applied_cents', discount_row.amount_cents) end),
      now());
  end loop;
  return new;
end;
$$;
drop trigger if exists orders_offer_redeemed on public.orders;
create trigger orders_offer_redeemed
after update of status on public.orders
for each row execute function public.wayne_outbox_offer_redeemed();

-- A customer who is removed loses their unused personal codes and their link.
create or replace function public.wayne_clear_personal_offers_on_removal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.removed_at is not null and old.removed_at is null then
    delete from public.promotions where customer_id = new.id and parent_promotion_id is not null and uses_count = 0;
    update public.customers set offer_link_key = null where id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists customers_clear_personal_offers on public.customers;
create trigger customers_clear_personal_offers
after update of removed_at on public.customers
for each row execute function public.wayne_clear_personal_offers_on_removal();

-- ---------------------------------------------------------------------------
-- A member's offers.  Shared by the phone lookup and the personal link.
-- Live personal "publish" offers the member qualifies for are made on the spot,
-- so someone who joined after Monday's publish still gets this week's codes.
create or replace function public.wayne_member_offers_for(target_customer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  customer_row public.customers%rowtype;
  offer_row record;
  offers jsonb;
begin
  select * into customer_row from public.customers where id = target_customer_id and removed_at is null;
  if customer_row.id is null or not customer_row.sms_marketing_opt_in then
    return jsonb_build_object('member', false, 'reason', 'not_a_member', 'offers', '[]'::jsonb);
  end if;

  for offer_row in
    select offer.id from public.promotions offer
    where offer.parent_promotion_id is null and offer.code_mode = 'personal' and offer.delivery = 'publish'
      and offer.published_at is not null and offer.active and offer.archived_at is null
      and (offer.starts_at is null or offer.starts_at <= now()) and (offer.ends_at is null or offer.ends_at > now())
      and target_customer_id in (select audience from public.wayne_offer_audience(offer.id) audience)
  loop
    perform public.wayne_issue_offer_code(offer_row.id, target_customer_id, 'claimed');
  end loop;

  select coalesce(jsonb_agg(offer order by (offer ->> 'personal')::boolean desc, (offer ->> 'minimum_order_cents')::integer, offer ->> 'code'), '[]'::jsonb)
    into offers
    from (
      select jsonb_build_object(
        'id', promotion.id, 'code', promotion.code, 'description', promotion.description,
        'discount_type', promotion.discount_type, 'discount_value', promotion.discount_value,
        'minimum_order_cents', promotion.minimum_order_cents, 'fulfillment_type', promotion.fulfillment_type,
        'ends_at', promotion.ends_at, 'personal', false) offer
      from public.promotions promotion
      where promotion.members_only and promotion.active and not promotion.private
        and promotion.code_mode = 'public' and promotion.archived_at is null
        and (promotion.starts_at is null or promotion.starts_at <= now())
        and (promotion.ends_at is null or promotion.ends_at > now())
        and (promotion.total_usage_limit is null or promotion.uses_count < promotion.total_usage_limit)
      union all
      select jsonb_build_object(
        'id', promotion.id, 'code', promotion.code, 'description', promotion.description,
        'discount_type', promotion.discount_type, 'discount_value', promotion.discount_value,
        'minimum_order_cents', promotion.minimum_order_cents, 'fulfillment_type', promotion.fulfillment_type,
        'ends_at', promotion.ends_at, 'personal', true) offer
      from public.promotions promotion
      where (promotion.customer_id = target_customer_id
             or promotion.id in (select grant_row.promotion_id from public.reward_grants grant_row where grant_row.customer_id = target_customer_id))
        and promotion.active and promotion.archived_at is null
        and (promotion.ends_at is null or promotion.ends_at > now())
        and (promotion.total_usage_limit is null or promotion.uses_count < promotion.total_usage_limit)
    ) rows;

  return jsonb_build_object(
    'member', true,
    'first_name', customer_row.first_name,
    'link_key', public.wayne_customer_offer_link_key(target_customer_id),
    'offers', offers);
end;
$$;

-- Phone lookup: unchanged for the customer, and now also returns their link.
create or replace function public.wayne_member_offers(phone_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  normalized text := public.wayne_normalize_phone(phone_text);
  found_id uuid;
begin
  if normalized is null then
    return jsonb_build_object('member', false, 'reason', 'invalid_phone', 'offers', '[]'::jsonb);
  end if;
  select id into found_id from public.customers where phone_normalized = normalized and removed_at is null limit 1;
  return public.wayne_member_offers_for(found_id);
end;
$$;

-- Personal link: /r/<member key> or /r/<one of their personal codes>.
create or replace function public.wayne_member_offers_by_link(link_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cleaned text := btrim(coalesce(link_key, ''));
  found_id uuid;
begin
  if cleaned = '' or char_length(cleaned) > 60 then
    return jsonb_build_object('member', false, 'reason', 'unknown_link', 'offers', '[]'::jsonb);
  end if;
  select id into found_id from public.customers where offer_link_key = lower(cleaned) and removed_at is null;
  if found_id is null then
    select customer_id into found_id from public.promotions
    where code = upper(cleaned) and customer_id is not null and parent_promotion_id is not null
    order by created_at desc limit 1;
  end if;
  if found_id is null then
    return jsonb_build_object('member', false, 'reason', 'unknown_link', 'offers', '[]'::jsonb);
  end if;
  return public.wayne_member_offers_for(found_id);
end;
$$;

-- The public deals list never shows offer templates or personal codes.
create or replace function public.wayne_public_promotions()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', promotion.id, 'code', promotion.code, 'description', promotion.description,
    'discount_type', promotion.discount_type, 'discount_value', promotion.discount_value,
    'minimum_order_cents', promotion.minimum_order_cents, 'fulfillment_type', promotion.fulfillment_type,
    'ends_at', promotion.ends_at
  ) order by promotion.minimum_order_cents, promotion.code), '[]'::jsonb)
  from public.promotions promotion
  where promotion.active and not promotion.private and not promotion.members_only
    and promotion.code_mode = 'public' and promotion.parent_promotion_id is null
    and promotion.archived_at is null
    and (promotion.starts_at is null or promotion.starts_at <= now())
    and (promotion.ends_at is null or promotion.ends_at > now())
    and (promotion.total_usage_limit is null or promotion.uses_count < promotion.total_usage_limit);
$$;

-- Admin -> Promotions numbers, one row per offer / public code.
create or replace function public.wayne_promotion_stats()
returns table (promotion_id uuid, codes_issued integer, orders_count integer, revenue_cents bigint, discount_cents bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('promotions.manage') then
    raise exception 'Promotion permission required' using errcode = '42501';
  end if;
  return query
  with uses as (
    select coalesce(promotion.parent_promotion_id, promotion.id) as top_id, discount.order_id, discount.amount_cents
    from public.order_discounts discount
    join public.promotions promotion on promotion.id = discount.promotion_id
    join public.orders order_row on order_row.id = discount.order_id
    where order_row.status not in ('cancelled', 'draft')
  )
  select top_row.id,
    (select count(*)::integer from public.promotions child where child.parent_promotion_id = top_row.id),
    (select count(distinct uses.order_id)::integer from uses where uses.top_id = top_row.id),
    (select coalesce(sum(order_row.total_cents), 0)::bigint from public.orders order_row
       where order_row.id in (select uses.order_id from uses where uses.top_id = top_row.id)),
    (select coalesce(sum(uses.amount_cents), 0)::bigint from uses where uses.top_id = top_row.id)
  from public.promotions top_row
  where top_row.parent_promotion_id is null;
end;
$$;

-- Server-side only: storefront routes call these with the service role, admin
-- actions call publish/stats as the signed-in manager.
revoke all on function public.wayne_customer_offer_link_key(uuid) from public, anon, authenticated;
revoke all on function public.wayne_offer_reward_json(uuid) from public, anon, authenticated;
revoke all on function public.wayne_issue_offer_code(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.wayne_deliver_auto_offer(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.wayne_offers_on_segment_entered() from public, anon, authenticated;
revoke all on function public.wayne_offer_audience(uuid) from public, anon, authenticated;
revoke all on function public.wayne_queue_offers_text(uuid, uuid) from public, anon, authenticated;
revoke all on function public.wayne_enforce_personal_offer_code() from public, anon, authenticated;
revoke all on function public.wayne_outbox_offer_redeemed() from public, anon, authenticated;
revoke all on function public.wayne_clear_personal_offers_on_removal() from public, anon, authenticated;
revoke all on function public.wayne_member_offers_for(uuid) from public, anon, authenticated;
revoke all on function public.wayne_member_offers(text) from public, anon, authenticated;
revoke all on function public.wayne_member_offers_by_link(text) from public, anon, authenticated;
grant execute on function public.wayne_member_offers(text) to service_role;
grant execute on function public.wayne_member_offers_by_link(text) to service_role;
revoke all on function public.wayne_publish_offer(uuid, boolean) from public, anon;
grant execute on function public.wayne_publish_offer(uuid, boolean) to authenticated;
revoke all on function public.wayne_promotion_stats() from public, anon;
grant execute on function public.wayne_promotion_stats() to authenticated;
