# Wayne's dinner pricing: review handoff

Development branch: `codex/menu-pricing-fix`. Base fetched and verified against
`origin/main`: `4ccaac0ec388ada16e6e505598d798bb51306983`.
No production database mutation, merge, staging deployment, or production deployment
was performed. Claude's branch and the shared checkout were not modified.

## Exact production records

These identifiers and configurations were supplied by the owner from read-only
production SQL results on 2026-10-31.

| Item | `menu_items.id` | Current `base_price_cents` | Approved target |
|---|---|---:|---:|
| Cheeseburger Dinner | `418c30cc-344c-4200-917d-0d60c183c77c` | 1350 | 1425 |
| Gyro Dinner | `5677ccf0-ba1d-41a1-8382-473233f61ea9` | 1350 | 1425 |

Both belong to workspace `40000000-0000-4000-8000-000000000001`, category
`3fcd712d-f81a-45cf-9251-228af6584bdc` (Dinners). Both are active, customer-visible,
POS-visible regular products, not specials. Neither has any size variants or
modifier size-price overrides. Their applicable price is the base item price.
Their last supplied update timestamp was `2026-10-20 02:15:30.352691+00`.

## Root cause and reproduction

Both have an active, optional Meats modifier group with **zero active choices**:

- Cheeseburger Dinner – Meats: `028f15b6-98a7-4040-bba5-2ab4a8775d8d`.
- Dinners – Meats on Gyro Dinner: `eadd6705-4823-438e-b682-4b94c79e8c73`.

Their minimum is zero, maximum twelve, and `required=false`. The editor loads
only active, unarchived choices. `modifierGroupSchema` nevertheless required
`choices.min(1)` for every group. Every full-item submission validates modifiers,
including a submission changing only `base_price`. These exact configurations
therefore fail at `modifier_groups.2.choices` before the database RPC is called.
The old action redirects away with the generic array-validation error.

Normalized production configuration fixtures reproduce both failures. The
pre-fix test run had two failures: `Too small: expected array to have >=1 items`.
The same regressions pass after allowing empty **optional** groups. Empty groups
that require any selection still fail validation. No removed meat options are
recreated and no production modifier records need repair.

A second reproduced bug allowed stale full-editor submissions to restore a prior
price. The original database function locks the item but never checks which
version was edited. Its baseline test demonstrates an old 1350-cent payload
succeeding after a 1425-cent save. Revision checking rejects that stale save.

The supplied production save-function definitions match the repository's
archive-and-recreate child-definition approach. The supplied RLS policies require
workspace-scoped `menu.manage`. The observed empty-group failure occurs before
those policies or database functions are reached; permissions are not relaxed.
No scheduled menu synchronization was found in the repository. A manually rerun
legacy full import could restore source pricing; that path now refuses an
existing active menu before its first write.

## Implementation

- `src/lib/menu/schemas.ts`: accept empty optional groups; retain required-group
  checks; reject duplicate normalized size names and unsafe currency integers.
  All prices continue to use integer cents.
- `menu-item-form.tsx`: show the applicable price field, explain full size prices,
  show empty optional groups, pending state and inline save errors. Clear prior success notices when a new edit starts. Prevent React
  action completion from resetting an unsuccessful uncontrolled form. Add a
  price-only submit mode using the same base/size fields.
- `actions.ts`: return validation/write failures to the current form, require
  database acknowledgement before success, handle uncertain network outcomes,
  submit the loaded revision, and invalidate admin, POS and online-menu paths.
  Price-only saves validate cents and identify sizes by their existing UUIDs.
- The item editor reads variant IDs and the revision. Failed child queries now
  stop editor loading instead of substituting empty definitions into a save.
- `20261123080000_menu_price_editing.sql`: add `menu_revision`; bump it on item and
  linked size/modifier/included-choice/size-rule changes, including shared groups.
  Wrap the existing full editor RPC with row locking, revision, tenant/category,
  and duplicate-size checks. Revoke direct client access to the renamed internal
  function. Add `wayne_set_menu_prices` to update canonical base/variant prices
  atomically without archiving or recreating children. Require workspace-scoped
  `menu.manage`, active regular items, valid cents and an exact active-size set.
  Preserve existing immutable price audit triggers; omit internal revision churn
  from their diffs. No order or payment table is modified.
