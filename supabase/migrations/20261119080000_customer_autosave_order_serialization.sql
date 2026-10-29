-- Customer autosave and order submission can both see an absent phone row.
-- Serialize their find-or-create transactions before either looks it up. Row
-- locks alone cannot protect a customer that does not exist yet. Preserve each
-- function's current body, authorization, caller-ID behavior and ACLs.
do $$
declare target regprocedure; definition text; phone_lock text := E'begin\n  -- customer_identity_serialization\n  perform pg_advisory_xact_lock(hashtextextended(public.wayne_normalize_phone(payload->>''phone''),918));\n';
begin
  foreach target in array array[
    'public.wayne_pos_remember_customer(jsonb)'::regprocedure,
    'public.wayne_create_pos_order(jsonb)'::regprocedure,
    'public.wayne_create_test_order(jsonb)'::regprocedure,
    'public.wayne_create_card_order(jsonb)'::regprocedure
  ] loop
    definition:=pg_get_functiondef(target);
    if position('customer_identity_serialization' in definition)>0 then continue; end if;
    if position(E'begin\n' in definition)=0 then raise exception 'Unsupported customer writer definition: %',target; end if;
    definition:=regexp_replace(definition,E'begin\n',phone_lock);
    execute definition;
  end loop;
end $$;
