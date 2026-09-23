-- Go-live blocker found in the 2026-09-23 audit.
--
-- Online card orders (wayne_create_card_order) are built by
-- wayne_create_test_order, which refused every order once "TEST / MANUAL
-- ordering" was switched off.  The go-live plan switches TEST ordering off
-- when cards go live, so that step would have stopped all online ordering.
--
-- Now: TEST ordering off still refuses a direct no-payment order, but a card
-- order (which is only created while card payment is switched on) goes
-- through.  The card function marks its own transaction; a public caller
-- can't set that flag because every RPC is its own transaction.
--
-- Also: the checkout text-deals box now shows the full SMS disclosure with
-- Terms / Privacy links, so its consent record is versioned wayne-checkout-v2.
do $$
declare
  body text;
begin
  body := pg_get_functiondef('public.wayne_create_test_order(jsonb)'::regprocedure);
  if position('wayne.card_checkout' in body) = 0 then
    body := replace(body,
      'if not settings.test_ordering_enabled then raise exception',
      'if not settings.test_ordering_enabled and coalesce(current_setting(''wayne.card_checkout'', true), '''') <> ''on'' then raise exception');
    if position('wayne.card_checkout' in body) = 0 then
      raise exception 'wayne_create_test_order: test-ordering check not found';
    end if;
  end if;
  body := replace(body, '''wayne-checkout-v1''', '''wayne-checkout-v2''');
  execute body;

  body := pg_get_functiondef('public.wayne_create_card_order(jsonb)'::regprocedure);
  if position('wayne.card_checkout' in body) = 0 then
    body := replace(body,
      'result := public.wayne_create_test_order(payload);',
      'perform set_config(''wayne.card_checkout'', ''on'', true);
  result := public.wayne_create_test_order(payload);
  perform set_config(''wayne.card_checkout'', '''', true);');
    if position('wayne.card_checkout' in body) = 0 then
      raise exception 'wayne_create_card_order: call to wayne_create_test_order not found';
    end if;
    execute body;
  end if;
end $$;
