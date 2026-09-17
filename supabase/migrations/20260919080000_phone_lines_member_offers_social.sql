-- Wayne's Pizza POS — caller ID lines, member-only offers, and social links.
--
-- Three unrelated-looking features share one migration because they are one
-- release:
--
--  1. Caller ID.  Thrive answers the phone by reading a Whozz Calling? box from
--     CallerID.com sitting on the store's LAN: the phone lines pass through it
--     and it broadcasts a UDP record every time a line rings.  A browser cannot
--     listen for UDP, so a small bridge on the store's computer forwards each
--     record to /api/phone/calls, which lands here.  The POS then shows Line 1
--     and Line 2 and the customer behind whichever one is ringing.
--  2. Member offers.  The weekly offers Wayne's saves for Rewards members are
--     ordinary promotions flagged members_only, so the owner keeps using the one
--     promotions screen he already knows, and checkout enforces membership at
--     the same point that enforces everything else about a discount.
--  3. A TikTok link beside the Facebook and Instagram ones the settings row has
--     carried since Phase 1.

-- ---------------------------------------------------------------------------
-- 1. Social
-- ---------------------------------------------------------------------------

alter table public.store_settings
  add column if not exists tiktok_url text not null default '';

alter table public.store_settings drop constraint if exists store_settings_tiktok_url_check;
alter table public.store_settings
  add constraint store_settings_tiktok_url_check
  check (tiktok_url = '' or tiktok_url ~ '^https?://');

comment on column public.store_settings.tiktok_url is
  'Public TikTok profile URL shown in the site header. Empty hides the icon.';

-- ---------------------------------------------------------------------------
-- 2. Phone lines
-- ---------------------------------------------------------------------------

