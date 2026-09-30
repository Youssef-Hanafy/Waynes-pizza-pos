-- Stripe Reader M2 at the counter (owner, 2026-09-30).
--
-- The M2 is a Bluetooth reader driven by Stripe's Terminal SDK inside the POS
-- Android app, on the same Stripe account (env:STRIPE) the store already uses
-- for online checkout.  It is switched on per location in Admin -> Hardware
-- (location_hardware_configurations.configuration ->> 'payment_terminal_mode'
-- = 'integrated'), so no new table or column is needed.  This migration only
-- records in the provider catalog that Stripe can now take card-present
-- payments, so Platform Admin describes it correctly.

update public.payment_provider_catalog
set capabilities = capabilities || '{"card_present": true, "card_present_integrated": true}'::jsonb,
    description = 'Stripe Payment Intents for online checkout and keyed phone cards, and Stripe Terminal (Stripe Reader M2 over Bluetooth, through the POS Android app) at the counter. Needs the business''s own Stripe account.',
    updated_at = now()
where code = 'stripe';

comment on column public.location_hardware_configurations.configuration is
  'Register hardware for the location (caller ID, printers, cash drawer, payment_terminal_mode: manual_external = separate terminal run by hand, integrated = Stripe Reader M2 through the POS Android app).';
