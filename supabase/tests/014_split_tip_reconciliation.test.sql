begin;
select plan(12);
update public.pos_tip_capture_control set execution_enabled=false;
insert into auth.users(id,email,raw_user_meta_data) values('7f000000-0000-4000-8000-000000000001','split-reconciliation@example.invalid','{}');
update public.profiles set role_id=(select id from public.roles where code='owner'),active=true where id='7f000000-0000-4000-8000-000000000001';
update public.store_settings set test_ordering_enabled=true,pickup_minimum_cents=0,tax_rate_basis_points=0;
insert into public.menu_categories(id,name) values('7f000000-0000-4000-8000-000000000002','Webhook regression');
insert into public.menu_items(id,category_id,name,base_price_cents,pos_visible) values('7f000000-0000-4000-8000-000000000003','7f000000-0000-4000-8000-000000000002','Synthetic webhook fixture',2000,true);
set local role authenticated;
select set_config('request.jwt.claim.sub','7f000000-0000-4000-8000-000000000001',true);
select set_config('recon.order',(public.wayne_create_pos_order(jsonb_build_object('idempotency_key',gen_random_uuid(),'source','pos','customer_mode','walk_in','fulfillment_type','pickup','payment_method','test_manual','items',jsonb_build_array(jsonb_build_object('menu_item_id','7f000000-0000-4000-8000-000000000003','quantity',1,'modifiers','[]'::jsonb))))->>'id'),true);
reset role;
select set_config('request.jwt.claim.sub','',true);
insert into public.payments(id,order_id,provider,provider_payment_id,method,amount_cents,status,metadata)
values('7f000000-0000-4000-8000-000000000004',current_setting('recon.order')::uuid,'stripe','pi_pgtap_split_original','card',2000,'authorized','{}');

insert into public.pos_tip_operations(id,payment_id,order_id,workspace_id,location_id,original_provider_id,authorized_cents,requested_tip_cents,origin,plan,replacement_id,tip_intent_id,fallback_to_capture)
select '7f000000-0000-4000-8000-000000000006',id,order_id,workspace_id,location_id,provider_payment_id,2000,500,'pgtap-split','{"mode":"replacement","amount_cents":2500,"fallback_amount_cents":2000}','pi_pgtap_split_declined','pi_pgtap_split_tip',true
from public.payments where id='7f000000-0000-4000-8000-000000000004';
set local role service_role;
select public.wayne_settle_stripe_payment('40000000-0000-4000-8000-000000000001','{"provider_payment_id":"pi_pgtap_split_tip","status":"captured","amount_cents":500}');
select is((select status from public.payments where id='7f000000-0000-4000-8000-000000000004'),'authorized','separate tip alone does not mark the whole order paid');
select is((select state from public.pos_tip_operations where id='7f000000-0000-4000-8000-000000000006'),'pending','partial split remains recoverable');
select throws_ok($$select public.wayne_record_tip_leg('7f000000-0000-4000-8000-000000000006','pi_wrong',2000)$$,'22023','Split payment identity or amount mismatch','unbound provider identity cannot complete a split');
select public.wayne_settle_stripe_payment('40000000-0000-4000-8000-000000000001','{"provider_payment_id":"pi_pgtap_split_original","status":"captured","amount_cents":2000}');
select is((select amount_cents from public.payments where id='7f000000-0000-4000-8000-000000000004'),2500,'both provider legs reconcile the aggregate total');
select is((select tip_cents from public.orders where id=current_setting('recon.order')::uuid),500,'both legs add exactly the requested tip');
select is((select provider_payment_id from public.payments where id='7f000000-0000-4000-8000-000000000004'),'pi_pgtap_split_original','original provider identity remains the main tender');
select is((select metadata->>'tip_charge_intent' from public.payments where id='7f000000-0000-4000-8000-000000000004'),'pi_pgtap_split_tip','separate tip reference persists');
select public.wayne_settle_stripe_payment('40000000-0000-4000-8000-000000000001','{"provider_payment_id":"pi_pgtap_split_tip","status":"captured","amount_cents":500}');
select is((select count(*) from public.order_events where order_id=current_setting('recon.order')::uuid and event_type='payment.tip_captured'),1::bigint,'replayed split completion is idempotent');
select lives_ok($$select public.wayne_update_tip_operation('7f000000-0000-4000-8000-000000000006',gen_random_uuid(),'release')$$,'completed receipt cleanup safely returns without a lease');
select ok(not has_function_privilege('authenticated','public.wayne_record_tip_leg(uuid,text,integer,text,text)','execute'),'split leg confirmation is service-only');
select ok(not has_function_privilege('authenticated','public.wayne_adopt_legacy_tip_operation(uuid,uuid,text,integer)','execute'),'legacy adoption is service-only');
select ok(not (select execution_enabled from public.pos_tip_capture_control),'split reconciliation leaves capture paused');
select * from finish();
rollback;
