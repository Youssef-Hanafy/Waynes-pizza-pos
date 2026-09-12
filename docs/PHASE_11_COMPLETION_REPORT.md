# Phase 11 — Live payment processor infrastructure (completion report, 2026-09-12)

Phase 11 was started early, before Wayne's has a merchant account or a card reader, on the
understanding that the infrastructure is built now and the credentials and hardware are
plugged in later. Everything below is real code against Square's documented API — nothing is
faked or stubbed — and all of it stays completely inert until an owner enters credentials and
switches card payment on.

## What was built

**The whole payment path, switched off.** With no provider configured, the storefront and the
POS look exactly as they do today, the database refuses to open a card payment at all, and no
order can reach a paid state. One screen turns it on.

- **Provider abstraction** (build sheet §20) — `createOnlinePayment`, `createCardPresentPayment`,
  `capturePayment`, `voidPayment`, `refundPayment`, `getPaymentStatus`, `handleWebhook`, plus
  reader polling and cancellation. Nothing outside `src/lib/payments/square.ts` knows Square
  exists; a second processor is a second file.
- **Square adapter** — plain `fetch` against the REST API (Square-Version `2026-08-19`), no SDK
  dependency. Decline codes are translated into sentences a customer or cashier can act on;
  anything unrecognised is never shown to a customer.
- **Online card checkout** — the customer's card is entered in Square's own hosted field, so a
  card number never touches this application. The order is written as `payment_pending`, which
  produces **no kitchen ticket and no print job**, the card is charged, and only a captured
  payment releases the order to the kitchen and marks it paid. A decline cancels the order and
  gives back any promotion use.
- **Counter card-present** — register a reader in Admin → Payments, then Open orders on the POS
  gets a "Take card payment" button that pushes the total to the reader, waits while the
  customer taps, and closes the ticket when the reader answers.
- **Refunds and voids** — on the admin order page, with a required reason, partial-refund
  support, a running refundable balance, and an entry in the immutable audit log.
- **Webhooks and reconciliation** — `/api/webhooks/square` verifies Square's HMAC signature
  against the exact registered notification URL, stores every event once by its provider event
  id, and applies it. Duplicate deliveries change nothing. A reconciliation screen lists every
  place the money and the orders disagree.
- **Failure safety** (§20) — browser closed mid-payment, webhook arriving before or after the
  browser, duplicate webhooks, reader offline, network failure with no answer, refund retries:
  each has a defined resting state, and none of them can produce a false "paid".

## Files created / changed

Created: `supabase/migrations/20260916080000_phase11_payment_processor.sql`,
`supabase/tests/009_phase11_payment_processor.test.sql`,
`src/lib/payments/{schemas,config,queries,square,square-mapping}.ts` (+ two test files),
`src/app/api/payments/card/route.ts`, `src/app/api/pos/terminal/route.ts`,
`src/app/api/webhooks/square/route.ts`, `src/app/admin/payments/{page.tsx,actions.ts}`,
`src/components/payments/square-card-field.tsx`.

Changed: `src/lib/payments/provider.ts` (the full interface), `src/lib/auth/permissions.ts`,
`src/app/admin/layout.tsx`, `src/app/checkout/{page.tsx,checkout-client.tsx}`,
`src/app/pos/open-orders-panel.tsx`, `src/app/admin/orders/[id]/{page.tsx,actions.ts}`,
`.env.example`.

## Database migration

`20260916080000_phase11_payment_processor.sql`, applied to the hosted project
`vxpkdmtornkeoedkawkt` on 2026-09-12. Idempotent and safe to re-run. It changes nothing a
customer or staff member can see until the switches are turned on.

- Permission `payments.manage` (owner, manager only).
- `payment_provider_settings` (singleton, non-secret only), `payment_terminals`,
  `payment_webhook_events`, all with RLS; the webhook ledger is server-only by design.
- `payments` gains `idempotency_key`, `provider_status`, `terminal_checkout_id`, `terminal_id`,
  `receipt_url`, `card_brand`, `card_last4`, `failure_reason`, and a `pending` status; `refunds`
  gains `status`, `provider_status`, `idempotency_key`.
- A bug in the original ledger was fixed on the way: the `(provider, provider_payment_id)`
  constraint was `NULLS NOT DISTINCT`, so two payments still waiting for an answer counted as
  duplicates of each other. It is now a normal unique constraint.
- RPCs: `wayne_payment_checkout_config`, `wayne_admin_payment_console`,
  `wayne_save_payment_settings`, `wayne_save_payment_terminal`, `wayne_create_card_order`,
  `wayne_begin_payment`, `wayne_settle_payment`, `wayne_record_payment_webhook`,
  `wayne_finish_payment_webhook`, `wayne_begin_refund`, `wayne_settle_refund`,
  `wayne_expire_stale_card_orders`, `wayne_payment_reconciliation`.
- A pg_cron job sweeps abandoned card checkouts every five minutes.

## Environment variables

Two, both server-only, both optional — without them card payment cannot happen at all:

```
SQUARE_ACCESS_TOKEN=
SQUARE_WEBHOOK_SIGNATURE_KEY=
```

The application ID, location ID and notification URL are **not** secrets and are entered in
Admin → Payments, so they can change without a redeploy. No card data and no processor secret
is ever stored in Wayne's database or sent to a browser.

## Setting it up with a free Square sandbox (no merchant account, no hardware)

