-- Phase 5: restricted kitchen projection, transactional routing, durable printing.
alter table public.orders add column in_kitchen_at timestamptz;
alter table public.order_items add column kitchen_route_snapshot text;

insert into public.permissions (id, code, description) values
 ('20000000-0000-4000-8000-000000000012', 'printing.manage', 'Review and retry kitchen print jobs'),
 ('20000000-0000-4000-8000-000000000013', 'printing.process', 'Claim and acknowledge printer jobs');
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code in ('owner','manager') and p.code in ('printing.manage','printing.process');

create table public.kitchen_tickets (
 order_id uuid primary key references public.orders(id) on delete restrict,
 status text not null,
 payload jsonb not null check(jsonb_typeof(payload) = 'object'),
 placed_at timestamptz not null,
 promised_at timestamptz, accepted_at timestamptz, in_kitchen_at timestamptz, ready_at timestamptz,
 updated_at timestamptz not null default now()
);
create index kitchen_tickets_active_idx on public.kitchen_tickets(placed_at, order_id)
where status in ('placed','accepted','in_kitchen','ready');
alter table public.kitchen_tickets enable row level security;
revoke all on public.kitchen_tickets from anon, authenticated;
grant select on public.kitchen_tickets to authenticated;
create policy kitchen_tickets_read on public.kitchen_tickets for select to authenticated
using (public.wayne_has_permission('kitchen.access'));

create table public.print_jobs (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.orders(id) on delete restrict,
 destination text not null check(char_length(destination) between 1 and 120),
 job_type text not null default 'kitchen_ticket' check(job_type = 'kitchen_ticket'),
 payload jsonb not null check(jsonb_typeof(payload) = 'object'),
 status text not null default 'pending' check(status in ('pending','processing','printed','failed')),
 attempts integer not null default 0 check(attempts >= 0),
 last_error text,
 lease_token uuid, lease_expires_at timestamptz, claimed_by uuid references public.profiles(id), worker_id text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), printed_at timestamptz,
 unique(order_id,destination,job_type)
);
create index print_jobs_pending_idx on public.print_jobs(destination,created_at) where status = 'pending';
alter table public.print_jobs enable row level security;
revoke all on public.print_jobs from anon, authenticated;
grant select on public.print_jobs to authenticated;
create policy print_jobs_read on public.print_jobs for select to authenticated
using (public.wayne_has_permission('printing.manage'));

create function public.wayne_snapshot_kitchen_route() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 select coalesce(nullif(btrim(kitchen_route),''),'kitchen') into new.kitchen_route_snapshot
 from public.menu_items where id = new.menu_item_id;
 new.kitchen_route_snapshot := coalesce(new.kitchen_route_snapshot,'kitchen');
 return new;
end $$;
create trigger order_item_kitchen_route before insert on public.order_items
for each row execute function public.wayne_snapshot_kitchen_route();

