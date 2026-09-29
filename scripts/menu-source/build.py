#!/usr/bin/env python3
"""Build the Wayne's Pizza menu load SQL from the extracted source files.

Reads source.md (Appetizers / Build Your Own Pizza / Gourmet Pizza / Calzones),
items.psv (everything else) and sets.psv (the 52 modifier sets), applies the
agreed data fixes, and writes menu-load-full.sql.

Nothing here is baked into the app: every row it emits is an ordinary row that
Admin -> Menu can edit.
"""
import re, sys, json, collections

BASE = "/home/claude/menu_load"

def cents(x):
    return int(round(float(str(x).replace("$", "").strip()) * 100))

def norm(name):
    return re.sub(r"\s+", " ", name).strip()

# --- data fixes ------------------------------------------------------------
# (b) removing something is never a charge
FREE_REMOVALS = {"No Cheese", "No Sauce", "Light Cheese", "Light Sauce",
                 "Light Italian Dressing"}
FIXLOG = collections.Counter()

CATEGORY_ORDER = ["Vegetables", "Meats", "Cheese", "Sauces", "Salad Dressings",
                  "Extras", "Cooking Instructions"]

SET_LABEL = {
 "M1":"Appetizers","M2":"Cheese Fries & Potato Skins","M3":"Appetizer Plates",
 "M4":"Cheese Breadsticks","M5":"Cheese Pizza","M6":"Build Your Own Pizza",
 "M7":"Gourmet Pizza","M8":"Greek & Chicken Broccoli Garlic Pizza",
 "M9":"BBQ Chicken Pizza","M10":"Buffalo Chicken Pizza","M11":"White Pizza",
 "M12":"Grilled Chicken Pizza","M13":"Shrimp Scampi & Five Alarm Pizza",
 "M14":"Calzones","M15":"Cold Subs","M16":"Ham Sub","M17":"BLT Sub",
 "M18":"American Sub","M19":"Gyro","M20":"Chicken Parm Sub",
 "M21":"Burger & Cutlet Subs","M22":"Meatball & Sausage Subs",
 "M23":"Eggplant Parm Sub","M24":"Egg & Cheese Sub","M25":"Ham, Egg & Cheese Sub",
 "M26":"Bacon, Egg & Cheese Sub","M27":"Pepper, Egg & Cheese Sub",
 "M28":"Steak & Cheese / Teriyaki Subs","M29":"BBQ Steak Sub",
 "M30":"Steak & Onion Sub","M31":"Steak & Pepper Sub","M32":"Steak & Mushroom Sub",
 "M33":"Steak Special Sub","M34":"Steak Bomb Sub","M35":"Steak Tip Sub",
 "M36":"Hot Pastrami Sub","M37":"Grilled Chicken Sub","M38":"Chicken Stir Fry Sub",
 "M39":"Buffalo Chicken Sub","M40":"Chicken Club Sub",
 "M41":"Grilled Chicken Parmesan Sub","M42":"Chicken Cordon Bleu Sub",
 "M43":"Fat Subs","M44":"Caesar Wrap","M45":"Chicken Caesar Wrap",
 "M46":"Mediterranean Wraps","M47":"Salads","M48":"Pasta","M49":"Dinners",
 "M50":"Cheeseburger Dinner","M51":"Kids Meals","M52":"Kid's Cheeseburger",
}

# ---------------------------------------------------------------- sets.psv
LISTS, MAPS = {}, {}
raw_sets = collections.defaultdict(lambda: collections.defaultdict(dict))  # set -> tier -> cat -> {choice: cents}

def parse_tokens(tokens):
    out = {}
    # split on commas that are not inside a macro reference
    for tok in [t.strip() for t in tokens.split(",") if t.strip()]:
        if tok.startswith("@"):
            ref = tok[1:]
            if "=" in ref:
                nm, price = ref.split("=", 1)
                if nm not in LISTS:
                    sys.exit(f"unknown LIST {nm}")
                for choice in LISTS[nm]:
                    out[choice] = cents(price)
            else:
                if ref not in MAPS:
                    sys.exit(f"unknown MAP {ref}")
                out.update(MAPS[ref])
        else:
            nm, price = tok.rsplit(":", 1)
            out[norm(nm)] = cents(price)
    return out

