-- Wayne's Pizza POS — Phase 7 only: authoritative customer intelligence and segments.

insert into public.permissions (id, code, description) values
  ('20000000-0000-4000-8000-000000000017', 'customers.view', 'View customer intelligence and customer order history'),
  ('20000000-0000-4000-8000-000000000018', 'segments.manage', 'Create, edit, and evaluate customer segments');
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id from public.roles role join public.permissions permission on permission.code in ('customers.view', 'segments.manage')
where role.code in ('owner', 'manager');
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id from public.roles role join public.permissions permission on permission.code = 'customers.view'
where role.code = 'marketing_readonly';

create table public.customer_segments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 100),
  description text not null default '' check (char_length(description) <= 1000),
  rules_json jsonb not null check (jsonb_typeof(rules_json) = 'object'),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customer_segments_name_idx on public.customer_segments (lower(name));

create table public.customer_segment_memberships (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  segment_id uuid not null references public.customer_segments(id) on delete restrict,
  entered_at timestamptz not null,
  exited_at timestamptz,
  active boolean not null default true,
  evaluated_at timestamptz not null,
  check ((active and exited_at is null) or (not active and exited_at is not null))
);
create unique index customer_segment_active_membership_idx on public.customer_segment_memberships(customer_id, segment_id) where active;
create index customer_segment_membership_history_idx on public.customer_segment_memberships(customer_id, entered_at desc);

create table public.customer_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  event_type text not null check (event_type in ('customer.metrics.updated', 'customer.segment.entered', 'customer.segment.exited')),
  segment_id uuid references public.customer_segments(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default now()
);
create index customer_events_customer_idx on public.customer_events(customer_id, occurred_at desc);

alter table public.customer_segments enable row level security;
alter table public.customer_segment_memberships enable row level security;
alter table public.customer_events enable row level security;
create policy customer_segments_view on public.customer_segments for select to authenticated using (public.wayne_has_permission('customers.view'));
create policy customer_segment_memberships_view on public.customer_segment_memberships for select to authenticated using (public.wayne_has_permission('customers.view'));
create policy customer_events_view on public.customer_events for select to authenticated using (public.wayne_has_permission('customers.view'));

