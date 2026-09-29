-- Wayne's Pizza: live Stripe online checkout.
--
-- Stripe's secrets remain in Vercel only.  This migration stores no API keys:
-- it names env:STRIPE and creates a Wayne's-specific, online-only connection.

alter table public.location_payment_configurations
  drop constraint if exists location_payment_configurations_provider_check;
alter table public.location_payment_configurations
  add constraint location_payment_configurations_provider_check
  check (provider in ('none', 'square', 'stripe'));

alter table public.location_payment_configurations
  drop constraint if exists location_payment_configurations_check;
alter table public.location_payment_configurations
  add constraint location_payment_configurations_check check (
    (not online_card_enabled and not terminal_card_enabled)
    or (provider = 'square' and btrim(application_id) <> '' and btrim(provider_location_id) <> '')
    or (provider = 'stripe' and online_card_enabled and not terminal_card_enabled)
  );

insert into public.payment_provider_catalog (code, name, availability, connection_modes, capabilities, description) values
  ('stripe', 'Stripe', 'available', array['api'],
   '{"online_card": true, "card_present": false, "card_present_integrated": false, "manual_confirmation": false, "refunds_via_api": true, "voids_via_api": true, "webhooks": true}'::jsonb,
   'Stripe Payment Intents for secure online card checkout. Stripe Terminal is intentionally not configured here.')
on conflict (code) do update set
  name = excluded.name,
  availability = excluded.availability,
  connection_modes = excluded.connection_modes,
  capabilities = excluded.capabilities,
  description = excluded.description,
  updated_at = now();

-- Keep the legacy business payment screen and the current connection registry
-- in sync.  Stripe is online-only; a manual counter terminal, if present,
-- remains separate and is never changed by this trigger.
create or replace function public.hanafy_sync_square_connection_from_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare existing uuid;
begin
  if new.provider = 'stripe' then
    select connection.id into existing
    from public.payment_connections connection
    where connection.workspace_id = new.workspace_id
      and connection.location_id = new.location_id
      and connection.provider = 'stripe'
      and connection.status <> 'disabled';

    update public.payment_connections set status = 'disabled'
    where workspace_id = new.workspace_id
      and location_id = new.location_id
      and purpose in ('online', 'counter_and_online')
      and status <> 'disabled'
      and (provider <> 'stripe' or coalesce(existing, '00000000-0000-0000-0000-000000000000'::uuid) <> id);

    if existing is null then
      insert into public.payment_connections (
        workspace_id, location_id, purpose, provider, connection_mode, status,
        environment, public_configuration, secret_reference
      ) values (
        new.workspace_id, new.location_id, 'online', 'stripe', 'api', 'pending_verification',
        new.environment,
        jsonb_build_object('online_card_enabled', new.online_card_enabled, 'terminal_card_enabled', false),
        'env:STRIPE'
      );
    else
      update public.payment_connections set
        environment = new.environment,
        public_configuration = jsonb_build_object('online_card_enabled', new.online_card_enabled, 'terminal_card_enabled', false),
        secret_reference = 'env:STRIPE'
      where id = existing;
    end if;
    return new;
  end if;

  -- Square keeps the Phase 9 behavior for historical Square installations.
  select connection.id into existing from public.payment_connections connection
  where connection.workspace_id = new.workspace_id and connection.location_id = new.location_id and connection.provider = 'square' and connection.status <> 'disabled';
  if new.provider = 'square' then
    if existing is null then
      update public.payment_connections set status = 'disabled'
      where workspace_id = new.workspace_id and location_id = new.location_id and purpose in ('counter_and_online', 'online') and status <> 'disabled';
      insert into public.payment_connections (workspace_id, location_id, purpose, provider, connection_mode, status, merchant_reference, environment, public_configuration, secret_reference)
      values (new.workspace_id, new.location_id,
        case when exists (select 1 from public.payment_connections counter where counter.workspace_id = new.workspace_id and counter.location_id = new.location_id
          and counter.purpose = 'counter' and counter.status <> 'disabled') then 'online' else 'counter_and_online' end,
        'square', 'api', 'pending_verification', nullif(new.provider_location_id, ''), new.environment,
        jsonb_build_object('application_id', new.application_id, 'provider_location_id', new.provider_location_id, 'notification_url', new.notification_url,
          'online_card_enabled', new.online_card_enabled, 'terminal_card_enabled', new.terminal_card_enabled), 'env:SQUARE');
    else
      update public.payment_connections set merchant_reference = nullif(new.provider_location_id, ''), environment = new.environment,
        public_configuration = jsonb_build_object('application_id', new.application_id, 'provider_location_id', new.provider_location_id,
          'notification_url', new.notification_url, 'online_card_enabled', new.online_card_enabled, 'terminal_card_enabled', new.terminal_card_enabled)
      where id = existing;
    end if;
  elsif existing is not null then
    update public.payment_connections set status = 'disabled' where id = existing;
  end if;
  return new;
end;
$$;

-- Switch only Wayne's active location to live, online Stripe checkout.  No
-- counter/terminal capability is enabled, and no secrets are persisted.
update public.location_payment_configurations configuration
set provider = 'stripe',
    environment = 'production',
    application_id = '',
    provider_location_id = '',
    notification_url = 'https://waynes-pizza-pos.vercel.app/api/webhooks/stripe',
    online_card_enabled = true,
    terminal_card_enabled = false
from public.workspaces workspace
where workspace.id = configuration.workspace_id
  and workspace.slug = 'waynes-pizza';
