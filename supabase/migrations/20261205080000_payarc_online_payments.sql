-- Payarc merchant API + hosted fields. No existing account is switched by this migration.
insert into public.payment_provider_catalog(code,name,availability,connection_modes,capabilities,description)
values('payarc','Payarc','available',array['api'],
 '{"online_card":true,"card_present":false,"card_present_integrated":false,"manual_confirmation":false,"refunds_via_api":true,"voids_via_api":true,"webhooks":true}',
 'Payarc hosted card fields for website and keyed payments. Tips collected before payment; readers configured separately.')
on conflict(code) do update set name=excluded.name,availability=excluded.availability,connection_modes=excluded.connection_modes,capabilities=excluded.capabilities,description=excluded.description;

alter table public.location_payment_configurations drop constraint if exists location_payment_configurations_provider_check;
alter table public.location_payment_configurations add constraint location_payment_configurations_provider_check check(provider in ('none','square','stripe','payarc'));
alter table public.payment_provider_settings drop constraint if exists payment_provider_settings_provider_check;
alter table public.payment_provider_settings add constraint payment_provider_settings_provider_check check(provider in ('none','square','stripe','payarc'));
-- Extend the existing constraints without removing the reader and Square requirements.
do $$ declare t regclass; c record; definition text; begin
 foreach t in array array['public.location_payment_configurations'::regclass,'public.payment_provider_settings'::regclass] loop
  for c in select conname,pg_get_constraintdef(oid) def from pg_constraint where conrelid=t and contype='c' loop
   if c.def like '%online_card_enabled%' and c.def like '%provider%' then
    definition:=c.def;
    execute format('alter table %s drop constraint %I',t,c.conname);
    execute format('alter table %s add constraint %I check ((provider = ''payarc'' and not terminal_card_enabled) or (%s))',t,c.conname,substring(definition from 8 for length(definition)-8));
   end if;
  end loop;
 end loop;
end $$;

-- Reuse the Stripe settings-to-connection branch for Payarc with its own secret reference.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.hanafy_sync_square_connection_from_settings()'::regprocedure);
 if position('if new.provider = ''stripe'' then' in definition)=0 then raise exception 'Review payment settings synchronization before applying Payarc'; end if;
 definition:=replace(definition,'if new.provider = ''stripe'' then','if new.provider in (''stripe'',''payarc'') then');
 definition:=replace(definition,'connection.provider = ''stripe''','connection.provider = new.provider');
 definition:=replace(definition,'provider <> ''stripe''','provider <> new.provider');
 definition:=replace(definition,'''online'', ''stripe'', ''api''','''online'', new.provider, ''api''');
 definition:=replace(definition,'''env:STRIPE''','case when new.provider = ''payarc'' then ''env:PAYARC'' else ''env:STRIPE'' end');
 execute definition;
end $$;

create unique index if not exists payments_payarc_reference_unique on public.payments((metadata->>'payarc_reference')) where provider='payarc';

