import { z } from "zod";

export const bundleComponentInputSchema = z.object({
  menu_item_id: z.uuid(),
  variant_id: z.uuid().nullable(),
  quantity: z.number().int().min(1).max(20),
});

export const bundleComponentSchema = bundleComponentInputSchema.extend({ name: z.string() });
export type BundleComponent = z.infer<typeof bundleComponentSchema>;

export const bundleComponentGroup = "Bundle includes";

export function bundleComponentLabel(component: Pick<BundleComponent, "name" | "quantity">) {
  return `${component.quantity}× ${component.name}`;
}
