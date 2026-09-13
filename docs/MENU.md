# The menu (loaded 2026-09-13)

Wayne's printed take-out menu (Shamrock Printing, 8/24) is now in the database as
ordinary rows. **Admin → Menu is the only place it is edited from here on.** Nothing in
the application refers to an item, price or topping by name, so Ehab can rename, reprice,
hide or add anything without a developer.

## What was loaded

| | Count |
| --- | --- |
| Categories | 15 |
| Items | 144 |
| Sizes (variants) | 164 |
| Option groups | 10 |
| Option choices | 107 |
| Item ↔ option links | 66 |

Categories in menu order: Pizza, Gourmet Pizza, Calzones, Appetizers, Salads, Cold Subs,
Hot Subs, Chicken Subs, Fat Subs, Wraps, Dinner Plates, Pasta, Kids Menu, Dessert,
Beverages.

## How the pricing is modelled

**Sizes are variants.** An item that has sizes prices from the size the customer picks;
its base price is unused. Small/Large for pizzas, calzones and subs; piece counts for
fingers, wings, sticks and poppers ("6 pieces", "12 pieces") so the register reads the way
the counter speaks.

**Pizza is priced by tier, exactly as printed.** Cheese, One-Topping, Two-Way Combo,
Three-Way Combo, each Small and Large. A topping costs a different amount on a small than
on a large, and the second and third toppings cost different amounts again, so the tier
carries the price and the topping list carries none — it tells the kitchen what goes on the
pizza. Extra Cheese is its own line at 1.95 / 2.85, as the menu prints it.

**Open question for Ehab:** the paper menu stops at three toppings. Four or more has no
printed price, so it cannot be ordered online today. He needs to say what a fourth topping
costs before that gap matters on a busy Friday.

**Shared option groups**, defined once and reused: pizza toppings (1, 2, 3 and an open list
for Make Your Own calzones), salad dressings (required, one of eleven including "No
dressing"), salad extras (extra meat 4.50, dressing 1.60, bread 1.65), quesadilla filling,
dinner-plate sides (exactly two, and two orders of fries is allowed), wrap bread, and cold-sub
requests (pickles, hot peppers, no provolone).

## Where it comes from

`scripts/menu-data.ts` holds the transcription, money in whole cents. It is a loading
source, not a runtime dependency — nothing in the app reads it.

- `npm run seed:menu` writes it to a database. It **creates only what is missing and
  changes nothing that exists**, so a price Ehab corrects in the admin survives a re-run,
  and nothing is ever deleted. `--visible` makes new items customer-facing immediately;
  without it they arrive hidden from customers but usable on the POS.
- `npx tsx scripts/menu-sql.ts > menu-load.sql` produces the same load as six guarded SQL
  statements, for a database the seed cannot reach over the network.

Production was loaded on 2026-09-13 and every item was then made customer-visible.

## Before this goes in front of a customer

- **Proof it.** Someone from Wayne's should read the menu screen against the paper menu
  line by line. A wrong modifier price is a wrong price on every ticket forever.
- **The meals-tax rate is still 0%** in Admin → Settings. Every order stores its own tax
  snapshot, so setting it later does not rewrite history — but until it is set, every total
  is short. Confirm the Worcester rate with Wayne's accountant.
- **Photographs.** Every item loaded without an image. The storefront works without them;
  they are worth adding for the items Wayne's wants to sell.
- **Daily items.** Fish & Chips and Shrimp Dinner are marked *Daily* on the paper menu.
  If they are not available every day, use the availability controls on the item rather
  than hiding and unhiding them by hand.
