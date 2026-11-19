begin;
-- A tip adjustment changes an existing captured Payarc charge, never creates a charge.
-- The request is immutable and submitted at most once. Unknown outcomes only read back.
create table public.payarc_tip_operations (
 id uuid primary key default gen_random_uuid(),
 payment_id uuid not null unique references public.payments(id),
 order_id uuid not null references public.orders(id),
 workspace_id uuid not null references public.workspaces(id),
 connection_id uuid not null references public.payment_connections(id),
 provider_payment_id text not null,
 original_amount_cents integer not null check(original_amount_cents>0),
 original_tip_cents integer not null check(original_tip_cents>=0),
 extra_tip_cents integer not null check(extra_tip_cents between 0 and 100000),
 target_amount_cents integer not null,
 target_tip_cents integer not null,
 state text not null default 'pending' check(state in ('pending','succeeded')),
 submitted_at timestamptz, completed_at timestamptz,
 created_at timestamptz not null default now(),
 check(target_amount_cents=original_amount_cents+extra_tip_cents),
 check(target_tip_cents=original_tip_cents+extra_tip_cents)
);
alter table public.payarc_tip_operations enable row level security;
revoke all on public.payarc_tip_operations from public,anon,authenticated;
grant all on public.payarc_tip_operations to service_role;

