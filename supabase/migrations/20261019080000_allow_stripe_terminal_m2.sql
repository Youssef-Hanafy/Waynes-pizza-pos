-- Stripe Terminal uses the same Stripe account as online checkout. The older
-- online-only rule incorrectly prohibited terminal_card_enabled for Stripe,
-- even after the M2 capability was introduced.

alter table public.location_payment_configurations
  drop constraint if exists location_payment_configurations_check;

alter table public.location_payment_configurations
  add constraint location_payment_configurations_check check (
    (not online_card_enabled and not terminal_card_enabled)
    or (provider = 'square' and btrim(application_id) <> '' and btrim(provider_location_id) <> '')
    or (provider = 'stripe' and online_card_enabled)
  );

-- Existing connected Stripe accounts inherit the provider catalog's Terminal
-- capability. The hardware setting remains the per-location on/off switch.
update public.payment_connections connection
set capabilities = coalesce(connection.capabilities, '{}'::jsonb)
  || jsonb_build_object('card_present', true, 'card_present_integrated', true),
    updated_at = now()
where connection.provider = 'stripe'
  and connection.status = 'connected';
