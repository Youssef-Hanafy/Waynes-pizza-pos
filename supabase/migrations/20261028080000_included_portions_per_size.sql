-- Included portions per size (owner, 2026-10-12).
--
-- "A large calzone comes with 3 sauces": for an option section (Sauces,
-- Dressings…) the owner sets, per size, how many portions are free, the most
-- that can be picked, and what each portion after the free ones costs.  The
-- free ones can be any mix, repeats allowed (2 Ranch + 1 BBQ).  Blank extra
-- price = each option's own price.  A rule with size_name '' covers items
-- without sizes / any size without its own rule.
--
-- Free portions go to the most expensive picks first (then by option id), the
-- same order the order screens use, so the screen total always matches the
-- server.  "No …" / "Light …" picks never count toward the free ones.

create table if not exists public.modifier_group_size_rules (
  id uuid primary key default gen_random_uuid(),
  modifier_group_id uuid not null references public.modifier_groups(id) on delete cascade,
  size_name text not null default '',
  included_count integer not null default 0 check (included_count between 0 and 20),
  max_portions integer check (max_portions is null or max_portions between 1 and 20),
  extra_each_cents integer check (extra_each_cents is null or extra_each_cents between 0 and 100000),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint modifier_group_size_rules_max check (max_portions is null or max_portions >= included_count)
);
create unique index if not exists modifier_group_size_rules_unique on public.modifier_group_size_rules (modifier_group_id, lower(btrim(size_name)));
alter table public.modifier_group_size_rules enable row level security;
revoke all on public.modifier_group_size_rules from anon;
grant select on public.modifier_group_size_rules to authenticated;
drop policy if exists modifier_group_size_rules_staff_read on public.modifier_group_size_rules;
create policy modifier_group_size_rules_staff_read on public.modifier_group_size_rules
  for select to authenticated using (public.wayne_has_permission('menu.manage') or public.wayne_has_permission('pos.access'));

-- The rule for a group on a size: that size's own rule, else the "any size" one.
create or replace function public.wayne_group_size_rule_id(p_group_id uuid, p_variant_id uuid)
returns uuid
language sql
stable
security definer
set search_path to ''
as $$
  select rule.id from public.modifier_group_size_rules rule
   where rule.modifier_group_id = p_group_id
     and (rule.size_name = ''
          or (p_variant_id is not null and lower(btrim(rule.size_name)) =
              (select lower(btrim(variant.name)) from public.menu_item_variants variant where variant.id = p_variant_id)))
   order by (rule.size_name = '') asc
   limit 1;
$$;

create or replace function public.wayne_group_size_rules_json(p_group_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'variant_name', rule.size_name, 'included_count', rule.included_count,
      'max_portions', rule.max_portions, 'extra_each_cents', rule.extra_each_cents) order by rule.size_name), '[]'::jsonb)
    from public.modifier_group_size_rules rule where rule.modifier_group_id = p_group_id;
$$;
grant execute on function public.wayne_group_size_rules_json(uuid) to anon, authenticated;

create or replace function public.wayne_is_instruction_choice(p_name text)
returns boolean
language sql
immutable
as $$ select btrim(coalesce(p_name, '')) ~* '^(no|light|lite)\M' $$;

-- Every selected portion of a rule group, cheapest-last, with what it costs.
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
    if public.wayne_is_instruction_choice(picked.name) then
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

-- The modifier total for one item line (per unit), allowances included.
-- Also refuses more portions than the size allows.
create or replace function public.wayne_line_modifier_total(p_item_id uuid, p_variant_id uuid, p_modifiers jsonb)
returns integer
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  total integer := 0;
  picked record;
  ruled record;
  rule public.modifier_group_size_rules%rowtype;
  counted integer;