create or replace function public.wayne_segment_rules_are_valid(rules jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare condition jsonb; field_name text; operator_name text; value_number numeric;
begin
  if (select count(*) from jsonb_object_keys(rules)) <> 1 or jsonb_typeof(rules -> 'all') <> 'array' or jsonb_array_length(rules -> 'all') = 0 or jsonb_array_length(rules -> 'all') > 20 then return false; end if;
  for condition in select value from jsonb_array_elements(rules -> 'all') loop
    field_name := condition ->> 'field'; operator_name := condition ->> 'operator';
    if field_name not in ('lifetime_spend_cents','order_count','average_order_value_cents','orders_last_30_days','days_since_last_order','sms_marketing_opt_in','email_marketing_opt_in') or operator_name not in ('>=','<=','=','!=') then return false; end if;
    if field_name in ('sms_marketing_opt_in','email_marketing_opt_in') then
      if operator_name not in ('=','!=') or jsonb_typeof(condition -> 'value') <> 'boolean' then return false; end if;
    else
      begin value_number := (condition ->> 'value')::numeric; exception when others then return false; end;
      if value_number < 0 or value_number > 1000000000 then return false; end if;
    end if;
  end loop;
  return true;
end;
$$;
alter table public.customer_segments add constraint customer_segments_valid_rules check (public.wayne_segment_rules_are_valid(rules_json));
create trigger customer_segments_set_updated_at before update on public.customer_segments for each row execute function public.set_updated_at();

insert into public.customer_segments(name, description, rules_json, sort_order) values
  ('VIP', 'High lifetime spend and repeat-order customers.', '{"all":[{"field":"lifetime_spend_cents","operator":">=","value":100000},{"field":"order_count","operator":">=","value":20}]}'::jsonb, 10),
  ('High spender', 'Customers with at least $500 lifetime spend.', '{"all":[{"field":"lifetime_spend_cents","operator":">=","value":50000}]}'::jsonb, 20),
  ('Frequent customer', 'Customers with three orders in the last 30 days.', '{"all":[{"field":"orders_last_30_days","operator":">=","value":3}]}'::jsonb, 30),
  ('30-day inactive', 'Customers with two or more orders and no order for 30 days.', '{"all":[{"field":"days_since_last_order","operator":">=","value":30},{"field":"order_count","operator":">=","value":2}]}'::jsonb, 40),
  ('60-day inactive', 'Customers with two or more orders and no order for 60 days.', '{"all":[{"field":"days_since_last_order","operator":">=","value":60},{"field":"order_count","operator":">=","value":2}]}'::jsonb, 50),
  ('90-day inactive', 'Customers with two or more orders and no order for 90 days.', '{"all":[{"field":"days_since_last_order","operator":">=","value":90},{"field":"order_count","operator":">=","value":2}]}'::jsonb, 60),
  ('Text Club', 'Customers with SMS marketing consent.', '{"all":[{"field":"sms_marketing_opt_in","operator":"=","value":true}]}'::jsonb, 70),
  ('Email-consented', 'Customers with email marketing consent.', '{"all":[{"field":"email_marketing_opt_in","operator":"=","value":true}]}'::jsonb, 80);

create or replace function public.wayne_apply_customer_segments(target_customer_id uuid, evaluated_at_value timestamptz default now())
returns void language plpgsql security definer set search_path = '' as $$
declare customer_row public.customers%rowtype; segment_row public.customer_segments%rowtype; condition jsonb; metrics jsonb; matches boolean; condition_matches boolean; active_membership_id uuid;
begin
  select * into customer_row from public.customers where id = target_customer_id for update;
  if not found then return; end if;
  select jsonb_build_object(
    'lifetime_spend_cents', customer_row.lifetime_spend_cents, 'order_count', customer_row.order_count, 'average_order_value_cents', customer_row.average_order_value_cents,
    'orders_last_30_days', (select count(*) from public.orders o where o.customer_id = customer_row.id and o.placed_at >= evaluated_at_value - interval '30 days' and o.placed_at <= evaluated_at_value and o.status not in ('draft','cancelled')),
    'days_since_last_order', case when customer_row.last_order_at is null then null else floor(extract(epoch from (evaluated_at_value - customer_row.last_order_at)) / 86400)::integer end,
    'sms_marketing_opt_in', customer_row.sms_marketing_opt_in, 'email_marketing_opt_in', customer_row.email_marketing_opt_in
  ) into metrics;
  for segment_row in select * from public.customer_segments where active order by sort_order, id loop
    matches := true;
    for condition in select value from jsonb_array_elements(segment_row.rules_json -> 'all') loop
      if condition ->> 'field' in ('sms_marketing_opt_in','email_marketing_opt_in') then
        condition_matches := case condition ->> 'operator' when '=' then (metrics ->> (condition ->> 'field'))::boolean = (condition ->> 'value')::boolean else (metrics ->> (condition ->> 'field'))::boolean <> (condition ->> 'value')::boolean end;
      elsif (metrics ->> (condition ->> 'field')) is null then condition_matches := false;
      else condition_matches := case condition ->> 'operator' when '>=' then (metrics ->> (condition ->> 'field'))::numeric >= (condition ->> 'value')::numeric when '<=' then (metrics ->> (condition ->> 'field'))::numeric <= (condition ->> 'value')::numeric when '=' then (metrics ->> (condition ->> 'field'))::numeric = (condition ->> 'value')::numeric else (metrics ->> (condition ->> 'field'))::numeric <> (condition ->> 'value')::numeric end;
      end if;
      if not condition_matches then matches := false; exit; end if;
    end loop;
    active_membership_id := null;
    select id into active_membership_id from public.customer_segment_memberships where customer_id = customer_row.id and segment_id = segment_row.id and active for update;
    if matches and active_membership_id is null then
      insert into public.customer_segment_memberships(customer_id, segment_id, entered_at, evaluated_at) values (customer_row.id, segment_row.id, evaluated_at_value, evaluated_at_value);
      insert into public.customer_events(customer_id, segment_id, event_type, occurred_at, metadata) values (customer_row.id, segment_row.id, 'customer.segment.entered', evaluated_at_value, jsonb_build_object('segment_name', segment_row.name, 'metrics', metrics));
    elsif not matches and active_membership_id is not null then
      update public.customer_segment_memberships set active = false, exited_at = evaluated_at_value, evaluated_at = evaluated_at_value where id = active_membership_id;
      insert into public.customer_events(customer_id, segment_id, event_type, occurred_at, metadata) values (customer_row.id, segment_row.id, 'customer.segment.exited', evaluated_at_value, jsonb_build_object('segment_name', segment_row.name, 'metrics', metrics));
    end if;
  end loop;
end;
$$;

create or replace function public.wayne_rebuild_customer_metrics(target_customer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare before_metrics jsonb; after_metrics jsonb;
begin
  select jsonb_build_object('order_count', order_count, 'lifetime_spend_cents', lifetime_spend_cents, 'average_order_value_cents', average_order_value_cents, 'first_order_at', first_order_at, 'last_order_at', last_order_at) into before_metrics from public.customers where id = target_customer_id;
  update public.customers customer set first_order_at = metrics.first_order_at, last_order_at = metrics.last_order_at, order_count = metrics.order_count, lifetime_spend_cents = metrics.lifetime_spend_cents, average_order_value_cents = case when metrics.order_count = 0 then 0 else round(metrics.lifetime_spend_cents::numeric / metrics.order_count)::integer end
  from (select count(*)::integer order_count, min(o.placed_at) first_order_at, max(o.placed_at) last_order_at, greatest(coalesce(sum(o.total_cents), 0) - coalesce((select sum(r.amount_cents) from public.refunds r join public.orders refunded_order on refunded_order.id = r.order_id where refunded_order.customer_id = target_customer_id and refunded_order.status not in ('draft','cancelled')), 0), 0)::bigint lifetime_spend_cents from public.orders o where o.customer_id = target_customer_id and o.placed_at is not null and o.status not in ('draft','cancelled')) metrics where customer.id = target_customer_id;
  select jsonb_build_object('order_count', order_count, 'lifetime_spend_cents', lifetime_spend_cents, 'average_order_value_cents', average_order_value_cents, 'first_order_at', first_order_at, 'last_order_at', last_order_at) into after_metrics from public.customers where id = target_customer_id;
  if before_metrics is distinct from after_metrics then insert into public.customer_events(customer_id, event_type, metadata) values (target_customer_id, 'customer.metrics.updated', jsonb_build_object('before', before_metrics, 'after', after_metrics)); end if;
end;
$$;

create or replace function public.wayne_customer_revaluate_segments()
returns trigger language plpgsql security definer set search_path = '' as $$ begin perform public.wayne_apply_customer_segments(new.id, now()); return new; end; $$;
create trigger customers_revaluate_segments after insert or update of first_order_at,last_order_at,order_count,lifetime_spend_cents,average_order_value_cents,sms_marketing_opt_in,email_marketing_opt_in on public.customers for each row execute function public.wayne_customer_revaluate_segments();

create or replace function public.wayne_save_customer_segment(payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare segment_id uuid := nullif(payload ->> 'id','')::uuid; saved_id uuid; rules jsonb := payload -> 'rules_json';
begin
  if not public.wayne_has_permission('segments.manage') then raise exception 'Segment management permission required' using errcode = '42501'; end if;
  if not public.wayne_segment_rules_are_valid(rules) then raise exception 'Invalid segment rules' using errcode = '22023'; end if;
  if segment_id is null then insert into public.customer_segments(name,description,rules_json,active,sort_order) values (btrim(payload ->> 'name'),coalesce(payload ->> 'description',''),rules,coalesce((payload ->> 'active')::boolean,true),coalesce((payload ->> 'sort_order')::integer,0)) returning id into saved_id;
  else update public.customer_segments set name=btrim(payload ->> 'name'),description=coalesce(payload ->> 'description',''),rules_json=rules,active=coalesce((payload ->> 'active')::boolean,true),sort_order=coalesce((payload ->> 'sort_order')::integer,0) where id=segment_id returning id into saved_id; if saved_id is null then raise exception 'Segment not found' using errcode = 'P0002'; end if; end if;
  for segment_id in select id from public.customers loop perform public.wayne_apply_customer_segments(segment_id, now()); end loop;
  return saved_id;
end;
$$;

create or replace function public.wayne_run_nightly_inactivity_evaluator(reference_at timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare customer_id uuid; count_value integer := 0;
begin
  if not public.wayne_has_permission('segments.manage') then raise exception 'Segment management permission required' using errcode = '42501'; end if;
  for customer_id in select id from public.customers where order_count >= 2 loop perform public.wayne_apply_customer_segments(customer_id, reference_at); count_value := count_value + 1; end loop;
  return count_value;
end;
$$;

create or replace function public.wayne_admin_customers(search_text text default null, segment_filter uuid default null, page_size integer default 50, page_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare normalized_search text := btrim(coalesce(search_text,''));
begin
  if not public.wayne_has_permission('customers.view') then raise exception 'Customer viewing permission required' using errcode = '42501'; end if;
  if page_size not between 1 and 250 or page_offset < 0 then raise exception 'Invalid pagination' using errcode = '22023'; end if;
  return jsonb_build_object('customers',coalesce((select jsonb_agg(to_jsonb(row) order by row.last_order_at desc nulls last,row.created_at desc) from (select customer.id, customer.first_name, customer.last_name, customer.phone_normalized, customer.email_normalized, customer.first_order_at, customer.last_order_at, customer.order_count, customer.lifetime_spend_cents, customer.average_order_value_cents, customer.sms_marketing_opt_in, customer.email_marketing_opt_in, customer.created_at, coalesce((select jsonb_agg(jsonb_build_object('id',segment.id,'name',segment.name) order by segment.name) from public.customer_segment_memberships membership join public.customer_segments segment on segment.id=membership.segment_id where membership.customer_id=customer.id and membership.active),'[]'::jsonb) segments from public.customers customer where (normalized_search='' or customer.first_name || ' ' || customer.last_name ilike '%'||normalized_search||'%' or customer.phone_normalized ilike '%'||regexp_replace(normalized_search,'[^0-9+]','','g')||'%' or coalesce(customer.email_normalized,'') ilike '%'||normalized_search||'%') and (segment_filter is null or exists(select 1 from public.customer_segment_memberships m where m.customer_id=customer.id and m.segment_id=segment_filter and m.active)) order by customer.last_order_at desc nulls last,customer.created_at desc limit page_size offset page_offset) row),'[]'::jsonb),'total_count',(select count(*) from public.customers customer where (normalized_search='' or customer.first_name || ' ' || customer.last_name ilike '%'||normalized_search||'%' or customer.phone_normalized ilike '%'||regexp_replace(normalized_search,'[^0-9+]','','g')||'%' or coalesce(customer.email_normalized,'') ilike '%'||normalized_search||'%') and (segment_filter is null or exists(select 1 from public.customer_segment_memberships m where m.customer_id=customer.id and m.segment_id=segment_filter and m.active))));
end;
$$;

create or replace function public.wayne_admin_customer_detail(target_customer_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('customers.view') then raise exception 'Customer viewing permission required' using errcode = '42501'; end if;
  return (select (to_jsonb(customer) - 'updated_at') || jsonb_build_object('addresses',coalesce((select jsonb_agg(to_jsonb(address) - 'customer_id' order by address.is_default desc,address.updated_at desc) from public.customer_addresses address where address.customer_id=customer.id),'[]'::jsonb),'consents',coalesce((select jsonb_agg(to_jsonb(consent) - 'customer_id' order by consent.occurred_at desc) from public.marketing_consents consent where consent.customer_id=customer.id),'[]'::jsonb),'segments',coalesce((select jsonb_agg(jsonb_build_object('membership_id',m.id,'id',s.id,'name',s.name,'entered_at',m.entered_at,'exited_at',m.exited_at,'active',m.active) order by m.active desc,m.entered_at desc) from public.customer_segment_memberships m join public.customer_segments s on s.id=m.segment_id where m.customer_id=customer.id),'[]'::jsonb),'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'order_number',o.order_number,'placed_at',o.placed_at,'status',o.status,'source',o.source,'fulfillment_type',o.fulfillment_type,'total_cents',o.total_cents) order by o.placed_at desc) from public.orders o where o.customer_id=customer.id),'[]'::jsonb),'events',coalesce((select jsonb_agg(to_jsonb(event) - 'customer_id' order by event.occurred_at desc) from public.customer_events event where event.customer_id=customer.id),'[]'::jsonb)) from public.customers customer where customer.id=target_customer_id);
end;
$$;

create or replace function public.wayne_admin_customer_segments()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.wayne_has_permission('customers.view') then raise exception 'Customer viewing permission required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',segment.id,'name',segment.name,'description',segment.description,'rules_json',segment.rules_json,'active',segment.active,'sort_order',segment.sort_order,'population',(select count(*)::integer from public.customer_segment_memberships m where m.segment_id=segment.id and m.active),'created_at',segment.created_at,'updated_at',segment.updated_at) order by segment.sort_order,segment.name) from public.customer_segments segment),'[]'::jsonb);
end;
$$;

revoke all on function public.wayne_segment_rules_are_valid(jsonb), public.wayne_apply_customer_segments(uuid,timestamptz), public.wayne_customer_revaluate_segments() from public;
revoke all on function public.wayne_rebuild_customer_metrics(uuid), public.wayne_save_customer_segment(jsonb), public.wayne_run_nightly_inactivity_evaluator(timestamptz), public.wayne_admin_customers(text,uuid,integer,integer), public.wayne_admin_customer_detail(uuid), public.wayne_admin_customer_segments() from public;
grant execute on function public.wayne_rebuild_customer_metrics(uuid), public.wayne_save_customer_segment(jsonb), public.wayne_run_nightly_inactivity_evaluator(timestamptz), public.wayne_admin_customers(text,uuid,integer,integer), public.wayne_admin_customer_detail(uuid), public.wayne_admin_customer_segments() to authenticated;

do $$ declare customer_id uuid; begin for customer_id in select id from public.customers loop perform public.wayne_rebuild_customer_metrics(customer_id); perform public.wayne_apply_customer_segments(customer_id, now()); end loop; end $$;
