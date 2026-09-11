import { z } from "zod";
import { roleSchema } from "@/lib/auth/permissions";

export const staffMemberSchema = z.object({
  id: z.uuid(), display_name: z.string(), first_name: z.string(), last_name: z.string(), email: z.string().nullable(),
  role: roleSchema, role_name: z.string(), active: z.boolean(), created_at: z.string(), last_sign_in_at: z.string().nullable(),
});
export const staffDirectorySchema = z.object({
  staff: z.array(staffMemberSchema),
  roles: z.array(z.object({ code: roleSchema, name: z.string(), description: z.string(), permissions: z.array(z.string()) })),
});
export type StaffDirectory = z.infer<typeof staffDirectorySchema>;

const password = z.string().min(12, "Passwords must be at least 12 characters.").max(72, "Passwords must be 72 characters or fewer.")
  .regex(/[a-z]/, "Include a lowercase letter.").regex(/[A-Z]/, "Include an uppercase letter.").regex(/[0-9]/, "Include a number.");

export const createStaffSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")),
  display_name: z.string().trim().min(1, "Enter a name.").max(120),
  role: roleSchema,
  password,
});
export const updateStaffSchema = z.object({ id: z.uuid(), role: roleSchema, active: z.boolean(), display_name: z.string().trim().max(120) });
export const resetPasswordSchema = z.object({ id: z.uuid(), password });
