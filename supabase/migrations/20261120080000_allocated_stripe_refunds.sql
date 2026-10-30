-- Refunds preserve captured receipts. Each provider leg has its own durable row.
-- Policy approved 2026-10-29: order first; tip explicit; paid driver tip becomes
-- recovery due. A recovery due is NOT cash received or an automatic wage deduction.
create table if not exists public.payment_refund_requests (
 id uuid primary key default gen_random_uuid(), payment_id uuid not null references public.payments(id),
 workspace_id uuid not null references public.workspaces(id), order_id uuid not null references public.orders(id),
 idempotency_key text not null unique, amount_cents integer not null check(amount_cents>0),
 tip_cents integer not null check(tip_cents>=0 and tip_cents<=amount_cents), reason text not null,
 created_by_user_id uuid references public.profiles(id), created_at timestamptz not null default now()
);
alter table public.refunds add column if not exists allocation_request_id uuid references public.payment_refund_requests(id);
alter table public.refunds add column if not exists provider_payment_id text;
alter table public.refunds add column if not exists tip_cents integer check(tip_cents>=0 and tip_cents<=amount_cents);
alter table public.orders add column if not exists tip_refunded_cents integer not null default 0 check(tip_refunded_cents>=0);
create table if not exists public.driver_tip_recovery_dues (
 id uuid primary key default gen_random_uuid(), refund_id uuid not null unique references public.refunds(id),
 order_id uuid not null references public.orders(id), workspace_id uuid not null references public.workspaces(id),
 driver_id uuid not null references public.profiles(id), cashout_id uuid not null references public.driver_cashouts(id),
 amount_cents integer not null check(amount_cents>0), created_at timestamptz not null default now()
);
alter table public.payment_refund_requests enable row level security;
alter table public.driver_tip_recovery_dues enable row level security;
revoke all on public.payment_refund_requests,public.driver_tip_recovery_dues from anon,authenticated;
grant all on public.payment_refund_requests,public.driver_tip_recovery_dues to service_role;

