import { z } from "zod";
import { roleSchema } from "@/lib/auth/permissions";

export const workspaceSlugSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens.")
  .min(3, "Use at least 3 characters.")
  .max(80, "Use at most 80 characters.");

export const workspaceAccessSchema = z.object({
  workspace_id: z.uuid(),
  workspace_slug: workspaceSlugSchema,
  workspace_name: z.string().min(1).max(160),
  role: roleSchema,
  permissions: z.array(z.string()),
  location_ids: z.array(z.uuid())
});

export type WorkspaceAccess = z.infer<typeof workspaceAccessSchema>;

const optionalEmailSchema = z.union([z.literal(""), z.email()]);

export const createWorkspaceSchema = z.object({
  workspace_slug: workspaceSlugSchema,
  business_name: z.string().trim().min(1, "Enter the business name.").max(160),
  legal_name: z.string().trim().max(240),
  public_email: optionalEmailSchema,
  public_phone: z.string().trim().max(40),
  owner_name: z.string().trim().min(1, "Enter the owner name.").max(120),
  owner_email: z.email({ error: "Enter the owner email." }).transform((value) => value.toLowerCase()),
  owner_password: z.string().min(12, "Use at least 12 characters.")
    .regex(/[a-z]/, "Include a lowercase letter.")
    .regex(/[A-Z]/, "Include an uppercase letter.")
    .regex(/[0-9]/, "Include a number."),
  location_name: z.string().trim().min(1, "Enter the first location name.").max(160),
  timezone: z.string().trim().min(1).max(120),
  service_codes: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1, "Select at least one service.")
});

export const workspaceOnboardingSchema = z.object({
  workspace_id: z.uuid(),
  workspace_slug: workspaceSlugSchema,
  location_id: z.uuid(),
  business_name: z.string().trim().min(1, "Enter the business name.").max(160),
  legal_name: z.string().trim().max(240),
  public_email: optionalEmailSchema,
  public_phone: z.string().trim().max(40),
  location_name: z.string().trim().min(1, "Enter the location name.").max(160),
  timezone: z.string().trim().min(1).max(120),
  address_line1: z.string().trim().max(200),
  address_line2: z.string().trim().max(200),
  city: z.string().trim().max(120),
  state_or_region: z.string().trim().max(120),
  postal_code: z.string().trim().max(32),
  country_code: z.string().trim().length(2, "Use a 2-letter country code.").transform((value) => value.toUpperCase()),
  complete: z.boolean()
});
