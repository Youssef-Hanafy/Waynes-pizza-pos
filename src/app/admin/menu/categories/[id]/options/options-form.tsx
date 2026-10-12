"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

export type OptionSection = {
  key: string;
  label: string;
  min_select: number;
  max_select: number;
  required: boolean;
  allow_quantities: boolean;
  /** How many of the category's items have this section. */
  item_count: number;
  /**
   * Included portions per size (owner, 2026-10-12): "Large comes with 3
   * sauces, up to 5, each extra $0.75".  Key "" = items without sizes.
   */
  size_rules: Record<string, { included_count: number; max_portions: number | null; extra_each_cents: number | null }>;
  choices: {
    key: string;
    name: string;
    /** null when items charge different amounts. */
    price_cents: number | null;
    /** Per size name: one price, "varies", or null (uses the regular price). */
    size_prices: Record<string, number | "varies" | null>;
    item_count: number;
  }[];
};

type ChoiceState = {
  id: string;
  key: string | null;
  name: string;
  price: string;
  sizes: Record<string, string>;
  everywhere: boolean;
  remove: boolean;
  original: OptionSection["choices"][number] | null;
};
type RuleState = { included: string; max: string; extra: string };
type SectionState = {
  rules: Record<string, RuleState>;
  key: string;
  label: string;
  min: string;
  max: string;
  required: boolean;
  allowQuantities: boolean;
  addToAll: boolean;
  itemCount: number;
  choices: ChoiceState[];
  original: OptionSection;
};

const money = (cents: number) => (cents / 100).toFixed(2);
function parseMoney(value: string): number | null | "bad" {
  const trimmed = value.trim().replace(/^\$/, "");
  if (!trimmed) return null;
  if (!/^-?\d*(\.\d{1,2})?$/.test(trimmed) || trimmed === "-" || trimmed === ".") return "bad";
  return Math.round(Number(trimmed) * 100);
}

/** The saved included-portions rule of a section on one size, as form text. */
function ruleOf(section: OptionSection, size: string): RuleState {
  const rule = Object.entries(section.size_rules ?? {}).find(([name]) => name.trim().toLowerCase() === size.trim().toLowerCase())?.[1];
  return { included: rule ? String(rule.included_count) : "", max: rule?.max_portions ? String(rule.max_portions) : "", extra: rule && rule.extra_each_cents !== null ? money(rule.extra_each_cents) : "" };
}

let counter = 0;
const nextId = () => `new-${++counter}`;

