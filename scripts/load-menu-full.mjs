/**
 * Loads Wayne's complete live menu (menu-data-full.json) into Supabase.
 *
 * Everything it writes is ordinary editable data: categories, items, sizes,
 * option groups, option choices, and the per-size option prices. Once this has
 * run, every name and price is changed from Admin -> Menu, not from code.
 *
 * The earlier simplified seed is archived (archived_at set), never deleted, so
 * nothing is lost and no order history breaks.
 *
 *   node scripts/load-menu-full.mjs            # load
 *   node scripts/load-menu-full.mjs --dry-run  # report only, write nothing
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const dryRun = process.argv.includes("--dry-run");

// --- environment ----------------------------------------------------------
function readEnv() {
  const out = { ...process.env };
  for (const file of [".env.local", ".env"]) {
    let text;
    try {
      text = readFileSync(resolve(repo, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const env = readEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local).");
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

async function rest(method, path, body, prefer) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: prefer ? { ...headers, Prefer: prefer } : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : [];
}

async function insertAll(table, rows, select) {
  const out = [];
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    const path = select ? `${table}?select=${select}` : table;
    out.push(...(await rest("POST", path, batch, "return=representation")));
    process.stdout.write(`\r  ${table}: ${Math.min(i + 400, rows.length)}/${rows.length}   `);
  }
  process.stdout.write(`\r  ${table}: ${rows.length} rows written\n`);
  return out;
}

// --- data -----------------------------------------------------------------
const data = JSON.parse(readFileSync(resolve(here, "menu-data-full.json"), "utf8"));
const counts = {
  categories: data.categories.length,
  items: data.items.length,
  sizes: data.items.reduce((n, i) => n + i.variants.length, 0),
  groups: data.groups.length,
  choices: data.groups.reduce((n, g) => n + g.choices.length, 0),
  links: data.links.length,
  perSizePrices: data.variant_prices.length,
};
console.log("Wayne's Pizza - full menu load");
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(16)} ${v}`);
if (dryRun) {
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

// --- archive the old simplified seed --------------------------------------
console.log("\nArchiving the previous menu (soft archive - nothing is deleted)…");
const now = new Date().toISOString();
await rest("DELETE", "menu_item_modifier_groups?menu_item_id=not.is.null");
await rest("PATCH", "menu_item_variants?archived_at=is.null", { archived_at: now });
await rest("PATCH", "modifier_choices?archived_at=is.null", { archived_at: now });
await rest("PATCH", "modifier_groups?archived_at=is.null", { archived_at: now });
await rest("PATCH", "menu_items?archived_at=is.null", {
  archived_at: now, customer_visible: false, pos_visible: false,
});
await rest("PATCH", "menu_categories?archived_at=is.null", {
  archived_at: now, customer_visible: false,
});

// --- load ------------------------------------------------------------------
console.log("\nLoading the live menu…");

const categoryId = new Map();
for (const row of await insertAll("menu_categories",
  data.categories.map((c) => ({ ...c, description: "", customer_visible: true })),
  "id,name")) categoryId.set(row.name, row.id);

const itemId = new Map();
{
  const rows = data.items.map((i) => ({
    category_id: categoryId.get(i.category),
    name: i.name,
    description: i.description,
    base_price_cents: i.base_price_cents,
    sort_order: i.sort_order,
    customer_visible: true,
    pos_visible: true,
  }));
  const written = await insertAll("menu_items", rows, "id,name,category_id");
  const byName = new Map(written.map((r) => [`${r.category_id}|${r.name}`, r.id]));
  for (const i of data.items) {
    const id = byName.get(`${categoryId.get(i.category)}|${i.name}`);
    if (!id) throw new Error(`no id captured for item ${i.key}`);
    itemId.set(i.key, id);
  }
}

const variantId = new Map();
{
  const rows = [];
  const keys = [];
  for (const i of data.items) {
    for (const v of i.variants) {
      rows.push({ menu_item_id: itemId.get(i.key), name: v.name, price_cents: v.price_cents, sku: "", sort_order: v.sort_order });
      keys.push(`${i.key}|${v.name}`);
    }
  }
  const written = await insertAll("menu_item_variants", rows, "id,name,menu_item_id");
  const byName = new Map(written.map((r) => [`${r.menu_item_id}|${r.name}`, r.id]));
  rows.forEach((row, index) => {
    const id = byName.get(`${row.menu_item_id}|${row.name}`);
    if (!id) throw new Error(`no id captured for size ${keys[index]}`);
    variantId.set(keys[index], id);
  });
}

// Groups a customer can ask for extra of (extra ham, double pepperoni).
function toppingGroup(g) {
  return / – (Vegetables|Meats|Cheese)$/.test(g.name) || /^(One|Two|Three) Topping Pizza – Toppings?$/.test(g.name) || g.name === "Pasta Special – Toppings";
}
const groupId = new Map();
{
  const rows = data.groups.map((g) => ({
    name: g.name, customer_label: g.customer_label, min_select: g.min_select,
    // Sauces, extra dressings (20260925080000) and toppings (20260928080000)
    // can be doubled.  Topping groups whose limit is "every option once" get
    // room for three portions of each.
    max_select: toppingGroup(g) && g.max_select >= g.choices.length && g.choices.length > 0 ? Math.max(g.max_select, g.choices.length * 3) : g.max_select,
    required: g.required,
    allow_quantities: toppingGroup(g) || (g.max_select > 1 && ((g.name.endsWith(" – Sauces") && g.name !== "Pasta – Sauces") || g.name === "Salads – Salad Dressings")),
    sort_order: g.sort_order,
  }));
  const written = await insertAll("modifier_groups", rows, "id,name");
  const byName = new Map(written.map((r) => [r.name, r.id]));
  for (const g of data.groups) {
    const id = byName.get(g.name);
    if (!id) throw new Error(`no id captured for option group ${g.name}`);
    groupId.set(g.key, id);
  }
}

const choiceId = new Map();
{
  const rows = [];
  const keys = [];
  for (const g of data.groups) {
    for (const c of g.choices) {
      rows.push({ modifier_group_id: groupId.get(g.key), name: c.name, price_delta_cents: c.price_delta_cents, sort_order: c.sort_order });
      keys.push(`${g.key}||${c.name}`);
    }
  }
  const written = await insertAll("modifier_choices", rows, "id,name,modifier_group_id");
  const byName = new Map(written.map((r) => [`${r.modifier_group_id}|${r.name}`, r.id]));
  rows.forEach((row, index) => {
    const id = byName.get(`${row.modifier_group_id}|${row.name}`);
    if (!id) throw new Error(`no id captured for option ${keys[index]}`);
    choiceId.set(keys[index], id);
  });
}

await insertAll("menu_item_modifier_groups", data.links.map((l) => ({
  menu_item_id: itemId.get(l.item),
  modifier_group_id: groupId.get(l.group),
  sort_order: l.sort_order,
})), "menu_item_id");

await insertAll("modifier_choice_variant_prices", data.variant_prices.map((p) => ({
  modifier_choice_id: choiceId.get(`${p.group}||${p.choice}`),
  menu_item_variant_id: variantId.get(`${p.item}|${p.variant}`),
  price_delta_cents: p.price_delta_cents,
})), "id");

console.log("\nDone. Open Admin -> Menu; every item, size, option and price there is editable.");
