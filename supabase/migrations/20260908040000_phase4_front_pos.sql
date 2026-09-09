-- Wayne's Pizza POS — Phase 4 only: front-counter and phone order entry.

insert into public.permissions (id, code, description)
values ('20000000-0000-4000-8000-000000000011', 'pos.discount.manage', 'Apply audited manual POS discounts');

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on permission.code = 'pos.discount.manage'
where role.code in ('owner', 'manager');

create or replace function public.wayne_raise_permission_error(message text)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%', message using errcode = '42501';
end;
$$;

create or replace function public.wayne_pos_menu()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.wayne_has_permission('pos.access') then coalesce(jsonb_agg(category_payload order by category_sort, category_name), '[]'::jsonb)
    else public.wayne_raise_permission_error('POS access required') end
  from (
    select category.sort_order category_sort, category.name category_name,
      jsonb_build_object(
        'id', category.id, 'name', category.name, 'description', category.description,
        'image_path', category.image_path, 'image_alt', category.image_alt,
        'items', coalesce((
          select jsonb_agg(item_payload order by item_sort, item_name)
          from (
            select item.sort_order item_sort, item.name item_name,
              jsonb_build_object(
                'id', item.id, 'name', item.name, 'description', item.description,
                'image_path', item.image_path, 'image_alt', item.image_alt,
                'base_price_cents', item.base_price_cents, 'included_count_label', item.included_count_label,
                'sold_out', item.sold_out, 'featured', item.featured,
                'available_days', item.available_days, 'available_start', item.available_start, 'available_end', item.available_end,
                'variants', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', variant.id, 'name', variant.name, 'price_cents', variant.price_cents, 'sku', variant.sku
                ) order by variant.sort_order, variant.name) from public.menu_item_variants variant
                  where variant.menu_item_id = item.id and variant.active and variant.archived_at is null), '[]'::jsonb),
                'modifier_groups', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', modifier_group.id, 'name', modifier_group.name, 'customer_label', modifier_group.customer_label,
                  'min_select', modifier_group.min_select, 'max_select', modifier_group.max_select,
                  'required', modifier_group.required, 'allow_quantities', modifier_group.allow_quantities,
                  'choices', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', choice.id, 'name', choice.name, 'price_delta_cents', choice.price_delta_cents,
                    'default_selected', choice.default_selected
                  ) order by choice.sort_order, choice.name) from public.modifier_choices choice
                    where choice.modifier_group_id = modifier_group.id and choice.active and choice.archived_at is null), '[]'::jsonb)
                ) order by link.sort_order, modifier_group.name)
                from public.menu_item_modifier_groups link
                join public.modifier_groups modifier_group on modifier_group.id = link.modifier_group_id
                where link.menu_item_id = item.id and link.active and modifier_group.active and modifier_group.archived_at is null), '[]'::jsonb)
              ) item_payload
            from public.menu_items item
            where item.category_id = category.id and item.pos_visible and item.archived_at is null
          ) items
        ), '[]'::jsonb)
      ) category_payload
    from public.menu_categories category
    where category.archived_at is null
  ) categories;
$$;

create or replace function public.wayne_pos_customer_search(search_text text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := btrim(coalesce(search_text, ''));
  phone_search text := regexp_replace(coalesce(search_text, ''), '[^0-9+]', '', 'g');
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if char_length(normalized_search) < 2 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(customer_payload order by last_order_at desc nulls last, display_name) from (
    select customer.last_order_at, customer.first_name || ' ' || customer.last_name display_name,
      jsonb_build_object(
        'id', customer.id, 'first_name', customer.first_name, 'last_name', customer.last_name,
        'phone', customer.phone_normalized, 'email', customer.email_normalized,
        'first_order_at', customer.first_order_at, 'last_order_at', customer.last_order_at,
        'order_count', customer.order_count, 'lifetime_spend_cents', customer.lifetime_spend_cents,
        'average_order_value_cents', customer.average_order_value_cents,
        'addresses', coalesce((select jsonb_agg(to_jsonb(address) - 'customer_id' order by address.is_default desc, address.updated_at desc) from public.customer_addresses address where address.customer_id = customer.id), '[]'::jsonb)
      ) customer_payload
    from public.customers customer
    where customer.first_name || ' ' || customer.last_name ilike '%' || normalized_search || '%'
      or (phone_search <> '' and customer.phone_normalized ilike '%' || phone_search || '%')
      or exists (select 1 from public.orders order_row where order_row.customer_id = customer.id and order_row.order_number ilike '%' || normalized_search || '%')
    order by customer.last_order_at desc nulls last
    limit 20
  ) matches), '[]'::jsonb);
