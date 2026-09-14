# Phase 14 — Wayne's complete live menu, with per-size option pricing

Wayne's real menu is now in the database: the same 18 categories, 197 items and
281 sizes that the live Thrive/Granbury ordering system serves, with all 52
option sets behind them.

Nothing on this page is hardcoded. Every category, item, size, option group,
option and price below is an ordinary row, editable in **Admin → Menu**.

## What changed in the app

Wayne charges a different amount for the same topping depending on the size —
pepperoni is $1.00 on a small pizza, $1.50 gluten free and $2.00 on a large. The
old schema could only hold one price per option, so per-size pricing was added:

- `modifier_choice_variant_prices` — one optional price per (option, size).
- `wayne_write_menu_children` writes those rows; `wayne_public_menu` and
  `wayne_pos_menu` return them, so online ordering and the POS price alike.
- `cartLineUnitCents` prefers the size's own price and falls back to the
  option's default price when a size has no override.
- Admin → Menu shows a price box per size under each option. Leave one blank
  and that size uses the default price shown as its placeholder.

## What was loaded

| | |
|---|---|
| Categories | 18 |
| Items | 197 |
| Sizes | 281 |
| Option groups | 253 (9 of them required choices) |
| Options | 2,026 |
| Per-size option prices | 1,483 |

Option groups are shared between the items that share them, exactly as Wayne's
own system does it — editing "Build Your Own Pizza – Vegetables" changes it for
the one, two and three topping pizzas together. Groups are named after the
items they belong to so it is clear in Admin what each one drives.

The previous simplified printed-menu seed was **archived, not deleted**
(`archived_at` set), so nothing was lost and no order history can break.

## Data fixes applied during the load

Wayne's live system has some mistakes in it. These were corrected on the way in
rather than copied. Each is a normal row, so any of them can be changed back in
Admin → Menu if Ehab disagrees.

1. **Italian Style pizzas gave every topping away free** (65 options). The live
   system charges $0.00 for toppings on Italian Style while charging $1.00–$2.00
   for the same topping on every other size. Each now charges the large price.
2. **Removing something was a charge** (113 options). "No Cheese", "Light
   Cheese", "Light Sauce" and "Light Italian Dressing" were priced at $1.00–$2.50.
   All are now $0.00.
3. **Sausage cost $22.00 on a white wrap** (6 subs). A typo for $2.00 — the
   price charged on every other size of the same sub. Now $2.00.
4. **The salad chicken choice listed all 22 calzones** as options for "Crispy or
   Grilled Chicken". Trimmed to Crispy Chicken and Grilled Chicken.
5. **"Dirty Sour Cream & Onion" chips appeared twice**, at $2.35 and $2.50. Kept
   the $2.50 one, which matches the other Dirty chips.

Two oddities were **left as they are**, because they may be deliberate:

- A small calzone charges $0.00 for jalapenos while a large charges $1.50.
- Pasta lets the customer decline the spaghetti-or-ziti choice.

## Re-running the load

    node scripts/load-menu-full.mjs --dry-run   # report only
    node scripts/load-menu-full.mjs            # archive the old menu, load this one

It reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from
`.env.local`. It must be run from a machine that can reach Supabase directly.

`scripts/menu-data-full.json` is what it loads. That file is generated from the
extract in `scripts/menu-source/` by `scripts/menu-source/build.py`, so a future
menu pull can be regenerated the same way. Neither file is read at runtime — once
the load has run, the database is the only source of truth.
