import { z } from "zod";

export const variantSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  price_cents: z.number().int().min(0).max(1_000_000),
  // The column is nullable and a variant without a SKU is normal, so the database
  // sends null here. Accepting only a string or undefined made every such variant
  // fail to parse, which emptied the customer menu and took the POS down with it.
  sku: z.string().trim().max(80).nullish().transform((value) => value ?? ""),
  sort_order: z.number().int().default(0)
});

export const modifierChoiceSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  price_delta_cents: z.number().int().min(-100_000).max(1_000_000),
  default_selected: z.boolean().default(false)
});

export const modifierGroupSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  customer_label: z.string().trim().min(1).max(160),
  min_select: z.number().int().min(0).max(100),
  max_select: z.number().int().min(1).max(100),
  required: z.boolean(),
  allow_quantities: z.boolean(),
  choices: z.array(modifierChoiceSchema).min(1).max(100)
}).refine((value) => value.max_select >= value.min_select, {
  message: "Maximum selections must be at least the minimum.",
  path: ["max_select"]
}).refine((value) => !value.required || value.min_select >= 1, {
  message: "Required modifier groups must require at least one selection.",
  path: ["min_select"]
});

export const menuItemPayloadSchema = z.object({
  category_id: z.uuid(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000),
  image_path: z.string().nullable(),
  image_alt: z.string().trim().max(300),
  base_price_cents: z.number().int().min(0).max(1_000_000),
  tax_category: z.string().trim().min(1).max(80),
  included_count_label: z.string().trim().max(120),
  sold_out: z.boolean(),
  customer_visible: z.boolean(),
  pos_visible: z.boolean(),
  featured: z.boolean(),
  kitchen_route: z.string().trim().max(120),
  available_days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  available_start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/),
  available_end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/),
  sort_order: z.number().int().min(-100_000).max(100_000),
  variants: z.array(variantSchema).max(100),
  modifier_groups: z.array(modifierGroupSchema).max(50)
}).refine((value) => (value.available_start === "") === (value.available_end === ""), {
  message: "Availability requires both a start and end time.",
  path: ["available_end"]
});

export const publicMenuChoiceSchema = modifierChoiceSchema.extend({ id: z.uuid() });
export const publicMenuGroupSchema = modifierGroupSchema.safeExtend({
  id: z.uuid(),
  choices: z.array(publicMenuChoiceSchema)
});
export const publicMenuVariantSchema = variantSchema.extend({ id: z.uuid() });
export const publicMenuItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  image_path: z.string().nullable(),
  image_alt: z.string(),
  base_price_cents: z.number().int(),
  included_count_label: z.string(),
  sold_out: z.boolean(),
  featured: z.boolean(),
  available_days: z.array(z.number().int()),
  available_start: z.string().nullable(),
  available_end: z.string().nullable(),
  variants: z.array(publicMenuVariantSchema),
  modifier_groups: z.array(publicMenuGroupSchema)
});
export const publicMenuCategorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  image_path: z.string().nullable(),
  image_alt: z.string(),
  items: z.array(publicMenuItemSchema)
});
export const publicMenuSchema = z.array(publicMenuCategorySchema);

export type MenuItemPayload = z.infer<typeof menuItemPayloadSchema>;
export type PublicMenu = z.infer<typeof publicMenuSchema>;

export function parseMoneyToCents(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [dollars, fraction = ""] = normalized.split(".");
  return Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
}

export function parseSignedMoneyToCents(value: string) {
  const normalized = value.trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const sign = normalized.startsWith("-") ? -1 : 1;
  const unsigned = normalized.replace(/^-/, "");
  const [dollars, fraction = ""] = unsigned.split(".");
  return sign * (Number(dollars) * 100 + Number(fraction.padEnd(2, "0")));
}

export function formatCents(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
}
