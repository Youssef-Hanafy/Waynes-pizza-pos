-- Owner, 2026-10-19 (evening):
--   1. Specials are POS-only: a special lives ONLY under the POS "Specials"
--      button (walk-in / pickup / phone pickup), never in its regular category,
--      never on the online menu or the website.  Making an item a special now
--      makes a separate copy with its own price, so the regular item (and the
--      online menu) never change.
--   2. Items that are done once their pick is made (One / Two / Three Topping
--      Pizza) add themselves to the ticket: menu_items.pos_auto_add.
--   3. Admin -> Customers: every past order's payment details and signatures,
--      for disputes.
--   4. A day's delivery close out (per driver: deliveries, tips, hands in) for
--      the paper slips and the driver's tips receipt at cash-out.

create or replace function public._wayne_patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
begin
  if position(old_text in definition) = 0 then
    raise exception 'Patch for % did not match: %', target, left(old_text, 120);
  end if;
  execute replace(definition, old_text, new_text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Auto-add to the ticket
-- ---------------------------------------------------------------------------
alter table public.menu_items add column if not exists pos_auto_add boolean not null default false;
comment on column public.menu_items.pos_auto_add is
  'POS: add the item to the ticket by itself as soon as its first option group is filled (e.g. One Topping Pizza once the topping is picked).';

update public.menu_items item set pos_auto_add = true
 where item.archived_at is null and not item.pos_auto_add
   and exists (select 1 from public.menu_item_modifier_groups link
                 join public.modifier_groups g on g.id = link.modifier_group_id
                where link.menu_item_id = item.id and link.active and g.archived_at is null
                  and g.name ~* '^(one|two|three) topping pizza');

-- POS menu: whether the item is a special at all (even an ended one stays out of
-- its category) and whether it adds itself to the ticket.
do $$
begin
  if position('pos_auto_add' in pg_get_functiondef('public.wayne_pos_menu()'::regprocedure)) = 0 then
    perform public._wayne_patch_function('public.wayne_pos_menu()'::regprocedure,
      $o$'special_note', item.special_note,$o$,
      $n$'special_note', item.special_note, 'special_item', item.special, 'pos_auto_add', item.pos_auto_add,$n$);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Specials are POS-only
-- ---------------------------------------------------------------------------
alter table public.menu_items alter column special_online set default false;
update public.menu_items set special_online = false where special_online;

-- The online menu never lists a special.
do $$
begin
  if position('not item.special' in pg_get_functiondef('public.hanafy_workspace_menu(uuid)'::regprocedure)) = 0 then
    perform public._wayne_patch_function('public.hanafy_workspace_menu(uuid)'::regprocedure,
      $o$and item.customer_visible and item.archived_at is null$o$,
      $n$and item.customer_visible and item.archived_at is null and not item.special$n$);
  end if;
end $$;

/**
 * A special = a copy of a menu item (sizes, prices, options, what it comes
 * with) shown only under the POS Specials button.  The regular item is never
 * touched.  Internal: called by wayne_make_special and by this migration.
 */
create or replace function public._wayne_copy_item_as_special(source_item_id uuid, headline text, ends_on date)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  source public.menu_items%rowtype;
  copy_id uuid := gen_random_uuid();
  variant_row record;
  new_variant uuid;
begin
  select * into source from public.menu_items where id = source_item_id and archived_at is null;
  if not found then raise exception 'That menu item could not be found' using errcode = 'P0002'; end if;
  if source.special then raise exception 'That item is already a special' using errcode = '22023'; end if;

  insert into public.menu_items (id, workspace_id, category_id, name, description, image_path, image_alt, base_price_cents, tax_category,
    included_count_label, sold_out, customer_visible, pos_visible, featured, kitchen_route, available_days, available_start, available_end,
    sort_order, pos_color, special, special_note, special_online, special_ends_on, pos_auto_add)
  values (copy_id, source.workspace_id, source.category_id, source.name, source.description, source.image_path, source.image_alt,
    source.base_price_cents, source.tax_category, source.included_count_label, false, false, true, false, source.kitchen_route,
    source.available_days, source.available_start, source.available_end, source.sort_order, source.pos_color,
    true, left(btrim(coalesce(headline, '')), 200), false, ends_on, source.pos_auto_add);

  for variant_row in
    select * from public.menu_item_variants where menu_item_id = source.id and archived_at is null order by sort_order, name
  loop
    insert into public.menu_item_variants (workspace_id, menu_item_id, name, price_cents, sku, sort_order, active)
    values (source.workspace_id, copy_id, variant_row.name, variant_row.price_cents, null, variant_row.sort_order, variant_row.active)
    returning id into new_variant;
    insert into public.modifier_choice_variant_prices (workspace_id, modifier_choice_id, menu_item_variant_id, price_delta_cents)
    select source.workspace_id, vp.modifier_choice_id, new_variant, vp.price_delta_cents
      from public.modifier_choice_variant_prices vp where vp.menu_item_variant_id = variant_row.id;
  end loop;

  insert into public.menu_item_modifier_groups (workspace_id, menu_item_id, modifier_group_id, sort_order, active)
  select source.workspace_id, copy_id, link.modifier_group_id, link.sort_order, link.active
    from public.menu_item_modifier_groups link where link.menu_item_id = source.id;

  insert into public.menu_item_included_choices (workspace_id, menu_item_id, modifier_choice_id)
  select source.workspace_id, copy_id, included.modifier_choice_id
    from public.menu_item_included_choices included where included.menu_item_id = source.id;

  return copy_id;
end;
$function$;
revoke all on function public._wayne_copy_item_as_special(uuid, text, date) from public, anon, authenticated;

/** Admin -> Menu -> Specials: "Make it a special". */
create or replace function public.wayne_make_special(source_item_id uuid, headline text default '', ends_on date default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  copy_id uuid;
  item_name text;
begin
  if not public.wayne_has_permission('menu.manage') then raise exception 'Menu permission required' using errcode = '42501'; end if;
  select name into item_name from public.menu_items where id = source_item_id and archived_at is null;
  copy_id := public._wayne_copy_item_as_special(source_item_id, headline, ends_on);
  perform public.wayne_write_audit('menu.special_created', 'menu_items', copy_id::text,
    'Made a POS special from ' || coalesce(item_name, 'a menu item'), '{}'::jsonb,
    jsonb_build_object('source_item_id', source_item_id, 'special_note', headline, 'special_ends_on', ends_on));
  return jsonb_build_object('id', copy_id, 'name', item_name);
end;
$function$;
revoke all on function public.wayne_make_special(uuid, text, date) from public, anon;
grant execute on function public.wayne_make_special(uuid, text, date) to authenticated;

-- The special made on 2026-10-19 marked the regular Cheese Pizza itself: give
-- it its own copy and put the regular item back to normal.
do $$
declare
  legacy record;
begin
  for legacy in
    select item.id, item.special_note, item.special_ends_on from public.menu_items item
     where item.special and item.archived_at is null
       and not exists (select 1 from public.menu_items other where other.special and other.archived_at is null
                        and other.id <> item.id and other.name = item.name and other.category_id = item.category_id)
  loop
    update public.menu_items set special = false, special_note = '', special_ends_on = null where id = legacy.id;
    perform public._wayne_copy_item_as_special(legacy.id, legacy.special_note, legacy.special_ends_on);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Admin -> Customers: payment details and signatures for disputes
-- ---------------------------------------------------------------------------
create or replace function public.wayne_admin_customer_payment_records(target_customer_id uuid, max_orders integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not public.wayne_has_permission('customers.view') then raise exception 'Customer viewing permission required' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(record order by placed desc)
    from (
      select coalesce(o.placed_at, o.created_at) placed, jsonb_build_object(
        'id', o.id, 'order_number', o.order_number, 'daily_number', o.daily_number,
        'placed_at', coalesce(o.placed_at, o.created_at), 'status', o.status, 'source', o.source,
        'fulfillment_type', o.fulfillment_type, 'payment_status', o.payment_status, 'payment_method', o.payment_method,
        'subtotal_cents', o.subtotal_cents, 'tax_cents', o.tax_cents, 'delivery_fee_cents', o.delivery_fee_cents,
        'discount_cents', o.discount_cents, 'tip_cents', o.tip_cents, 'total_cents', o.total_cents, 'is_test', o.is_test,
        'payments', coalesce((select jsonb_agg(jsonb_build_object(
            'id', p.id, 'method', p.method, 'provider', p.provider, 'provider_payment_id', p.provider_payment_id,
            'status', p.status, 'amount_cents', p.amount_cents, 'card_brand', p.card_brand, 'card_last4', p.card_last4,
            'entry', coalesce(p.metadata ->> 'entry', p.metadata ->> 'entry_mode', p.metadata ->> 'via', ''),
            'approval_code', coalesce(p.metadata ->> 'approval_code', ''),
            'tip_cents', coalesce((p.metadata ->> 'tip_cents')::integer, 0),
            'tendered_cents', p.tendered_cents, 'change_cents', p.change_cents,
            'authorized_at', p.authorized_at, 'captured_at', p.captured_at, 'failed_at', p.failed_at,
            'failure_reason', p.failure_reason, 'receipt_url', p.receipt_url, 'created_at', p.created_at,
            'taken_by', (select nullif(pr.display_name, '') from public.profiles pr where pr.id = p.created_by_user_id)
          ) order by p.created_at) from public.payments p where p.order_id = o.id), '[]'::jsonb),
        'refunds', coalesce((select jsonb_agg(jsonb_build_object('amount_cents', r.amount_cents, 'status', r.status, 'reason', r.reason, 'created_at', r.created_at)
            order by r.created_at) from public.refunds r where r.order_id = o.id), '[]'::jsonb),
        'signatures', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'signature_svg', s.signature_svg, 'tip_cents', s.tip_cents, 'signed_at', s.created_at)
            order by s.created_at) from public.order_signatures s where s.order_id = o.id), '[]'::jsonb)
      ) record
      from public.orders o
      where o.customer_id = target_customer_id and o.status <> 'draft'
      order by coalesce(o.placed_at, o.created_at) desc
      limit greatest(1, least(coalesce(max_orders, 100), 500))
    ) rows
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.wayne_admin_customer_payment_records(uuid, integer) from public, anon;
grant execute on function public.wayne_admin_customer_payment_records(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The day's deliveries per driver (delivery close out slip, driver tips receipt)
-- ---------------------------------------------------------------------------
create or replace function public.wayne_delivery_day_report(target_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  zone text;
  day date;
begin
  if not (public.wayne_has_permission('cash.manage') or public.wayne_has_permission('delivery.dispatch') or public.wayne_has_permission('reports.view')) then
    raise exception 'Manager permission required' using errcode = '42501';
  end if;
  zone := public.wayne_store_zone();
  day := coalesce(target_day, (now() at time zone zone)::date);
  return (
    with lines as (
      select dc.driver_id, dc.id cashout_id, dc.created_at cashed_out_at, o.id order_id, o.order_number, o.daily_number,
             coalesce(line ->> 'paid_by', '') paid_by,
             coalesce((line ->> 'tip_cents')::integer, 0) tip_cents,
             coalesce((line ->> 'cash_cents')::integer, 0) cash_cents,
             coalesce((line ->> 'total_cents')::integer, 0) total_cents
        from public.driver_cashouts dc
        cross join lateral jsonb_array_elements(coalesce(dc.detail, '[]'::jsonb)) line
        join public.orders o on o.id = (line ->> 'order_id')::uuid
       where not o.is_test and (coalesce(o.placed_at, o.created_at) at time zone zone)::date = day
    ),
    pending as (
      select a.driver_id, count(*)::integer n, coalesce(sum(o.total_cents), 0)::integer cents
        from public.delivery_assignments a join public.orders o on o.id = a.order_id
       where a.status <> 'released' and a.cashout_id is null and o.status <> 'cancelled' and not o.is_test
         and (coalesce(o.placed_at, o.created_at) at time zone zone)::date = day
       group by a.driver_id
    ),
    driver_ids as (select driver_id from lines union select driver_id from pending),
    per_driver as (
      select d.driver_id,
             coalesce((select nullif(p.display_name, '') from public.profiles p where p.id = d.driver_id), 'Driver') as name,
             (select count(*) from lines l where l.driver_id = d.driver_id)::integer deliveries,
             (select count(distinct l.cashout_id) from lines l where l.driver_id = d.driver_id)::integer cashouts,
             (select max(l.cashed_out_at) from lines l where l.driver_id = d.driver_id) last_cashout_at,
             (select coalesce(sum(l.total_cents), 0) from lines l where l.driver_id = d.driver_id)::integer delivery_total_cents,
             (select coalesce(sum(l.cash_cents), 0) from lines l where l.driver_id = d.driver_id)::integer cash_orders_cents,
             (select coalesce(sum(l.tip_cents), 0) from lines l where l.driver_id = d.driver_id and l.paid_by in ('card_held', 'card', 'paid'))::integer card_tips_cents,
             (select coalesce(sum(l.tip_cents), 0) from lines l where l.driver_id = d.driver_id and l.paid_by in ('cash', 'cash_paid'))::integer cash_tips_cents,
             coalesce((select pe.n from pending pe where pe.driver_id = d.driver_id), 0) pending_count,
             coalesce((select pe.cents from pending pe where pe.driver_id = d.driver_id), 0) pending_cents,
             coalesce((select jsonb_agg(jsonb_build_object('order_number', l.order_number, 'daily_number', l.daily_number, 'paid_by', l.paid_by,
                 'total_cents', l.total_cents, 'tip_cents', l.tip_cents, 'cash_cents', l.cash_cents) order by l.cashed_out_at, l.order_number)
               from lines l where l.driver_id = d.driver_id), '[]'::jsonb) orders
        from driver_ids d
    )
    select jsonb_build_object(
      'day', day,
      'timezone', zone,
      'generated_at', now(),
      'drivers', coalesce((select jsonb_agg(jsonb_build_object(
          'driver_id', pd.driver_id, 'name', pd.name, 'deliveries', pd.deliveries, 'cashouts', pd.cashouts,
          'last_cashout_at', pd.last_cashout_at, 'delivery_total_cents', pd.delivery_total_cents,
          'cash_orders_cents', pd.cash_orders_cents, 'card_tips_cents', pd.card_tips_cents, 'cash_tips_cents', pd.cash_tips_cents,
          'tips_cents', pd.card_tips_cents + pd.cash_tips_cents, 'hand_in_cents', pd.cash_orders_cents - pd.card_tips_cents,
          'pending_count', pd.pending_count, 'pending_cents', pd.pending_cents, 'orders', pd.orders
        ) order by pd.name) from per_driver pd), '[]'::jsonb)
    )
  );
end;
$function$;
revoke all on function public.wayne_delivery_day_report(date) from public, anon;
grant execute on function public.wayne_delivery_day_report(date) to authenticated;

drop function public._wayne_patch_function(regprocedure, text, text);
