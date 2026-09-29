import { z } from "zod";

/** Add Business (Phase 12, build sheet §25): input and checklist shapes. */
const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const text = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Times look like 11:00.");

export const weekDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export const provisionInputSchema = z.object({
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500),
  services: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(20),
  service_source: z.enum(["manual", "plan", "custom_contract"]),
  business: z.object({
    name: z.string().trim().min(1, "Enter the business name.").max(120),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "The web name uses lowercase letters, numbers and dashes, like joes-deli.").max(60),
    legal_name: text(240),
    industry: text(60),
    timezone: z.string().min(1).max(64),
    currency_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Currency is a 3-letter code like USD."),
    contact_name: text(120),
    contact_email: z.preprocess(blank, z.email("Enter a valid contact email.").optional()),
    contact_phone: text(40),
    is_test: z.boolean(),
  }),
  location: z.object({
    name: z.string().trim().min(1, "Enter the first location's name.").max(120),
    address_line_1: text(200),
    address_line_2: text(200),
    city: text(120),
    state_region: text(60),
    postal_code: text(20),
    phone: text(40),
    email: z.preprocess(blank, z.email("Enter a valid location email.").optional()),
    timezone: text(64),
    hours: z.object({ open: time, close: time, closed_days: z.array(z.enum(weekDays)) }),
  }),
});
export type ProvisionInput = z.infer<typeof provisionInputSchema>;

export const provisionResultSchema = z.object({ status: z.literal("saved"), slug: z.string(), workspace_id: z.uuid(), location_id: z.uuid() });

export const checklistItemSchema = z.object({
  key: z.string(),
  step: z.number().int(),
  label: z.string(),
  required: z.boolean(),
  tab: z.string(),
  status: z.enum(["pass", "fail", "optional"]),
  detail: z.string().nullable(),
});

export const workspaceSetupSchema = z.object({
  status: z.enum(["provisioning", "active", "suspended", "archived"]),
  is_test: z.boolean(),
  items: z.array(checklistItemSchema),
  can_activate: z.boolean(),
  blocking: z.array(z.string()),
  can_manage: z.boolean(),
  legacy: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
  orders_30d: z.coerce.number().int(),
});
export type WorkspaceSetup = z.infer<typeof workspaceSetupSchema>;

export const statusResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved") }),
  z.object({ status: z.literal("unchanged") }),
  z.object({ status: z.literal("needs_confirmation"), warnings: z.array(z.string()) }),
]);

/** A web name suggestion from the business name ("Joe's Deli & Grill" → "joes-deli-grill"). */
export function suggestSlug(name: string) {
  return name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