create function public.wayne_sync_kitchen_order(target_order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; ticket jsonb; station text;
begin
 select * into o from public.orders where id = target_order_id;
 if not found or o.placed_at is null then return; end if;
 if not exists(select 1 from public.kitchen_tickets where order_id = o.id)
    and o.status not in ('placed','accepted','in_kitchen','ready') then return; end if;
 select jsonb_build_object(
  'order_number',o.order_number,'customer_name',o.customer_name_snapshot,'source',o.source,
  'fulfillment_type',o.fulfillment_type,'instructions',o.special_instructions,
  'items',coalesce((select jsonb_agg(jsonb_build_object(
   'id',i.id,'name',i.item_name_snapshot,'variant',i.variant_name_snapshot,'quantity',i.quantity,
   'instructions',i.special_instructions,'station',coalesce(i.kitchen_route_snapshot,'kitchen'),
   'modifiers',coalesce((select jsonb_agg(jsonb_build_object('name',m.modifier_name_snapshot,
    'group',m.modifier_group_name_snapshot,'quantity',m.quantity) order by m.created_at,m.id)
    from public.order_item_modifiers m where m.order_item_id=i.id),'[]'::jsonb)
  ) order by i.created_at,i.id) from public.order_items i where i.order_id=o.id),'[]'::jsonb)
 ) into ticket;
 insert into public.kitchen_tickets(order_id,status,payload,placed_at,promised_at,accepted_at,in_kitchen_at,ready_at)
 values(o.id,o.status,ticket,o.placed_at,o.promised_at,o.accepted_at,o.in_kitchen_at,o.ready_at)
 on conflict(order_id) do update set status=excluded.status,promised_at=excluded.promised_at,
  accepted_at=excluded.accepted_at,in_kitchen_at=excluded.in_kitchen_at,ready_at=excluded.ready_at,updated_at=now();
 -- Never regenerate historical print payloads when menu or status changes.
 if o.status in ('placed','accepted','in_kitchen','ready') then
  for station in select distinct value->>'station' from jsonb_array_elements(ticket->'items') loop
   insert into public.print_jobs(order_id,destination,payload)
   values(o.id,station,ticket || jsonb_build_object('items',
    (select jsonb_agg(value) from jsonb_array_elements(ticket->'items') where value->>'station'=station)))
   on conflict(order_id,destination,job_type) do nothing;
  end loop;
 end if;
end $$;

create function public.wayne_deferred_kitchen_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform public.wayne_sync_kitchen_order(new.id); return new; end $$;
-- Order rows precede their items/modifiers in both checkout RPCs. Run after the
-- entire transaction so subscribers never receive a partially assembled ticket.
create constraint trigger orders_kitchen_sync after insert or update of status on public.orders
deferrable initially deferred for each row execute function public.wayne_deferred_kitchen_sync();

do $$ declare o record; begin
 for o in select id from public.orders where placed_at is not null and status in ('placed','accepted','in_kitchen','ready')
 loop perform public.wayne_sync_kitchen_order(o.id); end loop;
end $$;

create function public.wayne_kitchen_board() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not public.wayne_has_permission('kitchen.access') then raise exception 'Kitchen access required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(to_jsonb(t) order by t.placed_at,t.order_id)
 from public.kitchen_tickets t where status in ('placed','accepted','in_kitchen','ready')),'[]'::jsonb);
end $$;