begin
  for picked in
    select choice.id, choice.modifier_group_id, greatest(coalesce((selected.value ->> 'quantity')::integer, 0), 0) as qty
      from jsonb_array_elements(coalesce(p_modifiers, '[]'::jsonb)) selected
      join public.modifier_choices choice on choice.id = (selected.value ->> 'choice_id')::uuid
  loop
    if public.wayne_group_size_rule_id(picked.modifier_group_id, p_variant_id) is null then
      total := total + public.wayne_modifier_charge_cents(p_item_id, p_variant_id, picked.id, picked.qty);
    end if;
  end loop;
  for ruled in
    select distinct choice.modifier_group_id as group_id
      from jsonb_array_elements(coalesce(p_modifiers, '[]'::jsonb)) selected
      join public.modifier_choices choice on choice.id = (selected.value ->> 'choice_id')::uuid
     where public.wayne_group_size_rule_id(choice.modifier_group_id, p_variant_id) is not null
  loop
    total := total + coalesce((select sum(line.charge_cents) from public.wayne_group_allowance_lines(ruled.group_id, p_variant_id, p_modifiers) line), 0)::integer;
  end loop;
  -- Size limits.
  for ruled in
    select distinct choice.modifier_group_id as group_id, modifier_group.customer_label
      from jsonb_array_elements(coalesce(p_modifiers, '[]'::jsonb)) selected
      join public.modifier_choices choice on choice.id = (selected.value ->> 'choice_id')::uuid
      join public.modifier_groups modifier_group on modifier_group.id = choice.modifier_group_id
  loop
    select * into rule from public.modifier_group_size_rules where id = public.wayne_group_size_rule_id(ruled.group_id, p_variant_id);
    if not found or rule.max_portions is null then continue; end if;
    select coalesce(sum(line.portions), 0) into counted
      from public.wayne_group_allowance_lines(ruled.group_id, p_variant_id, p_modifiers) line
      join public.modifier_choices choice on choice.id = line.choice_id
     where not public.wayne_is_instruction_choice(choice.name);
    if counted > rule.max_portions then
      raise exception 'Too many for %: up to % on this size', ruled.customer_label, rule.max_portions using errcode = '22023';
    end if;
  end loop;
  return total;
end;
$$;

