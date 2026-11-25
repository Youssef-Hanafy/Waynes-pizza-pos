# Wayne's Payarc setup

Implementation prepared November 19, 2026. This file contains no credentials.
Local verification is separate from a Payarc sandbox transaction: merchant credentials
are still required before end-to-end processor testing and activation.

## Current setup: production credentials

The owner has added the three Payarc variables to Vercel and confirmed that the
merchant credentials are production credentials. Set `PAYARC_ENVIRONMENT` to the
literal value `production`, and scope the live credentials to Vercel Production.
A sandbox account is available on request from Payarc but is not currently provisioned
for Wayne's. The sandbox-first steps below describe the optional sandbox path.

For the current production path:

1. Verify `PAYARC_ENVIRONMENT=production` in Vercel and retain the matching live
   bearer token and Client ID. Never use the published test card numbers against
   the production API.
2. Apply the Payarc migration through the normal migration process, checking the
   production database's migration history first; the migration requires the
   preceding repository migrations and does not activate a payment connection.
3. Deploy the updated source code. Redeploying an older deployment only updates
   its variables; it does not include uncommitted local Payarc implementation files.
4. Configure Payarc as Production in Admin → Payments and run its read-only
   authentication check before taking payments. Complete existing Stripe holds
   and tip operations before switching the active online provider.
5. Register the generated production callback URL in the live Payarc dashboard.
6. Agree on a specific small live test amount with the owner before any real
   purchase, void, or refund. Local mocked/isolated tests are not a substitute
   for verifying actual production response shapes and the returned descriptor.

The current session could not inspect Vercel remotely: the saved Vercel CLI
credential received HTTP 403. Local Supabase service credentials were unavailable.
The three variable values, deployed code, and hosted database migration state have
therefore not been independently verified. No deployment, production database change,
charge, void, or refund was performed in this session.

## What is implemented

- Website checkout and staff keyed card payments through Payarc-hosted fields.
- Immediate charge for the database-calculated amount, including tips entered before payment.
- Durable payment attempts, split tender amounts, amount/connection validation, and a check-again path.
- Refunds with explicit base/tip allocations and existing driver tip recovery accounting.
- Voids of unbatched payments; refunds of batched payments.
- Merchant-specific callback URLs. Notifications prompt authenticated Payarc API reads;
  callback bodies never establish payment state and are never stored or logged.
- A unique `WAYNES <reference>` statement descriptor correlates a callback with an
  attempt even if the initial charge response was lost. Confirm the descriptor is
  accepted and returned unchanged during sandbox testing.

Physical readers, delayed capture/overcapture, wallet payments, automatic bank
payouts, and importing historical Payarc charges are outside this integration.
Payarc charges the order immediately; signed-slip extra tips use the existing
charge’s tip-adjustment API before batching, through Tips or driver cash-out.

## 1. Obtain matching Payarc sandbox credentials

Use a **merchant** sandbox account, not a partner onboarding account. Payarc support
provisions sandbox accounts. In the merchant dashboard, open **API** and reveal the
Client ID, Client Secret, and API Bearer Token. Only the bearer token and Client ID
are required for this phase. Do not paste secret values into chat, SQL, or Git.

