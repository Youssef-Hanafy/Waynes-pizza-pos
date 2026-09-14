"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Phase 14: variant_prices holds one $ string per size the owner has
// explicitly overridden, keyed by that size's *current* name. A size with no
// key here uses the choice's flat `price` -- which is also the only price an
// item with no sizes at all ever uses.
type DraftChoice = {
  name: string;
  price: string;
  default_selected: boolean;
  variant_prices: Record<string, string>;
};
type DraftGroup = {
  name: string;
  customer_label: string;
  min_select: number;
  max_select: number;
  required: boolean;
  allow_quantities: boolean;
  choices: DraftChoice[];
};
type DraftVariant = { name: string; price: string; sku: string };
export type MenuItemInitial = {
  name: string;
  description: string;
  image_alt: string;
  base_price: string;
  tax_category: string;
  included_count_label: string;
  sold_out: boolean;
  customer_visible: boolean;
  pos_visible: boolean;
  featured: boolean;
  kitchen_route: string;
  available_days: number[];
  available_start: string;
  available_end: string;
  sort_order: number;
  category_id: string;
  variants: DraftVariant[];
  modifier_groups: DraftGroup[];
};
type Props = {
  action: (formData: FormData) => void | Promise<void>;
  categories: { id: string; name: string }[];
  initial?: MenuItemInitial;
  submitLabel: string;
};
const emptyChoice = (): DraftChoice => ({
  name: "",
  price: "0.00",
  default_selected: false,
  variant_prices: {},
});
const emptyGroup = (): DraftGroup => ({
  name: "",
  customer_label: "",
  min_select: 0,
  max_select: 1,
  required: false,
  allow_quantities: false,
  choices: [emptyChoice()],
});

