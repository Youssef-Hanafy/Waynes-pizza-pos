# Phase 1 Completion Report — Public Site + Menu Admin

**Implementation:** complete. **Formal acceptance:** pending an isolated-staging owner walkthrough.

## What was built

- Responsive order-first public site (`/`, `/menu`, `/about`, `/contact`) with configured store identity, hours, SEO metadata, sitemap, and robots support.
- Owner/manager category, item, variant, modifier, availability, visibility, sold-out, image, and archive administration.
- Public menu projections that hide archived records while preserving source records needed by historical orders.

## Files and database changes

- Application modules: `src/app/{page,menu,about,contact,admin/menu,admin/settings}`, `src/lib/{content,menu}`, and `src/components/site`.
- Migration `20260908010000_phase1_public_menu.sql` adds settings/special-hours, menu, variant, modifier, storage, RLS, and archive-safe menu writes.
- `supabase/fixtures/phase0-5-staging-vertical-slice.sql` provides a non-production item with variants/modifiers for acceptance testing only.

## Environment/setup and verification

Normal Supabase application variables remain required; no Phase 1 browser secret was added. The owner must enter approved prices, photos/alt text, availability, and customer/POS visibility in `/admin/menu`; never use the staging fixture as a production catalog.

Latest repository verification (September 9, 2026): `npm run verify` passed (lint, typecheck, 24 test files / 142 tests, and production build). `npm run test` covers menu validation, availability, public projection, and migration integrity. The local pgTAP companion is `supabase/tests/002_phase1_menu_rls.test.sql`; it awaits a running local Supabase/Docker stack.

## Exact manual acceptance

1. In isolated staging, create an approved category and item with a variant, modifier group, and image.
2. Confirm it renders correctly on phone, tablet, and desktop at `/menu`.
3. Confirm sold-out remains visible but unorderable; archive it and confirm it disappears without deleting source records.

## Acceptance checklist

- [x] Editable menu, images, modifiers, sold-out state, availability, RLS, and historical-safe archive pattern are implemented.
- [ ] Owner staging acceptance is recorded; no live catalog was invented by development.
