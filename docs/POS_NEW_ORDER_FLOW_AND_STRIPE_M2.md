# POS: New Order card, live customer search, Stripe Reader M2

Owner request, 2026-09-30.

## 1. New Order card (no more cramped left panel)

Every ticket now starts with a card in the middle of the screen, one step at a time:

1. **Order type** — Walk-in / Pickup / Delivery (Delivery shows the fee, and is greyed out when delivery is off). For Pickup and Delivery a switch records whether it was **On the phone** or **In the store**.
2. **Customer** — phone, first and last name. Matching customers appear **as you type** (3+ digits of a phone or 2+ letters of a name); tap one to fill everything in. "Not them" lets go of a match. Pickup can "Skip — just put a name on the ticket" (no profile).
3. **Delivery address** (delivery only) — the customer's saved addresses as big buttons, or a new address with Google address search, unit, city/state/ZIP and delivery instructions. A ZIP outside Admin → Settings → delivery ZIPs shows a warning.

**Start order** checks the same rules the order API enforces (full name + 10-digit phone for a profile; complete address for delivery), then opens the menu.

The menu screen is now two columns: **menu** (search + category tabs, one category at a time — no small scrolling boxes) and **ticket**. A bar across the top says what the ticket is ("🚗 Delivery · Maria Lopez · (508) 555-0199 · 12 Main St, Worcester") — tap it (or **Edit**) to go back to the card; the items stay on the ticket. **＋ New order** holds the current ticket and opens a fresh card. Held tickets and "Other registers" stay in the top bar.

- Phone calls (caller ID) open the card with the number, line and caller name already filled in.
- Customers → Start order opens the card with that customer already chosen.
- Tickets saved before this change open straight to the menu (`started` defaults to true when missing).

Code: `src/app/pos/start-order-card.tsx`, `src/lib/orders/start-order.ts` (rules, tested), `src/app/pos/order-screen.tsx`, `started` on the draft in `src/lib/orders/drafts.ts`.

## 2. Live customer search

`src/app/pos/use-customer-search.ts` — searches 250 ms after typing stops, cancels the previous request, ignores late answers. Used by the New Order card and the Customers screen (the Find button is gone). Uses the existing `wayne_pos_customer_search` (partial phone / name / address / email / order #), so no database change.

## 3. Stripe Reader M2

The M2 is a **Bluetooth** reader. Stripe only supports it through its iOS / Android / React Native SDKs — it cannot be driven from a web browser. So:

- The **Wayne's POS Android app** (android/) now includes the Stripe Terminal Android SDK 5.8.1 (`StripeReader.java`). It discovers and connects the M2, installs required reader updates, and takes the card.
- The **website** does everything else. Server routes (all need POS access, same origin, Stripe connected, and the M2 switched on):

| Route | What it does |
| --- | --- |
| `POST /api/pos/stripe-terminal/connection-token` | Short-lived token the app's SDK needs (the app asks the signed-in page, the page asks the server — the secret key never leaves the server) |
| `POST /api/pos/stripe-terminal/location` | Finds or creates the Stripe Terminal Location from Admin → Settings' store address (tagged with the workspace id) |
| `POST /api/pos/stripe-terminal/intent` | Opens the ledger payment (`wayne_begin_payment`, entry `terminal` so the drawer opens) and a `card_present` PaymentIntent. Reuses the open one after a decline or a dropped app, so one order never has two authorisations; cancels and replaces it if the order total changed |
| `POST /api/pos/stripe-terminal/confirm` | Re-reads Stripe (never trusts the app) and settles: captured → order paid, card brand/last 4 recorded |
| `POST /api/pos/stripe-terminal/cancel` | Cancels the PaymentIntent (if not already paid) and voids the payment so the order can be paid with cash |

- Payments are captured automatically, on the **same Stripe account** as online checkout (`env:STRIPE`: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` on Vercel).
- A declined card leaves the PaymentIntent open for the next card (Stripe's recommended pattern); the Stripe webhook no longer marks those as failed (`metadata.wayne_entry = terminal`).
- Payments → Card shows **Card reader (Stripe M2)**: status + battery, **Charge $X on the reader**, the reader's live prompt ("Tap, insert or swipe the card", "Remove the card"…), **Try another card** after a decline, **Cancel card payment**. The old "Approved on a separate terminal" steps stay underneath as a fallback.
- More → **Card reader** shows the reader status with **Connect reader**. The app reconnects the reader by itself when the POS opens.
- In a normal browser the page says the reader works in the Android app.

### Switching it on

1. Build and install the app (Android Studio, `android/` → Run). versionName is now 1.1.
2. Admin → Hardware → Payment terminal → **Stripe Reader M2** → Save.
3. On the tablet: open the POS in the app, press the M2's button once, More → Card reader → **Connect reader**. Allow **Nearby devices** and **Location** when Android asks (Stripe requires location to take payments). The first connection may install a reader update (a few minutes; battery over 50%).
4. Make sure Admin → Settings has the store's street address (Stripe needs it for the reader's location).
5. Do **not** pair the M2 in Android's Bluetooth settings — the app pairs it.

### Database

`20261018080000_stripe_reader_m2` (applied to live Supabase): the provider catalog now says Stripe can take card-present payments. The on/off switch lives in `location_hardware_configurations.configuration.payment_terminal_mode` (`manual_external` | `integrated`), which already existed.

### Not verified here

- The Android app was not compiled in the Claude session (Maven Central / Google Maven are blocked there). Build it in Android Studio; the Stripe calls match the SDK 5.8.1 reference and its Java example app.
- End-to-end with a real M2 needs the hardware. Stripe test mode: switch the Stripe keys to test keys on a preview deployment and use a physical test card, or the SDK's simulated reader.

## 4. Payment prompt right after sending (2026-09-30, later)

Submit order → "Sent to the kitchen" → **How are they paying?**: 💵 Cash (keypad, change due), 💳 Card reader (Stripe M2 in the app, or the separate terminal + "Approved"), ⌨️ Key in card (Stripe's secure card field — now allowed for any order, not just phone deliveries), ⏱ Pay later (order stays unpaid in Payments). After payment: change due / print receipt / Next order. The Payments screen uses the same three tenders. A ringing phone doesn't auto-open while this prompt is up.

## 5. Android app: running it in the emulator

`app.hanafymedia.com` currently serves the Hanafy Media marketing site (404 for /pos), so the app — which opens `https://app.hanafymedia.com/pos` — shows a 404 until that subdomain points at the Vercel POS project (Vercel → Domains → add app.hanafymedia.com; Cloudflare DNS → CNAME `app` → `cname.vercel-dns.com`, DNS only, and no Worker route covering `app.hanafymedia.com`).

Open **`~/Downloads/waynes-pizza-pos/android`** itself in Android Studio (File → Open). The old "My Application" wrapper project in ~/AndroidStudioProjects only pointed at this app folder and ignored its settings.

To test now, add one line to `android/local.properties` (not committed) and re-run — it only affects **debug** builds; store (release) builds always open the live address:

- Emulator against `npm run dev` on the Mac: `waynesPosUrl=http://10.0.2.2:3000/pos`
- Or any https deployment: `waynesPosUrl=https://<preview>.vercel.app/pos`

Debug builds allow plain http only to 10.0.2.2 / localhost; release builds stay https-only. `next.config.ts` allows the 10.0.2.2 dev origin. The M2 can't be used in the emulator (no Bluetooth) — use a real tablet for the reader.
