-- One cheese + one sauce come with it, two on a Large (owner, 2026-10-19).
--
-- Turns on "included portions per size" (20261028080000) for every Cheese and
-- Sauces section used ONLY by subs, wraps, dinners, kids meals and calzones:
-- the first pick is free (two on a Large), picks after that cost their normal
-- price.  Pizzas and pasta are left as they were (owner's choice).  Sections
-- that already have a rule are not touched.  Everything stays editable in
-- Admin -> Menu -> the option section ("Included per size").
--
-- "Extra ..." options (Extra Cheese, Extra Sauce, Extra Meat) are an extra by
-- name, so they are never one of the free picks — always charged.  Mirrors
-- isExtraChoice() in src/lib/orders/cart.ts.

create or replace function public.wayne_is_extra_choice(p_name text)
returns boolean language sql immutable set search_path to ''
as $$ select coalesce(p_name, '') ~* '^\s*extra\M' $$;

create or replace function public.wayne_group_allowance_lines(p_group_id uuid, p_variant_id uuid, p_modifiers jsonb)
returns table (choice_id uuid, portions integer, free_portions integer, unit_cents integer, charge_cents integer)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  rule public.modifier_group_size_rules%rowtype;
  free_left integer;
  picked record;
  take integer;
  each_cents integer;
begin
  select * into rule from public.modifier_group_size_rules where id = public.wayne_group_size_rule_id(p_group_id, p_variant_id);
  if not found then return; end if;
  free_left := rule.included_count;
  for picked in
    select choice.id, choice.name, greatest(coalesce((selected.value ->> 'quantity')::integer, 0), 0) as qty,
           public.wayne_modifier_unit_cents(p_variant_id, choice.id) as unit
      from jsonb_array_elements(coalesce(p_modifiers, '[]'::jsonb)) selected
      join public.modifier_choices choice on choice.id = (selected.value ->> 'choice_id')::uuid
     where choice.modifier_group_id = p_group_id
     order by public.wayne_modifier_unit_cents(p_variant_id, choice.id) desc, choice.id
  loop
    if public.wayne_is_instruction_choice(picked.name) or public.wayne_is_extra_choice(picked.name) then
      choice_id := picked.id; portions := picked.qty; free_portions := 0; unit_cents := picked.unit; charge_cents := picked.unit * picked.qty;
      return next; continue;
    end if;
    take := least(picked.qty, free_left);
    free_left := free_left - take;
    each_cents := coalesce(rule.extra_each_cents, picked.unit);
    choice_id := picked.id; portions := picked.qty; free_portions := take; unit_cents := each_cents;
    charge_cents := (picked.qty - take) * each_cents;
    return next;
  end loop;
end;
$$;

with target as (
  select g.id, g.workspace_id
    from public.modifier_groups g
   where g.archived_at is null
     and g.name ~* '–\s*(cheese|sauces?)\s*$'
     and not exists (select 1 from public.modifier_group_size_rules r where r.modifier_group_id = g.id)
     and exists (select 1 from public.menu_item_modifier_groups mg where mg.modifier_group_id = g.id and mg.active)
     -- every item using it is a sub, wrap, dinner, kids meal or calzone
     and not exists (
       select 1 from public.menu_item_modifier_groups mg
         join public.menu_items i on i.id = mg.menu_item_id and i.archived_at is null
         join public.menu_categories c on c.id = i.category_id
        where mg.modifier_group_id = g.id and mg.active
          and c.name !~* '(subs?|wraps?|dinners?|kids|calzones?)\s*$')
)
insert into public.modifier_group_size_rules (modifier_group_id, size_name, included_count, workspace_id)
select id, s.size_name, s.included, workspace_id
  from target cross join (values ('', 1), ('Large', 2)) as s(size_name, included)
on conflict do nothing;
