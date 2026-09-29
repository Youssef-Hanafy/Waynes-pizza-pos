-- What an item comes with, highlighted and free.
--
-- Most of Wayne's menu ships with ingredients already on it: a Meat Lovers comes
-- with pepperoni, sausage, ham and salami; a cold sub with provolone, lettuce,
-- onion and tomato.  Until now that lived only in the "Comes with: ..." text, so
-- a cashier had to read the description and guess, and none of those options
-- were pre-selected on either order screen.
--
-- The option groups were loaded shared (every Gourmet Pizza uses the same
-- "Gourmet Pizza – Meats" group), so "comes with" cannot be a flag on the option
-- itself -- pepperoni is included on a Meat Lovers but is an add-on on a Veggie
-- Combo.  It is recorded per item instead, in menu_item_included_choices.
--
-- An included option is:
--   * pre-selected and highlighted on the POS and the online menu,
--   * free while it stays on (the price is already in the item),
--   * free to take off -- removing it never lowers the price,
--   * charged normally for each extra portion beyond the first,
--   * printed as "NO <option>" on the ticket when it is taken off, and left
--     off the ticket when it is kept (the kitchen already knows the recipe).
--
-- The flat modifier_choices.default_selected flag keeps working and means the
-- same thing; it is what an item edited in Admin -> Menu carries, because
-- saving an item gives it its own copy of its option groups.
--
-- This migration also fixes two live pricing/data bugs found on the way:
--   1. Both order functions charged every option its flat price and ignored
--      the per-size price table from Phase 14, so the server total did not
--      match what the screen showed on any sized item with an option.
--   2. Saving an item in Admin -> Menu archived every option group linked to
--      it -- including groups shared with other items -- which would silently
--      strip the toppings off every other pizza in that category.

create table public.menu_item_included_choices (
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  modifier_choice_id uuid not null references public.modifier_choices(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (menu_item_id, modifier_choice_id)
);

comment on table public.menu_item_included_choices is
  'Options an item comes with (pre-selected, free while kept, "NO x" on the ticket when removed). Per item because option groups are shared across items.';

create index menu_item_included_choices_choice_idx on public.menu_item_included_choices (modifier_choice_id);

alter table public.menu_item_included_choices enable row level security;

create policy menu_item_included_choices_admin_select on public.menu_item_included_choices
for select to authenticated using (public.wayne_has_permission('menu.manage'));

revoke all on public.menu_item_included_choices from anon, authenticated;
grant select on public.menu_item_included_choices to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers used by the order functions.  Internal only: not callable over REST.
-- ---------------------------------------------------------------------------

create or replace function public.wayne_choice_included(target_item_id uuid, target_choice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select choice.default_selected from public.modifier_choices choice where choice.id = target_choice_id), false)
      or exists (
        select 1 from public.menu_item_included_choices included
        where included.menu_item_id = target_item_id and included.modifier_choice_id = target_choice_id
      );
$$;

-- One portion of an option on a given size: the size's own price when the
-- owner set one (Phase 14), otherwise the option's flat price.
create or replace function public.wayne_modifier_unit_cents(target_variant_id uuid, target_choice_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select vp.price_delta_cents from public.modifier_choice_variant_prices vp
      where vp.modifier_choice_id = target_choice_id and vp.menu_item_variant_id = target_variant_id),
    (select choice.price_delta_cents from public.modifier_choices choice where choice.id = target_choice_id),
    0
  );
$$;

