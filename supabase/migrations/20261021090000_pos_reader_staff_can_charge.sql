-- Applied to live Supabase (vxpkdmtornkeoedkawkt) on 2026-10-08 as pos_reader_staff_can_charge.
-- The Stripe Reader M2 routes (/api/pos/stripe-terminal/intent and /confirm) call
-- wayne_begin_payment / wayne_settle_payment with the signed-in staff member's session.
-- Both were server-only (EXECUTE revoked from authenticated), so every POS user —
-- the owner included — got "permission denied" (shown as "Your account is not allowed
-- to make this change"). Allow signed-in staff with POS or payments access to call them,
-- keep anonymous callers out, and never let staff settle an online-checkout payment
-- (those are only settled by the Stripe webhook / server).
do $migration$
declare
  def text;
  guard text := E'\nbegin\n  if auth.uid() is not null\n     and not (public.wayne_has_permission(''pos.access'') or public.wayne_has_permission(''payments.manage'')) then\n    raise exception ''Your account is not allowed to take card payments'' using errcode = ''42501'';\n  end if;\n';
begin
  select pg_get_functiondef('public.wayne_begin_payment(jsonb)'::regprocedure) into def;
  if position('not allowed to take card payments' in def) = 0 then
    def := regexp_replace(def, E'\nbegin\n', guard);
    execute def;
  end if;

  select pg_get_functiondef('public.wayne_settle_payment(jsonb)'::regprocedure) into def;
  if position('not allowed to take card payments' in def) = 0 then
    def := regexp_replace(def, E'\nbegin\n', guard);
    def := replace(def,
      E'if not found then raise exception ''Payment not found'' using errcode = ''P0002''; end if;\n',
      E'if not found then raise exception ''Payment not found'' using errcode = ''P0002''; end if;\n  if auth.uid() is not null and coalesce(payment_row.metadata ->> ''entry'', ''online'') = ''online'' then\n    raise exception ''Online payments are settled by the payment processor only'' using errcode = ''42501'';\n  end if;\n');
    execute def;
  end if;
end
$migration$;

revoke execute on function public.wayne_begin_payment(jsonb) from public, anon;
revoke execute on function public.wayne_settle_payment(jsonb) from public, anon;
grant execute on function public.wayne_begin_payment(jsonb) to authenticated, service_role;
grant execute on function public.wayne_settle_payment(jsonb) to authenticated, service_role;
