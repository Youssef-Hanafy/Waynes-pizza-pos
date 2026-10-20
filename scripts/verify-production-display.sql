begin;
set local lock_timeout = '3s';
set local statement_timeout = '20s';

do $verification$
declare
  owner_id uuid;
  display_key text := 'deployment-verification-' || gen_random_uuid()::text;
  result jsonb;
begin
  select profile.id into owner_id
    from public.profiles profile
    join public.roles role on role.id = profile.role_id
   where role.code = 'owner' order by profile.created_at limit 1;
  if owner_id is null then raise exception 'No owner available for display verification'; end if;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);

  if has_function_privilege('anon', 'public.wayne_display_publish(text,jsonb,text,boolean)', 'execute')
    or has_function_privilege('anon', 'public.wayne_display_read(text)', 'execute')
    or has_function_privilege('anon', 'public.wayne_display_respond(text,jsonb)', 'execute') then
    raise exception 'Anonymous role must not access customer display functions';
  end if;
  if not has_function_privilege('authenticated', 'public.wayne_display_publish(text,jsonb,text,boolean)', 'execute')
    or not has_function_privilege('authenticated', 'public.wayne_display_read(text)', 'execute')
    or not has_function_privilege('authenticated', 'public.wayne_display_respond(text,jsonb)', 'execute') then
    raise exception 'Authenticated customer display permissions are missing';
  end if;

  perform public.wayne_display_publish(display_key, '{"phase":"tip","request_id":"verification-tip"}'::jsonb, 'verification-register', true);
  result := public.wayne_display_read(display_key);
  if result -> 'state' ->> 'request_id' is distinct from 'verification-tip' then
    raise exception 'Display did not receive the current tip request';
  end if;

  result := public.wayne_display_respond(display_key, '{"request_id":"stale-tip","kind":"tip","tip_cents":500}'::jsonb);
  if (result ->> 'accepted')::boolean then raise exception 'Display accepted a stale request'; end if;

  result := public.wayne_display_respond(display_key, '{"request_id":"verification-tip","kind":"tip","tip_cents":500}'::jsonb);
  if not (result ->> 'accepted')::boolean then raise exception 'Display rejected the current tip'; end if;
  result := public.wayne_display_publish(display_key, '{"phase":"tip","request_id":"verification-tip"}'::jsonb, 'verification-register', false);
  if (result -> 'response' ->> 'tip_cents')::integer is distinct from 500 then
    raise exception 'Register did not receive the selected tip';
  end if;

  perform public.wayne_display_publish(display_key, '{"phase":"idle"}'::jsonb, 'other-register', false);
  result := public.wayne_display_read(display_key);
  if result -> 'state' ->> 'request_id' is distinct from 'verification-tip' then
    raise exception 'A different register heartbeat replaced the active request';
  end if;

  perform public.wayne_display_publish(display_key, '{"phase":"sign","request_id":"verification-signature"}'::jsonb, 'verification-register', true);
  result := public.wayne_display_respond(display_key, '{"request_id":"verification-signature","kind":"signature","signature_svg":"<svg><path d=\"M1 1L2 2\"/></svg>"}'::jsonb);
  if not (result ->> 'accepted')::boolean then raise exception 'Display rejected the signature'; end if;
  result := public.wayne_display_publish(display_key, '{"phase":"sign","request_id":"verification-signature"}'::jsonb, 'verification-register', false);
  if result -> 'response' ->> 'kind' is distinct from 'signature' then
    raise exception 'Register did not receive the signature';
  end if;
end;
$verification$;

rollback;

select 'passed: display access control, tips, signatures, stale answers, register ownership; all test writes rolled back' as verification;