- `scripts/correct-dinner-prices.sql`: a **separate, unapplied** transaction for
  the approved 1425-cent correction. It verifies the exact supplied UUIDs,
  workspace/category, absence of duplicate regular items and size overrides,
  and an existing price of 1350 or 1425. It aborts the whole transaction on an
  unexpected record or price. It is repeatable and never creates items.
- The legacy seed, full-import JSON and its PSV source now agree on the approved
  target. `load-menu-full.mjs` refuses any active menu before destructive writes.
- Tests include normalized production fixtures, production Server Action tests,
  actual PostgreSQL tests, and a separate Next.js/Chromium application importing
  the real editor, action, POS dialog and online menu/customizer. Existing test
  helper changes allow an explicit baseline migration omission and safe release
  of browser-transport database clients. The older audit regression still
  requires its actor/price transition while tolerating internal revision metadata
  when it deliberately reapplies the historical audit migration.

## Validation and boundaries

Saved command output is in `docs/menu-pricing-validation/`.

| Check | Result |
|---|---|
| Production-shaped schema regressions before fix | 2 failed, 1 passed; exact empty-choice validation failure |
| Original database stale-save baseline | 1 failed as expected: stale update succeeded |
| Full `npm test` | 134 files, 885 tests passed |
| New isolated Chromium menu-pricing flow | 3 tests passed |
| Typecheck, ESLint, production build | Passed; final outputs saved alongside this report |
| `npm run test:db` | Unavailable: local Supabase Docker database at 127.0.0.1:54322 is not running |
| Existing staging E2E command | 3 skipped; 3 failed environment prerequisites before navigation; no staging session or coordinated access supplied |

Each dinner's browser test edits to $14.25 through the **actual full admin
Server Action**, reloads the editor, exercises price-only saving, adds through
the real POS item dialog, calls `wayne_create_pos_order`, and verifies the saved
order-line unit price is 1425. It then checks the real online menu and customizer
show $14.25 and adds to the online cart. The third browser test injects a database
write failure, proves no success notice and retention of the typed draft, then
proves another open register cannot restore $13.50.

Database tests separately create POS and online orders before and after editing,
check old order lines retain 1350 and new lines have 1425, exercise owner/cashier
and cross-workspace permission boundaries, concurrent connections, invalid cents,
size identity/duplicate handling, shared modifier/override/allowance preservation,
audit records, other editable items and the guarded correction script.

The browser harness substitutes sign-in/PIN and the Supabase transport only;
SQL runs against fresh PostgreSQL with all migrations. Its README states the
boundaries. It does not certify Supabase Auth sessions, Vercel hosting/domain
routing, live staff requests, Elo hardware, card-reader/payment checkout, or
shared staging. POS/public menu RPCs read the same canonical pricing, and existing
order creation resolves it from the database. The existing register runtime
refreshes while idle (normally every three minutes); a reload/reopen fetches
fresh menu data. Already loaded offline registers cannot receive a remote edit
until they reconnect and fetch it.

## Independent review and release sequence

1. Review the schema fix, revision triggers/RPC grants, exact production snapshot,
   and the baseline evidence. Run `npm test`, `npm run lint`, `npm run typecheck`,
   `npm run build`, and `npm run test:menu-pricing:e2e` in this branch.
2. Arrange isolated staging access with Claude before applying anything there.
   Apply the new migration to that isolated database and test the candidate app
   with real staff sessions and the shared checkout/domain paths. Run pgTAP after
   starting the isolated Supabase stack. Do not repoint or reset Claude's database.
3. Review and separately approve production deployment and the guarded correction
   SQL. This handoff grants neither. The schema migration does not change dinner
   prices; the correction script does. Older editor clients without a revision
   are explicitly rejected until the new application is deployed and reloaded.
4. After approval, apply the schema migration before the candidate application,
   run the separately approved correction transaction, reload an idle register,
   and verify both exact IDs in POS/online ordering. Preserve placed orders; use
   isolated test orders for operational acceptance. Recheck latest main before
   integrating. Do not rerun menu import scripts.

There has been no live price update: production remains at the owner-supplied
1350-cent state unless another authorized operator changes it independently.
