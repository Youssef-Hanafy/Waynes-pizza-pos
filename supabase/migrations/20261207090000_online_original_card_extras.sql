-- Extra food is a separate sale payment on the same order, never a tip.
-- Order editing already prices the added items and tax; charge only its balance.
create or replace function public.wayne_begin_online_extra_payment(
 target_order_id uuid, target_workspace_id uuid, target_location_id uuid,
 target_connection_id uuid, request_key text, expected_cents integer, actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders%rowtype; original public.payments%rowtype; attempt public.payments%rowtype; result jsonb;
begin
 select * into o from public.orders where id=target_order_id and workspace_id=target_workspace_id
 and (target_location_id is null or location_id=target_location_id) for update;
 if not found or o.source<>'online' or o.is_test or o.status in ('cancelled','draft','payment_pending')
 or o.payment_status in ('refunded','partially_refunded') then raise exception 'This online order cannot be charged' using errcode='22023'; end if;
 select * into original from public.payments where order_id=o.id and provider='payarc' and method='card' and status='captured'
 and metadata->>'entry'='online' and metadata->>'payarc_connection_id'=target_connection_id::text order by created_at limit 1;
 if not found or original.provider_payment_id is null then raise exception 'No original online card is available. Collect payment another way.' using errcode='22023'; end if;
 select * into attempt from public.payments where idempotency_key=request_key;
 if found then
  if attempt.order_id<>o.id or attempt.metadata->>'entry' is distinct from 'online_extra_charge'
   or attempt.metadata->>'original_payment_id' is distinct from original.id::text
   or attempt.metadata->>'payarc_connection_id' is distinct from target_connection_id::text
   or attempt.amount_cents is distinct from expected_cents then raise exception 'Extra charge request identity changed' using errcode='40001'; end if;
  return jsonb_build_object('payment_id',attempt.id,'status',attempt.status,'provider_payment_id',attempt.provider_payment_id,
   'amount_cents',attempt.amount_cents,'reference',attempt.metadata->>'payarc_reference','duplicate',true,
   'original_provider_payment_id',original.provider_payment_id);
 end if;
 if exists(select 1 from public.payments p where p.order_id=o.id and coalesce((p.metadata->>'void_requested')::boolean,false))
 or exists(select 1 from public.refunds r join public.payments p on p.id=r.payment_id where p.order_id=o.id and r.status in ('pending','completed'))
 or exists(select 1 from public.payarc_tip_operations where order_id=o.id and state='pending') then
  raise exception 'Resolve the pending tip, void or refund before charging extras' using errcode='40001';
 end if;
 if exists(select 1 from public.delivery_assignments where order_id=o.id and cashout_id is not null and status<>'released') then
  raise exception 'This delivery was already cashed out. Review payment before adding charges.' using errcode='40001';
 end if;
 result:=public.wayne_begin_payarc_payment(target_connection_id,o.id,request_key,expected_cents,null,actor_id);
 update public.payments set metadata=metadata||jsonb_build_object('entry','online_extra_charge','original_payment_id',original.id,
 'payarc_tip_finalized',true,'customer_approved',true) where id=(result->>'payment_id')::uuid;
 return result||jsonb_build_object('original_provider_payment_id',original.provider_payment_id);
end $$;
revoke all on function public.wayne_begin_online_extra_payment(uuid,uuid,uuid,uuid,text,integer,uuid) from public,anon,authenticated;
grant execute on function public.wayne_begin_online_extra_payment(uuid,uuid,uuid,uuid,text,integer,uuid) to service_role;

-- Keep signed-slip tips available on the ORIGINAL payment after successful
-- supplemental sales. Other split tenders and unresolved sales still need review.
do $$ declare d text; target regprocedure; begin
 foreach target in array array['public.wayne_claim_payarc_tip(uuid,uuid,integer,jsonb)'::regprocedure,
 'public.wayne_pos_tip_queue()'::regprocedure] loop
  d:=pg_get_functiondef(target);
  d:=replace(d,'p.provider<>''payarc'' or p.status<>''captured''', 'p.provider<>''payarc'' or p.status<>''captured'' or p.metadata->>''entry''=''online_extra_charge''');
  d:=replace(d,'p.amount_cents<>o.total_cents','public.wayne_order_paid_cents(o.id)<>o.total_cents');
  d:=replace(d,'p.amount_cents=o.total_cents','public.wayne_order_paid_cents(o.id)=o.total_cents');
  d:=replace(d,'and id<>p.id and status in (''authorized'',''captured'',''pending'')',
   'and id<>p.id and status in (''authorized'',''captured'',''pending'') and not coalesce((status=''captured'' and metadata->>''entry''=''online_extra_charge'' and metadata->>''original_payment_id''=p.id::text),false)');
  d:=replace(d,'and id<>p.id and status in (''pending'',''authorized'',''captured'')',
   'and id<>p.id and status in (''pending'',''authorized'',''captured'') and not coalesce((status=''captured'' and metadata->>''entry''=''online_extra_charge'' and metadata->>''original_payment_id''=p.id::text),false)');
  execute d;
 end loop;
 d:=pg_get_functiondef('public.wayne_pos_delivery_order_json(uuid)'::regprocedure);
 d:=replace(d,'p.amount_cents=(answer->>''total_cents'')::integer','public.wayne_order_paid_cents(target_order_id)=(answer->>''total_cents'')::integer');
 d:=replace(d,'and id<>p.id and status in (''pending'',''authorized'',''captured'')',
  'and id<>p.id and status in (''pending'',''authorized'',''captured'') and not coalesce((status=''captured'' and metadata->>''entry''=''online_extra_charge'' and metadata->>''original_payment_id''=p.id::text),false)');
 -- hold_cents is relative to the whole displayed order, including extras.
 d:=replace(d,'''hold_cents'',p.amount_cents+50000','''hold_cents'',(answer->>''total_cents'')::integer+50000');
 execute d;
end $$;