for line in open(f"{BASE}/sets.psv"):
    line = line.rstrip("\n")
    if not line or line.startswith("#"):
        continue
    kind, name, rest = line.split("|", 2)
    if kind == "LIST":
        LISTS[name] = [norm(x) for x in rest.split(",")]
    elif kind == "MAP":
        MAPS[name] = parse_tokens(rest)
    elif kind == "SET":
        tier, cat, tokens = rest.split("|", 2)
        raw_sets[name][tier][cat] = parse_tokens(tokens)

# resolve ALL SIZES into the concrete tiers, then apply the fixes
SETS = {}
for sid, tiers in raw_sets.items():
    allsz = tiers.get("ALL SIZES", {})
    concrete = {}
    named = [t for t in tiers if t != "ALL SIZES"]
    tier_names = named if named else []
    # tiers an item may ask for; ALL SIZES answers anything
    for t in (named or ["ALL SIZES"]):
        merged = {c: dict(v) for c, v in allsz.items()}
        for c, v in tiers.get(t, {}).items():
            merged[c] = dict(v)
        concrete[t] = merged
    if allsz:
        concrete["ALL SIZES"] = {c: dict(v) for c, v in allsz.items()}
    SETS[sid] = concrete

# (a) Italian Style gave every topping away free -> charge the Large price
for sid, tiers in SETS.items():
    it, lg = tiers.get("Italian Style"), tiers.get("Large")
    if not it or not lg:
        continue
    for cat, choices in it.items():
        for choice, price in list(choices.items()):
            if price == 0 and choice not in FREE_REMOVALS:
                large = lg.get(cat, {}).get(choice)
                if large:
                    choices[choice] = large
                    FIXLOG["italian_style_free_topping"] += 1

# (b) removals are never a charge
for sid, tiers in SETS.items():
    for tier, cats in tiers.items():
        for cat, choices in cats.items():
            for choice, price in list(choices.items()):
                if choice in FREE_REMOVALS and price != 0:
                    choices[choice] = 0
                    FIXLOG["charged_for_removal"] += 1

# --------------------------------------------------------- shared required groups
DRESSINGS = ["Balsamic Vinaigrette Dressing","BBQ Dressing","Blue Cheese Dressing",
 "Caesar Dressing","French Dressing","Greek Dressing","Honey Mustard Dressing",
 "Hot Sauce Dressing","Italian Dressing","Light Italian Dressing","Oil & Vinegar",
 "Parmesan Peppercorn Dressing","Ranch Dressing","Thousand Island Dressing",
 "Extra Dressing"]
SHARED_REQ = {
 "DRESS": ("Salad Dressing", 0, len(DRESSINGS), DRESSINGS),
 # source listed every calzone in here as well - clearly a polluted option list
 "CHICK": ("Crispy or Grilled Chicken", 0, 1, ["Crispy Chicken", "Grilled Chicken"]),
 "PASTA": ("Pasta Choice", 0, 1, ["Spaghetti", "Ziti"]),
 "SIDES": ("Dinner Side Choice", 2, 2, ["French Fries","Onion Rings","Rice Pilaf","Curly Fries"]),
}

items = []          # dicts: key, category, name, description, modset, variants[(name,cents)], base, reqs[]
req_groups = {}     # name -> (min,max,[choices])

def add_req(name, mn, mx, choices):
    name = norm(name)
    if name in req_groups:
        prev = req_groups[name]
        if prev != (mn, mx, choices):
            sys.exit(f"conflicting required group {name}")
    else:
        req_groups[name] = (mn, mx, choices)
    return name