create or replace function public.wayne_claim_payarc_tip(target_payment_id uuid,target_workspace_id uuid,extra_tip integer,observed jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments%rowtype; o public.orders%rowtype; op public.payarc_tip_operations%rowtype; remote_tip integer:=(observed->>'tip_amount')::integer;
begin
 if extra_tip is null or extra_tip<0 or extra_tip>100000 then raise exception 'Invalid extra tip' using errcode='22023'; end if;
 select * into p from public.payments where id=target_payment_id and workspace_id=target_workspace_id for update;
 if not found or p.provider<>'payarc' or p.status<>'captured' or p.provider_payment_id is null then raise exception 'A captured Payarc payment is required' using errcode='22023'; end if;
 select * into o from public.orders where id=p.order_id for update;
 select * into op from public.payarc_tip_operations where payment_id=p.id;
 if found then
  if op.extra_tip_cents<>extra_tip then raise exception 'This card already has a saved tip request. Restore the extra tip to $% and check it again.',(op.extra_tip_cents/100.0)::numeric(12,2) using errcode='40001'; end if;
  return to_jsonb(op);
 end if;
 if o.status='cancelled' or o.is_test or p.amount_cents<>o.total_cents or exists(select 1 from public.payments where order_id=o.id and id<>p.id and status in ('authorized','captured','pending')) then raise exception 'Split or changed payments require review before adjusting a tip' using errcode='22023'; end if;
 if exists(select 1 from public.delivery_assignments where order_id=o.id and cashout_id is not null and status<>'released') then raise exception 'This delivery was already cashed out' using errcode='40001'; end if;
 if coalesce((p.metadata->>'void_requested')::boolean,false) or exists(select 1 from public.refunds where payment_id=p.id and status in ('pending','completed')) then raise exception 'Resolve the void or refund before adjusting a tip' using errcode='40001'; end if;
 if observed->>'provider_payment_id' is distinct from p.provider_payment_id or observed->>'status' is distinct from 'captured' or (observed->>'amount_cents')::integer is distinct from p.amount_cents or remote_tip is null or remote_tip<0 then raise exception 'Payarc charge amount or tip could not be verified' using errcode='40001'; end if;
 if extra_tip>0 and not coalesce(observed->>'provider_status' in ('submitted_for_settlement','captured'),false) then raise exception 'Payarc charge is no longer eligible for tip adjustment. Review its batch status.' using errcode='22023'; end if;
 if extra_tip>0 and not coalesce((select tips_enabled from public.store_settings where id=true),false) then raise exception 'Tips are switched off' using errcode='22023'; end if;
 insert into public.payarc_tip_operations(payment_id,order_id,workspace_id,connection_id,provider_payment_id,original_amount_cents,original_tip_cents,extra_tip_cents,target_amount_cents,target_tip_cents)
 values(p.id,o.id,p.workspace_id,(p.metadata->>'payarc_connection_id')::uuid,p.provider_payment_id,p.amount_cents,remote_tip,extra_tip,p.amount_cents+extra_tip,remote_tip+extra_tip) returning * into op;
 return to_jsonb(op);
end $$;

create or replace function public.wayne_submit_payarc_tip(target_operation_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.payarc_tip_operations set submitted_at=now() where id=target_operation_id and state='pending' and submitted_at is null and extra_tip_cents>0;
 return found;
end $$;

create or replace function public.wayne_complete_payarc_tip(target_operation_id uuid,observed jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op public.payarc_tip_operations%rowtype; p public.payments%rowtype;
begin
 -- Same payment -> order -> operation lock order as claim/refund/cash-out.
 select * into op from public.payarc_tip_operations where id=target_operation_id;
 if not found then raise exception 'Payarc tip request not found' using errcode='P0002'; end if;
 select * into p from public.payments where id=op.payment_id for update;
 perform 1 from public.orders where id=op.order_id for update;
 select * into op from public.payarc_tip_operations where id=target_operation_id for update;
 if p.provider<>'payarc' or p.status<>'captured' or p.provider_payment_id is distinct from op.provider_payment_id or p.metadata->>'payarc_connection_id' is distinct from op.connection_id::text then raise exception 'Payarc tip binding changed' using errcode='40001'; end if;
 if observed->>'provider_payment_id' is distinct from op.provider_payment_id or observed->>'status' is distinct from 'captured' or (observed->>'amount_cents')::integer is distinct from op.target_amount_cents or (observed->>'tip_amount')::integer is distinct from op.target_tip_cents then raise exception 'Payarc has not confirmed this exact tip and total. Check the saved request again.' using errcode='40001'; end if;
 if op.state='succeeded' then return to_jsonb(op); end if;
 if op.extra_tip_cents>0 and op.submitted_at is null then raise exception 'Tip was not submitted by this request' using errcode='40001'; end if;
 if p.amount_cents<>op.original_amount_cents or coalesce((p.metadata->>'void_requested')::boolean,false) or exists(select 1 from public.refunds where payment_id=p.id and status in ('pending','completed')) then raise exception 'Payarc adjustment conflicts with the payment ledger' using errcode='40001'; end if;
 update public.payments set amount_cents=op.target_amount_cents,provider_status=observed->>'provider_status',
 metadata=metadata||jsonb_build_object('payarc_tip_finalized',true,'payarc_tip_operation_id',op.id,'payarc_extra_tip_cents',op.extra_tip_cents) where id=p.id;
 update public.orders set total_cents=total_cents+op.extra_tip_cents,tip_cents=tip_cents+op.extra_tip_cents where id=op.order_id;
 update public.payarc_tip_operations set state='succeeded',completed_at=now() where id=op.id returning * into op;
 insert into public.order_events(workspace_id,order_id,event_type,metadata) values(op.workspace_id,op.order_id,'payment.tip_adjusted',jsonb_build_object('payment_id',p.id,'operation_id',op.id,'extra_tip_cents',op.extra_tip_cents,'captured_cents',op.target_amount_cents));
 return to_jsonb(op);
end $$;

revoke all on function public.wayne_claim_payarc_tip(uuid,uuid,integer,jsonb),public.wayne_submit_payarc_tip(uuid),public.wayne_complete_payarc_tip(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wayne_claim_payarc_tip(uuid,uuid,integer,jsonb),public.wayne_submit_payarc_tip(uuid),public.wayne_complete_payarc_tip(uuid,jsonb) to service_role;

-- Reconcile a matching adjustment before the normal Payarc amount check. A callback
-- only carries a hint; its caller supplies freshly authenticated API observations.
do $$ declare d text; anchor text:=' if outcome in (''captured'',''authorized'') and'; begin
 d:=pg_get_functiondef('public.wayne_settle_payarc_payment(uuid,jsonb)'::regprocedure);
 if position(anchor in d)=0 then raise exception 'Review Payarc settlement before enabling tips'; end if;
 d:=replace(d,anchor,E' if exists(select 1 from public.payarc_tip_operations op where op.payment_id=p.id and op.state=''pending'' and op.target_amount_cents=(payload->>''amount_cents'')::integer and op.target_tip_cents=(payload->>''tip_amount'')::integer and (op.submitted_at is not null or op.extra_tip_cents=0)) then\n  perform public.wayne_complete_payarc_tip((select id from public.payarc_tip_operations where payment_id=p.id),payload);\n  select * into p from public.payments where id=p.id;\n end if;\n'||anchor);
 execute d;
end $$;

-- Refund and void reservations must not race an unresolved tip request.
do $$ declare d text; target regprocedure; anchor text; begin
 foreach target in array array['public.wayne_begin_allocated_refund(jsonb)'::regprocedure,'public.wayne_prepare_payment_void(uuid,uuid)'::regprocedure] loop
  d:=pg_get_functiondef(target);
  if target='public.wayne_begin_allocated_refund(jsonb)'::regprocedure then anchor:=' select * into o from public.orders where id=p.order_id for update;';
  else anchor:=' if p.status=''voided'' then'; end if;
  if position(anchor in d)=0 then raise exception 'Review refund/void fence before enabling Payarc tips'; end if;
  d:=replace(d,anchor,E' if exists(select 1 from public.payarc_tip_operations where payment_id=p.id and state=''pending'') then raise exception ''Reconcile the pending Payarc tip before refunding or voiding'' using errcode=''40001''; end if;\n'||anchor);
  execute d;
 end loop;
end $$;

-- Preserve existing delivery JSON and expose a distinct state for already-charged
-- Payarc cards awaiting a slip tip. Never describe their money as merely held.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.wayne_pos_delivery_order_json(uuid)'::regprocedure);
 execute replace(d,'FUNCTION public.wayne_pos_delivery_order_json(','FUNCTION public.wayne_pos_delivery_order_json_before_payarc_tips(');
end $$;
revoke all on function public.wayne_pos_delivery_order_json_before_payarc_tips(uuid) from public,anon,authenticated;
create or replace function public.wayne_pos_delivery_order_json(target_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare answer jsonb; p public.payments%rowtype;
begin
 answer:=public.wayne_pos_delivery_order_json_before_payarc_tips(target_order_id);
 select * into p from public.payments where order_id=target_order_id and provider='payarc' and status='captured'
 and not coalesce((metadata->>'payarc_tip_finalized')::boolean,false) order by created_at desc limit 1;
 if found and p.amount_cents=(answer->>'total_cents')::integer and not exists(select 1 from public.payments where order_id=target_order_id and id<>p.id and status in ('pending','authorized','captured')) and not exists(select 1 from public.refunds where payment_id=p.id and status in ('pending','completed')) then
  answer:=answer||jsonb_build_object('paid_by','card_adjustable','hold_cents',p.amount_cents+50000,'held_at',p.captured_at,'card_label','Payarc '||coalesce(p.card_last4,''));
 end if;
 return answer;
end $$;

-- A forged direct cash-out may not bypass the server's adjustment confirmation.
do $$ declare d text; anchor text:='    if v_paid_by = ''card_held'' then'; begin
 d:=pg_get_functiondef('public.wayne_pos_driver_cashout(uuid,jsonb,jsonb,jsonb,text)'::regprocedure);
 if position(anchor in d)=0 then raise exception 'Review driver cash-out before enabling Payarc tips'; end if;
 d:=replace(d,anchor,E'    if v_paid_by = ''card_adjustable'' then raise exception ''Confirm the Payarc tip before cashing this order out'' using errcode=''40001''; end if;\n'||anchor);
 execute d;
end $$;

-- Keep the existing Stripe queue intact and append Payarc adjustment candidates.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.wayne_pos_tip_queue()'::regprocedure);
 execute replace(d,'FUNCTION public.wayne_pos_tip_queue(','FUNCTION public.wayne_pos_tip_queue_before_payarc_tips(');
end $$;
revoke all on function public.wayne_pos_tip_queue_before_payarc_tips() from public,anon,authenticated;
create or replace function public.wayne_pos_tip_queue()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare existing jsonb; added jsonb;
begin
 existing:=public.wayne_pos_tip_queue_before_payarc_tips();
 select coalesce(jsonb_agg(jsonb_build_object('order_id',o.id,'order_number',o.order_number,'daily_number',o.daily_number,'customer_name',o.customer_name_snapshot,'source',o.source,'fulfillment_type',o.fulfillment_type,
 'total_cents',o.total_cents,'tip_already_cents',o.tip_cents,'is_test',o.is_test,'placed_at',coalesce(o.placed_at,o.created_at),'payment_id',p.id,'provider','payarc','authorized_cents',p.amount_cents,'card_brand',p.card_brand,'card_last4',p.card_last4,'authorized_at',coalesce(p.captured_at,p.created_at),
 'max_capture_cents',p.amount_cents+100000,'entry','payarc_tip_adjustment','tip_mode','adjustment',
 'with_driver',exists(select 1 from public.delivery_assignments where order_id=o.id and status<>'released' and cashout_id is null)) order by p.created_at),'[]'::jsonb) into added
 from public.payments p join public.orders o on o.id=p.order_id
 where p.provider='payarc' and p.status='captured' and public.hanafy_can_access_workspace_data(p.workspace_id,array['pos.access','cash.manage']) and not coalesce((p.metadata->>'payarc_tip_finalized')::boolean,false)
 and o.status not in ('cancelled','draft') and not o.is_test and p.amount_cents=o.total_cents
 and not exists(select 1 from public.payments where order_id=o.id and id<>p.id and status in ('pending','authorized','captured'))
 and not exists(select 1 from public.refunds where payment_id=p.id and status in ('pending','completed'))
 and not exists(select 1 from public.delivery_assignments where order_id=o.id and cashout_id is not null and status<>'released');
 return existing||added;
end $$;
revoke all on function public.wayne_pos_tip_queue() from public,anon;
grant execute on function public.wayne_pos_tip_queue() to authenticated;

-- The counter needs a signed tip slip even though Payarc captured the order now.
create or replace function public.wayne_payarc_queues_tip_slip()
returns trigger language plpgsql security definer set search_path='' as $$
declare o public.orders%rowtype;
begin
 if new.provider<>'payarc' or new.status<>'captured' or new.method<>'card' or (tg_op='UPDATE' and old.status='captured') then return new; end if;
 select * into o from public.orders where id=new.order_id;
 if o.source='online' then return new; end if;
 insert into public.print_jobs(order_id,destination,job_type,payload,workspace_id,location_id)
 values(o.id,'receipt','tip_slip',jsonb_build_object('order_number',o.order_number,'customer_name',o.customer_name_snapshot,'fulfillment_type',o.fulfillment_type,'payment_method','card'),o.workspace_id,o.location_id)
 on conflict(order_id,destination,job_type) do nothing;
 return new;
end $$;
revoke all on function public.wayne_payarc_queues_tip_slip() from public,anon,authenticated;
create trigger payarc_payments_queue_tip_slip after insert or update of status on public.payments for each row execute function public.wayne_payarc_queues_tip_slip();
commit;
