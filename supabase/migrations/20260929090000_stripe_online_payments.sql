-- Stripe is used for the online storefront. Existing Square payment history and
-- settings remain valid, while Stripe needs no database-stored secret or location.
alter table public.payment_provider_settings
  drop constraint if exists payment_provider_settings_provider_check;
alter table public.payment_provider_settings
  add constraint payment_provider_settings_provider_check
  check (provider in ('none', 'square', 'stripe'));

alter table public.payment_provider_settings
  drop constraint if exists payment_provider_settings_ready;
alter table public.payment_provider_settings
  add constraint payment_provider_settings_ready check (
    (not online_card_enabled and not terminal_card_enabled)
    or (provider = 'square' and char_length(btrim(application_id)) > 0 and char_length(btrim(location_id)) > 0)
    or (provider = 'stripe' and online_card_enabled and not terminal_card_enabled)
  );