-- Ticket/receipt rows for rule groups: "Ranch (1 included + 1 extra)".
create or replace function public.wayne_apply_group_allowances(p_order_item_id uuid, p_item_id uuid, p_variant_id uuid, p_modifiers jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  ruled record;
  line record;
begin
  for ruled in
    select distinct choice.modifier_group_id as group_id
      from jsonb_array_elements(coalesce(p_modifiers, '[]'::jsonb)) selected
      join public.modifier_choices choice on choice.id = (selected.value ->> 'choice_id')::uuid
     where public.wayne_group_size_rule_id(choice.modifier_group_id, p_variant_id) is not null
  loop
    for line in select * from public.wayne_group_allowance_lines(ruled.group_id, p_variant_id, p_modifiers) loop
      update public.order_item_modifiers modifier
         set quantity = line.portions,
             price_delta_cents = case when line.portions > line.free_portions then line.unit_cents else 0 end,
             modifier_name_snapshot = (select btrim(choice.name) from public.modifier_choices choice where choice.id = line.choice_id)
               || case
                    when line.free_portions > 0 and line.portions > line.free_portions then ' (' || line.free_portions || ' included + ' || (line.portions - line.free_portions) || ' extra)'
                    when line.free_portions = 0 and line.charge_cents > 0 then ' (extra)'
                    else '' end
       where modifier.order_item_id = p_order_item_id and modifier.modifier_choice_id = line.choice_id;
    end loop;
  end loop;
end;
$$;

-- The old "comes with one free" settling is skipped for rule groups.
create or replace function public.wayne_settle_included_modifier(p_order_item_id uuid, p_item_id uuid, p_variant_id uuid, p_choice_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  portions integer;
  unit_cents integer := public.wayne_modifier_unit_cents(p_variant_id, p_choice_id);
begin
  if public.wayne_group_size_rule_id((select modifier_group_id from public.modifier_choices where id = p_choice_id), p_variant_id) is not null then
    return;
  end if;
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

-- Admin → Menu → category options: save the per-size rules of each section.
create or replace function public.wayne_save_category_size_rules(target_category_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  section jsonb;
  rule jsonb;
  group_ids uuid[];
  gid uuid;
  saved integer := 0;
  top integer;
begin
  if not public.wayne_has_permission('menu.manage') then raise exception 'Menu permission required' using errcode = '42501'; end if;
  for section in select value from jsonb_array_elements(coalesce(payload -> 'sections', '[]'::jsonb)) loop
    select array_agg(distinct link.modifier_group_id) into group_ids
      from public.menu_item_modifier_groups link
      join public.menu_items item on item.id = link.menu_item_id and item.category_id = target_category_id and item.archived_at is null
      join public.modifier_groups modifier_group on modifier_group.id = link.modifier_group_id and modifier_group.archived_at is null
     where link.active and lower(btrim(modifier_group.customer_label)) = lower(btrim(section ->> 'label'));
    if group_ids is null then continue; end if;
    for rule in select value from jsonb_array_elements(coalesce(section -> 'rules', '[]'::jsonb)) loop
      if coalesce((rule ->> 'included_count')::integer, -1) not between 0 and 20 then raise exception 'Included portions must be 0 to 20' using errcode = '22023'; end if;
      if (rule ->> 'max_portions') is not null and ((rule ->> 'max_portions')::integer not between 1 and 20 or (rule ->> 'max_portions')::integer < (rule ->> 'included_count')::integer) then
        raise exception 'The most for % has to be at least the number included', coalesce(nullif(rule ->> 'size_name', ''), 'every size') using errcode = '22023';
      end if;
      if (rule ->> 'extra_each_cents') is not null and (rule ->> 'extra_each_cents')::integer not between 0 and 100000 then raise exception 'Check the extra price' using errcode = '22023'; end if;
    end loop;
    delete from public.modifier_group_size_rules where modifier_group_id = any(group_ids);
    foreach gid in array group_ids loop
      insert into public.modifier_group_size_rules (modifier_group_id, size_name, included_count, max_portions, extra_each_cents, workspace_id)
      select gid, btrim(coalesce(rule.value ->> 'size_name', '')), (rule.value ->> 'included_count')::integer,
             (rule.value ->> 'max_portions')::integer, (rule.value ->> 'extra_each_cents')::integer,
             (select workspace_id from public.modifier_groups where id = gid)
        from jsonb_array_elements(coalesce(section -> 'rules', '[]'::jsonb)) rule;
      if jsonb_array_length(coalesce(section -> 'rules', '[]'::jsonb)) > 0 then
        select case when bool_or(max_portions is null) then 20 else max(max_portions) end into top
          from public.modifier_group_size_rules where modifier_group_id = gid;
        update public.modifier_groups
           set allow_quantities = true, max_select = greatest(top, min_select, 1), updated_at = now()
         where id = gid;
      end if;
    end loop;
    saved := saved + 1;
  end loop;
  perform public.wayne_write_audit('menu.size_rules_saved', 'menu_categories', target_category_id::text,
    'Saved included portions per size', '{}'::jsonb, payload);
  return jsonb_build_object('sections', saved);
end;
$$;
revoke all on function public.wayne_save_category_size_rules(uuid, jsonb) from public, anon;
grant execute on function public.wayne_save_category_size_rules(uuid, jsonb) to authenticated;

-- Patch the order functions and menu feeds in place (each patch runs once).
do $patch$
declare
  fn text;
  def text;
  before text;
begin
  foreach fn in array array['public.wayne_create_pos_order(jsonb)', 'public.wayne_create_test_order(jsonb)'] loop
    def := pg_get_functiondef(fn::regprocedure);
    if position('wayne_line_modifier_total' in def) = 0 then
      before := def;
      def := replace(def, 'line_total := (unit_price + modifier_total) * quantity_value;',
        'modifier_total := public.wayne_line_modifier_total(item_record.id, variant_record.id, coalesce(item_payload -> ''modifiers'', ''[]''::jsonb)); line_total := (unit_price + modifier_total) * quantity_value;');
      if (length(def) - length(before)) <> 2 * (length('modifier_total := public.wayne_line_modifier_total(item_record.id, variant_record.id, coalesce(item_payload -> ''modifiers'', ''[]''::jsonb)); ')) then
        raise exception 'Could not patch line totals in %', fn;
      end if;
      before := def;
      def := regexp_replace(def,
        '(perform public\.wayne_settle_included_modifier\([^;]*\);\s*end loop;)',
        E'\\1\n    perform public.wayne_apply_group_allowances(order_item_id, item_record.id, variant_record.id, coalesce(item_payload -> ''modifiers'', ''[]''::jsonb));');
      if def = before then raise exception 'Could not patch modifier rows in %', fn; end if;
      execute def;
    end if;
  end loop;

  foreach fn in array array['public.hanafy_workspace_menu(uuid)', 'public.wayne_pos_menu()'] loop
    def := pg_get_functiondef(fn::regprocedure);
    if position('size_rules' in def) = 0 then
      before := def;
      def := replace(def, '''allow_quantities'', modifier_group.allow_quantities,',
        '''allow_quantities'', modifier_group.allow_quantities, ''size_rules'', public.wayne_group_size_rules_json(modifier_group.id),');
      if def = before then raise exception 'Could not patch menu feed %', fn; end if;
      execute def;
    end if;
  end loop;
end
$patch$;