create function public.wayne_kitchen_transition(target_order_id uuid, expected_status text, next_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype;
begin
 if not public.wayne_has_permission('kitchen.access') then raise exception 'Kitchen access required' using errcode='42501'; end if;
 if expected_status is null or next_status is null or not (
  (expected_status='placed' and next_status='accepted') or
  (expected_status='accepted' and next_status='in_kitchen') or
  (expected_status='in_kitchen' and next_status='ready')) then
  raise exception 'Invalid kitchen transition' using errcode='22023';
 end if;
 select * into o from public.orders where id=target_order_id for update;
 if not found then raise exception 'Order not found' using errcode='P0002'; end if;
 if o.status=next_status then return jsonb_build_object('status',o.status,'duplicate',true); end if;
 if o.status<>expected_status then raise exception 'Order changed on another screen. Refresh the kitchen.' using errcode='40001'; end if;
 update public.orders set status=next_status,
  accepted_at=case when next_status='accepted' then now() else accepted_at end,
  in_kitchen_at=case when next_status='in_kitchen' then now() else in_kitchen_at end,
  ready_at=case when next_status='ready' then now() else ready_at end
 where id=o.id;
 insert into public.order_events(order_id,event_type,from_status,to_status,actor_user_id,metadata)
 values(o.id,'order.'||next_status,o.status,next_status,auth.uid(),jsonb_build_object('screen','kitchen'));
 return jsonb_build_object('status',next_status,'duplicate',false);
end $$;

create function public.wayne_claim_print_job(target_destination text, target_worker_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare job public.print_jobs%rowtype;
begin
 if not public.wayne_has_permission('printing.process') then raise exception 'Print processing permission required' using errcode='42501'; end if;
 if char_length(btrim(coalesce(target_worker_id,''))) not between 1 and 100 then raise exception 'Worker ID required' using errcode='22023'; end if;
 -- Expired leases remain visible for manual inspection, never silently reprint.
 select * into job from public.print_jobs where destination=target_destination and status='pending'
 order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update public.print_jobs set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),
  lease_expires_at=now()+interval '2 minutes',claimed_by=auth.uid(),worker_id=target_worker_id,updated_at=now()
 where id=job.id returning * into job;
 return to_jsonb(job);
end $$;

create function public.wayne_finish_print_job(target_job_id uuid, target_lease_token uuid, succeeded boolean, failure_message text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare job public.print_jobs%rowtype;
begin
 if not public.wayne_has_permission('printing.process') then raise exception 'Print processing permission required' using errcode='42501'; end if;
 select * into job from public.print_jobs where id=target_job_id for update;
 if not found then raise exception 'Print job not found' using errcode='P0002'; end if;
 if succeeded is null or target_lease_token is null or job.lease_token is distinct from target_lease_token
 or job.claimed_by is distinct from auth.uid() then raise exception 'Stale print lease' using errcode='40001'; end if;
 if job.status='printed' and succeeded then return; end if;
 if job.status<>'processing' then raise exception 'Print job is not processing' using errcode='40001'; end if;
 if job.lease_expires_at<=now() then raise exception 'Expired print lease' using errcode='40001'; end if;
 update public.print_jobs set status=case when succeeded then 'printed' else 'failed' end,
  printed_at=case when succeeded then now() else null end,lease_expires_at=null,
  last_error=case when succeeded then null else left(coalesce(nullif(failure_message,''),'Printer unavailable'),500) end,
  updated_at=now() where id=job.id;
end $$;

create function public.wayne_retry_print_job(target_job_id uuid, retry_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare job public.print_jobs%rowtype;
begin
 if not public.wayne_has_permission('printing.manage') then raise exception 'Print management permission required' using errcode='42501'; end if;
 if char_length(btrim(coalesce(retry_reason,''))) not between 3 and 500 then raise exception 'Retry reason required' using errcode='22023'; end if;
 select * into job from public.print_jobs where id=target_job_id for update;
 if not found then raise exception 'Print job not found' using errcode='P0002'; end if;
 if not(job.status='failed' or (job.status='processing' and job.lease_expires_at<=now())) then
  raise exception 'Only failed or expired print jobs can be retried' using errcode='22023';
 end if;
 update public.print_jobs set status='pending',lease_token=null,lease_expires_at=null,claimed_by=null,worker_id=null,updated_at=now()
 where id=job.id;
 insert into public.order_events(order_id,event_type,actor_user_id,metadata)
 values(job.order_id,'print.retry_requested',auth.uid(),jsonb_build_object('job_id',job.id,'previous_status',job.status,'reason',btrim(retry_reason)));
end $$;

revoke all on function public.wayne_snapshot_kitchen_route(),public.wayne_sync_kitchen_order(uuid),public.wayne_deferred_kitchen_sync() from public,anon,authenticated;
revoke all on function public.wayne_kitchen_board(),public.wayne_kitchen_transition(uuid,text,text),
 public.wayne_claim_print_job(text,text),public.wayne_finish_print_job(uuid,uuid,boolean,text),public.wayne_retry_print_job(uuid,text) from public,anon,authenticated;
grant execute on function public.wayne_kitchen_board(),public.wayne_kitchen_transition(uuid,text,text),
 public.wayne_claim_print_job(text,text),public.wayne_finish_print_job(uuid,uuid,boolean,text),public.wayne_retry_print_job(uuid,text) to authenticated;

do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
  select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='kitchen_tickets') then
  alter publication supabase_realtime add table public.kitchen_tickets;
 end if;
end $$;

comment on table public.kitchen_tickets is 'Restricted kitchen projection without customer phone/email/address, payment or public access tokens.';
comment on table public.print_jobs is 'Persistent station ticket snapshots. Expired leases require staff inspection before retry to avoid unobserved duplicate physical prints.';
