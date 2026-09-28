import { z } from "zod";

export const roleSchema = z.enum(["owner", "manager", "cashier", "kitchen", "driver", "marketing_readonly"]);
export type AppRole = z.infer<typeof roleSchema>;

export const permissionSchema = z.enum([
  "admin.access",
  "staff.view",
  "staff.manage",
  "settings.manage",
  "menu.manage",
  "content.manage",
  "orders.view",
  "reports.view",
  "customers.view",
  "segments.manage",
  "pos.access",
  "pos.discount.manage",
  "printing.manage",
  "printing.process",
  "kitchen.access",
  "driver.access",
  "delivery.dispatch",
  "payments.manage",
  "cash.manage",
  "integrations.manage",
  "orders.manage",
  "orders.cancel",
  "audit.view",
  "promotions.manage",
  "hardware.manage",
  "pilot.manage"
]);
export type Permission = z.infer<typeof permissionSchema>;

export const accessSchema = z.object({
  profile_id: z.uuid(),
  display_name: z.string().min(1),
  role: roleSchema,
  // Present when access is resolved through the Phase 3 workspace context.
  // Optional keeps this parser compatible with older serialized test fixtures.
  workspace_id: z.uuid().optional(),
  workspace_slug: z.string().min(1).optional(),
  // Phase 5: the selected workspace, its first location and its active services.
  workspace_name: z.string().min(1).optional(),
  location_id: z.uuid().nullable().optional(),
  enabled_services: z.array(z.string()).optional(),
  // True only for the workspace the pre-platform wayne_* operations serve.
  legacy_operations: z.boolean().optional(),
  membership_count: z.number().int().nonnegative().optional(),
  // Unknown codes (e.g. a permission added by a newer migration) are ignored instead
  // of failing the whole parse, which would sign every staff member out.
  permissions: z.array(z.string()).transform((codes) =>
    codes.filter((code): code is Permission => permissionSchema.safeParse(code).success)
  )
});

export type CurrentAccess = z.infer<typeof accessSchema>;

export function hasPermission(access: Pick<CurrentAccess, "permissions"> | null, permission: Permission) {
  return access?.permissions.includes(permission) ?? false;
}

export function hasService(access: Pick<CurrentAccess, "enabled_services"> | null, service: string) {
  return access?.enabled_services?.includes(service) ?? false;
}

/**
 * The /admin, /pos, /kitchen and /driver screens still run on the
 * pre-platform wayne_* database functions, which serve one workspace only.
 * For any other workspace they must not act at all, so the operational
 * permissions are withheld (the workspace shell under /w is used instead).
 */
export function forLegacyOperations(access: CurrentAccess): CurrentAccess {
  return access.legacy_operations === false ? { ...access, permissions: [] } : access;
}
