begin;
select plan(22);

select ok((select relrowsecurity from pg_class where oid = 'public.workspaces'::regclass), 'workspaces has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.locations'::regclass), 'locations has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.workspace_members'::regclass), 'workspace members has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.workspace_invites'::regclass), 'workspace invites has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.workspace_services'::regclass), 'workspace services has RLS enabled');
select is((select count(*) from public.workspaces where slug = 'waynes-pizza'), 1::bigint, 'Wayne''s is seeded as the first workspace');
select is((select count(*) from public.locations where workspace_id = '50000000-0000-4000-8000-000000000001'), 1::bigint, 'Wayne''s has a seeded location');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('30000000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'workspace-a-owner@test.local', '', now(), '{}', '{"display_name":"Workspace A Owner"}'),
  ('30000000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'workspace-b-cashier@test.local', '', now(), '{}', '{"display_name":"Workspace B Cashier"}'),
  ('30000000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'platform-admin@test.local', '', now(), '{}', '{"display_name":"Platform Admin"}');

insert into public.workspaces (id, slug, name) values
  ('50000000-0000-4000-8000-000000000011', 'workspace-a', 'Workspace A'),
  ('50000000-0000-4000-8000-000000000012', 'workspace-b', 'Workspace B');
insert into public.locations (workspace_id, slug, name) values
  ('50000000-0000-4000-8000-000000000011', 'main', 'Workspace A Main'),
  ('50000000-0000-4000-8000-000000000012', 'main', 'Workspace B Main');
insert into public.workspace_members (workspace_id, user_id, role_id) values
  ('50000000-0000-4000-8000-000000000011', '30000000-0000-4000-8000-000000000011', (select id from public.roles where code = 'owner')),
  ('50000000-0000-4000-8000-000000000012', '30000000-0000-4000-8000-000000000012', (select id from public.roles where code = 'cashier'));
insert into public.platform_users (user_id, role) values
  ('30000000-0000-4000-8000-000000000013', 'platform_admin');

set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000011', true);
select ok(public.hanafy_is_workspace_member('50000000-0000-4000-8000-000000000011'), 'owner is a member of their workspace');
select ok(not public.hanafy_is_workspace_member('50000000-0000-4000-8000-000000000012'), 'owner is not a member of another workspace');
select ok(public.hanafy_has_workspace_permission('50000000-0000-4000-8000-000000000011', 'staff.manage'), 'owner has workspace-scoped staff permission');
select ok(not public.hanafy_has_workspace_permission('50000000-0000-4000-8000-000000000012', 'staff.manage'), 'owner cannot borrow another workspace permission');
select is((select count(*) from public.workspaces), 1::bigint, 'owner sees only their workspace');
select is((select count(*) from public.locations), 1::bigint, 'owner sees only their workspace location');
select is((select count(*) from public.workspace_services), 0::bigint, 'owner cannot read another workspace services');

select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000012', true);
select ok(not public.hanafy_has_workspace_permission('50000000-0000-4000-8000-000000000012', 'staff.manage'), 'cashier cannot manage staff in their own workspace');
select is((select count(*) from public.workspaces), 1::bigint, 'cashier sees only their workspace');
select is((select count(*) from public.workspace_members), 1::bigint, 'cashier sees only their own membership');

select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000013', true);
select ok(public.hanafy_is_platform_admin(), 'platform administrator is recognized separately from restaurant ownership');
select ok(public.hanafy_create_workspace('workspace-c', 'Workspace C', '', '', '', 'Main location', 'America/New_York', '30000000-0000-4000-8000-000000000011', array['restaurant_pos']::text[]) is not null, 'platform administrator can provision a workspace with an owner and service');
select is((select count(*) from public.workspaces), 4::bigint, 'platform administrator can see all workspaces');
select is((select count(*) from public.locations), 4::bigint, 'platform administrator can see all locations');

select * from finish();
rollback;
