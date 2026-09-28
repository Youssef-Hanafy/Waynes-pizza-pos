begin;

select plan(6);

select ok((select relrowsecurity from pg_class where oid = 'public.customers'::regclass), 'customers have RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.orders'::regclass), 'orders have RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.integration_outbox'::regclass), 'integration outbox has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.payment_provider_settings'::regclass), 'payment settings have RLS enabled');
select ok(exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customers' and policyname = 'hanafy_workspace_read'), 'customers use a workspace read policy');
select ok(exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders' and policyname = 'hanafy_workspace_read'), 'orders use a workspace read policy');

select * from finish();
rollback;