# ---------------------------------------------------------------- source.md
md = open(f"{BASE}/source.md").read()
cur_cat = None
SKIP_CATS = {"LG Cheese Pizza Pick-Up Special"}
blocks = re.split(r"\n(?=## )", md)
for block in blocks:
    m = re.match(r"## (.+)", block)
    if not m:
        continue
    cur_cat = norm(m.group(1).split(" — ")[0])
    if cur_cat in SKIP_CATS:
        continue
    for chunk in re.split(r"\n(?=### )", block)[1:]:
        head = re.match(r"### (.+)", chunk).group(1)
        name = norm(head.split(" — ")[0])
        base = cents(head.split(" — ")[1]) if " — " in head else 0
        comes = re.search(r"\*\*Comes with:\*\* (.+)", chunk)
        variants = [(norm(r[0]), cents(r[1])) for r in
                    re.findall(r"^\| (?!Size|---)([^|]+?) \| \$([\d.]+) \|", chunk, re.M)]
        modset = re.search(r"see set `(M\d+)`", chunk)
        reqs = []
        for rq in re.finditer(r"\*\*REQUIRED — (.+?)\*\* \((.+?)\):\n> (.+)", chunk):
            label, rule, choices = rq.group(1), rq.group(2), rq.group(3)
            n = int(re.search(r"choose (\d+)", rule).group(1))
            mn = 0 if "can decline" in rule else n
            reqs.append(add_req(f"{name} – {label}" if label == name else label,
                                mn, n, [norm(c) for c in choices.split(",")]))
        items.append(dict(key=f"{cur_cat}|{name}", category=cur_cat, name=name,
                          description=norm(comes.group(1)) if comes else "",
                          modset=modset.group(1) if modset else None,
                          variants=variants, base=base, reqs=reqs))

# ---------------------------------------------------------------- items.psv
for line in open(f"{BASE}/items.psv"):
    line = line.rstrip("\n")
    if not line or line.startswith("#"):
        continue
    cat, name, comes, modset, sizes, reqs, desc = (line.split("|") + [""] * 7)[:7]
    cat, name = norm(cat), norm(name)
    variants, base = [], 0
    if sizes.startswith("S3:"):
        p = cents(sizes[3:]); variants = [("One Size", p), ("White Wrap", p), ("Wheat Wrap", p)]
    elif sizes.startswith("W2:"):
        p = cents(sizes[3:]); variants = [("White Wrap", p), ("Wheat Wrap", p)]
    elif sizes.startswith("BASE:"):
        base = cents(sizes[5:])
    elif sizes:
        variants = [(norm(a), cents(b)) for a, b in
                    (s.split("=") for s in sizes.split(";"))]
    rq = []
    for token in [t for t in reqs.split(";;") if t.strip()]:
        if token in SHARED_REQ:
            rq.append(add_req(*SHARED_REQ[token]))
        else:
            label, mn, mx, choices = token.split("~")
            rq.append(add_req(label, int(mn), int(mx), [norm(c) for c in choices.split(",")]))
    items.append(dict(key=f"{cat}|{name}", category=cat, name=name,
                      description=norm(desc) or norm(comes),
                      modset=modset or None, variants=variants, base=base, reqs=rq))

# ---------------------------------------------------------------- sanity
keys = [i["key"] for i in items]
dupes = [k for k, n in collections.Counter(keys).items() if n > 1]
if dupes:
    sys.exit(f"duplicate items: {dupes}")
for i in items:
    if i["modset"] and i["modset"] not in SETS:
        sys.exit(f"{i['name']} refers to unknown set {i['modset']}")

categories = []
for i in items:
    if i["category"] not in categories:
        categories.append(i["category"])

# --------------------------------------------- modifier groups from the sets
groups = {}   # key -> dict(name, customer_label, min, max, required, sort, choices{name:cents})
def gkey(sid, cat):
    return f"{sid}::{cat}"

for sid, tiers in SETS.items():
    cats = collections.OrderedDict()
    for tier in tiers.values():
        for cat, choices in tier.items():
            cats.setdefault(cat, collections.OrderedDict())
            for choice in choices:
                cats[cat].setdefault(choice, None)
    for cat, choices in cats.items():
        # the price a size-less item pays, and the fallback for anything unmatched
        default_tier = next((t for t in ("Large", "ALL SIZES", "One Size") if t in tiers),
                            list(tiers)[0])
        prices = {}
        for choice in choices:
            p = tiers.get(default_tier, {}).get(cat, {}).get(choice)
            if p is None:
                for t in tiers.values():
                    if choice in t.get(cat, {}):
                        p = t[cat][choice]; break
            prices[choice] = p or 0
        groups[gkey(sid, cat)] = dict(
            name=f"{SET_LABEL[sid]} – {cat}", customer_label=cat,
            min=0, max=len(prices), required=False,
            sort=(CATEGORY_ORDER.index(cat) + 2) * 10 if cat in CATEGORY_ORDER else 900,
            choices=prices)

