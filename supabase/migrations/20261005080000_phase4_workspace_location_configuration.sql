-- Hanafy Platform Phase 4: workspace and location configuration.
--
-- The historical Wayne's singleton settings remain as a compatibility mirror
-- for pre-platform RPCs.  The tables below are the source of truth for all
-- new configuration reads and writes.  No secret is stored in these records.

create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete restrict,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  legal_name text not null default '' check (char_length(legal_name) <= 240),
  description text not null default '' check (char_length(description) <= 8000),
  support_email text not null default '' check (char_length(support_email) <= 254),
  support_phone text not null default '' check (char_length(support_phone) <= 40),
  logo_path text,
  logo_alt text not null default '' check (char_length(logo_alt) <= 300),
  brand_colors jsonb not null default '{}'::jsonb check (jsonb_typeof(brand_colors) = 'object'),
  social_links jsonb not null default '{}'::jsonb check (jsonb_typeof(social_links) = 'object'),
  feature_defaults jsonb not null default '{}'::jsonb check (jsonb_typeof(feature_defaults) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.location_settings (
  location_id uuid primary key references public.locations(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object'),
  receipt_header text not null default '' check (char_length(receipt_header) <= 500),
  receipt_footer text not null default '' check (char_length(receipt_footer) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, location_id)
);

create table public.workspace_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete restrict,
  hostname text not null check (hostname = lower(hostname) and hostname ~ '^[a-z0-9.-]+$'),
  is_canonical boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hostname),
  unique (workspace_id, location_id, hostname)
);
create unique index workspace_domains_one_canonical_idx on public.workspace_domains (workspace_id, location_id) where is_canonical;

create table public.workspace_messaging_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  channel text not null check (channel in ('sms', 'email')),
  sender_name text not null default '' check (char_length(sender_name) <= 120),
  sender_address text not null default '' check (char_length(sender_address) <= 254),
  provider text not null default 'none' check (char_length(provider) <= 80),
  provider_configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_configuration) = 'object'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, channel)
);

create table public.location_payment_configurations (
  location_id uuid primary key references public.locations(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  provider text not null default 'none' check (provider in ('none', 'square')),
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  application_id text not null default '',
  provider_location_id text not null default '',
  notification_url text not null default '',
  online_card_enabled boolean not null default false,
  terminal_card_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, location_id),
  check ((not online_card_enabled and not terminal_card_enabled) or (provider <> 'none' and btrim(application_id) <> '' and btrim(provider_location_id) <> ''))
);

create table public.location_hardware_configurations (
  location_id uuid primary key references public.locations(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, location_id)
);

create table public.location_caller_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete restrict,
  line_number smallint not null check (line_number between 1 and 32),
  label text not null default '' check (char_length(label) <= 120),
  phone_number text not null default '' check (char_length(phone_number) <= 40),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, line_number)
);

create index workspace_settings_display_name_idx on public.workspace_settings(display_name);
create index location_settings_workspace_id_idx on public.location_settings(workspace_id);
create index workspace_domains_workspace_location_idx on public.workspace_domains(workspace_id, location_id);
create index location_caller_lines_workspace_location_idx on public.location_caller_lines(workspace_id, location_id, line_number);

create trigger workspace_settings_set_updated_at before update on public.workspace_settings for each row execute function public.set_updated_at();
create trigger location_settings_set_updated_at before update on public.location_settings for each row execute function public.set_updated_at();
create trigger workspace_domains_set_updated_at before update on public.workspace_domains for each row execute function public.set_updated_at();
create trigger workspace_messaging_identities_set_updated_at before update on public.workspace_messaging_identities for each row execute function public.set_updated_at();
create trigger location_payment_configurations_set_updated_at before update on public.location_payment_configurations for each row execute function public.set_updated_at();
create trigger location_hardware_configurations_set_updated_at before update on public.location_hardware_configurations for each row execute function public.set_updated_at();
create trigger location_caller_lines_set_updated_at before update on public.location_caller_lines for each row execute function public.set_updated_at();

-- Backfill exactly the operating Wayne's record. Future workspaces are not
-- provisioned here; their configuration must be created by the workspace flow.
insert into public.workspace_settings (
  workspace_id, display_name, description, support_email, support_phone, logo_path, logo_alt, social_links
)
select settings.workspace_id, settings.store_name, settings.story, settings.public_email, settings.public_phone,
  settings.logo_path, settings.logo_alt,
  jsonb_build_object('facebook_url', settings.facebook_url, 'instagram_url', settings.instagram_url, 'tiktok_url', settings.tiktok_url)
