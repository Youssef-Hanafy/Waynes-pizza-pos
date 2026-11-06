# Stage 1 recurring usage optimization

Live events remain immediate. The following fallback intervals change:

| Activity | Interval |
| --- | --- |
| Online-order alerts, visible register | 60 seconds; refresh on return/reconnect |
| Open orders/current-order rail/payments/day orders | 60 seconds |
| Printer-station backup | 60 seconds; live jobs still wake it immediately |
| Delivery and driver boards | 60 seconds; actions refresh immediately |
| Drawer, closeout, tips background refresh | 120 seconds while visible |
| Admin dashboard and order reports | 300 seconds; live events still refresh them |
| App version fallback | 300 seconds; startup and existing event checks remain |
| Abandoned checkout cleanup | Hourly |
| Platform automation tick | Every 15 minutes |

The drawer refreshes when its panel opens and after actions. Printing a store closeout fetches the latest report first and refuses to print cached totals after a failed refresh. Driver freshness uses a two-minute threshold so the one-minute interval does not display a false disconnected warning.

Card payouts stay hourly. Held-card capture, its nightly fallback, caller-ID backup, customer inactivity evaluation, customer-facing display and update-safety protections retain their existing behavior. No payment is captured or paid out as part of this optimization.

Shared open-order requests and customer-display events belong to Stage 2. Two other changes need event handling before their interval can safely be reduced: CRM routine delivery must be separated from immediate consent changes and frequent async-response collection; menu/settings need change notifications before a 15-minute fallback can preserve prompt edits. Their current intervals remain in Stage 1.