for name, (mn, mx, choices) in req_groups.items():
    groups[f"REQ::{name}"] = dict(name=name, customer_label=name, min=mn, max=mx,
                                  required=mn > 0, sort=10,
                                  choices=collections.OrderedDict((c, 0) for c in choices))

gnames = [g["name"] for g in groups.values()]
dupes = [k for k, n in collections.Counter(gnames).items() if n > 1]
if dupes:
    sys.exit(f"duplicate group names: {dupes}")

# --------------------------------------------- per-size overrides
def resolve_tier(sid, variant_name):
    tiers = SETS[sid]
    if variant_name in tiers:
        return variant_name
    if "ALL SIZES" in tiers:
        return "ALL SIZES"
    if len(tiers) == 1:
        return list(tiers)[0]
    return None

varmeta, itemset, resolves, tierprices = [], [], set(), []
for i in items:
    if not i["modset"]:
        continue
    itemset.append((i["key"], i["modset"]))
    for vname, _ in i["variants"]:
        t = resolve_tier(i["modset"], vname)
        if t is None:
            print(f"  ! no modifier prices for {i['name']} / {vname}", file=sys.stderr)
            continue
        varmeta.append((i["key"], vname))
        resolves.add((i["modset"], vname, t))

for sid, tiers in SETS.items():
    for tier, cats in tiers.items():
        for cat, choices in cats.items():
            g = groups[gkey(sid, cat)]
            for choice, price in choices.items():
                if price != g["choices"].get(choice):      # only real overrides
                    tierprices.append((sid, tier, gkey(sid, cat), choice, price))

# ---------------------------------------------------------------- emit JSON
import json as _json

payload = {
  "categories": [{"name": c, "sort_order": (n + 1) * 10} for n, c in enumerate(categories)],
  "items": [], "groups": [], "links": [], "variant_prices": [],
}

per_cat = collections.Counter()
for i in items:
    per_cat[i["category"]] += 1
    payload["items"].append({
        "key": i["key"], "category": i["category"], "name": i["name"],
        "description": ("Comes with: " + i["description"]) if i["description"] else "",
        "base_price_cents": 0 if i["variants"] else i["base"],
        "sort_order": per_cat[i["category"]] * 10,
        "variants": [{"name": v, "price_cents": p, "sort_order": n * 10}
                     for n, (v, p) in enumerate(i["variants"])],
    })

for k, g in groups.items():
    payload["groups"].append({
        "key": k, "name": g["name"], "customer_label": g["customer_label"],
        "min_select": g["min"], "max_select": g["max"], "required": g["required"],
        "sort_order": g["sort"],
        "choices": [{"name": c, "price_delta_cents": p, "sort_order": n * 10}
                    for n, (c, p) in enumerate(g["choices"].items())],
    })

for i in items:
    keys = [f"REQ::{r}" for r in i["reqs"]]
    if i["modset"]:
        keys += [k for k in groups if k.startswith(f"{i['modset']}::")]
    for n, k in enumerate(keys):
        payload["links"].append({"item": i["key"], "group": k, "sort_order": n * 10})

tp_index = collections.defaultdict(list)
for sid, tier, gk, choice, price in tierprices:
    tp_index[(sid, tier)].append((gk, choice, price))

for i in items:
    if not i["modset"]:
        continue
    for vname, _ in i["variants"]:
        tier = resolve_tier(i["modset"], vname)
        if tier is None:
            continue
        for gk, choice, price in tp_index[(i["modset"], tier)]:
            payload["variant_prices"].append({
                "group": gk, "choice": choice, "item": i["key"],
                "variant": vname, "price_delta_cents": price})

open(f"{BASE}/menu-data-full.json", "w").write(_json.dumps(payload))

nsizes = sum(len(x["variants"]) for x in payload["items"])
nchoices = sum(len(x["choices"]) for x in payload["groups"])
print("categories       ", len(payload["categories"]))
print("items            ", len(payload["items"]))
print("sizes            ", nsizes)
print("option groups    ", len(payload["groups"]), " required-choice:", len(req_groups))
print("option choices   ", nchoices)
print("item-group links ", len(payload["links"]))
print("per-size prices  ", len(payload["variant_prices"]))
print("fixes applied    ", dict(FIXLOG))
