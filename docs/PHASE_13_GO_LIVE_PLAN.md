# Phase 13 — Production hardening, migration and cutover (plan, 2026-09-12)

Phases 0–12 are the software. Phase 13 is **putting it into a restaurant**, and most of it is
not code — it is accounts, hardware, data, people and a night of parallel running. This
document is the order to do it in, who has to do each part, and what "done" looks like.

Nothing here should start until Phases 10, 11 and 12 are on `main`, `npm run verify` passes, and
the Vercel production deployment is green.

Deployment mechanics (GitHub, Vercel, Supabase projects, the owner bootstrap, the domain) live
in [`DEPLOYMENT.md`](DEPLOYMENT.md) and are not repeated here.

---

## Stage 0 — Close what is still open (developer, before anything else)

These are known gaps from earlier phases. None blocks taking an order, but each is a loose end
that will be harder to chase after go-live.

| Item | From | What is needed |
| --- | --- | --- |
| Square sandbox walkthrough | Phase 11 | Run one sandbox card order end to end, one decline, one refund, one webhook replay. Never run. |
| CRM scheduler | Phase 9 | Something (Vercel Cron or the CRM's own scheduler) calling `/api/crm/triggers/run` on a schedule, or wait-steps and quiet hours silently never fire. |
| STOP write-back | Phase 9 | A STOP texted to the CRM does not uncheck `sms_marketing_opt_in` on Wayne's side. The CRM blocks the send, so no one is texted wrongly — but the checkbox lies. |
| Email delivery | Phase 9 | Email actions are logged, not sent. Needs a provider in the CRM. |
| Leaked-password protection | Audit M5 | Supabase → Authentication → Password security, on the production project. Dashboard-only setting. |
| CRM security advisories | Phase 9 | Several `sms_*` / `crm_*` SECURITY DEFINER functions on the CRM project are callable by `anon`. Not Wayne's project, but it is the same account. |
| Deployment Protection | Phase 9 | Re-enable it on the marketing site. |

---

## Stage 1 — Production configuration (developer + owner, ~1 day)

1. **Secrets.** Production Vercel environment carries `SUPABASE_SERVICE_ROLE_KEY`,
   `SQUARE_ACCESS_TOKEN` and `SQUARE_WEBHOOK_SIGNATURE_KEY` (production, not sandbox) and the
   Hanafy signing secret. None of these belongs in the database, the browser, or a chat window.
   Rotate anything that has ever been pasted anywhere.
2. **Backups.** Supabase → Database → Backups. Confirm daily backups are on and note the
   retention the plan actually gives (the free tier's retention is short — if Wayne's is on it,
   this is the one line item worth paying to fix). Take a manual backup immediately before
   cutover. Verify a restore into a scratch project **once**, before go-live, so the first
   restore attempt is not during an emergency.
3. **Monitoring.** Decide where errors go. Today `src/lib/logging/logger.ts` writes structured
   logs and `src/lib/monitoring/error-event.ts` shapes error events; production needs somewhere
   for them to land (Vercel log drains, or Sentry). Add an uptime check on `/` and on
   `/api/pos/drawer` so a dead deployment is noticed by a machine, not by a cook.
4. **Payments live.** Swap Square to production credentials, register the production webhook URL
   (the signature is verified against the exact registered URL — a trailing-slash mismatch will
   silently reject every event), and leave card payment **off** until Stage 4.

---

## Stage 2 — Data migration (owner + developer, ~2 days)

1. **Menu.** The production menu is entered and proofed in Admin → Menu by someone from Wayne's
   — prices, sizes, toppings, modifier prices, and what is hidden. Print it and have Ehab check
   it line by line against the current menu. A wrong modifier price is a wrong price on every
   ticket forever.
2. **Tax.** Confirm the Worcester meals-tax rate with Wayne's accountant and set it in Admin →
   Settings. It is currently a single rate in basis points; every order stores its own snapshot,
   so changing it later does not rewrite history.
3. **Customers.** Per build sheet §1795: import historical customers only if the legacy export
   is trustworthy. If it is not, establish a clean go-live date, keep the legacy export as an
   archive, and let the customer base rebuild from real orders. A dirty import poisons CRM
   segments — a customer with a wrong "last ordered" date gets a win-back text on day one.
4. **Store details.** Hours, holiday closures, delivery ZIPs, delivery fee and minimum, public
   phone, canonical URL.
5. **Registers.** Admin → Cash: create a register for each physical till. **The counter cannot
   open a drawer until at least one exists.**

---

## Stage 3 — Hardware and printing (developer on site, ~1 day)

1. Install the receipt printer(s) and confirm routing in Admin → Printing: which printer gets
   kitchen tickets, which gets customer receipts, what happens to a delivery ticket.
2. Install the KDS screen where the cooks will actually look at it, signed in as a kitchen
   account with no admin rights.
3. Install the card reader, pair it in Admin → Payments, and take one real $1 card payment and
   refund it. This is the build sheet's outstanding Phase 11 acceptance item.
4. Print a ticket, pull the plug on the printer mid-service, and confirm the queue retries
   rather than losing the ticket.
5. Confirm the cash drawer opens on a cash payment (if it is wired to the printer).

---

## Stage 4 — Staff, training and permissions (owner + developer, ~2 days)

1. Create an **individual** account for every cashier, cook, driver and manager in Admin →
   Staff. Shared logins destroy the audit trail, which is the whole point of the audit trail.
2. Walk each role through its own screen only: cashier → POS and drawer; cook → KDS; driver →
   `/driver`; manager → everything plus Cash and Reports.
3. Teach the three things people get wrong: count the drawer **before** looking at the expected
   figure; every paid-out needs a real reason because the owner reads them; a refund needs a
   reason and is permanent.
4. Verify the negative cases: a cashier cannot open Admin → Cash, cannot refund, cannot change
   the menu. Try it, do not assume it.

---

## Stage 5 — Load and failure testing (developer, half a day)

1. Concurrency: place ~50 orders in a few minutes against production (or a staging clone with
   production data shape) and confirm no order numbers collide, no ticket is lost, and the KDS
   keeps up.
2. Kill the CRM: pause the Hanafy destination and place orders. Ordering must continue and
   events must queue, not drop. **A CRM outage cannot stop the POS** — this is an explicit
   acceptance criterion.
3. Kill the network at the counter mid-payment and confirm the order resolves to exactly one
   state — paid or not paid, never both, never a false paid.
4. Close a drawer with a payment still pending and confirm it is refused.

---

## Stage 6 — Parallel operation (Wayne's team, 3–5 service periods)

Run the new system **alongside** the legacy POS. Every order goes into both. At the end of each
night, compare:

- order count and order total,
- cash: counted vs expected on each drawer, and against the legacy report,
- card total against the Square dashboard,
- tax collected,
- any order that appears in one system and not the other.

Keep a written log of every discrepancy and its cause. Do not move to Stage 7 until two
consecutive nights reconcile to the cent with no unexplained difference.

---

## Stage 7 — Cutover (developer + owner, one morning)

1. Take a manual Supabase backup.
2. Point the domain at Vercel; update `NEXT_PUBLIC_APP_URL`, the Supabase Site URL and redirect
   URLs, and `canonical_url` in Admin → Settings.
3. Turn card payment on; take one real order.
4. Turn off TEST / MANUAL ordering — the storefront is live.
5. Leave the legacy POS powered on and reachable for two weeks. Do not cancel it the same week.

---

## Stage 8 — First live week (everyone)

- Reconcile cash and card **every night** in Admin → Cash and Admin → Reports for the first
  week, not weekly.
- Read the audit log at the end of the first week — it will show who actually does what, which
  is usually not what the training assumed.
- Keep a single list of every "that's not how we do it" from staff. Most are five-minute fixes
  and all of them are cheaper to fix in week one.

---

## Final go-live checklist

Do not turn off TEST ordering until every line is true.

- [ ] `npm run verify` passes on `main`; production deployment green
- [ ] Dashboard's **Before going live** checklist complete (menu, tax, delivery ZIPs, fee and minimum, phone, staff sign-ins, Hanafy)
- [ ] Production secrets set in Vercel; nothing sandbox left
- [ ] Daily backups on, retention known, one restore rehearsed
- [ ] Error monitoring and an uptime check are reporting somewhere a human looks
- [ ] Menu and modifier prices proofed against the paper menu by Wayne's
- [ ] Meals-tax rate confirmed with the accountant
- [ ] At least one register created in Admin → Cash
- [ ] Printer routing tested, including a printer failure and recovery
- [ ] KDS installed and stable through a service period
- [ ] Card reader paired; one real payment and one real refund completed
- [ ] Every staff member has their own account; role restrictions tested by attempting them
- [ ] CRM outage test passed — ordering unaffected, events queued
- [ ] Two consecutive parallel nights reconcile exactly
- [ ] Domain cut over, Supabase URLs updated
- [ ] Legacy POS still available as a fallback
- [ ] Wayne's owns the domain, the Supabase account, the Square account and the Vercel project

## Acceptance (build sheet §Phase 13)

| Criterion | How it is proved |
| --- | --- |
| Wayne's team can run a full service period on the new system | Stage 6, then Stage 7 |
| No orders lost | Stage 6 nightly comparison |
| Cash / card / tax totals reconcile | Stage 6, and Admin → Cash closeout |
| KDS and printing stable | Stage 3 and Stage 6 |
| Payment stable | Stage 3 real payment, Stage 5 failure tests |
| Driver workflow stable | Stage 6 — real deliveries assigned and closed on the driver screen |
| CRM outage cannot stop the POS | Stage 5.2 |
| Staff permissions and audit work | Stage 4.4 and Stage 8 audit-log review |
| Production owner controls domain and critical accounts | Final checklist |

**Phase 13 cannot be signed off by a developer. It is signed off by Wayne's running a real
night on it.**