create table if not exists public.store_phone_lines (
  id uuid primary key default gen_random_uuid(),
  line_number smallint not null unique check (line_number between 1 and 8),
  label text not null default '' check (char_length(label) <= 60),
  phone_number text not null default '' check (char_length(phone_number) <= 40),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.store_phone_lines is
  'The store''s incoming phone lines, in the order they are wired into the caller ID box.';

-- Wayne's has two lines. They exist from the first deploy so the POS has
-- something to show before a single call has ever come in.
insert into public.store_phone_lines (line_number, label)
values (1, 'Line 1'), (2, 'Line 2')
on conflict (line_number) do nothing;

create table if not exists public.phone_calls (
  id uuid primary key default gen_random_uuid(),
  line_number smallint not null check (line_number between 1 and 8),
  unit_number text not null default '' check (char_length(unit_number) <= 20),
  direction text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  caller_number_raw text not null default '' check (char_length(caller_number_raw) <= 40),
  caller_number text check (caller_number is null or caller_number ~ '^\+1[0-9]{10}$'),
  caller_name text not null default '' check (char_length(caller_name) <= 80),
  customer_id uuid references public.customers(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- Kept verbatim so a malformed record from the box can be diagnosed without
  -- standing in the store watching the phone ring.
  raw_record text not null default '' check (char_length(raw_record) <= 400),
  created_at timestamptz not null default now()
);

create index if not exists phone_calls_recent_idx on public.phone_calls (started_at desc);
create index if not exists phone_calls_line_idx on public.phone_calls (line_number, started_at desc);
create index if not exists phone_calls_customer_idx on public.phone_calls (customer_id, started_at desc);

comment on table public.phone_calls is
  'One row per ring reported by the caller ID box. The POS reads the newest row per line.';

alter table public.store_phone_lines enable row level security;
alter table public.phone_calls enable row level security;

-- No direct client access at all: everything goes through the definer functions
-- below, so a leaked anon key cannot read who called the store.
revoke all on table public.store_phone_lines from anon, authenticated;
revoke all on table public.phone_calls from anon, authenticated;

-- Records the ring.  Called by the ingest route with the service role, which is
-- the only credential the store's bridge ever gets near.
create or replace function public.wayne_record_phone_call(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  line smallint := coalesce((payload ->> 'line_number')::smallint, 1);
  raw_number text := btrim(coalesce(payload ->> 'caller_number', ''));
  normalized text := public.wayne_normalize_phone(raw_number);
  event_kind text := coalesce(nullif(btrim(payload ->> 'event'), ''), 'start');
  occurred timestamptz := coalesce((payload ->> 'occurred_at')::timestamptz, now());
  matched_customer_id uuid;
  call_row public.phone_calls;
begin
  if line < 1 or line > 8 then
    raise exception 'Unknown phone line %', line using errcode = '22023';
  end if;

  -- "End of call" closes the ring that is already open on that line rather than
  -- opening a second one, so the POS never shows the same call twice.
  if event_kind = 'end' then
    update public.phone_calls
       set ended_at = occurred
     where id = (
       select id from public.phone_calls
        where line_number = line and ended_at is null
        order by started_at desc limit 1
     )
    returning * into call_row;
    return jsonb_build_object('ok', true, 'call_id', call_row.id, 'event', 'end');
  end if;

  if normalized is not null then
    select id into matched_customer_id
      from public.customers
     where phone_normalized = normalized
       and removed_at is null
     limit 1;
  end if;

  insert into public.phone_calls (
    line_number, unit_number, direction, caller_number_raw, caller_number,
    caller_name, customer_id, started_at, raw_record
  ) values (
    line,
    left(coalesce(payload ->> 'unit_number', ''), 20),
    case when coalesce(payload ->> 'direction', 'inbound') = 'outbound' then 'outbound' else 'inbound' end,
    left(raw_number, 40),
    normalized,
    left(coalesce(payload ->> 'caller_name', ''), 80),
    matched_customer_id,
    occurred,
    left(coalesce(payload ->> 'raw_record', ''), 400)
  )
  returning * into call_row;

  return jsonb_build_object(
    'ok', true,
    'call_id', call_row.id,
    'event', 'start',
    'line_number', call_row.line_number,
    'caller_number', call_row.caller_number,
    'matched', matched_customer_id is not null
  );
end;
$$;

-- What the POS phone panel draws: every configured line, and the most recent
-- call on it from the last two hours with the customer already resolved.
create or replace function public.wayne_phone_line_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.wayne_has_permission('pos.access') then
    raise exception 'POS access required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(line_payload order by line_number)
      from (
        select phone_line.line_number,
          jsonb_build_object(
            'line_number', phone_line.line_number,
            'label', coalesce(nullif(phone_line.label, ''), 'Line ' || phone_line.line_number),
            'phone_number', phone_line.phone_number,
            'active', phone_line.active,
            'call', (
              select jsonb_build_object(
                'id', call_row.id,
                'caller_number', call_row.caller_number,
                'caller_number_raw', call_row.caller_number_raw,
                'caller_name', call_row.caller_name,
                'started_at', call_row.started_at,
                'ended_at', call_row.ended_at,
                'customer_id', call_row.customer_id,
                'customer', case when customer.id is null then null else jsonb_build_object(
                  'id', customer.id,
                  'first_name', customer.first_name,
                  'last_name', customer.last_name,
                  'order_count', customer.order_count,
                  'last_order_at', customer.last_order_at,
                  'lifetime_spend_cents', customer.lifetime_spend_cents
                ) end
              )
                from public.phone_calls call_row
                left join public.customers customer on customer.id = call_row.customer_id
               where call_row.line_number = phone_line.line_number
                 and call_row.started_at > now() - interval '2 hours'
               order by call_row.started_at desc
               limit 1
            )
          ) line_payload
        from public.store_phone_lines phone_line
       where phone_line.active
      ) lines
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.wayne_record_phone_call(jsonb) from public;
revoke all on function public.wayne_phone_line_board() from public;
grant execute on function public.wayne_record_phone_call(jsonb) to service_role;
grant execute on function public.wayne_phone_line_board() to authenticated, service_role;

comment on function public.wayne_record_phone_call(jsonb) is
  'Service-role ingest for the store''s caller ID box. Matches the caller to a customer at write time.';
comment on function public.wayne_phone_line_board() is
  'Phase 16 POS phone panel: every active line with its current call and matched customer.';

-- ---------------------------------------------------------------------------
-- 3. Member-only offers
-- ---------------------------------------------------------------------------

alter table public.promotions
  add column if not exists members_only boolean not null default false;

comment on column public.promotions.members_only is
  'Wayne''s Rewards offer. Shown only to opted-in members and refused at checkout for everyone else.';

-- Restore the private-code filter that the Phase 12 rewrite of this function
-- dropped: without it, every member's personal welcome code is listed publicly.
-- Members-only weekly offers are excluded here too — they have their own,
-- membership-checked function below.
create or replace function public.wayne_public_promotions()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', promotion.id,
    'code', promotion.code,
    'description', promotion.description,
    'discount_type', promotion.discount_type,
    'discount_value', promotion.discount_value,
    'minimum_order_cents', promotion.minimum_order_cents,
    'fulfillment_type', promotion.fulfillment_type,
    'ends_at', promotion.ends_at
  ) order by promotion.minimum_order_cents, promotion.code), '[]'::jsonb)
  from public.promotions promotion
  where promotion.active
    and not promotion.private
    and not promotion.members_only
    and promotion.archived_at is null
    and (promotion.starts_at is null or promotion.starts_at <= now())
    and (promotion.ends_at is null or promotion.ends_at > now())
    and (promotion.total_usage_limit is null
         or promotion.uses_count < promotion.total_usage_limit);
