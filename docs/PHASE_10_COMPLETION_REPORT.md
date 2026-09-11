# Phase 10 — Delivery Driver Module (completion report, 2026-09-11)

## What was built

Master build sheet §19 (delivery operations) and §34 Phase 10, end to end:

- **Driver role/screen** — `/driver`, a one-thumb phone screen gated on the existing
  `driver.access` permission. Each delivery shows order number, customer name, tap-to-call
  phone, full address, door instructions, order note, items, order total, and the exact
  amount due at the door.
- **Assign delivery** — `/admin/delivery` dispatch board for owner, manager, and cashier
  (new `delivery.dispatch` permission). Assign, reassign (which releases the previous
  assignment rather than stacking a second one), and release with a required reason.
- **Accept** — the driver accepts the assignment; accepting twice is a no-op, not an error.
- **Pickup** — "Picked up" is refused until the kitchen marks the order ready, and moves the
  order from `ready` to `out_for_delivery` on the live order timeline.
- **Navigation hand-off** — "Open navigation" opens the phone's own map app with the stored
  address. No maps SDK, no API key, no third-party script on the page.
- **Delivered** — closes the delivery and completes the order.
- **Cash collected** — the driver must record the cash taken at the door before a delivery
  with money owing can be closed. The amount is written to the assignment ledger, mirrored
  into the `payments` ledger as a captured `cash_on_delivery` payment, written to the order
  timeline, and written to the immutable audit log. A shortfall does not block the delivery;
  it is recorded and surfaced as an exception.
- **Owner delivery metrics** — per-driver deliveries, delivered sales, cash collected, cash
  short, average door time, late count, and an exceptions table (cash short, released after
  pickup, late past promise, still out after 90 minutes), all on the store's business day.

Card-at-door remains deliberately absent, per the build sheet. The driver screen offers cash
only and the database refuses to collect cash on an order that is already paid.

## Files created / changed

Created:

- `supabase/migrations/20260915080000_phase10_delivery_driver.sql`
- `supabase/tests/008_phase10_delivery_driver.test.sql`
- `src/lib/delivery/schemas.ts`, `src/lib/delivery/queries.ts`, `src/lib/delivery/schemas.test.ts`
- `src/app/driver/page.tsx`, `src/app/driver/driver-screen.tsx`
- `src/app/api/driver/route.ts`
- `src/app/admin/delivery/page.tsx`, `src/app/admin/delivery/actions.ts`

Changed:

- `src/lib/auth/permissions.ts` — adds `delivery.dispatch`.
- `src/app/admin/layout.tsx` — adds the Delivery link for dispatchers and report viewers.
- `supabase/tests/001`–`006` — repaired against the Phase 0–8 remediation (staff accounts now
  start inactive, checkout is server-only, order items require a category snapshot). These
  fixtures had silently stopped matching the database; all eight suites now pass.

## Database migration

`20260915080000_phase10_delivery_driver.sql`, applied to the hosted project
`vxpkdmtornkeoedkawkt` on 2026-09-11. It is idempotent and safe to re-run.

- Permission `delivery.dispatch`, granted to owner, manager, and cashier — never to drivers.
- Table `public.delivery_assignments` (the hand-off and cash ledger) with RLS on, a partial
  unique index enforcing one active assignment per order, and SELECT limited to dispatchers,
  report viewers, and the driver's own rows. No direct INSERT/UPDATE/DELETE for anyone.
- RPCs: `wayne_delivery_dispatch`, `wayne_assign_delivery`, `wayne_release_delivery`,
  `wayne_driver_board`, `wayne_driver_claim_delivery`, `wayne_driver_update_delivery`,
  `wayne_delivery_metrics`, plus two internal payload helpers that are not callable by
  browsers or signed-in staff.
- Every privileged action checks its permission inside the function; nothing trusts a value
  sent by the client.

## Environment variables

None added. Phase 10 uses the existing Supabase configuration.

## Manual setup the owner must complete

1. In **Admin → Staff**, give each delivery driver the **Driver** role and mark them active.
   Until at least one active driver exists, the dispatch board says so and cannot assign.
2. Drivers sign in at **/driver** on their phone with their own staff account. They cannot
   reach the admin area, the POS, the kitchen screen, or any other driver's delivery.
3. Nothing else. Existing delivery settings (fee, minimum, postal codes, estimate) are
   unchanged from Phase 2.

## Automated tests

