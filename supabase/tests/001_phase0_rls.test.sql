begin;
select plan(14);

select ok((select relrowsecurity from pg_class where oid = 'public.roles'::regclass), 'roles has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.permissions'::regclass), 'permissions has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.role_permissions'::regclass), 'role_permissions has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles has RLS enabled');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@test.local', '', now(), '{}', '{"display_name":"Test Owner"}'),
  ('30000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cashier@test.local', '', now(), '{}', '{"display_name":"Test Cashier"}');

update public.profiles
set role_id = (select id from public.roles where code = 'owner')
where id = '30000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000001', true);
select ok(public.wayne_has_role(array['owner']), 'owner role check succeeds server-side');
select ok(public.wayne_has_permission('admin.access'), 'owner has admin access');
select ok(public.wayne_has_permission('staff.manage'), 'owner can manage staff');
select is((select count(*) from public.profiles), 2::bigint, 'owner can view staff profiles');

select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000002', true);
select ok(public.wayne_has_role(array['cashier']), 'cashier role check succeeds server-side');
select ok(not public.wayne_has_permission('admin.access'), 'cashier has no admin access');
select ok(public.wayne_has_permission('pos.access'), 'cashier has POS access');
select is((select count(*) from public.profiles), 1::bigint, 'cashier can view only their own profile');

select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000099', true);
select ok(not public.wayne_has_permission('admin.access'), 'unknown authenticated user has no admin access');
select is((select count(*) from public.profiles), 0::bigint, 'unknown authenticated user sees no profiles');

select * from finish();
rollback;