export function CategoryOptionsForm({ action, itemCount, sections, sizeNames }: {
  action: (formData: FormData) => void | Promise<void>;
  itemCount: number;
  sections: OptionSection[];
  sizeNames: string[];
}) {
  const showSizes = sizeNames.length > 1;
  // Included-portion rows: one per size, or one for the whole category.
  const ruleSizes = useMemo(() => (sizeNames.length ? sizeNames : [""]), [sizeNames]);
  const [state, setState] = useState<SectionState[]>(() => sections.map((section) => ({
    rules: Object.fromEntries(ruleSizes.map((size) => [size, ruleOf(section, size)])),
    key: section.key,
    label: section.label,
    min: String(section.min_select),
    max: String(section.max_select),
    required: section.required,
    allowQuantities: section.allow_quantities,
    addToAll: false,
    itemCount: section.item_count,
    original: section,
    choices: section.choices.map((choice) => ({
      id: choice.key,
      key: choice.key,
      name: choice.name,
      price: choice.price_cents === null ? "" : money(choice.price_cents),
      sizes: Object.fromEntries(sizeNames.map((size) => {
        const value = choice.size_prices[size];
        return [size, typeof value === "number" ? money(value) : ""];
      })),
      everywhere: false,
      remove: false,
      original: choice,
    })),
  })));
  const [error, setError] = useState("");

  function patchSection(index: number, patch: Partial<SectionState>) {
    setState((current) => current.map((section, i) => (i === index ? { ...section, ...patch } : section)));
  }
  function patchChoice(sectionIndex: number, choiceId: string, patch: Partial<ChoiceState>) {
    setState((current) => current.map((section, i) => (i === sectionIndex
      ? { ...section, choices: section.choices.map((choice) => (choice.id === choiceId ? { ...choice, ...patch } : choice)) }
      : section)));
  }
  function addChoice(sectionIndex: number) {
    setState((current) => current.map((section, i) => (i === sectionIndex
      ? { ...section, choices: [...section.choices, { id: nextId(), key: null, name: "", price: "0.00", sizes: Object.fromEntries(sizeNames.map((size) => [size, ""])), everywhere: true, remove: false, original: null }] }
      : section)));
  }

  /** Only what changed goes to the server. */
  const payload = useMemo(() => {
    const problems: string[] = [];
    const sizeRules: { label: string; rules: { size_name: string; included_count: number; max_portions: number | null; extra_each_cents: number | null }[] }[] = [];
    const out = state.map((section) => {
      const min = Number(section.min);
      const max = Number(section.max);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || max < min) {
        problems.push(`${section.label}: "fewest" must be 0 or more and "most" at least 1 and not less than "fewest".`);
      }
      const choices = section.choices.flatMap((choice) => {
        if (!choice.key && (!choice.name.trim() || choice.remove)) return [];
        if (choice.remove) return [{ key: choice.key, name: choice.name, price_cents: null, variant_prices: {}, everywhere: false, remove: true }];
        const price = parseMoney(choice.price);
        if (price === "bad") { problems.push(`${section.label} › ${choice.name || "new option"}: price "${choice.price}" isn't a dollar amount.`); return []; }
        const original = choice.original;
        const priceChanged = price !== null && (!original || original.price_cents !== price);
        const variantPrices: Record<string, number | "clear" | null> = {};
        let sizeChanged = false;
        for (const size of sizeNames) {
          const raw = choice.sizes[size] ?? "";
          const parsed = parseMoney(raw);
          if (parsed === "bad") { problems.push(`${section.label} › ${choice.name}: ${size} price "${raw}" isn't a dollar amount.`); continue; }
          const before = original?.size_prices[size] ?? null;
          if (parsed === null) {
            if (typeof before === "number") { variantPrices[size] = "clear"; sizeChanged = true; }
          } else if (before !== parsed) {
            variantPrices[size] = parsed; sizeChanged = true;
          }
        }
        const nameChanged = !original || original.name !== choice.name.trim();
        if (!choice.key || nameChanged || priceChanged || sizeChanged || choice.everywhere) {
          if (!choice.name.trim()) { problems.push(`${section.label}: every option needs a name.`); return []; }
          return [{ key: choice.key, name: choice.name.trim(), price_cents: priceChanged || !choice.key ? (price ?? 0) : null, variant_prices: variantPrices, everywhere: choice.everywhere, remove: false }];
        }
        return [];
      });
      const original = section.original;
      const sizeRulesChanged = ruleSizes.some((size) => {
        const now = section.rules[size]!;
        const before = ruleOf(original, size);
        return now.included.trim() !== before.included || now.max.trim() !== before.max || (parseMoney(now.extra) ?? null) !== (parseMoney(before.extra) ?? null);
      });
      if (sizeRulesChanged) {
        const rules = ruleSizes.flatMap((size) => {
          const row = section.rules[size]!;
          const where = `${section.label}${size ? ` › ${size}` : ""}`;
          if (!row.included.trim()) {
            if (row.max.trim() || row.extra.trim()) problems.push(`${where}: fill in how many come included (0 is fine), or clear the row.`);
            return [];
          }
          const included = Number(row.included);
          const most = row.max.trim() ? Number(row.max) : null;
          const extra = parseMoney(row.extra);
          if (!Number.isInteger(included) || included < 0 || included > 20) { problems.push(`${where}: "included" must be 0 to 20.`); return []; }
          if (most !== null && (!Number.isInteger(most) || most < 1 || most > 20 || most < included)) { problems.push(`${where}: "most" must be at least the number included (up to 20).`); return []; }
          if (extra === "bad" || (typeof extra === "number" && extra < 0)) { problems.push(`${where}: extra price "${row.extra}" isn't a dollar amount.`); return []; }
          return [{ size_name: size, included_count: included, max_portions: most, extra_each_cents: extra }];
        });
        sizeRules.push({ label: section.label.trim() || section.key, rules });
      }
      const rulesChanged = section.label.trim() !== original.label || min !== original.min_select || max !== original.max_select || section.required !== original.required || section.allowQuantities !== original.allow_quantities;
      if (!rulesChanged && !choices.length && !section.addToAll) return null;
      return {
        key: section.key,
        customer_label: section.label.trim() || section.key,
        min_select: min,
        max_select: max,
        required: section.required,
        allow_quantities: section.allowQuantities,
        add_to_all_items: section.addToAll,
        choices,
      };
    }).filter(Boolean);
    return { sections: out, sizeRules, problems };
  }, [ruleSizes, sizeNames, state]);

  const changes = payload.sections.length + payload.sizeRules.length;

  return (
    <form
      action={action}
      className="mt-8 grid gap-6"
      onSubmit={(event) => {
        if (payload.problems.length) { event.preventDefault(); setError(payload.problems[0]); return; }
        if (!changes) { event.preventDefault(); setError("Nothing has changed yet."); return; }
        setError("");
      }}
    >
      <input name="configuration" type="hidden" value={JSON.stringify({ sections: payload.sections, size_rules: payload.sizeRules })} />
      {state.map((section, sectionIndex) => (
        <section className="rounded-2xl border border-wayne-border bg-white p-5 shadow-sm" key={section.key}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid flex-1 gap-1 text-sm font-bold">
              Section name
              <input className="min-h-11 rounded-lg border border-wayne-border px-3 text-lg font-black" onChange={(e) => patchSection(sectionIndex, { label: e.target.value })} value={section.label} />
            </label>
            <label className="grid w-24 gap-1 text-sm font-bold">Fewest<input className="min-h-11 rounded-lg border border-wayne-border px-3" inputMode="numeric" onChange={(e) => patchSection(sectionIndex, { min: e.target.value })} value={section.min} /></label>
            <label className="grid w-24 gap-1 text-sm font-bold">Most<input className="min-h-11 rounded-lg border border-wayne-border px-3" inputMode="numeric" onChange={(e) => patchSection(sectionIndex, { max: e.target.value })} value={section.max} /></label>
            <label className="flex min-h-11 items-center gap-2 text-sm font-bold"><input checked={section.required} className="h-5 w-5 accent-wayne-red" onChange={(e) => patchSection(sectionIndex, { required: e.target.checked })} type="checkbox" />Required</label>
            <label className="flex min-h-11 items-center gap-2 text-sm font-bold"><input checked={section.allowQuantities} className="h-5 w-5 accent-wayne-red" onChange={(e) => patchSection(sectionIndex, { allowQuantities: e.target.checked })} type="checkbox" />Extra portions allowed</label>
          </div>
          <div className="mt-4 rounded-xl border border-wayne-ok/40 bg-wayne-ok-soft/40 p-3">
            <p className="text-sm font-black">Comes with (free) — e.g. a Large comes with 3 sauces, any mix, 2 of the same is fine</p>
            <p className="text-xs text-wayne-muted">Leave &quot;Included&quot; blank for the normal way (only what each item comes with is free). &quot;Each extra&quot; blank = each option&apos;s own price. Turns on extra portions automatically.</p>
            <div className="mt-2 grid gap-2">
              {ruleSizes.map((size) => {
                const row = section.rules[size]!;
                const set = (patch: Partial<RuleState>) => patchSection(sectionIndex, { rules: { ...section.rules, [size]: { ...row, ...patch } } });
                return <div className="grid grid-cols-[minmax(6rem,1fr)_7rem_7rem_8rem] items-end gap-2" key={size || "all"}>
                  <span className="min-h-10 content-center text-sm font-bold">{size || "All sizes"}</span>
                  <label className="grid gap-1 text-xs font-bold">Included<input className="min-h-10 rounded-lg border border-wayne-border bg-white px-2 text-base" inputMode="numeric" onChange={(e) => set({ included: e.target.value })} placeholder="—" value={row.included} /></label>
                  <label className="grid gap-1 text-xs font-bold">Most<input className="min-h-10 rounded-lg border border-wayne-border bg-white px-2 text-base" inputMode="numeric" onChange={(e) => set({ max: e.target.value })} placeholder="no limit" value={row.max} /></label>
                  <label className="grid gap-1 text-xs font-bold">Each extra $<input className="min-h-10 rounded-lg border border-wayne-border bg-white px-2 text-base" inputMode="decimal" onChange={(e) => set({ extra: e.target.value })} placeholder="option price" value={row.extra} /></label>
                </div>;
              })}
            </div>
          </div>
          <p className="mt-2 text-sm text-wayne-muted">
            On {section.itemCount} of {itemCount} items.
            {section.itemCount < itemCount ? (
              <label className="ml-3 inline-flex items-center gap-2 font-bold text-wayne-ink"><input checked={section.addToAll} className="h-5 w-5 accent-wayne-red" onChange={(e) => patchSection(sectionIndex, { addToAll: e.target.checked })} type="checkbox" />Add this section to the other {itemCount - section.itemCount}</label>
            ) : null}
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-wayne-muted">
                  <th className="py-2 pr-2">Option</th>
                  <th className="w-28 py-2 pr-2">Price (+$)</th>
                  {showSizes ? sizeNames.map((size) => <th className="w-28 py-2 pr-2" key={size}>{size}</th>) : null}
                  <th className="py-2 pr-2">On</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {section.choices.map((choice) => {
                  const partial = choice.original && choice.original.item_count < section.itemCount;
                  return (
                    <tr className={`border-t border-wayne-border align-middle ${choice.remove ? "opacity-40" : ""}`} key={choice.id}>
                      <td className="py-2 pr-2"><input className={`min-h-10 w-full rounded-lg border px-2 font-semibold ${choice.remove ? "line-through" : ""} ${choice.key ? "border-wayne-border" : "border-wayne-ok"}`} disabled={choice.remove} onChange={(e) => patchChoice(sectionIndex, choice.id, { name: e.target.value })} placeholder="New option name" value={choice.name} /></td>
                      <td className="py-2 pr-2"><input className="min-h-10 w-full rounded-lg border border-wayne-border px-2" disabled={choice.remove} inputMode="decimal" onChange={(e) => patchChoice(sectionIndex, choice.id, { price: e.target.value })} placeholder={choice.original && choice.original.price_cents === null ? "varies" : "0.00"} value={choice.price} /></td>
                      {showSizes ? sizeNames.map((size) => (
                        <td className="py-2 pr-2" key={size}><input className="min-h-10 w-full rounded-lg border border-wayne-border px-2" disabled={choice.remove} inputMode="decimal" onChange={(e) => patchChoice(sectionIndex, choice.id, { sizes: { ...choice.sizes, [size]: e.target.value } })} placeholder={choice.original?.size_prices[size] === "varies" ? "varies" : "same"} value={choice.sizes[size] ?? ""} /></td>
                      )) : null}
                      <td className="py-2 pr-2 text-xs font-bold text-wayne-muted">
                        {choice.key ? (
                          partial ? (
                            <label className="inline-flex items-center gap-1.5 whitespace-nowrap"><input checked={choice.everywhere} className="h-4 w-4 accent-wayne-red" disabled={choice.remove} onChange={(e) => patchChoice(sectionIndex, choice.id, { everywhere: e.target.checked })} type="checkbox" />{choice.original?.item_count} items · add to all</label>
                          ) : <span className="whitespace-nowrap">all {section.itemCount}</span>
                        ) : <span className="whitespace-nowrap text-wayne-ok">new · all {section.itemCount}</span>}
                      </td>
                      <td className="py-2 text-right">
                        {choice.key ? (
                          <button className="min-h-10 rounded-lg px-3 text-sm font-bold text-wayne-red underline" onClick={() => patchChoice(sectionIndex, choice.id, { remove: !choice.remove })} type="button">{choice.remove ? "Keep" : "Remove"}</button>
                        ) : (
                          <button className="min-h-10 rounded-lg px-3 text-sm font-bold text-wayne-red underline" onClick={() => setState((current) => current.map((s, i) => (i === sectionIndex ? { ...s, choices: s.choices.filter((c) => c.id !== choice.id) } : s)))} type="button">Cancel</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Button className="mt-3" onClick={() => addChoice(sectionIndex)} size="sm" type="button" variant="secondary">＋ Add an option to {section.label || "this section"}</Button>
        </section>
      ))}
      <div className="sticky bottom-0 z-10 -mx-5 flex flex-wrap items-center gap-3 border-t border-wayne-border bg-wayne-cream/95 px-5 py-4 backdrop-blur">
        <Button disabled={!changes} type="submit">{changes ? `Save for all ${itemCount} items` : "No changes yet"}</Button>
        {showSizes ? <p className="text-sm text-wayne-muted">Size columns override the price for that size; leave blank to keep what each item has.</p> : null}
        {error ? <p aria-live="polite" className="w-full rounded-lg bg-wayne-alert-soft p-3 font-bold text-wayne-alert">{error}</p> : null}
      </div>
    </form>
  );
}