$$;

-- "What do I have this week?"  A member types the number their texts go to and
-- gets this week's member offers plus any personal code still unspent.  A
-- non-member gets the membership answer and nothing else, which is what makes
-- the join prompt honest rather than a guess.
create or replace function public.wayne_member_offers(phone_text text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized text := public.wayne_normalize_phone(phone_text);
  customer_row public.customers;
  offers jsonb;
begin
  if normalized is null then
    return jsonb_build_object('member', false, 'reason', 'invalid_phone', 'offers', '[]'::jsonb);
  end if;

  select * into customer_row
    from public.customers
   where phone_normalized = normalized
     and removed_at is null
   limit 1;

  if customer_row.id is null or not customer_row.sms_marketing_opt_in then
    return jsonb_build_object('member', false, 'reason', 'not_a_member', 'offers', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(offer order by (offer ->> 'minimum_order_cents')::integer, offer ->> 'code'), '[]'::jsonb)
    into offers
    from (
      -- This week's member offers, the same rows the owner edits in Admin -> Promotions.
      select jsonb_build_object(
        'id', promotion.id,
        'code', promotion.code,
        'description', promotion.description,
        'discount_type', promotion.discount_type,
        'discount_value', promotion.discount_value,
        'minimum_order_cents', promotion.minimum_order_cents,
        'fulfillment_type', promotion.fulfillment_type,
        'ends_at', promotion.ends_at,
        'personal', false
      ) offer
        from public.promotions promotion
       where promotion.members_only
         and promotion.active
         and not promotion.private
         and promotion.archived_at is null
         and (promotion.starts_at is null or promotion.starts_at <= now())
         and (promotion.ends_at is null or promotion.ends_at > now())
         and (promotion.total_usage_limit is null or promotion.uses_count < promotion.total_usage_limit)
      union all
      -- Plus this member's own unspent personal codes (the welcome offer).
      select jsonb_build_object(
        'id', promotion.id,
        'code', promotion.code,
        'description', promotion.description,
        'discount_type', promotion.discount_type,
        'discount_value', promotion.discount_value,
        'minimum_order_cents', promotion.minimum_order_cents,
        'fulfillment_type', promotion.fulfillment_type,
        'ends_at', promotion.ends_at,
        'personal', true
      ) offer
        from public.reward_grants grant_row
        join public.promotions promotion on promotion.id = grant_row.promotion_id
       where grant_row.customer_id = customer_row.id
         and promotion.active
         and promotion.archived_at is null
         and (promotion.ends_at is null or promotion.ends_at > now())
         and (promotion.total_usage_limit is null or promotion.uses_count < promotion.total_usage_limit)
    ) rows;

  return jsonb_build_object(
    'member', true,
    'first_name', customer_row.first_name,
    'offers', offers
  );
end;
$$;

revoke all on function public.wayne_member_offers(text) from public;
grant execute on function public.wayne_member_offers(text) to service_role;

comment on function public.wayne_member_offers(text) is
  'Phase 16 offers tab: this week''s Rewards offers plus the member''s own codes, for an opted-in number only.';

-- Enforcement.  Both order-creation functions write the discount they applied
-- into order_discounts; checking membership here means online checkout and the
-- POS are covered by one rule that cannot be bypassed by calling the other one.
create or replace function public.wayne_enforce_member_only_discount()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  is_members_only boolean;
  order_customer_id uuid;
  opted_in boolean;
begin
  if new.promotion_id is null then return new; end if;
  select members_only into is_members_only from public.promotions where id = new.promotion_id;
  if not coalesce(is_members_only, false) then return new; end if;

  select customer_id into order_customer_id from public.orders where id = new.order_id;
  if order_customer_id is null then
    raise exception 'Code % is a Wayne''s Rewards offer. Join the text club to use it.', new.code_snapshot
      using errcode = '22023';
  end if;

  select sms_marketing_opt_in into opted_in from public.customers where id = order_customer_id;
  if not coalesce(opted_in, false) then
    raise exception 'Code % is a Wayne''s Rewards offer. Join the text club to use it.', new.code_snapshot
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists wayne_order_discounts_member_only on public.order_discounts;
create trigger wayne_order_discounts_member_only
before insert on public.order_discounts
for each row execute function public.wayne_enforce_member_only_discount();

comment on function public.wayne_enforce_member_only_discount() is
  'Refuses a members_only promotion for an order with no opted-in Wayne''s Rewards customer.';