Source: [API authentication](https://docs.payarc.net/docs/api-authentication),
[sandbox access](https://docs.payarc.net/docs/getting-started).

## 2. Add three Vercel variables

Open the Wayne's Vercel project, then **Settings → Environment Variables**.
Use these exact names for the test deployment:

| Name | Value | Visibility |
| --- | --- | --- |
| `PAYARC_API_TOKEN` | Sandbox API Bearer Token, without the `Bearer ` prefix | Server only |
| `PAYARC_ENVIRONMENT` | `sandbox` | Server configuration |
| `NEXT_PUBLIC_PAYARC_CLIENT_ID` | Sandbox Client ID from the same merchant | Public hosted-fields identifier |

Scope sandbox values to the designated Preview/staging deployment. Live values belong
only in Production when activating live processing. Never put the bearer token or
Client Secret in a variable prefixed `NEXT_PUBLIC_`.

Keep existing Supabase variables and Stripe credentials. They are still needed for
the application and historical Stripe payment reconciliation. No
`PAYARC_CLIENT_SECRET` or invented `PAYARC_WEBHOOK_SECRET` is required by this code.

Deploy this code after saving the variables; existing deployments do not receive
environment-variable changes. Source: [Vercel environment variables](https://vercel.com/docs/environment-variables/managing-environment-variables).

## 3. Apply the Supabase migration

Apply `supabase/migrations/20261205080000_payarc_online_payments.sql` through the
normal migration process, first to the isolated staging database. The file depends
on all preceding repository migrations. Do not reset the production database.

The migration registers Payarc, adds the payment/refund coordination functions,
and extends existing processor settings. **It does not switch any merchant's
processor or insert secret credentials.**

There are no Payarc secrets to add to Supabase Edge Function Secrets. This integration
runs in Next.js on Vercel. Supabase stores payment records and the `env:PAYARC`
credential reference, not the bearer token.

## 4. Select Payarc in the test site's Admin → Payments

1. Select **Payarc — website and keyed cards**.
2. Choose **Sandbox (test money)**.
3. Leave the Square-only application and location fields blank.
4. Enable website card payments. This also enables staff keyed cards.
5. Turn off the integrated counter reader switch for this phase.
6. Save processor settings. The server performs a read-only Payarc API check and
   records the result. A failed check must be corrected before a charge can start.

The environment on this connection must match `PAYARC_ENVIRONMENT`. Switching the
connection does not move or refund old Stripe transactions. Finish outstanding
Stripe authorizations/tip operations before a live cutover. Historical Stripe
callbacks continue to be accepted with the original callback keys and credentials.

## 5. Register the callback in Payarc

Obtain the exact URL in Platform → Wayne's → Integrations, using the Payarc
connection's webhook path. If needed, run this read-only query in Supabase SQL Editor:

```sql
select c.id, w.slug, c.environment,
       '/api/payments/webhooks/' || c.webhook_key as webhook_path
from public.payment_connections c
join public.workspaces w on w.id = c.workspace_id
where c.provider = 'payarc' and c.status <> 'disabled';
```

Use the row for Wayne's and the intended environment. Prefix `webhook_path` with the
stable HTTPS hostname of that deployment. Treat the full URL as a secret; don't
post it publicly. Do not enter a Supabase database webhook URL or a Stripe endpoint.

In **Payarc Dashboard → API → Webhooks → Add endpoint**, enter that URL and select:

- `charge.created`
- `charge.captured`
- `charge.voided`
- `refund.created`

The public merchant documentation reviewed does not specify a signing algorithm.
This receiver therefore does not claim signature verification: possession of the
random callback URL admits a hint, and an authenticated merchant API read plus
database identity checks decides the outcome. Raw Payarc callbacks can contain
sensitive `request_payload` fields, so this receiver discards the body after
extracting a charge identifier. Do not subscribe this integration to `token.created`.

Source: [merchant webhooks](https://docs.payarc.net/reference/apiwebhooks).

## 6. Complete sandbox acceptance testing

Use Payarc's documented test cards, never a live card in sandbox. Use ordinary orders
in the isolated test database; the POS's **Test order** toggle intentionally simulates
cards and does not exercise Payarc.

Verify website pickup and delivery orders, staff keyed cards, a tip before payment,
split cash/card payments, a decline, and repeated submissions. Check that:

- Payarc shows exactly one charge for the correct total and reference descriptor.
- The POS only reports paid after Payarc confirms capture and Supabase records it.
- A lost response/repeated request does not submit another charge.
- Charge callbacks recover a pending attempt using the descriptor and exact amount.
- An unbatched full void restores the order's unpaid balance without creating a refund.
- A batched partial/full refund appears once in Payarc and in the local refund ledger.
- Explicit refunded tips affect driver recovery accounting correctly.

Refund requests are reserved before submission. If a refund's response is lost, use
**Resume existing refund**. An already-submitted request only performs lookups; it
never assumes an undocumented Payarc idempotency expiration period. If Payarc cannot
return a matching refund identity, review it in the merchant dashboard before
clearing anything. External/dashboard-issued refunds require separate ledger review;
the receiver automatically reconciles refunds initiated by this application.

## 7. Activate production after sandbox verification

Use Wayne's production bearer token and Client ID, set `PAYARC_ENVIRONMENT=production`,
and redeploy with those Production-scoped values. Apply the verified migration to
the production database, select Production for the Payarc connection, verify the
read-only connection check, and register the Production callback URL in the live
merchant dashboard. Then perform an owner-authorized live purchase/refund check.

No live Payarc charge, refund, deployment, or production migration was performed
while preparing this integration.

## API references used

- [Hosted fields](https://docs.payarc.net/docs/hosted-fields-iframes)
- [Create a charge](https://docs.payarc.net/reference/create-a-charge-keyed)
- [Retrieve a charge](https://docs.payarc.net/reference/retrieve-a-charge)
- [Capture](https://docs.payarc.net/reference/capture-a-charge)
- [Tip adjustment](https://docs.payarc.net/reference/tip-adjustment)
- [Refund](https://docs.payarc.net/reference/refund-a-charge)
- [Void/refund batching rules](https://docs.payarc.net/docs/voiding-and-refunding-payments)

## Signed-slip tips with Payarc

Apply `20261206080000_payarc_tip_adjustment.sql` along with the matching code release.
No additional API keys or webhook subscriptions are needed.

- The order is charged immediately, including any tip collected online or by phone.
- In **Deliveries → Cash out**, enter only the **extra** tip from the slip. Pickup
  slips can be processed in **POS → Tips**. A $30 order with a $5 phone tip and a
  $3 extra slip tip ends at $38 charged and $8 recorded as the driver's tip.
- The server reads the current charge, saves an immutable adjustment request, and
  calls `POST /v1/charges/{id}/tip_adjustment` with the target processor tip in cents.
  It verifies both the returned/read-back charge total and the processor tip before
  recording the extra tip or letting driver cash-out proceed.
- Payarc's processor tip baseline is read from the original charge. Existing phone
  tips already folded into the original charge amount are retained locally; they
  are never added to the charge a second time.
- Only one saved adjustment is accepted per payment. Duplicate submissions,
  concurrent registers, callbacks and lost receipts reconcile the saved request.
  After a submission, retries only read; they never issue a replacement charge.
- Zero extra tip finalizes the existing payment without invoking the positive-tip API.
- Positive adjustments are refused after settlement. Payarc determines merchant
  eligibility and limits; the software does not assume Stripe overcapture limits.
  An unconfirmed or rejected adjustment stays pending for review; do not change
  its amount or pay the driver that unconfirmed tip. Check the same saved request.
- Refunds and voids are blocked while an adjustment is pending. Split/changed
  payments require allocation review instead of an automatic adjustment.
- Automatic nightly capture remains a Stripe flow; Payarc extra tips are not
  submitted automatically at the nightly cutoff.

Actual merchant response semantics, eligibility and batch deadlines still need an
owner-authorized real card test. Local tests use mocked Payarc responses and an
isolated PostgreSQL database; they do not move money.


## Online order extras on the original card

Apply `20261207090000_online_original_card_extras.sql` with this release.

- Online item notes and checkout order notes are available again and retained in
  the submitted order. Notes explain that paid extras require confirmation.
- In **POS → Today's Orders**, open an online order and choose **Add extras /
  charge original card**. Edit its priced modifiers, add items, or add an open
  item with a description and price. Existing order editing calculates tax and
  leaves only the added balance due on the same order.
- On the payment screen, confirm the customer approved the extra amount and tap
  **Charge original card**. The server reads the card identifier from the original
  captured Payarc charge, then creates a separate sale for the remaining balance.
  No checkout token is reused and no card number or CVV is stored or requested.
  This uses the documented `card_id` (and `customer_id` when present) fields of
  [Create a Charge](https://docs.payarc.net/reference/create-a-charge-keyed).
- The supplemental payment keeps its original payment ID, staff actor, approval,
  amount, and unique processor reference. Retrying an existing request only reads
  its charge. If the initial submission's outcome is unknown and there is no
  charge ID yet, it remains pending for webhook/reference reconciliation; it is
  never automatically submitted again.
- Canceled, refunded, already cashed-out, cross-workspace and stale-balance
  requests are refused. Pending tips/refunds/voids must be reconciled first.
  A missing reusable card or processor refusal leaves the balance unpaid.
- Supplemental food charges are excluded from the slip-tip queue. The original
  payment can still receive its extra slip tip after these sales are confirmed.
- Verification uses real isolated PostgreSQL, mocked processor responses and
  browser fixtures. No live customer charge was submitted during development.

## PAX A35 counter setup

1. Attach the communication cable to the USB-C port under the back cover and
   reinstall the cover. Connect Ethernet through the communication cable and
   power the A35 using the cable's DC input and the supplied adapter. The exact
   power connection depends on the supplied cable. Confirm Ethernet has an IP
   address. Position the reader where the customer can shield PIN entry.
   [PAX A35 Quick Setup Guide](https://www.pax.us/support/documents/a35-quick-setup-guide/)
2. Ask the processor to register the existing A35 serial to the store's merchant
   ID and provision the Payarc Connect app in V3 mode. Request the production Login
   and V3 API origins. Payarc lists Connect as
   a distinct application option for PAX devices.
   [Payarc terminal setup questionnaire](https://sales.payarc.com/hubfs/Partner_Resource_Center/Forms/Payarc_TSQ.pdf)
3. In Admin → Payments → Card readers, add **Front counter PAX A35** with the
   device's 10-digit serial as its Device ID and leave it Active.
4. Set the following server variables for the same environment and merchant as
   the existing Payarc connection. Keep the existing Payarc website and keyed-card
   settings in Admin → Payments.

   | Variable | Value |
   | --- | --- |
   | `PAYARC_CONNECT_LOCATION_ID` | UUID of the POS location where the A35 is registered |
   | `PAYARC_CONNECT_TERMINAL_SERIAL` | Registered 10-digit A35 serial |
   | `PAYARC_CONNECT_MID` | 12-digit Payarc Connect V3 tenant ID provided for the terminal |
   | `PAYARC_CONNECT_LOGIN_MID` | Merchant Profile MID when Payarc assigns a different ID for Connect Login |
   | `PAYARC_CONNECT_EMAIL` | Payarc merchant dashboard sign-in email |
   | `PAYARC_CONNECT_CLIENT_SECRET` | Merchant API Client Secret |
   | `PAYARC_CONNECT_API_TOKEN` | Optional bearer credential already verified against Payarc Connect V3 |
   | `PAYARC_CONNECT_CALLBACK_ORIGIN` | Public POS HTTPS origin, with no path or trailing slash |
   | `PAYARC_CONNECT_LOGIN_ORIGIN` | Provider-confirmed production Connect Login origin |
   | `PAYARC_CONNECT_API_ORIGIN` | Provider-confirmed production Connect V3 origin |

   The existing `PAYARC_API_TOKEN` and `PAYARC_ENVIRONMENT` are also used for
   Connect. The sandbox origins default to the hosts in the documentation.
   Payarc must be able to reach `/api/payments/payarc-connect/<payment-id>`
   on the configured public origin. Each callback URL carries a per-payment
   signature. The POS treats callbacks as notifications and verifies outcomes
   through an authenticated Payarc Connect transaction lookup.
   [Connect Login](https://docs.payarc.net/reference/login)
   [V3 transaction callbacks](https://docs.payarc.net/reference/transaction-callback-v3)
5. Apply `20261213080000_payarc_connect_counter_reader.sql` after the preceding
   database migrations. Deploy the application with the reader variables, then
   use **Check PAX connection** under Admin → Payments → Card readers. This
   checks authentication and live terminal connectivity without sending a sale.
   [Terminal connectivity](https://docs.payarc.net/reference/getterminalconnectivity)
6. On the counter POS choose **Card reader → Pay** on a normal order. On the
   paired customer tablet, select a tip or **No tip**. The register saves the
   tip and automatically sends the final total to the A35. The A35 uses that
   total for chip or contactless payment. Check the tablet total, the captured
   payment in the POS, and the charge in the merchant dashboard. Verify the same
   charge can be looked up by ID for voids and refunds through the merchant API.
   The POS Test order toggle simulates reader payments.
   [V3 sale](https://docs.payarc.net/reference/createsaletransaction)

If the register loses the result, use **Check reader payment**. A reopened ticket
can resume a pending payment on the same reader. If the result remains uncertain,
check the terminal and Payarc records before collecting payment again.
