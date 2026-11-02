-- Split tenders reserve only the requested portion of the locked remaining balance.
-- Preserve all existing authorization, audit, drawer and offline handling.
do $$
declare target regprocedure; definition text; old_text text; new_text text;
begin
  foreach target in array array[
    'public.wayne_begin_payment(jsonb)'::regprocedure,
    'public.wayne_take_cash_payment(jsonb)'::regprocedure,
    'public.wayne_record_card_payment(jsonb)'::regprocedure
  ] loop
    definition := pg_get_functiondef(target);
    old_text := 'order_row.total_cents := order_row.total_cents - public.wayne_order_paid_cents(order_row.id);';
    new_text := old_text || E'\n  if payload ? ''amount_cents'' then\n    if (payload->>''amount_cents'')::integer is null or (payload->>''amount_cents'')::integer <= 0 or (payload->>''amount_cents'')::integer > order_row.total_cents then\n      raise exception ''Payment amount must be greater than zero and no more than the remaining balance'' using errcode = ''22023'';\n    end if;\n    order_row.total_cents := (payload->>''amount_cents'')::integer;\n  end if;';
    if position(old_text in definition)=0 then raise exception 'Missing balance calculation: %',target; end if;
    definition := replace(definition, old_text, new_text);
    definition := replace(definition, 'payment_status = ''paid'', payment_method = ''cash''',
      'payment_status = case when public.wayne_order_paid_cents(order_row.id) >= (select total_cents from public.orders where id=order_row.id) then ''paid'' else ''unpaid'' end, payment_method = ''cash''');
    definition := replace(definition, 'payment_status = ''paid'', payment_method = ''card''',
      'payment_status = case when public.wayne_order_paid_cents(order_row.id) >= (select total_cents from public.orders where id=order_row.id) then ''paid'' else ''unpaid'' end, payment_method = ''card''');
    execute definition;
  end loop;

  -- Keep the legacy test RPC, add an explicit amount overload for split tests.
  definition := pg_get_functiondef('public.wayne_pos_test_card_payment(uuid,boolean,text,text)'::regprocedure);
  definition := replace(definition, 'request_key text)', 'request_key text, amount_cents integer)');
  old_text := 'v_order.total_cents := v_order.total_cents - public.wayne_order_paid_cents(v_order.id);';
  if position(old_text in definition)=0 then raise exception 'Missing test balance calculation'; end if;
  definition := replace(definition, old_text, old_text || E'\n  if amount_cents is null or amount_cents <= 0 or amount_cents > v_order.total_cents then raise exception ''Invalid split amount'' using errcode=''22023''; end if;\n  v_order.total_cents := amount_cents;');
  definition := replace(definition, 'payment_status = ''paid'', payment_method = ''card''',
    'payment_status = case when public.wayne_order_paid_cents(v_order.id) >= (select total_cents from public.orders where id=v_order.id) then ''paid'' else ''unpaid'' end, payment_method = ''card''');
  execute definition;
end $$;
revoke all on function public.wayne_pos_test_card_payment(uuid,boolean,text,text,integer) from public,anon;
grant execute on function public.wayne_pos_test_card_payment(uuid,boolean,text,text,integer) to authenticated;

-- A partial authorization is still a balance due, not a fully held order.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.wayne_payment_marks_order_authorized()'::regprocedure);
  definition := replace(definition, 'where id = new.order_id and payment_status = ''unpaid'';',
    'where id = new.order_id and payment_status = ''unpaid'' and public.wayne_order_paid_cents(new.order_id) >= total_cents;');
  execute definition;
end $$;

-- Ingredients can be repeated on every item; instructions stay once-only in the UI.
update public.modifier_groups g set allow_quantities=true, max_select=greatest(max_select,20), updated_at=now()
where active and archived_at is null
  and (g.allow_quantities or g.name ~* '(topping|vegetable|meat|cheese|sauce|dressing|extras?|bread)');

-- Pick-N pizzas retain N included portions, with paid repeats in the SAME group.
insert into public.modifier_group_size_rules(modifier_group_id,size_name,included_count,max_portions,extra_each_cents,workspace_id)
select g.id,'',case when g.name ~* '^one' then 1 when g.name ~* '^two' then 2 else 3 end,20,null,g.workspace_id
from public.modifier_groups g
where g.active and g.archived_at is null and g.name ~* '^(one|two|three)[ -]topping.*toppings?'
on conflict (modifier_group_id, lower(btrim(size_name))) do update set max_portions=20;
update public.modifier_group_size_rules r set max_portions=20
from public.modifier_groups g where g.id=r.modifier_group_id and g.name ~* '^(one|two|three)[ -]topping.*toppings?';

-- Pick-N choices historically cost $0 because their original limit stopped at N.
-- Use the same item's priced topping option for extra portions, including size overrides.
-- Existing positive prices remain owner-controlled.
with sources as (
  select pick.id, max(other.price_delta_cents) price
  from public.modifier_choices pick
  join public.modifier_groups g on g.id=pick.modifier_group_id
  join public.menu_item_modifier_groups main on main.modifier_group_id=g.id and main.active
  join public.menu_item_modifier_groups link on link.menu_item_id=main.menu_item_id and link.active and link.modifier_group_id<>g.id
  join public.modifier_choices other on other.modifier_group_id=link.modifier_group_id and other.active and other.archived_at is null
    and lower(btrim(other.name))=lower(btrim(pick.name))
  where g.name ~* '^(one|two|three)[ -]topping.*toppings?' and pick.price_delta_cents=0
  group by pick.id
)
update public.modifier_choices c set price_delta_cents=s.price,updated_at=now() from sources s where c.id=s.id;

insert into public.modifier_choice_variant_prices(modifier_choice_id,menu_item_variant_id,price_delta_cents)
select pick.id, variant.id, max(public.wayne_modifier_unit_cents(variant.id,other.id))
from public.modifier_choices pick
join public.modifier_groups g on g.id=pick.modifier_group_id
join public.menu_item_modifier_groups main on main.modifier_group_id=g.id and main.active
join public.menu_item_variants variant on variant.menu_item_id=main.menu_item_id and variant.active and variant.archived_at is null
join public.menu_item_modifier_groups link on link.menu_item_id=main.menu_item_id and link.active and link.modifier_group_id<>g.id
join public.modifier_choices other on other.modifier_group_id=link.modifier_group_id and other.active and other.archived_at is null
  and lower(btrim(other.name))=lower(btrim(pick.name))
where g.name ~* '^(one|two|three)[ -]topping.*toppings?'
group by pick.id,variant.id
on conflict (modifier_choice_id,menu_item_variant_id) do update
set price_delta_cents=excluded.price_delta_cents,updated_at=now()
where public.modifier_choice_variant_prices.price_delta_cents=0;