-- What a selected option adds to one unit of the item: every portion is
-- charged, except the first portion of an option the item comes with.
create or replace function public.wayne_modifier_charge_cents(
  target_item_id uuid, target_variant_id uuid, target_choice_id uuid, portions integer
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select public.wayne_modifier_unit_cents(target_variant_id, target_choice_id)
       * greatest(coalesce(portions, 0) - case when public.wayne_choice_included(target_item_id, target_choice_id) then 1 else 0 end, 0);
$$;

-- Runs right after an order function writes one selected option.  Keeps the
-- ticket to what the kitchen needs: an included option left on is dropped,
-- extra portions of it read "Extra <option>", and everything carries the
-- per-size price it was actually charged.
create or replace function public.wayne_settle_included_modifier(
  p_order_item_id uuid, p_item_id uuid, p_variant_id uuid, p_choice_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  portions integer;
  unit_cents integer := public.wayne_modifier_unit_cents(p_variant_id, p_choice_id);
begin
  select quantity into portions from public.order_item_modifiers
  where order_item_id = p_order_item_id and modifier_choice_id = p_choice_id;
  if not found then return; end if;

  if public.wayne_choice_included(p_item_id, p_choice_id) then
    if portions <= 1 then
      delete from public.order_item_modifiers
      where order_item_id = p_order_item_id and modifier_choice_id = p_choice_id;
    else
      update public.order_item_modifiers
      set quantity = portions - 1,
          modifier_name_snapshot = 'Extra ' || modifier_name_snapshot,
          price_delta_cents = unit_cents
      where order_item_id = p_order_item_id and modifier_choice_id = p_choice_id;
    end if;
  else
    update public.order_item_modifiers set price_delta_cents = unit_cents
    where order_item_id = p_order_item_id and modifier_choice_id = p_choice_id;
  end if;
end;
$$;

-- Writes "NO <option>" for every option the item comes with that the order
-- took off, so the kitchen, the receipt and the order history all show it.
-- Only called for order lines sent with lists_included = true: a screen built
-- before this change never pre-selects included options, and reading its
-- lines this way would print "NO" for the whole recipe.
create or replace function public.wayne_record_removed_included(
  p_order_item_id uuid, p_item_id uuid, p_modifiers jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.order_item_modifiers (
    order_item_id, modifier_choice_id, modifier_group_name_snapshot, modifier_name_snapshot, price_delta_cents, quantity
  )
  select distinct on (choice.id) p_order_item_id, choice.id, modifier_group.name, 'NO ' || btrim(choice.name), 0, 1
  from public.menu_item_modifier_groups link
  join public.modifier_groups modifier_group on modifier_group.id = link.modifier_group_id
  join public.modifier_choices choice on choice.modifier_group_id = modifier_group.id
  where link.menu_item_id = p_item_id and link.active
    and modifier_group.active and modifier_group.archived_at is null
    and choice.active and choice.archived_at is null
    and public.wayne_choice_included(p_item_id, choice.id)
    and not exists (
      select 1 from jsonb_array_elements(coalesce(p_modifiers, '[]'::jsonb)) selected
      where selected.value ->> 'choice_id' = choice.id::text
    )
  order by choice.id, link.sort_order;
$$;

revoke all on function public.wayne_choice_included(uuid, uuid) from public, anon, authenticated;
revoke all on function public.wayne_modifier_unit_cents(uuid, uuid) from public, anon, authenticated;
revoke all on function public.wayne_modifier_charge_cents(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.wayne_settle_included_modifier(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.wayne_record_removed_included(uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rewire the existing functions.  Each edit is a targeted text replacement on
-- the live definition that must match exactly once, so a definition that has
-- drifted fails loudly here instead of half-applying.
-- ---------------------------------------------------------------------------

create function pg_temp.replace_once(source text, find text, replacement text, label text)
returns text
language plpgsql
as $$
declare
  occurrences integer := (length(source) - length(replace(source, find, ''))) / length(find);
begin
  if occurrences <> 1 then
    raise exception 'included toppings migration: expected exactly one "%" in %, found %', find, label, occurrences;
  end if;
  return replace(source, find, replacement);
end;
$$;

do $patch$
declare
  fn text;
  src text;
begin
  -- Order functions: per-size price, included first portion free, removed
  -- included options recorded as "NO x".
  foreach fn in array array['public.wayne_create_test_order(jsonb)', 'public.wayne_create_pos_order(jsonb)'] loop
    src := pg_get_functiondef(fn::regprocedure);
    src := pg_temp.replace_once(src,
      'choice_record.price_delta_cents * modifier_quantity;',
      'public.wayne_modifier_charge_cents(item_record.id, variant_record.id, choice_record.id, modifier_quantity);', fn);
    src := pg_temp.replace_once(src,
      'choice_record.price_delta_cents * (modifier_payload ->> ''quantity'')::integer;',
      'public.wayne_modifier_charge_cents(item_record.id, variant_record.id, choice_record.id, (modifier_payload ->> ''quantity'')::integer);', fn);
    src := pg_temp.replace_once(src,
      'returning id into order_item_id;',
      'returning id into order_item_id;
    if coalesce((item_payload ->> ''lists_included'')::boolean, false) then
      perform public.wayne_record_removed_included(order_item_id, item_record.id, item_payload -> ''modifiers'');
    end if;', fn);
    src := pg_temp.replace_once(src,
      'choice_record.price_delta_cents, (modifier_payload ->> ''quantity'')::integer);',
      'choice_record.price_delta_cents, (modifier_payload ->> ''quantity'')::integer);
      perform public.wayne_settle_included_modifier(order_item_id, item_record.id, variant_record.id, choice_record.id);', fn);
    execute src;
  end loop;

  -- Menu feeds: an option is sent pre-selected when this item comes with it.
  foreach fn in array array['public.wayne_public_menu()', 'public.wayne_pos_menu()'] loop
    src := pg_get_functiondef(fn::regprocedure);
    src := pg_temp.replace_once(src,
      '''default_selected'', choice.default_selected',
      '''default_selected'', (choice.default_selected or exists (
                          select 1 from public.menu_item_included_choices included
                          where included.menu_item_id = item.id and included.modifier_choice_id = choice.id))', fn);
    execute src;
  end loop;
end;
$patch$;

-- ---------------------------------------------------------------------------
-- Saving an item must not archive option groups other items still use.
-- ---------------------------------------------------------------------------
create or replace function public.wayne_update_menu_item(target_item_id uuid, payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.wayne_has_permission('menu.manage') then
    raise exception 'Menu management permission required' using errcode = '42501';
  end if;

  perform 1 from public.menu_items where id = target_item_id for update;
  if not found then raise exception 'Menu item not found'; end if;

  update public.menu_items set
    category_id = (payload ->> 'category_id')::uuid,
    name = btrim(payload ->> 'name'),
    description = btrim(coalesce(payload ->> 'description', '')),
    image_path = coalesce(nullif(payload ->> 'image_path', ''), image_path),
    image_alt = btrim(coalesce(payload ->> 'image_alt', '')),
    base_price_cents = (payload ->> 'base_price_cents')::integer,
    tax_category = btrim(payload ->> 'tax_category'),
    included_count_label = btrim(coalesce(payload ->> 'included_count_label', '')),
    sold_out = (payload ->> 'sold_out')::boolean,
    customer_visible = (payload ->> 'customer_visible')::boolean,
    pos_visible = (payload ->> 'pos_visible')::boolean,
    featured = (payload ->> 'featured')::boolean,
    kitchen_route = nullif(btrim(coalesce(payload ->> 'kitchen_route', '')), ''),
    available_days = array(select jsonb_array_elements_text(payload -> 'available_days')::smallint),
    available_start = nullif(payload ->> 'available_start', '')::time,
    available_end = nullif(payload ->> 'available_end', '')::time,
    sort_order = (payload ->> 'sort_order')::integer
  where id = target_item_id;

  update public.menu_item_variants
  set active = false, archived_at = coalesce(archived_at, now())
  where menu_item_id = target_item_id and archived_at is null;

  -- Groups (and their options) used only by this item are archived; a group
  -- another item still uses is simply unlinked from this one.
  update public.modifier_choices
  set active = false, archived_at = coalesce(archived_at, now())
  where modifier_group_id in (
    select link.modifier_group_id from public.menu_item_modifier_groups link
    where link.menu_item_id = target_item_id
      and not exists (
        select 1 from public.menu_item_modifier_groups other
        where other.modifier_group_id = link.modifier_group_id
          and other.menu_item_id <> target_item_id and other.active
      )
  ) and archived_at is null;

  update public.modifier_groups
  set active = false, archived_at = coalesce(archived_at, now())
  where id in (
    select link.modifier_group_id from public.menu_item_modifier_groups link
    where link.menu_item_id = target_item_id
      and not exists (
        select 1 from public.menu_item_modifier_groups other
        where other.modifier_group_id = link.modifier_group_id
          and other.menu_item_id <> target_item_id and other.active
      )
  ) and archived_at is null;

  update public.menu_item_modifier_groups
  set active = false
  where menu_item_id = target_item_id and active;

  -- The saved item carries "comes with" on its own option copies
  -- (default_selected), so its per-item rows are no longer needed.
  delete from public.menu_item_included_choices where menu_item_id = target_item_id;

  perform public.wayne_write_menu_children(target_item_id, payload);
  return target_item_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Seed from each item's "Comes with: ..." line (Wayne's live Thrive menu).
-- Names are matched to that item's own options; "Tomatoes and Onion" style
-- entries are split, and plurals fall back to the singular option name.
-- Where an item has the same option in two groups, the first group wins.
-- ---------------------------------------------------------------------------
with wants as (
  select item.id as item_id, btrim(want.value) as want
  from public.menu_items item
  cross join lateral unnest(string_to_array(regexp_replace(item.description, '^\s*Comes with:\s*', '', 'i'), ',')) as want(value)
  where item.archived_at is null and item.description ~* '^\s*Comes with:' and btrim(want.value) <> ''
),
options as (
  select link.menu_item_id as item_id, choice.id as choice_id, lower(btrim(choice.name)) as option_name,
         link.sort_order as link_sort, modifier_group.name as group_name, choice.sort_order as choice_sort
  from public.menu_item_modifier_groups link
  join public.modifier_groups modifier_group on modifier_group.id = link.modifier_group_id
    and modifier_group.active and modifier_group.archived_at is null
  join public.modifier_choices choice on choice.modifier_group_id = modifier_group.id
    and choice.active and choice.archived_at is null
  where link.active
),
expanded as (
  select wants.item_id, wants.want from wants
  where exists (select 1 from options where options.item_id = wants.item_id and options.option_name = lower(wants.want))
  union all
  select wants.item_id, btrim(part.value) from wants
  cross join lateral unnest(regexp_split_to_array(wants.want, '\s+and\s+', 'i')) as part(value)
  where not exists (select 1 from options where options.item_id = wants.item_id and options.option_name = lower(wants.want))
),
resolved as (
  select distinct on (expanded.item_id, lower(expanded.want)) expanded.item_id, options.choice_id
  from expanded
  join options on options.item_id = expanded.item_id
   and options.option_name in (
     lower(expanded.want),
     lower(regexp_replace(expanded.want, 'es$', '', 'i')),
     lower(regexp_replace(expanded.want, 's$', '', 'i'))
   )
  order by expanded.item_id, lower(expanded.want), (options.option_name = lower(expanded.want)) desc,
           options.link_sort, options.group_name, options.choice_sort
)
insert into public.menu_item_included_choices (menu_item_id, modifier_choice_id)
select item_id, choice_id from resolved
on conflict do nothing;