from public.store_settings settings
on conflict (workspace_id) do nothing;

insert into public.location_settings (location_id, workspace_id, configuration, receipt_header, receipt_footer)
select settings.location_id, settings.workspace_id,
  to_jsonb(settings) - array['id','workspace_id','location_id','created_at','updated_at']::text[],
  settings.store_name, 'Thank you!'
from public.store_settings settings
on conflict (location_id) do nothing;

insert into public.workspace_domains (workspace_id, location_id, hostname, is_canonical)
select settings.workspace_id, settings.location_id,
  lower(regexp_replace(regexp_replace(settings.canonical_url, '^https?://', ''), '/.*$', '')),
  true
from public.store_settings settings
where btrim(settings.canonical_url) <> ''
on conflict (hostname) do nothing;
insert into public.workspace_domains (workspace_id, location_id, hostname)
select settings.workspace_id, settings.location_id, 'localhost'
from public.store_settings settings
on conflict (hostname) do nothing;

insert into public.workspace_messaging_identities (workspace_id, channel, sender_name, sender_address, provider)
select workspace_id, 'sms', store_name, public_phone, 'aws' from public.store_settings
on conflict (workspace_id, channel) do nothing;
insert into public.workspace_messaging_identities (workspace_id, channel, sender_name, sender_address, provider)
select workspace_id, 'email', store_name, public_email, 'aws' from public.store_settings
on conflict (workspace_id, channel) do nothing;

insert into public.location_payment_configurations (
  location_id, workspace_id, provider, environment, application_id, provider_location_id, notification_url, online_card_enabled, terminal_card_enabled
)
select settings.location_id, settings.workspace_id, payment.provider, payment.environment, payment.application_id,
  payment.location_id, payment.notification_url, payment.online_card_enabled, payment.terminal_card_enabled
from public.payment_provider_settings payment
join public.store_settings settings on settings.workspace_id = payment.workspace_id
on conflict (location_id) do nothing;

insert into public.location_hardware_configurations (location_id, workspace_id, configuration)
select hardware.location_id, hardware.workspace_id,
  to_jsonb(hardware) - array['id','workspace_id','location_id','updated_by','created_at','updated_at']::text[]
from public.pos_hardware_settings hardware
on conflict (location_id) do nothing;

insert into public.location_caller_lines (workspace_id, location_id, line_number, label, phone_number, active)
select workspace_id, location_id, line_number, label, phone_number, active
from public.store_phone_lines
on conflict (location_id, line_number) do nothing;

-- The public storefront receives only public configuration. Hostname is an
-- explicit argument, making its cache key tenant-safe and preventing unknown
-- hosts from silently rendering Wayne's data.
create or replace function public.hanafy_public_store_settings(target_hostname text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with domain as (
    select workspace_id, location_id, hostname
    from public.workspace_domains
    where hostname = lower(regexp_replace(split_part(coalesce(target_hostname, ''), ':', 1), '\\.$', ''))
      and active
    limit 1
  )
  select location.configuration || jsonb_build_object(
    'id', true,
    'canonical_url', 'https://' || domain.hostname,
    'special_hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', hours.id, 'service_date', hours.service_date, 'label', hours.label,
        'closed', hours.closed, 'opens_at', case when hours.opens_at is null then null else to_char(hours.opens_at, 'HH24:MI') end,
        'closes_at', case when hours.closes_at is null then null else to_char(hours.closes_at, 'HH24:MI') end,
        'public_note', hours.public_note
      ) order by hours.service_date)
      from public.store_special_hours hours
      where hours.workspace_id = domain.workspace_id and hours.location_id = domain.location_id and hours.archived_at is null
    ), '[]'::jsonb)
  )
  from domain
  join public.location_settings location on location.location_id = domain.location_id and location.workspace_id = domain.workspace_id;
$$;