1. Create a free account at `developer.squareup.com` and add an application.
2. On the application's **Sandbox** tab, copy the **Sandbox Access Token**, **Sandbox
   Application ID**, and the sandbox **Location ID**.
3. Put the access token in `.env.local` as `SQUARE_ACCESS_TOKEN`. Leave
   `SQUARE_WEBHOOK_SIGNATURE_KEY` blank for now.
4. `npm run dev`, sign in as the owner, open **Admin → Payments**. Set provider **Square**,
   environment **Sandbox**, paste the application ID and location ID, tick **Take card payments
   on the website**, and save.
5. Order something on the site. At checkout, pay with Square's sandbox test card
   `4111 1111 1111 1111`, any future expiry, CVV `111`, postal code `94103`. The order should
   appear paid, and only then appear on the kitchen screen.
6. Decline path: use Square's sandbox decline card. The order must end **cancelled** and
   **unpaid**, with nothing in the kitchen.
7. Card reader without hardware: tick **Take card payments on a counter card reader**, add a
   reader with Square's simulated device ID `9fa747a2-25ff-48ee-b078-04381f7c828f`, take a POS
   order, and press **Take card payment** in Open orders. Square's simulator approves it.
   `841100b9-ee60-4537-9bcf-e30b2ba5e215` simulates the customer cancelling at the reader.
8. Webhooks: when the site is deployed, add a webhook subscription in the Square console
   pointing at `https://<your domain>/api/webhooks/square`, subscribe to `payment.updated`,
   `refund.updated` and `terminal.checkout.updated`, copy its **signature key** into
   `SQUARE_WEBHOOK_SIGNATURE_KEY`, and paste the same URL, character for character, into the
   notification URL field in Admin → Payments.

When the real merchant account arrives: swap the two environment variables for production
values, change the environment to **Production**, and paste the production application and
location IDs. No code changes.

## Automated tests

- `supabase/tests/009_phase11_payment_processor.test.sql` — 59 assertions: card payment is off
  and publishes nothing until configured; anonymous browsers cannot read provider settings, the
  webhook ledger, or call any payment RPC; a card order is refused while card payment is off; a
  cashier cannot configure the processor or refund; the switch cannot be turned on without
  identifiers; a card order waits in `payment_pending` with **no kitchen ticket and no print
  job**; opening a payment does not make an order paid; the same idempotency key never opens a
  second payment; a second payment cannot be opened on one order; a declined card cancels the
  order and never produces a paid order; a captured card releases the order to the kitchen and
  marks it paid; settling twice changes nothing; duplicate webhooks are ignored; refunds respect
  permission, the refundable balance and the reason; a completed refund updates the order and is
  audited; an abandoned checkout is swept up; reconciliation counts correctly and a cashier
  cannot read it. **All pass.**
- `src/lib/payments/square-mapping.test.ts` — 17 assertions on signature verification (correct
  signature, tampered body, wrong key, wrong notification URL, missing values) and on status
  mapping, where anything Square has not explicitly completed is treated as not-yet-money.
- `src/lib/payments/schemas.test.ts` — 14 assertions on request validation, refundable balance,
  amount parsing and error messages.

Verification run: every migration replayed from empty on a clean PostgreSQL 16 database, then
all nine `supabase/tests` suites — 267 assertions, all passing.

## Not yet verified

The session that built this could not reach the owner's machine at the end, and its own network
blocks both the npm registry and Square. So these remain to be run once, on the Mac:

```
npm run verify        # lint, typecheck, unit tests, next build
```

and the sandbox walkthrough above. Every TypeScript file was parse-checked and the payment
logic was exercised directly, but `tsc` against the project's real type graph, ESLint, the
vitest suites and the Next build have not run against this change.

## Known limitations / deferred items

- Card payment is **off** in production until someone configures it. That is deliberate.
- The online-ordering master switch is still labelled `test_ordering_enabled` in the database.
  When card payment goes live it stays the on/off switch for online ordering; renaming it is a
  small follow-up, not a Phase 11 requirement.
- Tips are taken at checkout before the card is charged, not on the reader's tip screen.
- A card order that a customer abandons is cancelled after 30 minutes, which sends an
  `order.cancelled` event to the CRM for an order that never really existed. Harmless, but it is
  visible in Hanafy's event log.
- Apple Pay / Google Pay, gift cards, and stored cards on file are not wired up.
- Receipt hardware is untouched: Phase 5's print queue is unchanged, and the build sheet's rule
  that payment hardware is not complete until tested on Wayne's physical setup still stands.

## Acceptance criteria

The build sheet's Phase 11 criteria need the real merchant account and hardware, so they are
marked against what the sandbox can prove:

| Criterion | Status |
| --- | --- |
| Real test payment succeeds end to end | Ready to test — sandbox walkthrough above, not yet run |
| Failed payment produces no false paid state | Proved in the database tests; a decline cancels the order |
| Duplicate webhook safe | Proved — stored once per provider event id |
| Browser-close recovery works | Proved — pending payments settle by webhook, abandoned orders are swept |
| Refund audited | Proved — audit log entry and order timeline |
| Receipt workflow tested on Wayne's hardware | Not started — needs the hardware |

**Phase 11 infrastructure is complete and inert. The phase is not signed off until the sandbox
walkthrough and, later, the real hardware test have been run.**

## Next

Phase 12 — cash drawer, shifts and closeout (build sheet §21). Not started.
