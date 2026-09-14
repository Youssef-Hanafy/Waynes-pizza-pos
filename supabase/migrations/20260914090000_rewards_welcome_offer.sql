-- Wayne's Pizza POS — Wayne's Rewards welcome offer.
--
-- Joining the text club now mints a single-use code for a free small side.
-- Each member gets their OWN code with its own 30-day clock, because a shared
-- code cannot expire per person and ends up posted on a deals forum. The code
-- rides out to Hanafy on a customer.reward.issued event so the welcome text can
-- quote it, and the signup response carries it so the popup can show it the
-- moment someone joins.

-- Personal codes must never appear in the public deals list on the home page.
alter table public.promotions
  add column if not exists private boolean not null default false;

comment on column public.promotions.private is
  'Personal, per-customer codes. Excluded from wayne_public_promotions().';

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
    and promotion.archived_at is null
    and (promotion.starts_at is null or promotion.starts_at <= now())
    and (promotion.ends_at is null or promotion.ends_at > now())
    and (promotion.total_usage_limit is null
         or promotion.uses_count < promotion.total_usage_limit);
$$;

-- One grant per customer per reward kind is what makes issuing idempotent: a
-- retried signup returns the code already minted instead of a second one.
create table if not exists public.reward_grants (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{2,40}$'),
  promotion_id uuid not null references public.promotions(id),
  issued_at timestamptz not null default now(),
  unique (customer_id, kind)
);
create index if not exists reward_grants_customer_idx
  on public.reward_grants(customer_id, issued_at desc);

alter table public.reward_grants enable row level security;
drop policy if exists reward_grants_admin_select on public.reward_grants;
create policy reward_grants_admin_select on public.reward_grants
  for select to authenticated using (public.wayne_has_permission('admin.access'));
revoke all on public.reward_grants from anon, authenticated;
grant select on public.reward_grants to authenticated;

create or replace function public.wayne_issue_welcome_reward(target_customer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing public.reward_grants%rowtype;
  promotion_row public.promotions%rowtype;
  code_value text;
  expires_value timestamptz := now() + interval '30 days';
  attempt integer := 0;
begin
  if target_customer_id is null then return null; end if;

  select * into existing from public.reward_grants
  where customer_id = target_customer_id and kind = 'rewards_welcome';
  if found then
    select * into promotion_row from public.promotions where id = existing.promotion_id;
    return jsonb_build_object(
      'code', promotion_row.code,
      'expires_at', promotion_row.ends_at,
      'discount_cents', promotion_row.discount_value,
      'minimum_order_cents', promotion_row.minimum_order_cents,
      'already_issued', true
    );
  end if;

  -- Six hex characters is 16 million codes; the loop covers the rare collision.
  loop
    attempt := attempt + 1;
    code_value := 'WAYNE' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    exit when not exists (select 1 from public.promotions where code = code_value);
    if attempt >= 10 then
      raise exception 'Could not allocate a unique welcome reward code';
    end if;
  end loop;

  insert into public.promotions (
    code, description, discount_type, discount_value, minimum_order_cents,
    starts_at, ends_at, total_usage_limit, per_customer_limit, active, private
  ) values (
    code_value,
    'Wayne''s Rewards welcome offer: free small side on an order of $26.99 or more.',
    'fixed', 450, 2699,
    now(), expires_value,
    1, 1, true, true
  ) returning * into promotion_row;

  insert into public.reward_grants (customer_id, kind, promotion_id)
  values (target_customer_id, 'rewards_welcome', promotion_row.id);

  perform public.wayne_enqueue_hanafy_event(
    'customer.reward.issued',
    coalesce(public.wayne_customer_hanafy_properties(target_customer_id), '{}'::jsonb)
      || jsonb_build_object(
           'reward', jsonb_build_object(
             'kind', 'rewards_welcome',
             'code', promotion_row.code,
             'description', promotion_row.description,
             'discount_cents', promotion_row.discount_value,
             'minimum_order_cents', promotion_row.minimum_order_cents,
             'expires_at', promotion_row.ends_at
           )
         ),
    now()
  );

  return jsonb_build_object(
    'code', promotion_row.code,
    'expires_at', promotion_row.ends_at,
    'discount_cents', promotion_row.discount_value,
    'minimum_order_cents', promotion_row.minimum_order_cents,
    'already_issued', false
  );
end;
$$;

revoke all on function public.wayne_issue_welcome_reward(uuid) from public, anon, authenticated;