-- Admin writes update the new source of truth. Wayne's legacy singleton is
-- deliberately mirrored only for its existing scoped record, keeping old POS
-- procedures functional while new workspace code no longer depends on it.
create or replace function public.hanafy_save_location_settings(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_workspace_id uuid;
  selected_location_id uuid;
  saved public.location_settings%rowtype;
begin
  selected_workspace_id := (public.hanafy_current_workspace_access() ->> 'workspace_id')::uuid;
  if selected_workspace_id is null or not public.hanafy_has_workspace_permission(selected_workspace_id, 'content.manage') then
    raise exception 'Content management permission required' using errcode = '42501';
  end if;
  select id into selected_location_id from public.locations where workspace_id = selected_workspace_id and status = 'active' order by created_at limit 1;
  if selected_location_id is null then raise exception 'An active location is required' using errcode = 'P0002'; end if;
  update public.location_settings
    set configuration = configuration || (payload - 'receipt_header' - 'receipt_footer'),
        receipt_header = coalesce(payload ->> 'receipt_header', receipt_header),
        receipt_footer = coalesce(payload ->> 'receipt_footer', receipt_footer)
    where workspace_id = selected_workspace_id and location_id = selected_location_id
    returning * into saved;
  if not found then raise exception 'Location settings not found' using errcode = 'P0002'; end if;
  update public.store_settings set
    store_name = coalesce(saved.configuration ->> 'store_name', store_name),
    owner_name = coalesce(saved.configuration ->> 'owner_name', owner_name),
    story = coalesce(saved.configuration ->> 'story', story), owner_story = coalesce(saved.configuration ->> 'owner_story', owner_story),
    address_line1 = coalesce(saved.configuration ->> 'address_line1', address_line1), address_line2 = coalesce(saved.configuration ->> 'address_line2', address_line2),
    city = coalesce(saved.configuration ->> 'city', city), state = coalesce(saved.configuration ->> 'state', state), postal_code = coalesce(saved.configuration ->> 'postal_code', postal_code),
    public_phone = coalesce(saved.configuration ->> 'public_phone', public_phone), public_email = coalesce(saved.configuration ->> 'public_email', public_email), timezone = coalesce(saved.configuration ->> 'timezone', timezone),
    business_hours = coalesce(saved.configuration -> 'business_hours', business_hours), ordering_open = coalesce((saved.configuration ->> 'ordering_open')::boolean, ordering_open),
    pickup_enabled = coalesce((saved.configuration ->> 'pickup_enabled')::boolean, pickup_enabled), delivery_enabled = coalesce((saved.configuration ->> 'delivery_enabled')::boolean, delivery_enabled),
    pickup_minimum_cents = coalesce((saved.configuration ->> 'pickup_minimum_cents')::integer, pickup_minimum_cents), delivery_minimum_cents = coalesce((saved.configuration ->> 'delivery_minimum_cents')::integer, delivery_minimum_cents), delivery_fee_cents = coalesce((saved.configuration ->> 'delivery_fee_cents')::integer, delivery_fee_cents), tax_rate_basis_points = coalesce((saved.configuration ->> 'tax_rate_basis_points')::integer, tax_rate_basis_points),
    tips_enabled = coalesce((saved.configuration ->> 'tips_enabled')::boolean, tips_enabled), suggested_tip_percentages = coalesce(array(select jsonb_array_elements_text(saved.configuration -> 'suggested_tip_percentages')::integer), suggested_tip_percentages),
    pickup_prep_minutes = coalesce((saved.configuration ->> 'pickup_prep_minutes')::integer, pickup_prep_minutes), delivery_estimate_minutes = coalesce((saved.configuration ->> 'delivery_estimate_minutes')::integer, delivery_estimate_minutes),
    delivery_area_text = coalesce(saved.configuration ->> 'delivery_area_text', delivery_area_text), delivery_postal_codes = coalesce(array(select jsonb_array_elements_text(saved.configuration -> 'delivery_postal_codes')), delivery_postal_codes),
    test_ordering_enabled = coalesce((saved.configuration ->> 'test_ordering_enabled')::boolean, test_ordering_enabled), service_area_text = coalesce(saved.configuration ->> 'service_area_text', service_area_text),
    canonical_url = coalesce(saved.configuration ->> 'canonical_url', canonical_url), facebook_url = coalesce(saved.configuration ->> 'facebook_url', facebook_url), instagram_url = coalesce(saved.configuration ->> 'instagram_url', instagram_url), tiktok_url = coalesce(saved.configuration ->> 'tiktok_url', tiktok_url), logo_path = coalesce(saved.configuration ->> 'logo_path', logo_path), logo_alt = coalesce(saved.configuration ->> 'logo_alt', logo_alt),
    announcement_text = coalesce(saved.configuration ->> 'announcement_text', announcement_text), homepage_eyebrow = coalesce(saved.configuration ->> 'homepage_eyebrow', homepage_eyebrow), homepage_heading = coalesce(saved.configuration ->> 'homepage_heading', homepage_heading), homepage_description = coalesce(saved.configuration ->> 'homepage_description', homepage_description), pickup_heading = coalesce(saved.configuration ->> 'pickup_heading', pickup_heading), pickup_description = coalesce(saved.configuration ->> 'pickup_description', pickup_description), delivery_heading = coalesce(saved.configuration ->> 'delivery_heading', delivery_heading), delivery_description = coalesce(saved.configuration ->> 'delivery_description', delivery_description), about_heading = coalesce(saved.configuration ->> 'about_heading', about_heading), contact_heading = coalesce(saved.configuration ->> 'contact_heading', contact_heading), ordering_instructions = coalesce(saved.configuration ->> 'ordering_instructions', ordering_instructions), general_notice = coalesce(saved.configuration ->> 'general_notice', general_notice), footer_text = coalesce(saved.configuration ->> 'footer_text', footer_text), seo_home_title = coalesce(saved.configuration ->> 'seo_home_title', seo_home_title), seo_home_description = coalesce(saved.configuration ->> 'seo_home_description', seo_home_description), seo_menu_title = coalesce(saved.configuration ->> 'seo_menu_title', seo_menu_title), seo_menu_description = coalesce(saved.configuration ->> 'seo_menu_description', seo_menu_description), seo_about_title = coalesce(saved.configuration ->> 'seo_about_title', seo_about_description), seo_about_description = coalesce(saved.configuration ->> 'seo_about_description', seo_about_description), seo_contact_title = coalesce(saved.configuration ->> 'seo_contact_title', seo_contact_title), seo_contact_description = coalesce(saved.configuration ->> 'seo_contact_description', seo_contact_description), faq_items = coalesce(saved.configuration -> 'faq_items', faq_items)
  where workspace_id = selected_workspace_id and location_id = selected_location_id;
  update public.workspace_settings set display_name = coalesce(saved.configuration ->> 'store_name', display_name), description = coalesce(saved.configuration ->> 'story', description), support_email = coalesce(saved.configuration ->> 'public_email', support_email), support_phone = coalesce(saved.configuration ->> 'public_phone', support_phone), logo_path = coalesce(saved.configuration ->> 'logo_path', logo_path), logo_alt = coalesce(saved.configuration ->> 'logo_alt', logo_alt) where workspace_id = selected_workspace_id;
  return saved.configuration || jsonb_build_object('receipt_header', saved.receipt_header, 'receipt_footer', saved.receipt_footer);
end;
$$;

create or replace function public.hanafy_save_location_hardware_configuration(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare selected_workspace_id uuid; selected_location_id uuid; saved jsonb;
begin
  selected_workspace_id := (public.hanafy_current_workspace_access() ->> 'workspace_id')::uuid;
  if selected_workspace_id is null or not public.hanafy_has_workspace_permission(selected_workspace_id, 'hardware.manage') then raise exception 'Hardware management permission required' using errcode = '42501'; end if;
  select id into selected_location_id from public.locations where workspace_id = selected_workspace_id and status = 'active' order by created_at limit 1;
  update public.location_hardware_configurations set configuration = configuration || payload where workspace_id = selected_workspace_id and location_id = selected_location_id returning configuration || jsonb_build_object('updated_at', updated_at) into saved;
  if not found then raise exception 'Hardware configuration not found' using errcode = 'P0002'; end if;
  if payload ? 'caller_line_count' then
    insert into public.location_caller_lines (workspace_id, location_id, line_number, label)
    select selected_workspace_id, selected_location_id, line_number, 'Line ' || line_number from generate_series(1, (payload ->> 'caller_line_count')::integer) line_number
    on conflict (location_id, line_number) do nothing;
    update public.location_caller_lines set active = line_number <= (payload ->> 'caller_line_count')::integer where workspace_id = selected_workspace_id and location_id = selected_location_id;
  end if;
  return saved;
end;
$$;

create or replace function public.hanafy_save_location_payment_configuration(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare selected_workspace_id uuid; selected_location_id uuid; saved public.location_payment_configurations%rowtype;
begin
  selected_workspace_id := (public.hanafy_current_workspace_access() ->> 'workspace_id')::uuid;
  if selected_workspace_id is null or not public.hanafy_has_workspace_permission(selected_workspace_id, 'payments.manage') then raise exception 'Payment management permission required' using errcode = '42501'; end if;
  select id into selected_location_id from public.locations where workspace_id = selected_workspace_id and status = 'active' order by created_at limit 1;
  update public.location_payment_configurations set provider = coalesce(nullif(btrim(payload ->> 'provider'), ''), provider), environment = coalesce(nullif(btrim(payload ->> 'environment'), ''), environment), application_id = btrim(coalesce(payload ->> 'application_id', application_id)), provider_location_id = btrim(coalesce(payload ->> 'location_id', provider_location_id)), notification_url = btrim(coalesce(payload ->> 'notification_url', notification_url)), online_card_enabled = coalesce((payload ->> 'online_card_enabled')::boolean, online_card_enabled), terminal_card_enabled = coalesce((payload ->> 'terminal_card_enabled')::boolean, terminal_card_enabled) where workspace_id = selected_workspace_id and location_id = selected_location_id returning * into saved;
  if not found then raise exception 'Payment configuration not found' using errcode = 'P0002'; end if;
  return to_jsonb(saved) || jsonb_build_object('location_id', saved.provider_location_id);
end;
$$;

alter table public.workspace_settings enable row level security;
alter table public.location_settings enable row level security;
alter table public.workspace_domains enable row level security;
alter table public.workspace_messaging_identities enable row level security;
alter table public.location_payment_configurations enable row level security;
alter table public.location_hardware_configurations enable row level security;
alter table public.location_caller_lines enable row level security;

create policy workspace_settings_member_read on public.workspace_settings for select to authenticated using (public.hanafy_is_workspace_member(workspace_id) or public.hanafy_has_platform_access());
create policy workspace_settings_manager_write on public.workspace_settings for all to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'settings.manage')) with check (public.hanafy_has_workspace_permission(workspace_id, 'settings.manage'));
create policy location_settings_member_read on public.location_settings for select to authenticated using (public.hanafy_is_workspace_member(workspace_id) or public.hanafy_has_platform_access());
create policy location_settings_manager_write on public.location_settings for all to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'settings.manage') or public.hanafy_has_workspace_permission(workspace_id, 'content.manage')) with check (public.hanafy_has_workspace_permission(workspace_id, 'settings.manage') or public.hanafy_has_workspace_permission(workspace_id, 'content.manage'));
create policy workspace_domains_member_read on public.workspace_domains for select to authenticated using (public.hanafy_is_workspace_member(workspace_id) or public.hanafy_has_platform_access());
create policy workspace_domains_manager_write on public.workspace_domains for all to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'settings.manage')) with check (public.hanafy_has_workspace_permission(workspace_id, 'settings.manage'));
create policy workspace_messaging_member_read on public.workspace_messaging_identities for select to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'integrations.manage') or public.hanafy_has_platform_access());
create policy workspace_messaging_manager_write on public.workspace_messaging_identities for all to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'integrations.manage')) with check (public.hanafy_has_workspace_permission(workspace_id, 'integrations.manage'));
create policy location_payment_member_read on public.location_payment_configurations for select to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'payments.manage') or public.hanafy_has_workspace_permission(workspace_id, 'pos.access') or public.hanafy_has_platform_access());
create policy location_payment_manager_write on public.location_payment_configurations for all to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'payments.manage')) with check (public.hanafy_has_workspace_permission(workspace_id, 'payments.manage'));
create policy location_hardware_member_read on public.location_hardware_configurations for select to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'hardware.manage') or public.hanafy_has_workspace_permission(workspace_id, 'pos.access') or public.hanafy_has_platform_access());
create policy location_hardware_manager_write on public.location_hardware_configurations for all to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'hardware.manage')) with check (public.hanafy_has_workspace_permission(workspace_id, 'hardware.manage'));
create policy location_caller_lines_member_read on public.location_caller_lines for select to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'hardware.manage') or public.hanafy_has_workspace_permission(workspace_id, 'pos.access') or public.hanafy_has_platform_access());
create policy location_caller_lines_manager_write on public.location_caller_lines for all to authenticated using (public.hanafy_has_workspace_permission(workspace_id, 'hardware.manage')) with check (public.hanafy_has_workspace_permission(workspace_id, 'hardware.manage'));

revoke all on function public.hanafy_public_store_settings(text), public.hanafy_save_location_settings(jsonb), public.hanafy_save_location_hardware_configuration(jsonb), public.hanafy_save_location_payment_configuration(jsonb) from public;
grant execute on function public.hanafy_public_store_settings(text) to anon, authenticated;
grant execute on function public.hanafy_save_location_settings(jsonb) to authenticated;
grant execute on function public.hanafy_save_location_hardware_configuration(jsonb), public.hanafy_save_location_payment_configuration(jsonb) to authenticated;

comment on table public.workspace_settings is 'Phase 4 workspace-wide business, branding, support, social, and feature-default configuration.';
comment on table public.location_settings is 'Phase 4 location-specific public, hours, ordering, tax, delivery, and receipt configuration.';
comment on table public.workspace_domains is 'Phase 4 explicit hostname-to-workspace/location mapping; unknown domains deliberately resolve to no tenant.';
