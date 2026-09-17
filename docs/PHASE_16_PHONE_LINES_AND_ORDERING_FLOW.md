# Phase 16 — Caller ID, a POS that fits, member offers, and the ordering flow

Six changes, one release.

---

## 1. Caller ID on Line 1 and Line 2

### How Thrive does it (and how we do it)

Thrive does not read caller ID in software. Its own hardware requirements page
says it reads a **Whozz Calling?** unit from **CallerID.com** — the Ethernet
model is the one they recommend — and that CallerID.com's **Vertex** unit is the
VoIP equivalent. The store's phone lines physically pass through that box. Every
time a line rings, the box broadcasts a UDP packet on port **3520** describing
the ring: which line, the number, the name the carrier sent, and whether the call
is starting or ending.

Wayne's now reads the same hardware.

### What to buy

A **Whozz Calling? POS 2-line Ethernet** unit (about $200–250 from POS
resellers). Two-line is exactly right for Wayne's. If Wayne's ever moves the
phones to VoIP, the CallerID.com **Vertex** unit replaces it and nothing in this
code changes.

Wiring: the incoming lines go into the box, the box's outputs go to the phones,
and an Ethernet cable goes from the box to any switch or router in the store.

### The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| `scripts/callerid-bridge.mjs` | The store's counter computer | Listens for the box's UDP broadcast and posts each ring to the website |
| `POST /api/phone/calls` | The website | Accepts the ring, parses the record, records it |
| `wayne_record_phone_call(jsonb)` | Supabase | Normalizes the number and matches it to a customer as the row is written |
| `wayne_phone_line_board()` | Supabase | Every active line with its current call and matched customer |
| Phone panel | POS → Phone | Line 1 / Line 2 tiles, live |

A browser cannot listen for UDP, which is the only reason the bridge exists. It
is about eighty lines, needs nothing installed, and forwards the raw record so a
firmware quirk is fixed by deploying the site rather than by walking into the
store.

### Running the bridge

On the counter computer:

```bash
WAYNES_URL=https://waynespizzaofworcester.com \
CALLER_ID_INGEST_TOKEN=<the token set on the website> \
node scripts/callerid-bridge.mjs
```

Set the same `CALLER_ID_INGEST_TOKEN` in the site's environment (generate one
with `openssl rand -hex 32`). Without it the endpoint stays closed — otherwise
anyone could make Wayne's phone appear to ring.

Set it to start on login so nobody has to remember it.

### Testing it before the hardware arrives

```bash
curl -X POST https://waynespizzaofworcester.com/api/phone/calls \
  -H "authorization: Bearer $CALLER_ID_INGEST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"line_number":1,"caller_number":"5085550111"}'
```

Line 1 lights up in the POS within three seconds.

### At the counter

The phone rings → POS → **Phone** → the ringing line is outlined in green and
shows the number, the customer's name, and how many orders they have placed →
tap it → their card loads with their saved address, and the ticket is already
theirs. An unknown caller loads with the number filled in and a prompt for a
name, which then saves a profile for next time.

---

## 2. The POS fits the screen

The register was a scrolling web page: finding the subs meant scrolling the
whole window. It is now a fixed three-column screen inside the viewport. Only the
menu grid and the ticket scroll, each inside its own column, and the totals and
**Submit order** button are pinned to the bottom of the ticket where they belong.
The columns collapse at narrow widths, and the item tiles are denser so more of
the menu is reachable without scrolling at all.

---

## 3. Wayne's Rewards — "already a member?"

The join card asks for a name and a number because the person filling it in is
not a member yet. There is now a second card for people who already get Wayne's
texts: they enter the number their texts go to and see this week's member offers
plus any personal code still unspent. A number with no membership behind it gets
the invitation to join rather than an error.

It lives on **/offers** (new "Offers" tab in the nav) beside the public deals,
and on the rewards page.

### Setting the week's offers

Admin → Promotions, same screen as always, with one new checkbox: **Wayne's
Rewards members only**. Tick it and the promotion:

* is hidden from the public deals list,
* appears in the member lookup for opted-in numbers,
* is **refused at checkout** for anyone who is not an opted-in member — enforced
  in the database on `order_discounts`, so online checkout and the POS are
  covered by one rule.

Use the promotion's start and end times for the week's window.

### One bug fixed on the way past

`wayne_public_promotions()` had lost its `not private` filter in the Phase 12
rewrite, which meant **every member's personal welcome code was being listed
publicly on the home page**. It is restored here.

---

## 4. Delivery asks for the address first

Choosing **Delivery** now asks, before the first item goes in the cart:

* first and last name, mobile number,
* house / apartment / business / dorm — and the unit line only for the ones that
  need it,
* street, city, state, ZIP,
* anything the driver should know.

It also states the delivery time up front: **40–45 min**, from
`delivery_estimate_minutes` in Admin → Website settings, so a snowy night is a
settings change rather than a deploy.

Choosing **Pickup** asks for a name and says pay at the counter. Nothing else.

Whatever is entered is carried into checkout pre-filled, so nobody types their
address twice. "Switch to pickup" is the way out of the delivery question.

---

## 5. Social links in the header

TikTok, Instagram and Facebook, as brand icons at the top of every page, each
colouring in on hover. All three URLs live in Admin → Website settings — clearing
one takes that icon down. They also replaced the text links in the footer.

---

## 6. What still has to be done by hand

1. **Apply the migration** to the live Supabase project (`vxpkdmtornkeoedkawkt`):
   `supabase/migrations/20260919080000_phone_lines_member_offers_social.sql`.
   It must be run from Youssef's own Mac — Supabase is unreachable from the
   Claude sandbox and the device VM.
2. **Set `CALLER_ID_INGEST_TOKEN`** in the site's environment.
3. **Order the Whozz Calling? 2-line Ethernet unit** and wire it in.
4. **Run the bridge** on the counter computer.
5. **Run `npm run verify`** on the Mac. `tsc` and `eslint` both pass in the
   sandbox; `vitest` and `next build` cannot run there because this repo's
   `node_modules` are macOS binaries.

The migration's behaviour was verified against the full migration chain in
PGlite: all eighteen checks in `tests/phase16-phone-lines-member-offers.test.ts`
pass, including that the call log is unreachable with the anon key and that a
members-only code is refused for a non-member and accepted for a member.