-- The app's server opens a durable attempt BEFORE talking to Payarc. Serialized
-- against the same order lock used by existing tender RPCs, including split tenders.
create or replace function public.wayne_begin_payarc_payment(target_connection_id uuid,target_order_id uuid,request_key text,expected_cents integer,split_cents integer default null,actor_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.payment_connections%rowtype; o public.orders%rowtype; p public.payments%rowtype; amount_due integer; ref text;
begin
 select * into c from public.payment_connections where id=target_connection_id and provider='payarc' and status='connected' and purpose in ('online','counter_and_online');
 if not found or not coalesce((c.public_configuration->>'online_card_enabled')::boolean,false) then raise exception 'Payarc connection is not ready' using errcode='22023'; end if;
 if char_length(request_key)<16 or char_length(request_key)>160 then raise exception 'Invalid payment request key' using errcode='22023'; end if;
 select * into o from public.orders where id=target_order_id and workspace_id=c.workspace_id and (c.location_id is null or location_id=c.location_id) for update;
 if not found or o.is_test or o.status='cancelled' or o.payment_status in ('refunded','partially_refunded') then raise exception 'Order is not payable' using errcode='22023'; end if;
 select * into p from public.payments where idempotency_key=request_key;
 if found then
  if p.order_id<>o.id or p.provider<>'payarc' or p.metadata->>'payarc_connection_id' is distinct from c.id::text or p.amount_cents<>expected_cents then raise exception 'Payment request identity changed' using errcode='40001'; end if;
  return jsonb_build_object('payment_id',p.id,'status',p.status,'provider_payment_id',p.provider_payment_id,'amount_cents',p.amount_cents,'reference',p.metadata->>'payarc_reference','duplicate',true);
 end if;
 amount_due:=o.total_cents-public.wayne_order_paid_cents(o.id);
 if split_cents is not null then
  if split_cents<=0 or split_cents>amount_due then raise exception 'Invalid split amount' using errcode='22023'; end if;
  amount_due:=split_cents;
 end if;
 if expected_cents is null or expected_cents<=0 or expected_cents<>amount_due then raise exception 'The order total changed. Review it before charging.' using errcode='40001'; end if;
 if exists(select 1 from public.payments where order_id=o.id and status='pending') then raise exception 'A payment is already in progress' using errcode='40001'; end if;
 p.id:=gen_random_uuid();
 -- 25-character, unique merchant statement descriptor also recovers a lost HTTP response.
 ref:='WAYNES '||left(replace(p.id::text,'-',''),18);
 insert into public.payments(id,workspace_id,location_id,order_id,provider,method,amount_cents,status,idempotency_key,created_by_user_id,metadata)
 values(p.id,o.workspace_id,o.location_id,o.id,'payarc','card',amount_due,'pending',request_key,actor_id,
 jsonb_build_object('payarc_connection_id',c.id,'payarc_reference',ref,'environment',c.environment,'entry',case when actor_id is null then 'online' else 'pos_keyed_card' end));
 insert into public.order_events(workspace_id,order_id,event_type,actor_user_id,metadata)
 values(o.workspace_id,o.id,'payment.started',actor_id,jsonb_build_object('payment_id',p.id,'provider','payarc','amount_cents',amount_due));
 return jsonb_build_object('payment_id',p.id,'status','pending','amount_cents',amount_due,'reference',ref,'duplicate',false);
end $$;
revoke all on function public.wayne_begin_payarc_payment(uuid,uuid,text,integer,integer,uuid) from public,anon,authenticated;
grant execute on function public.wayne_begin_payarc_payment(uuid,uuid,text,integer,integer,uuid) to service_role;

-- Only server-to-server readbacks reach this RPC. Bind one charge to one attempt,
-- and never overwrite a captured ledger with an earlier callback/readback.
create or replace function public.wayne_settle_payarc_payment(target_connection_id uuid,payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.payment_connections%rowtype; p public.payments%rowtype; charge_id text:=payload->>'provider_payment_id'; outcome text:=payload->>'status';
begin
 select * into c from public.payment_connections where id=target_connection_id and provider='payarc';
 if not found or nullif(charge_id,'') is null then raise exception 'Payarc identity required' using errcode='22023'; end if;
 select * into p from public.payments where provider='payarc' and workspace_id=c.workspace_id and metadata->>'payarc_connection_id'=c.id::text
 and (provider_payment_id=charge_id or (provider_payment_id is null and metadata->>'payarc_reference'=payload->>'reference')) for update;
 if not found then raise exception 'Payarc payment is not bound to this connection' using errcode='P0002'; end if;
 if p.provider_payment_id is not null and p.provider_payment_id<>charge_id then raise exception 'Payarc charge changed' using errcode='40001'; end if;
 if outcome in ('captured','authorized') and ((payload->>'amount_cents')::integer is distinct from p.amount_cents) then raise exception 'Payarc amount does not match the ticket' using errcode='40001'; end if;
 update public.payments set provider_payment_id=charge_id,provider_status=payload->>'provider_status' where id=p.id;
 if outcome='pending' or (p.status='captured' and outcome<>'voided') or p.status in ('voided','failed') then return jsonb_build_object('payment_id',p.id,'status',p.status); end if;
 perform public.wayne_settle_payment(jsonb_build_object('payment_id',p.id,'status',outcome,'provider_status',payload->>'provider_status',
 'amount_cents',p.amount_cents,'card_brand',payload->>'card_brand','card_last4',payload->>'card_last4','failure_reason',payload->>'failure_reason'));
 if outcome='voided' then update public.orders set payment_status=case when public.wayne_order_paid_cents(p.order_id)>=total_cents then 'paid' else 'unpaid' end where id=p.order_id; end if;
 return jsonb_build_object('payment_id',p.id,'status',outcome);
end $$;
revoke all on function public.wayne_settle_payarc_payment(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wayne_settle_payarc_payment(uuid,jsonb) to service_role;

-- Payarc uses the existing explicit base/tip allocation and driver recovery ledger.
-- Refund submission is reserved once; ambiguous responses only trigger lookups,
-- without assuming an undocumented Payarc idempotency retention period.
alter table public.refunds add column if not exists payarc_submitted_at timestamptz;
create or replace function public.wayne_claim_payarc_refund(target_refund_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.refunds r set payarc_submitted_at=now() from public.payments p
 where r.id=target_refund_id and r.payment_id=p.id and p.provider='payarc' and r.status='pending' and r.payarc_submitted_at is null;
 return found;
end $$;
revoke all on function public.wayne_claim_payarc_refund(uuid) from public,anon,authenticated;
grant execute on function public.wayne_claim_payarc_refund(uuid) to service_role;

do $$ declare d text; begin
 d:=pg_get_functiondef('public.wayne_begin_allocated_refund(jsonb)'::regprocedure);
 if position('p.provider<>''stripe''' in d)=0 then raise exception 'Review refund allocation before applying Payarc'; end if;
 d:=replace(d,'p.provider<>''stripe''','p.provider not in (''stripe'',''payarc'')');
 d:=replace(d,'Only a captured Stripe payment can be refunded','Only a captured processor payment can be refunded');
 d:=replace(d,'total_tip := o.tip_cents;',E'if p.provider=''payarc'' and coalesce((p.metadata->>''void_requested'')::boolean,false) then raise exception ''Reconcile the void before refunding'' using errcode=''40001''; end if;\n  total_tip := o.tip_cents;');
 execute d;
 d:=pg_get_functiondef('public.wayne_begin_refund(jsonb)'::regprocedure);
 d:=replace(d,'payment_row.provider=''stripe''','payment_row.provider in (''stripe'',''payarc'')');
 execute d;
 d:=pg_get_functiondef('public.wayne_prepare_payment_void(uuid,uuid)'::regprocedure);
 d:=replace(d,'if p.status<>''authorized'' or p.provider_payment_id is null', 'if (p.status<>''authorized'' and not (p.provider=''payarc'' and p.status=''captured'')) or p.provider_payment_id is null');
 d:=replace(d,'update public.payments set metadata=metadata||jsonb_build_object(''void_requested'',true)', E'if exists(select 1 from public.refunds where payment_id=p.id and status in (''pending'',''completed'')) then raise exception ''Review existing refunds before voiding'' using errcode=''40001''; end if;\n update public.payments set metadata=metadata||jsonb_build_object(''void_requested'',true)');
 execute d;
 d:=pg_get_functiondef('public.wayne_finish_payment_void(uuid,text)'::regprocedure);
 d:=replace(d,'if p.status<>''authorized'' or not', 'if (p.status<>''authorized'' and not (p.provider=''payarc'' and p.status=''captured'')) or not');
 d:=replace(d,E'\nend',E'\n if p.provider=''payarc'' then update public.orders set payment_status=case when public.wayne_order_paid_cents(p.order_id)>=total_cents then ''paid'' else ''unpaid'' end where id=p.order_id; end if;\nend');
 execute d;
end $$;

-- Keep receiving historical payment outcomes after changing the active processor.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.hanafy_payment_connection_by_webhook_key(text)'::regprocedure);
 d:=replace(d, ' and connection.status <> ''disabled''', '');
 execute d;
end $$;

-- The server may release an unsuccessful void reservation only after an
-- authoritative read confirms a captured, batched charge (which needs a refund).
create or replace function public.wayne_release_payarc_void(target_payment_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.payments where id=target_payment_id for update;
 update public.payments set metadata=metadata-'void_requested'
 where id=target_payment_id and provider='payarc' and status='captured';
end $$;
revoke all on function public.wayne_release_payarc_void(uuid) from public,anon,authenticated;
grant execute on function public.wayne_release_payarc_void(uuid) to service_role;