create or replace function public.wayne_begin_allocated_refund(payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 p public.payments%rowtype; o public.orders%rowtype; req public.payment_refund_requests%rowtype;
 amount integer := (payload->>'amount_cents')::integer;
 tip integer := coalesce((payload->>'tip_cents')::integer,0);
 request_key text := btrim(coalesce(payload->>'idempotency_key',''));
 why text := btrim(coalesce(payload->>'reason',''));
 total_tip integer; used_base integer; used_tip integer; split_id text; base integer;
begin
 if not public.wayne_has_permission('payments.manage') then raise exception 'Payment management permission required' using errcode='42501'; end if;
 select * into p from public.payments where id=(payload->>'payment_id')::uuid for update;
 if not found or not public.hanafy_can_access_workspace_data(p.workspace_id,array['payments.manage']) then raise exception 'Payment not found or not allowed' using errcode='42501'; end if;
 select * into o from public.orders where id=p.order_id for update;
 if nullif(payload->>'order_id','')::uuid is distinct from p.order_id then raise exception 'Payment does not belong to this order' using errcode='22023'; end if;
 if p.provider<>'stripe' or p.status<>'captured' or p.provider_payment_id is null then raise exception 'Only a captured Stripe payment can be refunded' using errcode='22023'; end if;
 if amount is null or amount<=0 or amount>10000000 or tip<0 or tip>amount or char_length(request_key) not between 16 and 160 or char_length(why) not between 3 and 1000 then raise exception 'Invalid refund allocation' using errcode='22023'; end if;
 select * into req from public.payment_refund_requests where idempotency_key=request_key;
 if found then
  if req.payment_id<>p.id or req.amount_cents<>amount or req.tip_cents<>tip or req.reason<>why then raise exception 'Refund key already used for a different request' using errcode='22023'; end if;
 else
  if exists(select 1 from public.refunds where payment_id=p.id and status in ('pending','completed') and allocation_request_id is null) then raise exception 'Existing refunds require allocation review before another refund' using errcode='22023'; end if;
  if exists(select 1 from public.pos_tip_operations where payment_id=p.id and (state='pending' or release_pending)) then raise exception 'Reconcile the payment operation before refunding' using errcode='40001'; end if;
  if p.amount_cents<>o.total_cents or exists(select 1 from public.payments other where other.order_id=o.id and other.id<>p.id and other.status='captured') then raise exception 'Multiple or mismatched payment receipts require allocation review' using errcode='22023'; end if;
  total_tip := o.tip_cents;
  split_id := nullif(p.metadata->>'tip_charge_intent','');
  if total_tip<0 or total_tip>p.amount_cents or (split_id is not null and split_id=p.provider_payment_id) then raise exception 'Payment allocation requires review' using errcode='22023'; end if;
  select coalesce(sum(amount_cents-coalesce(tip_cents,0)),0),coalesce(sum(tip_cents),0) into used_base,used_tip
   from public.refunds where payment_id=p.id and status in ('pending','completed');
  base := amount-tip;
  if base>p.amount_cents-total_tip-used_base or tip>total_tip-used_tip then raise exception 'That is more than the remaining refundable order amount or tip; select tip explicitly' using errcode='22023'; end if;
  insert into public.payment_refund_requests(payment_id,workspace_id,order_id,idempotency_key,amount_cents,tip_cents,reason,created_by_user_id)
   values(p.id,p.workspace_id,p.order_id,request_key,amount,tip,why,auth.uid()) returning * into req;
  if split_id is null then
   insert into public.refunds(payment_id,order_id,workspace_id,amount_cents,reason,status,idempotency_key,created_by_user_id,allocation_request_id,provider_payment_id,tip_cents)
    values(p.id,p.order_id,p.workspace_id,amount,why,'pending','refund-leg-'||req.id,auth.uid(),req.id,p.provider_payment_id,tip);
  else
   if base>0 then
    insert into public.refunds(payment_id,order_id,workspace_id,amount_cents,reason,status,idempotency_key,created_by_user_id,allocation_request_id,provider_payment_id,tip_cents)
     values(p.id,p.order_id,p.workspace_id,base,why,'pending','refund-base-'||req.id,auth.uid(),req.id,p.provider_payment_id,0);
   end if;
   if tip>0 then
    insert into public.refunds(payment_id,order_id,workspace_id,amount_cents,reason,status,idempotency_key,created_by_user_id,allocation_request_id,provider_payment_id,tip_cents)
     values(p.id,p.order_id,p.workspace_id,tip,why,'pending','refund-tip-'||req.id,auth.uid(),req.id,split_id,tip);
   end if;
  end if;
  perform public.wayne_write_audit('payment.refund_allocated','orders',o.id::text,'Refund allocated; tip explicitly selected','{}',jsonb_build_object('request_id',req.id,'amount_cents',amount,'tip_cents',tip));
 end if;
 return jsonb_build_object('request_id',req.id,'legs',(select jsonb_agg(to_jsonb(r) order by r.tip_cents,r.id) from public.refunds r where r.allocation_request_id=req.id));
end $$;
revoke all on function public.wayne_begin_allocated_refund(jsonb) from public,anon;
grant execute on function public.wayne_begin_allocated_refund(jsonb) to authenticated;

-- Retain the original settlement implementation, permissions and reporting.
-- Interpose only accounting for explicit tip allocations. Reapplication safe.
do $$ begin
 if to_regprocedure('public.wayne_settle_refund_before_allocation(jsonb)') is null then
  alter function public.wayne_settle_refund(jsonb) rename to wayne_settle_refund_before_allocation;
 end if;
end $$;
revoke all on function public.wayne_settle_refund_before_allocation(jsonb) from public,anon,authenticated,service_role;
create or replace function public.wayne_settle_refund(payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.refunds%rowtype; result jsonb; a record; due integer; prior integer;
begin
 select * into r from public.refunds where id=(payload->>'refund_id')::uuid for update;
 if not found then raise exception 'Refund not found' using errcode='P0002'; end if;
 -- Serialize with the driver cashout's order lock. Never take an assignment
 -- lock here: cashout takes assignment then order, so doing both deadlocks.
 perform 1 from public.orders where id=r.order_id for update;
 result := public.wayne_settle_refund_before_allocation(payload);
 if r.status='pending' and payload->>'status'='completed' and coalesce(r.tip_cents,0)>0 then
  update public.orders set tip_refunded_cents=tip_refunded_cents+r.tip_cents where id=r.order_id;
  select * into a from public.delivery_assignments where order_id=r.order_id and cashout_id is not null and status<>'released' order by cashed_out_at desc limit 1;
  if found then
   select coalesce(sum(amount_cents),0) into prior from public.driver_tip_recovery_dues where order_id=r.order_id and cashout_id=a.cashout_id;
   due := least(r.tip_cents,greatest(a.tip_cents-prior,0));
   if due>0 then
    insert into public.driver_tip_recovery_dues(refund_id,order_id,workspace_id,driver_id,cashout_id,amount_cents)
     values(r.id,r.order_id,r.workspace_id,a.driver_id,a.cashout_id,due);
    insert into public.order_events(order_id,event_type,metadata) values(r.order_id,'delivery.tip_recovery_due',jsonb_build_object('refund_id',r.id,'driver_id',a.driver_id,'cashout_id',a.cashout_id,'amount_cents',due,'cash_received',false));
   end if;
  end if;
 end if;
 return result;
end $$;
revoke all on function public.wayne_settle_refund(jsonb) from public,anon,authenticated;
grant execute on function public.wayne_settle_refund(jsonb) to service_role;

-- Preserve cashout's current feature body; adjust only settled tip entitlement.
do $$ declare definition text; replacement text; begin
 definition := pg_get_functiondef('public.wayne_pos_driver_cashout(uuid,jsonb,jsonb,jsonb,text)'::regprocedure);
 replacement := replace(definition,'v_tip := greatest(coalesce(v_order.tip_cents, 0), 0);','v_tip := greatest(coalesce(v_order.tip_cents, 0) - v_order.tip_refunded_cents, 0);');
 if replacement=definition and position('v_order.tip_refunded_cents' in definition)=0 then raise exception 'Review production driver cashout definition before refund migration'; end if;
 execute replacement;
end $$;

create or replace function public.wayne_order_refund_requests(target_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare workspace uuid;
begin
 select workspace_id into workspace from public.orders where id=target_order_id;
 if not public.wayne_has_permission('payments.manage') or not coalesce(public.hanafy_can_access_workspace_data(workspace,array['payments.manage']),false) then raise exception 'Payment management permission required' using errcode='42501'; end if;
 return jsonb_build_object('requests',coalesce((select jsonb_agg(to_jsonb(q)||jsonb_build_object('pending',exists(select 1 from public.refunds r where r.allocation_request_id=q.id and r.status='pending'))) from public.payment_refund_requests q where q.order_id=target_order_id),'[]'),
 'driver_recovery_due_cents',coalesce((select sum(amount_cents) from public.driver_tip_recovery_dues where order_id=target_order_id),0));
end $$;
revoke all on function public.wayne_order_refund_requests(uuid) from public,anon;
grant execute on function public.wayne_order_refund_requests(uuid) to authenticated;

-- The legacy RPC must not bypass explicit allocation on Stripe payments.
do $$ declare definition text; begin
 definition := pg_get_functiondef('public.wayne_begin_refund(jsonb)'::regprocedure);
 if position('Use the allocated Stripe refund workflow' in definition)=0 then
  if position('if payment_row.status <> ''captured''' in definition)=0 then raise exception 'Review production refund function before migration'; end if;
  definition := replace(definition,'if payment_row.status <> ''captured''',E'if payment_row.provider=''stripe'' then raise exception ''Use the allocated Stripe refund workflow'' using errcode=''22023''; end if;\n  if payment_row.status <> ''captured''');
  execute definition;
 end if;
end $$;

-- Owner closeout uses net tip entitlement too; gross sale/receipt history stays intact.
do $$ declare definition text; replacement text; begin
 definition := pg_get_functiondef('public.wayne_day_closeout(date)'::regprocedure);
 replacement := replace(definition,'o.tip_cents as order_tip_cents','greatest(o.tip_cents - o.tip_refunded_cents, 0) as order_tip_cents');
 if replacement=definition and position('o.tip_refunded_cents' in definition)=0 then raise exception 'Review production closeout definition before refund migration'; end if;
 execute replacement;
end $$;
create index if not exists refunds_allocation_request_idx on public.refunds(allocation_request_id) where allocation_request_id is not null;
create index if not exists payment_refund_requests_order_idx on public.payment_refund_requests(order_id);

create or replace function public.wayne_observe_refund(payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare r public.refunds%rowtype; provider_id text:=nullif(payload->>'provider_refund_id','');
begin
 select * into r from public.refunds where id=(payload->>'refund_id')::uuid for update;
 if not found or provider_id is null then raise exception 'Refund identity required' using errcode='22023'; end if;
 if r.provider_refund_id is not null and r.provider_refund_id<>provider_id then raise exception 'Refund identity changed; review required' using errcode='22023'; end if;
 update public.refunds set provider_refund_id=provider_id,provider_status=payload->>'provider_status' where id=r.id;
end $$;
revoke all on function public.wayne_observe_refund(jsonb) from public,anon,authenticated;
grant execute on function public.wayne_observe_refund(jsonb) to service_role;

-- Original authorizations are voided, never refunded. Reserve the intent under
-- the same fence as tip capture; keep its button available for uncertain retries.
create or replace function public.wayne_prepare_payment_void(target_payment_id uuid,target_order_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments%rowtype;
begin
 if not public.wayne_has_permission('payments.manage') then raise exception 'Payment management permission required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_payment_id::text,731));
 select * into p from public.payments where id=target_payment_id for update;
 if not found or p.order_id<>target_order_id or not coalesce(public.hanafy_can_access_workspace_data(p.workspace_id,array['payments.manage']),false) then raise exception 'Payment not found or not allowed' using errcode='42501'; end if;
 if p.status='voided' then return jsonb_build_object('duplicate',true); end if;
 if p.status<>'authorized' or p.provider_payment_id is null then raise exception 'Only an authorization can be voided' using errcode='22023'; end if;
 if exists(select 1 from public.pos_tip_operations where payment_id=p.id) then raise exception 'Reconcile the existing tip operation before voiding' using errcode='40001'; end if;
 update public.payments set metadata=metadata||jsonb_build_object('void_requested',true) where id=p.id;
 return jsonb_build_object('provider_payment_id',p.provider_payment_id,'provider',p.provider,'workspace_id',p.workspace_id,'duplicate',false);
end $$;
revoke all on function public.wayne_prepare_payment_void(uuid,uuid) from public,anon;
grant execute on function public.wayne_prepare_payment_void(uuid,uuid) to authenticated;

create or replace function public.wayne_finish_payment_void(target_payment_id uuid,provider_id text)
returns void language plpgsql security definer set search_path='' as $$
declare p public.payments%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended(target_payment_id::text,731));
 select * into p from public.payments where id=target_payment_id for update;
 if not found or p.provider_payment_id is distinct from provider_id then raise exception 'Void payment binding changed' using errcode='40001'; end if;
 if p.status='voided' then return; end if;
 if p.status<>'authorized' or not coalesce((p.metadata->>'void_requested')::boolean,false) or exists(select 1 from public.pos_tip_operations where payment_id=p.id) then raise exception 'Void payment state changed; reconcile it' using errcode='40001'; end if;
 perform public.wayne_settle_payment(jsonb_build_object('payment_id',p.id,'status','voided','provider_status','canceled'));
end $$;
revoke all on function public.wayne_finish_payment_void(uuid,text) from public,anon,authenticated;
grant execute on function public.wayne_finish_payment_void(uuid,text) to service_role;

do $$ declare definition text; anchor text:='perform pg_advisory_xact_lock(hashtextextended(target_payment_id::text, 731));'; begin
 definition:=pg_get_functiondef('public.wayne_claim_tip_operation(uuid,uuid,integer,uuid,text)'::regprocedure);
 if position('void_requested' in definition)=0 then
  if position(anchor in definition)=0 then raise exception 'Review tip coordinator void fence before migration'; end if;
  definition:=replace(definition,anchor,anchor||E'\n  if exists(select 1 from public.payments where id=target_payment_id and coalesce((metadata->>''void_requested'')::boolean,false)) then return jsonb_build_object(''acquired'',false,''busy'',true); end if;');
  execute definition;
 end if;
end $$;