end;
$$;

create or replace function public.wayne_rebuild_customer_metrics(target_customer_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.customers customer set
    first_order_at = metrics.first_order_at,
    last_order_at = metrics.last_order_at,
    order_count = metrics.order_count,
    lifetime_spend_cents = metrics.lifetime_spend_cents,
    average_order_value_cents = case when metrics.order_count = 0 then 0 else round(metrics.lifetime_spend_cents::numeric / metrics.order_count)::integer end
  from (
    select count(*)::integer order_count, min(order_row.placed_at) first_order_at, max(order_row.placed_at) last_order_at,
      coalesce(sum(order_row.total_cents), 0)::bigint lifetime_spend_cents
    from public.orders order_row
    where order_row.customer_id = target_customer_id and order_row.placed_at is not null and order_row.status not in ('draft', 'cancelled')
  ) metrics
  where customer.id = target_customer_id;
$$;

create or replace function public.wayne_refresh_order_customer_metrics()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.customer_id is distinct from new.customer_id and old.customer_id is not null then perform public.wayne_rebuild_customer_metrics(old.customer_id); end if;
  if new.customer_id is not null then perform public.wayne_rebuild_customer_metrics(new.customer_id); end if;
  return new;
end;
$$;

create trigger orders_refresh_customer_metrics
after insert or update of customer_id, status, total_cents, placed_at on public.orders
for each row execute function public.wayne_refresh_order_customer_metrics();

do $$ declare customer_row record; begin
  for customer_row in select id from public.customers loop perform public.wayne_rebuild_customer_metrics(customer_row.id); end loop;
end $$;

create or replace function public.wayne_create_pos_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings public.store_settings%rowtype;
  request_key text := btrim(coalesce(payload ->> 'idempotency_key', ''));
  existing_order_id uuid;
  created_order_id uuid;
  order_item_id uuid;
  created_customer_id uuid;
  supplied_customer_id uuid;
  address_id uuid;
  normalized_phone text;
  normalized_email text;
  customer_name text;
  customer_mode text := payload ->> 'customer_mode';
  order_source text := payload ->> 'source';
  fulfillment text := payload ->> 'fulfillment_type';
  payment_method_value text := payload ->> 'payment_method';
  manual_type text := nullif(payload ->> 'manual_discount_type', '');
  manual_value integer := greatest(coalesce((payload ->> 'manual_discount_value')::integer, 0), 0);
  manual_reason text := btrim(coalesce(payload ->> 'manual_discount_reason', ''));
  item_payload jsonb;
  modifier_payload jsonb;
  item_record public.menu_items%rowtype;
  variant_record public.menu_item_variants%rowtype;
  choice_record record;
  group_record record;
  address_record public.customer_addresses%rowtype;
  quantity_value integer;
  modifier_quantity integer;
  unit_price integer;
  modifier_total integer;
  line_total integer;
  subtotal integer := 0;
  discount integer := 0;
  delivery_fee integer := 0;
  tax integer := 0;
  tip integer := greatest(coalesce((payload ->> 'tip_cents')::integer, 0), 0);
  total integer;
  promotion_record public.promotions%rowtype;
  address_snapshot jsonb;
  selection_count integer;
  duplicate_choice_count integer;
begin
  if not public.wayne_has_permission('pos.access') then raise exception 'POS access required' using errcode = '42501'; end if;
  if char_length(request_key) < 16 then raise exception 'A valid idempotency key is required' using errcode = '22023'; end if;
  insert into public.order_idempotency (idempotency_key) values (request_key) on conflict do nothing;
  select request.order_id into existing_order_id from public.order_idempotency request where request.idempotency_key = request_key for update;
  if existing_order_id is not null then return (select jsonb_build_object('id', id, 'order_number', order_number, 'total_cents', total_cents, 'duplicate', true) from public.orders where id = existing_order_id); end if;

  select * into settings from public.store_settings where id = true;
  if not settings.test_ordering_enabled then raise exception 'Test ordering is disabled' using errcode = 'P0001'; end if;
  if customer_mode not in ('walk_in', 'identified') then raise exception 'Choose walk-in or customer order' using errcode = '22023'; end if;
  if order_source not in ('pos', 'phone') then raise exception 'Choose a valid POS order source' using errcode = '22023'; end if;
  if customer_mode = 'walk_in' and (order_source <> 'pos' or fulfillment <> 'pickup') then raise exception 'Walk-in orders must be POS pickup orders' using errcode = '22023'; end if;
  if fulfillment not in ('pickup', 'delivery') then raise exception 'Choose pickup or delivery' using errcode = '22023'; end if;
  if fulfillment = 'pickup' and not settings.pickup_enabled then raise exception 'Pickup is currently unavailable' using errcode = 'P0001'; end if;
  if fulfillment = 'delivery' and not settings.delivery_enabled then raise exception 'Delivery is currently unavailable' using errcode = 'P0001'; end if;
  if payment_method_value not in ('test_manual', 'cash') then raise exception 'Only TEST / MANUAL or cash designation is available' using errcode = '22023'; end if;
  if jsonb_typeof(payload -> 'items') <> 'array' or jsonb_array_length(payload -> 'items') = 0 or jsonb_array_length(payload -> 'items') > 50 then raise exception 'Ticket must contain between 1 and 50 lines' using errcode = '22023'; end if;

  if customer_mode = 'walk_in' then
    customer_name := 'Walk-in'; normalized_phone := ''; normalized_email := null;
  else
    normalized_phone := public.wayne_normalize_phone(payload ->> 'phone');
    if normalized_phone is null then raise exception 'Enter a valid 10-digit US phone number' using errcode = '22023'; end if;
    if char_length(btrim(coalesce(payload ->> 'first_name', ''))) not between 1 and 100 or char_length(btrim(coalesce(payload ->> 'last_name', ''))) not between 1 and 100 then raise exception 'First and last name are required' using errcode = '22023'; end if;
    normalized_email := nullif(lower(btrim(coalesce(payload ->> 'email', ''))), '');
    if normalized_email is not null and (char_length(normalized_email) > 254 or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
    customer_name := btrim(payload ->> 'first_name') || ' ' || btrim(payload ->> 'last_name');
    supplied_customer_id := nullif(payload ->> 'customer_id', '')::uuid;
    if supplied_customer_id is not null then
      select id into created_customer_id from public.customers where id = supplied_customer_id and phone_normalized = normalized_phone for update;
      if created_customer_id is null then raise exception 'Selected customer no longer matches that phone number' using errcode = 'P0001'; end if;
    else
      select id into created_customer_id from public.customers where phone_normalized = normalized_phone for update;
    end if;
    if created_customer_id is null then
      insert into public.customers (first_name, last_name, phone_normalized, email_normalized) values (btrim(payload ->> 'first_name'), btrim(payload ->> 'last_name'), normalized_phone, normalized_email) returning id into created_customer_id;
    else
      update public.customers set first_name = btrim(payload ->> 'first_name'), last_name = btrim(payload ->> 'last_name'), email_normalized = coalesce(normalized_email, email_normalized) where id = created_customer_id;
    end if;
  end if;

  if fulfillment = 'delivery' then
    address_id := nullif(payload ->> 'address_id', '')::uuid;
    if address_id is not null then
      select * into address_record from public.customer_addresses where id = address_id and customer_id = created_customer_id;
      if not found then raise exception 'Selected delivery address was not found' using errcode = 'P0001'; end if;
      address_snapshot := jsonb_build_object('address1', address_record.address1, 'address2', address_record.address2, 'city', address_record.city, 'state', address_record.state, 'postal_code', address_record.postal_code, 'delivery_instructions', address_record.delivery_instructions);
    else
      if char_length(btrim(coalesce(payload #>> '{address,address1}', ''))) = 0 or char_length(btrim(coalesce(payload #>> '{address,city}', ''))) = 0 or char_length(btrim(coalesce(payload #>> '{address,state}', ''))) = 0 or char_length(btrim(coalesce(payload #>> '{address,postal_code}', ''))) = 0 then raise exception 'A complete delivery address is required' using errcode = '22023'; end if;
      address_snapshot := jsonb_build_object('address1', btrim(payload #>> '{address,address1}'), 'address2', btrim(coalesce(payload #>> '{address,address2}', '')), 'city', btrim(payload #>> '{address,city}'), 'state', upper(btrim(payload #>> '{address,state}')), 'postal_code', btrim(payload #>> '{address,postal_code}'), 'delivery_instructions', btrim(coalesce(payload #>> '{address,delivery_instructions}', '')));
      insert into public.customer_addresses (customer_id, address1, address2, city, state, postal_code, delivery_instructions, is_default) values (created_customer_id, address_snapshot ->> 'address1', address_snapshot ->> 'address2', address_snapshot ->> 'city', address_snapshot ->> 'state', address_snapshot ->> 'postal_code', address_snapshot ->> 'delivery_instructions', not exists (select 1 from public.customer_addresses where customer_id = created_customer_id)) returning id into address_id;
    end if;
    if cardinality(settings.delivery_postal_codes) > 0 and not ((address_snapshot ->> 'postal_code') = any(settings.delivery_postal_codes)) then raise exception 'That address is outside the configured delivery area' using errcode = 'P0001'; end if;
  end if;

  for item_payload in select value from jsonb_array_elements(payload -> 'items') loop
    quantity_value := coalesce((item_payload ->> 'quantity')::integer, 0);
    if quantity_value not between 1 and 20 then raise exception 'Each ticket quantity must be between 1 and 20' using errcode = '22023'; end if;
    select item.* into item_record from public.menu_items item join public.menu_categories category on category.id = item.category_id where item.id = (item_payload ->> 'menu_item_id')::uuid and item.pos_visible and item.archived_at is null and not item.sold_out and category.archived_at is null;
    if not found then raise exception 'A ticket item is unavailable' using errcode = 'P0001'; end if;
    if exists (select 1 from public.menu_item_variants variant where variant.menu_item_id = item_record.id and variant.active and variant.archived_at is null) then
      if nullif(item_payload ->> 'variant_id', '') is null then raise exception 'Choose a variant for %', item_record.name using errcode = '22023'; end if;
      select * into variant_record from public.menu_item_variants where id = (item_payload ->> 'variant_id')::uuid and menu_item_id = item_record.id and active and archived_at is null;
      if not found then raise exception 'A selected variant is unavailable' using errcode = 'P0001'; end if;
      unit_price := variant_record.price_cents;
    else
      if nullif(item_payload ->> 'variant_id', '') is not null then raise exception 'Invalid variant selection' using errcode = '22023'; end if;
      variant_record := null; unit_price := item_record.base_price_cents;
    end if;
    if jsonb_typeof(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) <> 'array' then raise exception 'Invalid modifier selections' using errcode = '22023'; end if;
    select count(*) - count(distinct value ->> 'choice_id') into duplicate_choice_count from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb));
    if duplicate_choice_count > 0 then raise exception 'Duplicate modifier choices are not allowed' using errcode = '22023'; end if;
    modifier_total := 0;
    for modifier_payload in select value from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) loop
      modifier_quantity := coalesce((modifier_payload ->> 'quantity')::integer, 0);
      select choice.id, choice.name, choice.price_delta_cents, modifier_group.id group_id, modifier_group.name group_name, modifier_group.allow_quantities into choice_record from public.modifier_choices choice join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id join public.menu_item_modifier_groups link on link.modifier_group_id = modifier_group.id where choice.id = (modifier_payload ->> 'choice_id')::uuid and link.menu_item_id = item_record.id and link.active and choice.active and choice.archived_at is null and modifier_group.active and modifier_group.archived_at is null;
      if not found then raise exception 'A selected modifier is unavailable' using errcode = 'P0001'; end if;
      if modifier_quantity not between 1 and 20 or (not choice_record.allow_quantities and modifier_quantity <> 1) then raise exception 'Invalid modifier quantity' using errcode = '22023'; end if;
      modifier_total := modifier_total + choice_record.price_delta_cents * modifier_quantity;
    end loop;
    for group_record in select modifier_group.* from public.menu_item_modifier_groups link join public.modifier_groups modifier_group on modifier_group.id = link.modifier_group_id where link.menu_item_id = item_record.id and link.active and modifier_group.active and modifier_group.archived_at is null loop
      select coalesce(sum(case when group_record.allow_quantities then (selected.value ->> 'quantity')::integer else 1 end), 0)::integer into selection_count from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) selected join public.modifier_choices choice on choice.id = (selected.value ->> 'choice_id')::uuid where choice.modifier_group_id = group_record.id;
      if selection_count < group_record.min_select or selection_count > group_record.max_select or (group_record.required and selection_count = 0) then raise exception 'Invalid selections for %', group_record.customer_label using errcode = '22023'; end if;
    end loop;
    line_total := (unit_price + modifier_total) * quantity_value;
    if line_total < 0 then raise exception 'Item price cannot be negative' using errcode = '22023'; end if;
    subtotal := subtotal + line_total;
  end loop;

  if fulfillment = 'pickup' and subtotal < settings.pickup_minimum_cents then raise exception 'Pickup order minimum is not met' using errcode = 'P0001'; end if;
  if fulfillment = 'delivery' and subtotal < settings.delivery_minimum_cents then raise exception 'Delivery order minimum is not met' using errcode = 'P0001'; end if;
  if fulfillment = 'delivery' then delivery_fee := settings.delivery_fee_cents; end if;
  if nullif(upper(btrim(coalesce(payload ->> 'promo_code', ''))), '') is not null then
    if manual_type is not null then raise exception 'Use either a promotion or a manual discount, not both' using errcode = '22023'; end if;
    select * into promotion_record from public.promotions where code = upper(btrim(payload ->> 'promo_code')) and active and archived_at is null and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()) and (fulfillment_type is null or fulfillment_type = fulfillment) and minimum_order_cents <= subtotal and (total_usage_limit is null or uses_count < total_usage_limit) for update;
    if not found then raise exception 'Promotion code is invalid or unavailable' using errcode = 'P0001'; end if;
    discount := case when promotion_record.discount_type = 'fixed' then least(subtotal, promotion_record.discount_value) else least(subtotal, ((subtotal::bigint * promotion_record.discount_value + 5000) / 10000)::integer) end;
  elsif manual_type is not null then
    if not public.wayne_has_permission('pos.discount.manage') then raise exception 'Manager discount permission required' using errcode = '42501'; end if;
    if char_length(manual_reason) < 3 then raise exception 'A manual discount reason is required' using errcode = '22023'; end if;
    if manual_type = 'fixed' and manual_value > 0 then discount := least(subtotal, manual_value);
    elsif manual_type = 'percent' and manual_value between 1 and 10000 then discount := least(subtotal, ((subtotal::bigint * manual_value + 5000) / 10000)::integer);
    else raise exception 'Enter a valid manual discount' using errcode = '22023'; end if;
  end if;
  if not settings.tips_enabled then tip := 0; end if;
  if tip > subtotal then raise exception 'Tip amount is too high' using errcode = '22023'; end if;
  tax := (((subtotal - discount + delivery_fee)::bigint * settings.tax_rate_basis_points + 5000) / 10000)::integer;
  total := subtotal - discount + delivery_fee + tax + tip;

  insert into public.orders (order_number, customer_id, source, fulfillment_type, status, payment_status, payment_method, subtotal_cents, discount_cents, delivery_fee_cents, tax_cents, tip_cents, total_cents, customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, delivery_address_snapshot, special_instructions, pricing_snapshot, placed_at, promised_at, created_by_user_id, idempotency_key)
  values ('W' || lpad(nextval('public.wayne_order_number_seq')::text, 6, '0'), created_customer_id, order_source, fulfillment, 'placed', 'unpaid', payment_method_value, subtotal, discount, delivery_fee, tax, tip, total, customer_name, normalized_phone, normalized_email, address_snapshot, btrim(coalesce(payload ->> 'special_instructions', '')), jsonb_build_object('tax_rate_basis_points', settings.tax_rate_basis_points, 'pickup_minimum_cents', settings.pickup_minimum_cents, 'delivery_minimum_cents', settings.delivery_minimum_cents, 'delivery_fee_cents', settings.delivery_fee_cents, 'payment_mode', case when payment_method_value = 'cash' then 'CASH DESIGNATION / UNPAID' else 'TEST / MANUAL' end), now(), now() + make_interval(mins => case when fulfillment = 'delivery' then settings.delivery_estimate_minutes else settings.pickup_prep_minutes end), auth.uid(), request_key)
  returning id into created_order_id;

  for item_payload in select value from jsonb_array_elements(payload -> 'items') loop
    quantity_value := (item_payload ->> 'quantity')::integer;
    select * into item_record from public.menu_items where id = (item_payload ->> 'menu_item_id')::uuid;
    if nullif(item_payload ->> 'variant_id', '') is not null then select * into variant_record from public.menu_item_variants where id = (item_payload ->> 'variant_id')::uuid; unit_price := variant_record.price_cents; else variant_record := null; unit_price := item_record.base_price_cents; end if;
    modifier_total := 0;
    for modifier_payload in select value from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) loop
      select choice.id, choice.name, choice.price_delta_cents, modifier_group.name group_name into choice_record from public.modifier_choices choice join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id where choice.id = (modifier_payload ->> 'choice_id')::uuid;
      modifier_total := modifier_total + choice_record.price_delta_cents * (modifier_payload ->> 'quantity')::integer;
    end loop;
    line_total := (unit_price + modifier_total) * quantity_value;
    insert into public.order_items (order_id, menu_item_id, variant_id, item_name_snapshot, variant_name_snapshot, unit_price_cents, modifier_unit_total_cents, quantity, line_total_cents, special_instructions)
    values (created_order_id, item_record.id, variant_record.id, item_record.name, variant_record.name, unit_price, modifier_total, quantity_value, line_total, btrim(coalesce(item_payload ->> 'special_instructions', ''))) returning id into order_item_id;
    for modifier_payload in select value from jsonb_array_elements(coalesce(item_payload -> 'modifiers', '[]'::jsonb)) loop
      select choice.id, choice.name, choice.price_delta_cents, modifier_group.name group_name into choice_record from public.modifier_choices choice join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id where choice.id = (modifier_payload ->> 'choice_id')::uuid;
      insert into public.order_item_modifiers (order_item_id, modifier_choice_id, modifier_group_name_snapshot, modifier_name_snapshot, price_delta_cents, quantity) values (order_item_id, choice_record.id, choice_record.group_name, choice_record.name, choice_record.price_delta_cents, (modifier_payload ->> 'quantity')::integer);
    end loop;
  end loop;
  if promotion_record.id is not null then
    update public.promotions set uses_count = uses_count + 1 where id = promotion_record.id;
    insert into public.order_discounts (order_id, promotion_id, code_snapshot, description_snapshot, discount_type_snapshot, discount_value_snapshot, amount_cents) values (created_order_id, promotion_record.id, promotion_record.code, promotion_record.description, promotion_record.discount_type, promotion_record.discount_value, discount);
  elsif manual_type is not null then
    insert into public.order_discounts (order_id, promotion_id, code_snapshot, description_snapshot, discount_type_snapshot, discount_value_snapshot, amount_cents) values (created_order_id, null, 'MANUAL', manual_reason, manual_type, manual_value, discount);
    insert into public.order_events (order_id, event_type, actor_user_id, metadata) values (created_order_id, 'order.discount_applied', auth.uid(), jsonb_build_object('reason', manual_reason, 'discount_type', manual_type, 'discount_value', manual_value, 'amount_cents', discount));
  end if;
  insert into public.order_events (order_id, event_type, to_status, actor_user_id, metadata) values (created_order_id, 'order.placed', 'placed', auth.uid(), jsonb_build_object('source', order_source, 'payment_mode', payment_method_value));
  update public.order_idempotency set order_id = created_order_id where idempotency_key = request_key;
  return (select jsonb_build_object('id', id, 'order_number', order_number, 'total_cents', total_cents, 'duplicate', false) from public.orders where id = created_order_id);
end;
$$;

revoke all on function public.wayne_raise_permission_error(text) from public;
revoke all on function public.wayne_pos_menu() from public;
revoke all on function public.wayne_pos_customer_search(text) from public;
revoke all on function public.wayne_rebuild_customer_metrics(uuid) from public;
revoke all on function public.wayne_refresh_order_customer_metrics() from public;
revoke all on function public.wayne_create_pos_order(jsonb) from public;
grant execute on function public.wayne_pos_menu() to authenticated;
grant execute on function public.wayne_pos_customer_search(text) to authenticated;
grant execute on function public.wayne_create_pos_order(jsonb) to authenticated;

comment on function public.wayne_create_pos_order(jsonb) is 'Phase 4 idempotent, server-authoritative POS/phone order transaction using TEST/MANUAL or unpaid cash designation only.';