- `supabase/tests/008_phase10_delivery_driver.test.sql` — 41 assertions covering the whole
  delivery lifecycle and its security: drivers cannot dispatch; a kitchen account cannot be
  assigned a delivery; assignment sets the amount due from the unpaid order total;
  reassignment releases the previous assignment and only one stays active; releasing requires
  a reason; a driver cannot read or act on another driver's delivery; accepting twice is a
  no-op; pickup is refused before the kitchen is done; pickup moves the order out for
  delivery; delivering without recording cash is refused; a completed delivery marks the
  order completed and paid, records the payment ledger row, the audit row, and the delivery
  timeline; owner metrics count it; a driver cannot read delivery analytics. **All pass.**
- `src/lib/delivery/schemas.test.ts` — 19 unit assertions over address formatting, the map and
  phone links, driver step sequencing, cash parsing, action validation, and error mapping.
  **All pass.**
- Suites 001–007 were repaired and re-run: 14, 24, 30, 19, 31, 45, 4 assertions, all passing.

Verification run for this phase: every migration replayed from empty on a clean PostgreSQL 16
database, then all eight `supabase/tests` suites; `tsc --noEmit` and `eslint . --max-warnings=0`
against the repository's own configuration; and the delivery module's pure functions and board
parsers executed against the exact JSON shapes the RPCs return.

## Exact manual test steps

1. Sign in as the owner. Place a delivery order (storefront or POS) to an address inside the
   delivery area.
2. Open **Admin → Delivery**. The order appears under *Live deliveries* as **Unassigned**.
   Choose a driver and press **Assign**.
3. On the driver's phone, open **/driver** and sign in as that driver. The delivery appears
   with the customer's name, phone, address, door note, and the cash due.
4. Press **Accept delivery**. Press **Picked up** — it is refused with "The kitchen has not
   marked this order ready yet" until the kitchen screen marks the order ready.
5. Mark the order ready on **/kitchen**. Back on the driver screen press **Picked up**. The
   order moves to *out for delivery* on the admin order page and the dispatch board.
6. Press **Open navigation** — the phone's map app opens at the customer's address.
7. Press **Delivered**. Enter the cash collected (pre-filled with the amount due) and confirm.
8. Check **Admin → Orders**: the order is completed and paid, and the timeline shows
   `delivery.assigned`, `delivery.accepted`, `delivery.picked_up`, `order.out_for_delivery`,
   `order.completed`, and `delivery.delivered` with the cash amount.
9. Check **Admin → Audit**: a `delivery.delivered` entry names the driver and the cash.
10. Check **Admin → Delivery → Driver performance** for today: the driver's delivered count,
    cash collected, and average door time are there. Entering less cash than owed on a second
    order puts a **Cash short** row in *Exceptions*.
11. Reassignment: assign a second delivery, then reassign it to another driver. The first
    driver's screen no longer shows it; the second driver's does.

## Known limitations / deferred items

- **Card at the door is not available.** By design — it arrives with the payment processor in
  Phase 11, together with the driver's card-present hardware flow.
- No live driver GPS tracking or route optimisation; the build sheet does not ask for it.
- Drivers may self-claim a *ready, unassigned* delivery from the driver screen (the available
  list hides the address and phone until claimed). Turn this off by removing the "Ready and
  unassigned" section if Wayne's wants dispatch-only assignment.
- Delivery cash is recorded per delivery, not yet reconciled into a driver cash drawer or day
  close — that is build sheet §21, which has not been scheduled into a phase yet.
- `npm run build` and `npm test` were not executed in this session's cloud environment, whose
  network policy blocks the npm registry; the equivalent checks were run against the repo's
  installed toolchain as described above, and the Vercel production build is the final gate.

## Acceptance criteria

| Build sheet criterion | Result |
| --- | --- |
| A ready delivery can be assigned | Pass — dispatch board assigns and reassigns; drivers may also claim a ready unassigned order |
| Driver sees required information | Pass — order number, name, phone, address, instructions, total, amount due, status |
| Owner sees status live | Pass — dispatch board auto-refreshes; order timeline and admin order page update on every step |
| Cash collection is auditable | Pass — assignment ledger, `payments` row, order event, and immutable audit entry, with shortfalls surfaced as exceptions |
| Card-at-door disabled | Pass — cash only in the UI and refused in the database for a paid order |

**Phase 10 acceptance criteria passed.**

## Next

Phase 11 — Live Square / payment processor + receipt hardware. Not started; the build sheet
says to begin it only after the merchant account and the exact Square hardware are confirmed.
