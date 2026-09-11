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
  "integrations.manage",
  "orders.manage",
  "orders.cancel",
  "audit.view",
  "promotions.manage"
]);
export type Permission = z.infer<typeof permissionSchema>;

export const accessSchema = z.object({
  profile_id: z.uuid(),
  display_name: z.string().min(1),
  role: roleSchema,
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