export function MenuItemForm({
  action,
  categories,
  initial,
  submitLabel,
}: Props) {
  const [variants, setVariants] = useState<DraftVariant[]>(
    initial?.variants ?? [],
  );
  const [groups, setGroups] = useState<DraftGroup[]>(
    initial?.modifier_groups ?? [],
  );
  return (
    <form action={action} className="grid gap-6">
      <input
        name="configuration"
        type="hidden"
        value={JSON.stringify({ variants, modifier_groups: groups })}
      />
      <section className="grid gap-4 rounded-2xl border border-wayne-border bg-white p-6">
        <h2 className="text-2xl font-black">Item details</h2>
        <label className="grid gap-2 text-sm font-semibold">
          Category
          <select
            className="min-h-11 rounded-lg border border-wayne-border bg-white px-3"
            defaultValue={initial?.category_id}
            name="category_id"
            required
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <Input
          defaultValue={initial?.name}
          label="Item name"
          name="name"
          required
        />
        <label className="grid gap-2 text-sm font-semibold">
          Description
          <textarea
            className="rounded-lg border border-wayne-border p-3 font-normal"
            defaultValue={initial?.description}
            name="description"
            rows={4}
          />
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <Input
            defaultValue={initial?.base_price ?? "0.00"}
            inputMode="decimal"
            label="Base price ($)"
            name="base_price"
            required
          />
          <Input
            defaultValue={initial?.tax_category ?? "prepared_food"}
            label="Tax category"
            name="tax_category"
            required
          />
          <Input
            defaultValue={initial?.included_count_label}
            label="Count/size label (optional)"
            name="included_count_label"
          />
          <Input
            defaultValue={initial?.kitchen_route}
            label="Kitchen route (optional)"
            name="kitchen_route"
          />
          <Input
            defaultValue={initial?.sort_order ?? 0}
            label="Sort order"
            name="sort_order"
            type="number"
          />
          <Input
            defaultValue={initial?.image_alt}
            label="Image alt text"
            name="image_alt"
          />
          <Input
            accept="image/jpeg,image/png,image/webp,image/avif"
            label={
              initial ? "Replace image (optional)" : "Item image (optional)"
            }
            name="image"
            type="file"
          />
        </div>
        <div className="flex flex-wrap gap-5">
          <Check
            defaultChecked={initial?.customer_visible ?? true}
            label="Visible to customers"
            name="customer_visible"
          />
          <Check
            defaultChecked={initial?.pos_visible ?? true}
            label="Visible in future POS"
            name="pos_visible"
          />
          <Check
            defaultChecked={initial?.featured ?? false}
            label="Featured on homepage"
            name="featured"
          />
          <Check
            defaultChecked={initial?.sold_out ?? false}
            label="Sold out"
            name="sold_out"
          />
        </div>
      </section>
      <section className="grid gap-4 rounded-2xl border border-wayne-border bg-white p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black">Availability</h2>
            <p className="text-sm text-wayne-muted">
              Choose days and optionally limit to a daily time window.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
            (label, day) => (
              <Check
                defaultChecked={initial?.available_days.includes(day) ?? true}
                label={label}
                name={`available_day_${day}`}
                key={label}
              />
            ),
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Input
            defaultValue={initial?.available_start}
            label="Available from (optional)"
            name="available_start"
            type="time"
          />
          <Input
            defaultValue={initial?.available_end}
            label="Available until (optional)"
            name="available_end"
            type="time"
          />
        </div>
      </section>
      <section className="grid gap-4 rounded-2xl border border-wayne-border bg-white p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black">Variants / sizes</h2>
            <p className="text-sm text-wayne-muted">
              Examples: Small, Large, 8 wings, 2-liter.
            </p>
          </div>
          <Button
            onClick={() =>
              setVariants([...variants, { name: "", price: "0.00", sku: "" }])
            }
            type="button"
            variant="secondary"
          >
            Add variant
          </Button>
        </div>
        {variants.map((variant, index) => (
          <div
            className="grid gap-3 rounded-xl border border-wayne-border p-4 md:grid-cols-[1fr_10rem_1fr_auto]"
            key={index}
          >
            <Input
              label="Name"
              value={variant.name}
              onChange={(event) =>
                setVariants(
                  variants.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, name: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <Input
              label="Price ($)"
              value={variant.price}
              onChange={(event) =>
                setVariants(
                  variants.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, price: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <Input
              label="SKU (optional)"
              value={variant.sku}
              onChange={(event) =>
                setVariants(
                  variants.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, sku: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <Button
              onClick={() =>
                setVariants(
                  variants.filter((_, itemIndex) => itemIndex !== index),
                )
              }
              type="button"
              variant="secondary"
            >
              Remove
            </Button>
          </div>
        ))}
      </section>
      <section className="grid gap-5 rounded-2xl border border-wayne-border bg-white p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black">Modifier groups</h2>
            <p className="text-sm text-wayne-muted">
              Required or optional single/multiple-choice options with price
              changes.
            </p>
          </div>
          <Button
            onClick={() => setGroups([...groups, emptyGroup()])}
            type="button"
            variant="secondary"
          >
            Add group
          </Button>
        </div>
        {groups.map((group, groupIndex) => (
          <div
            className="grid gap-4 rounded-xl border border-wayne-border bg-wayne-cream p-4"
            key={groupIndex}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Input
                label="Internal name"
                value={group.name}
                onChange={(event) =>
                  changeGroup(groupIndex, { name: event.target.value })
                }
              />
              <Input
                label="Customer label"
                value={group.customer_label}
                onChange={(event) =>
                  changeGroup(groupIndex, {
                    customer_label: event.target.value,
                  })
                }
              />
              <Input
                label="Minimum selections"
                type="number"
                min={0}
                value={group.min_select}
                onChange={(event) =>
                  changeGroup(groupIndex, {
                    min_select: Number(event.target.value),
                  })
                }
              />
              <Input
                label="Maximum selections"
                type="number"
                min={1}
                value={group.max_select}
                onChange={(event) =>
                  changeGroup(groupIndex, {
                    max_select: Number(event.target.value),
                  })
                }
              />
            </div>
            <div className="flex flex-wrap gap-5">
              <Check
                checked={group.required}
                label="Required"
                onChange={(event) =>
                  changeGroup(groupIndex, { required: event.target.checked })
                }
              />
              <Check
                checked={group.allow_quantities}
                label="Allow quantities"
                onChange={(event) =>
                  changeGroup(groupIndex, {
                    allow_quantities: event.target.checked,
                  })
                }
              />
            </div>
            <div className="grid gap-3">
              <strong>Choices</strong>
              {group.choices.map((choice, choiceIndex) => (
                <div
                  className="grid gap-3 rounded-lg bg-white p-3"
                  key={choiceIndex}
                >
                  <div className="grid gap-3 md:grid-cols-[1fr_10rem_auto_auto]">
                    <Input
                      label="Choice"
                      value={choice.name}
                      onChange={(event) =>
                        changeChoice(groupIndex, choiceIndex, {
                          name: event.target.value,
                        })
                      }
                    />
                    <Input
                      label={
                        variants.length > 0
                          ? "Default price change ($)"
                          : "Price change ($)"
                      }
                      value={choice.price}
                      onChange={(event) =>
                        changeChoice(groupIndex, choiceIndex, {
                          price: event.target.value,
                        })
                      }
                    />
                    <Check
                      checked={choice.default_selected}
                      label="Default"
                      onChange={(event) =>
                        changeChoice(groupIndex, choiceIndex, {
                          default_selected: event.target.checked,
                        })
                      }
                    />
                    <Button
                      onClick={() =>
                        setGroups(
                          groups.map((item, index) =>
                            index === groupIndex
                              ? {
                                  ...item,
                                  choices: item.choices.filter(
                                    (_, innerIndex) => innerIndex !== choiceIndex,
                                  ),
                                }
                              : item,
                          ),
                        )
                      }
                      type="button"
                      variant="secondary"
                    >
                      Remove
                    </Button>
                  </div>
                  {variants.length > 0 && (
                    <div className="grid gap-2 rounded-lg border border-dashed border-wayne-border p-3">
                      <span className="text-xs font-semibold text-wayne-muted">
                        Price by size -- leave a size blank to use the default
                        price change above
                      </span>
                      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                        {variants
                          .filter((variant) => variant.name.trim())
                          .map((variant) => (
                            <Input
                              key={variant.name}
                              label={`${variant.name} ($)`}
                              placeholder={choice.price}
                              value={choice.variant_prices[variant.name] ?? ""}
                              onChange={(event) =>
                                changeChoiceVariantPrice(
                                  groupIndex,
                                  choiceIndex,
                                  variant.name,
                                  event.target.value,
                                )
                              }
                            />
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <Button
                className="justify-self-start"
                onClick={() =>
                  changeGroup(groupIndex, {
                    choices: [...group.choices, emptyChoice()],
                  })
                }
                type="button"
                variant="secondary"
              >
                Add choice
              </Button>
            </div>
            <Button
              className="justify-self-start"
              onClick={() =>
                setGroups(groups.filter((_, index) => index !== groupIndex))
              }
              type="button"
              variant="danger"
            >
              Remove group
            </Button>
          </div>
        ))}
      </section>
      <div className="sticky bottom-4 flex justify-end">
        <Button className="min-w-44 shadow-lg" type="submit">
          {submitLabel}
        </Button>
      </div>
    </form>
  );

  function changeGroup(index: number, change: Partial<DraftGroup>) {
    setGroups(
      groups.map((group, groupIndex) =>
        groupIndex === index ? { ...group, ...change } : group,
      ),
    );
  }
  function changeChoice(
    groupIndex: number,
    choiceIndex: number,
    change: Partial<DraftChoice>,
  ) {
    setGroups(
      groups.map((group, index) =>
        index === groupIndex
          ? {
              ...group,
              choices: group.choices.map((choice, innerIndex) =>
                innerIndex === choiceIndex ? { ...choice, ...change } : choice,
              ),
            }
          : group,
      ),
    );
  }
  function changeChoiceVariantPrice(
    groupIndex: number,
    choiceIndex: number,
    variantName: string,
    price: string,
  ) {
    setGroups(
      groups.map((group, index) =>
        index === groupIndex
          ? {
              ...group,
              choices: group.choices.map((choice, innerIndex) => {
                if (innerIndex !== choiceIndex) return choice;
                const variant_prices = { ...choice.variant_prices };
                if (price.trim()) variant_prices[variantName] = price;
                else delete variant_prices[variantName];
                return { ...choice, variant_prices };
              }),
            }
          : group,
      ),
    );
  }
}

function Check(
  props: React.InputHTMLAttributes<HTMLInputElement> & { label: string },
) {
  const { label, ...inputProps } = props;
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
      <input
        className="h-5 w-5 accent-wayne-red"
        type="checkbox"
        {...inputProps}
      />
      {label}
    </label>
  );
}
