begin;

select plan(12);

select has_table('public', 'workspaces', 'creates the workspace tenant root');
select has_table('public', 'locations', 'creates workspace locations');
select has_table('public', 'platform_users', 'keeps platform identities separate');
select has_table('public', 'workspace_members', 'creates workspace membership');
select has_table('public', 'service_catalog', 'creates a platform service catalogue');
select has_table('public', 'workspace_services', 'creates workspace entitlements');

select ok((select relrowsecurity from pg_class where oid = 'public.workspaces'::regclass), 'workspace RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.locations'::regclass), 'location RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.platform_users'::regclass), 'platform user RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.workspace_members'::regclass), 'workspace membership RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.service_catalog'::regclass), 'service catalogue RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.workspace_services'::regclass), 'workspace service RLS is enabled');

select * from finish();
rollback;
