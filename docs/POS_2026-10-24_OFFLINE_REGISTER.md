# Offline register + lower Vercel/GitHub usage (2026-10-24)

Owner: "when the ELO disconnects from the wifi … I want to make sure that even
when not connected to wifi it'll work and once it reconnects it'll put
everything that happened online."  Also: optimise Vercel compute and GitHub.

## What the Elo does now with no connection

| | Before | Now |
|---|---|---|
| POS screen | Needed the internet to open; a background refresh offline reloaded the page onto "Can't reach the POS" | Opens and keeps running offline (`public/pos-sw.js` keeps the last good copy of the POS and its code). Background refreshes pause while offline |
| Take payment | "Not sent — no connection" | The order is saved on the register as **O1, O2 …** and paid right there |
| Cash | — | Change shown; drawer opened through the receipt printer |
| Stripe M2 | — | Stripe offline mode: the reader stores the card and forwards it when back online (in-store orders; not deliveries) |
| Pay later / Cash at the door | — | Works |
| Kitchen ticket (+ delivery receipt) | — | Printed by the register straight to the printers on the store network (same slips). Keeps retrying for 30 min if the printer doesn't answer; **Print ticket** button in the Offline orders bar |
| When the connection is back | Unsent tickets resent | Each offline order is sent with its own idempotency key (never twice), then its payment (cash recorded without popping the drawer again; card matched to the order on the server). The server never prints its kitchen ticket again |
| Problems | — | An order the server refuses, or a stored card Stripe declines, stays in the **Offline orders** bar with what to do until someone taps **Done** |

Not offline: keying in a card, adding items to an order already sent, promo codes,
other registers seeing the ticket, the customer screen tip/signature.
If the Elo is off Wi-Fi entirely (not just the internet), the printers, drawer
and caller ID are unreachable too: the order is still saved, the screen says the
kitchen ticket did not print (read it to the kitchen), and it is sent later.

The POS has to be opened **once online** after installing app 1.5 so it can keep
its offline copy, and the M2 has to connect online once so Stripe turns on its
offline mode (done automatically: Terminal Location → configuration with
`offline.enabled`).

## Pieces

* `supabase/migrations/20261108080000_offline_register.sql` (applied live):
  `orders.offline_printed_at`; `wayne_create_pos_order` takes `offline_printed`,
  `offline_taken_at`, `offline_local_number` (logs `order.taken_offline`, and a
  re-send of an order the server already had marks its pending kitchen ticket
  printed); kitchen-ticket / delivery-receipt queue skip offline orders;
  `wayne_take_cash_payment` takes `offline` (metadata) and the drawer trigger
  skips it.  Every online order sends `offline_printed=false` → exactly as before
  (checked live in a rolled-back transaction).
* `src/stores/offline-orders.ts` — offline orders: totals, local numbers, local
  printing/drawer, sync. `src/stores/connectivity.ts` — server reachable or not.
* `src/app/pos/offline-payment.tsx`, `offline-orders-bar.tsx` — the screens.
* `src/app/api/pos/stripe-terminal/offline-settle` — records a forwarded card
  after reading it from Stripe and checking it carries the order's ticket key.
* Android 1.5 (`StripeReader.java`, `NativeBridge.java`): `Terminal.init` with an
  OfflineListener; `stripeCollectOffline` (SDK-created PaymentIntent,
  PREFER_ONLINE, automatic capture, metadata `wayne_offline_key` /
  `wayne_order_key`); forwarded cards kept in the app until the page records them.

## Vercel / GitHub

* `/api/version` is now a static file (the registers ask every minute: no function time).
* POS menu refresh every 3 min instead of 1 (and on screen wake); paused offline.
* Online-order alerts: Realtime (new kitchen ticket / print job) instead of an
  8-second poll; 20-second safety poll.
* Device diagnostics batched every 5 s instead of every 0.8 s.
* M2 auto-reconnect slows to every 3 min after 20 failed tries (a reader asleep overnight).
* `vercel.json` + `scripts/vercel-ignore-build.sh`: only `main` builds, and a push
  that only touches android/, docs/, supabase/, scripts/, tests or notes doesn't rebuild.
* The 14 MB `WaynesPOS-1.4.apk` is no longer committed (`*.apk` ignored).
