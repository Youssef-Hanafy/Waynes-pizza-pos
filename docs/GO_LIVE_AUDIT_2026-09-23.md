# Go-live audit — 2026-09-23

Everything in the master build sheet, the phone-line build sheet and the later
asks, checked against the code on `main` and the **live** databases (Wayne's
`vxpkdmtornkeoedkawkt`, Hanafy CRM `lgbdfqpnlvjxdlalhnbk`) and the deployed CRM
worker (`hanafy-media-crm`).

**Bottom line.** The software side is in good shape: ordering, POS, kitchen,
calendar, customers, segments, the Wayne's → CRM event pipe and the text-club
welcome loop all work. Four real problems were found and fixed today (below).
What stands between you and go-live is mostly **setup and accounts**, not code:
AWS 10DLC registration, Square, tax rate, staff/registers, photos, and putting
the caller-ID box on the new POS. One CRM code change (inbound STOP webhook) has
to be made in the CRM repo, which isn't on this Mac.

## Fixed today

| # | What was wrong | Fix | Where |
|---|---|---|---|
| 1 | Couldn't add extra of a topping an item already comes with (Hawaiian: extra ham / extra pineapple). Only sauces allowed it. | Every vegetables / meats / cheese group and the pick-your-toppings groups now allow extra portions. Included portion free, each extra charged at its per-size price, ticket prints "Extra Ham". "No/Light Cheese" stay once-only. | migration `20260928080000`, commit `3ab060b` |
| 2 | Items whose toppings are in the name had nothing highlighted (Grilled Chicken Pizza, BBQ Chicken, Pasta with Meatball, Turkey Bacon Sub…). Mozzarella Sticks had lost its marinara. | 38 "comes with" toppings added across 29 items from the item names and the "Comes with" lines; Shrimp Broccoli Alfredo now comes with Alfredo, not marinara. All editable in Admin → Menu. | same |
| 3 | **Go-live blocker:** online card orders are built by the test-order function, which refuses everything once "TEST / MANUAL ordering" is off, and the storefront treated that switch as "online ordering open". The go-live plan turns it off → online ordering would have died the moment cards went live. | Card orders pass; direct no-payment orders are still refused. Storefront is open when cards are live **or** TEST mode is on. Verified on live in a rolled-back transaction. | migration `20260929080000`, commit `8c95b34` |
| 4 | CRM showed every Wayne's customer with 0 orders / $0 / no last order (order events were never turned into CRM orders), so the CRM's "30-Day Winback" segment and campaign audiences could never match. The "Waynes Pizza Text Club" list had 0 members. | Order events now mirror into `crm_orders` (contact rollups correct: 1 order / $5.95 for the test customer); Text Club list follows SMS consent. | CRM DB, `docs/crm-sql/`, commit `9b03c52` |
| 5 | Checkout "text deals" box had **no** SMS disclosure; no Terms or Privacy page anywhere. Carriers reject 10DLC campaigns for this. | New `/terms` and `/privacy`, full disclosure + links at checkout and on Wayne's Rewards, footer + sitemap links. Checkout consent now recorded as `wayne-checkout-v2`. | commit `9b03c52` |
| 6 | Phone rang → cashier had to tap PHONE → line → start order. | **Auto pick-up:** when Line 1 or 2 rings and the register is idle (empty ticket or order lists), the caller's card opens by itself; mid-ticket it only lights the PHONE button. Per-register switch in POS → More. | commit `13d024b` |
| 7 | No win-back text existed (the project's headline example). | "30-day win-back (Wayne's)" automation added to the CRM as a **draft**, triggered by Wayne's 30-day-inactive segment; consent + STOP checked by the CRM. Publish it after you approve the wording. | CRM `sms_automations` |

## Phone lines 1 and 2 — status

* Software: done and tested with the simulator (Line 1 / Line 2 cards, customer
  lookup, claim lock, hold/resume, call ↔ order link, now auto pick-up).
* **Not hooked to the real phones yet.** Admin → Hardware has caller ID set to
  **Simulated**, line phone numbers blank, and there has never been a real call.
  To go live:
  1. Install the Wayne's POS Android app (`android/`, see `ANDROID_APP_SETUP.md`)
     on the counter tablet, on the store Wi-Fi (ThriveAP, 10.10.10.x) — same
     network as the Whozz Calling box. Allow "local network" when asked.
  2. Admin → Hardware → Caller ID provider → **Android app**; enter both store
     numbers for Line 1 / Line 2; turn the simulator off.
  3. Call each line from a cell phone; run the Caller ID section of Admin → Pilot.

