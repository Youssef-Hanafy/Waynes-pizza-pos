-- Deals are the single biggest conversion lever on an ordering site, and Wayne's
-- already prints five of them on the take-out menu. They belong on the storefront,
-- but they must stay owner-editable, so the storefront reads the promotions an
-- owner manages in Admin -> Promotions rather than anything written into a page.
--
-- Only what a customer needs to decide is exposed: what the deal is, what it costs
-- to qualify, and the code to type. Usage counts, per-customer limits and total
-- limits stay private — they tell a stranger how the promotion is performing.

create or replace function public.wayne_public_promotions()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
    and promotion.archived_at is null
    and (promotion.starts_at is null or promotion.starts_at <= now())
    and (promotion.ends_at is null or promotion.ends_at > now())
    -- A promotion that has been used up is not a deal, it is a disappointment.
    and (promotion.total_usage_limit is null or promotion.uses_count < promotion.total_usage_limit);
$$;

revoke all on function public.wayne_public_promotions() from public;
grant execute on function public.wayne_public_promotions() to anon, authenticated, service_role;
