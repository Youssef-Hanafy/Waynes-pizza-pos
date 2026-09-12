# Phase 12 — Cash drawer, shifts and closeout (completion report, 2026-09-12)

Phase 12 gives Wayne's a real till. Every dollar that goes into or out of a drawer is attached
to a named person, a reason and a shift, and the amount a drawer *should* hold is worked out
from that ledger rather than typed by anyone. A drawer can only be reconciled by being counted.

## What was built

**Registers.** Each till has its own identity, so two drawers at the counter never share a
count. An owner or manager adds them in Admin → Cash; a register can be retired without losing
its history.

**Shifts.** A cashier opens a drawer by counting the opening float. One register can have only
one open drawer at a time — enforced by a partial unique index in the database, not by the
screen — so two people cannot open the same till and quietly diverge.

**Cash movements.** Paid in, paid out, drop to safe, and driver cash returned. Every one needs
an amount and a reason of at least three characters, and is written with the actor's identity
into the immutable audit log.

**Cash payments that are real.** `wayne_take_cash_payment` takes the tendered amount, records
the change owed, attaches the payment to the open drawer, and marks the order paid — in one
transaction, keyed by an idempotency key, so a double-tap on a busy counter cannot take the
money twice.

**Expected vs counted.** The expected figure is derived, never stored as an input:

```
opening float + cash sales − cash refunds + paid in + driver cash − paid out − drops
```

At close, the cashier types only the count. The screen shows the variance the moment a count is
entered, and the drawer refuses to close without a written explanation when it is out by **$5
or more** in either direction. It also refuses to close while a payment on that drawer is still
pending, so a card or cash payment in flight can never land on a closed shift.

**Manager closeout.** Admin → Cash runs a closeout over any business-date range in the store's
timezone: cash sales, counted, expected, variance, paid in, paid out and drops, driver cash,
every drawer with who opened and closed it, and the full movement history with reasons. A
manager can also close a drawer a cashier walked away from — same count and note rules apply.

## Files created / changed

Created: `supabase/migrations/20260917080000_phase12_cash_drawer.sql`,
`supabase/tests/010_phase12_cash_drawer.test.sql`,
`src/lib/cash/{schemas,queries}.ts` + `src/lib/cash/schemas.test.ts`,
`src/app/api/pos/drawer/route.ts`, `src/app/pos/drawer-panel.tsx`,
`src/app/admin/cash/{page.tsx,actions.ts}`.

Changed: `src/app/pos/pos-client.tsx` (drawer button in the POS header),
`src/app/pos/open-orders-panel.tsx` (inline "Take cash" with tendered amount and change due),
`src/app/admin/layout.tsx` (Cash nav), `src/lib/auth/permissions.ts` (`cash.manage`).

## Database migration

`20260917080000_phase12_cash_drawer.sql`, applied to the hosted project `vxpkdmtornkeoedkawkt`
on 2026-09-12. Idempotent and safe to re-run.

- Permission `cash.manage` (owner, manager). Cashiers work the drawer through `pos.access`;
  only owners and managers create registers and run the closeout.
- Tables `registers`, `register_shifts`, `cash_movements`. `register_shifts` carries snapshot
  columns (counted, expected, variance and each component) filled at close, so a historic
  closeout never changes when later data moves.
- `payments` and `refunds` gain `shift_id`; `payments` gains `tendered_cents` and
  `change_cents`.
- RPCs: `wayne_shift_cash_totals`, `wayne_save_register`, `wayne_open_shift`,
  `wayne_record_cash_movement`, `wayne_close_shift`, `wayne_take_cash_payment`,
  `wayne_pos_drawer`, `wayne_cash_closeout` — all `security definer` with
  `set search_path = ''` and their own permission checks, so the rules hold no matter which
  client calls them.

## Verification

A local Postgres 16 cluster replays every migration from empty and runs all ten suites:

```
suites 001–010 · 328 assertions · all passing
```

Suite 010 (61 assertions) covers, among others: opening a drawer twice on one register is
refused; expected cash tracks every movement kind in the right direction; a cash payment
records tender and change and marks the order paid; a duplicate idempotency key does not take
the money twice; a close without a note at a $5 variance is refused and at $4.99 is allowed;
closing with a pending payment on the drawer is refused; a cashier without `cash.manage` cannot
create a register or read the closeout; and every movement, open and close writes an audit row
with the actor.

`src/lib/cash/schemas.test.ts` covers the pure money helpers — expected-cash derivation,
variance sign and wording, the note threshold, and the count parser (which accepts `0`, since
an empty drawer is a real count).

### Not yet verified

Your Mac went offline before this change could be copied across, so `tsc` against the project's
real type graph, ESLint, the vitest suites and the Next build have **not** run against Phase 12.
Every file was parse-checked and the SQL is proved, but the type graph is not.

## Known limitations / deferred items

- Blind close is a convention, not an enforcement: the drawer panel shows the expected figure
  while the shift is open, because a cashier needs it during service. The count field is what is
  recorded, and the variance is computed from it.
- No denomination breakdown — the count is a single total, not a bill-and-coin tally.
- No safe/deposit ledger beyond the drop: cash dropped to the safe leaves the drawer's ledger
  and is not tracked further.
- Tips are not split out of the cash drawer; a cash tip is part of the counted total.
- Card payments attach to the open drawer for reporting, but a card variance is not a cash
  variance and is not surfaced as one.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| Test day cash reconciles exactly | Proved in the database tests — a full day of sales, refunds, paid in/out, drops and driver cash closes at zero variance |
| Paid-in/out and refunds are reflected | Proved — each movement kind moves the expected figure in the correct direction |
| Actor/reason history is complete | Proved — every movement carries an actor and a reason; every open, movement, payment and close writes an audit row |

**Phase 12 is complete in code and in the database. It is not signed off until it has run on
Wayne's real counter for a service period — that is part of Phase 13.**

## Next

Phase 13 — production hardening, migration and cutover. Most of Phase 13 is not code: see
`docs/PHASE_13_GO_LIVE_PLAN.md` for what is left, who has to do it, and in what order.