## SMS / Hanafy CRM — status

Working end to end: Wayne's outbox → signed events → CRM (all 28 events
delivered, 0 failed, ~1 min latency) → "Text club welcome" → SMS from
+1 513-676-4597. CRM checks consent and suppression before every send.

Needs doing:

| Item | Who | Notes |
|---|---|---|
| **10DLC brand + campaign registration** in AWS End User Messaging for +1 513-676-4597 (identity shows `ten_dlc_status` empty). Use opt-in URL `…/rewards`, attach `/terms` and `/privacy`, sample messages = the welcome and win-back texts. | You | Required before US carriers deliver at volume. Also request the account leave the SMS sandbox and raise the spend limit. Deploy these site changes **first** — reviewers open the links. |
| **Inbound STOP / HELP webhook** — CRM routes `/api/sms/inbound` and `/api/webhooks/aws/sms` don't answer SNS "SubscriptionConfirmation" and require an `x-hanafy-sms-secret` header SNS can't send, so AWS two-way SMS can't be subscribed. 0 inbound messages ever recorded. | CRM repo | Handle `Type: SubscriptionConfirmation` (GET the `SubscribeURL`), verify the SNS signature, accept the secret as a query param. AWS still enforces STOP on its own opt-out list meanwhile, so no one is texted after STOP — but the CRM contact isn't updated. |
| No **configuration set** on the number → no delivery receipts (0 `sms_message_events`). | You (AWS console) | Create one with an SNS event destination → `/api/webhooks/aws/sms` (same SNS fix as above). |
| STOP in the CRM doesn't write back to Wayne's `sms_marketing_opt_in`. | CRM repo | The CRM blocks the send, so nobody is texted wrongly; Wayne's checkbox just lags. |
| No scheduler for CRM wait-steps / quiet hours (`/api/crm/triggers/run`). The welcome and win-back flows don't need it. | CRM repo | Add a Cloudflare Cron Trigger that calls it every 5 min before building any flow with a delay. |
| Publish the win-back draft; decide whether it includes an offer. | You | /admin/sms → Automations. |
| Transactional texts (order ready / out for delivery) aren't built. | Later | Build sheet §27; not a go-live blocker. |

## Settings / data still to set (all in Admin, no code)

| Setting | Now | Needed |
|---|---|---|
| Meals tax | **0%** | Confirm with the accountant (MA 6.25% + Worcester local option → 7%). Admin → Settings. |
| Delivery ZIPs | empty = delivers anywhere | Worcester ZIPs you actually deliver to. |
| Card payments | Square not connected (provider none) | Merchant account, production keys in Vercel, webhook URL, reader. |
| Staff | owner only | One account per cashier / cook / driver / manager. |
| Registers | none | Admin → Cash — the drawer can't open without one. |
| Menu photos | 0 of 197 items | Upload real photos in Admin → Menu → Photos. |
| Social links, logo | blank | Admin → Settings. |
| Leaked-password protection | off | Supabase dashboard → Auth → Password security. |
| Deals #1–#4 / bundle deals (Phase 15) | not on `main`, not live | Rebuild / apply before advertising them. |
| Pilot checklist | 0 of 30 done | Admin → Pilot, at the store. |

## Security check

Supabase advisors: no errors. Anon-callable functions are the public menu /
settings / order-status ones plus two admin ones that refuse without permission
(checked: anon → "Customer viewing permission required"). Only leaked-password
protection is outstanding.

## Equipment and domain

* Already owned and set up in Admin → Hardware: Epson TM-T20III L front
  printer (10.10.10.161) with the cash drawer, Epson TM-U220B kitchen printer
  (10.10.10.171), Whozz Calling? Basic POS 2 caller-ID box.
* To buy: an Android tablet for the counter (runs the app: caller ID + network
  printing), optionally a second for the kitchen (KDS), and the Square
  reader/terminal once the merchant account exists.
* Domain: the site's canonical URL is `waynespizzaofworcester.com`. Transfer the
  domain into an account Wayne's owns, point it at Vercel, then update
  `NEXT_PUBLIC_APP_URL`, Supabase Auth Site URL / redirects and Admin → Settings
  → canonical URL (Phase 13 Stage 7). Keep Thrive running until two
  consecutive nights reconcile.

## To deploy today's work

`git push origin main` from your Terminal (4 commits ahead); Vercel builds it.
Database changes are already live on both projects.
