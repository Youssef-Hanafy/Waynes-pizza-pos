"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/access";
import { logger } from "@/lib/logging/logger";
import { createStaffSchema, resetPasswordSchema, updateStaffSchema } from "@/lib/staff/schemas";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

const back = (message: string, key: "error" | "saved" = "error") => redirect(`/admin/staff?${key}=${encodeURIComponent(message)}`);
const safe = (message: string) => ["own role", "active owner", "Unknown role", "not found", "Display name"].some((part) => message.includes(part)) ? message : "The change could not be saved. Refresh and try again.";

export async function createStaffMember(form: FormData) {
  await requirePermission("staff.manage", "/admin/staff");
  const parsed = createStaffSchema.safeParse({ email: form.get("email"), display_name: form.get("display_name"), role: form.get("role"), password: form.get("password") });
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Check the new staff details.");
  const input = parsed.data!;
  let service;
  try { service = createServiceSupabaseClient(); } catch { back("Staff accounts need SUPABASE_SERVICE_ROLE_KEY configured on the server."); }
  // Creating an Auth user needs the admin API. The database trigger gives the new
  // profile no access; the owner's own session then grants the role (and is audited).
  const { data, error } = await service!.auth.admin.createUser({ email: input.email, password: input.password, email_confirm: true, user_metadata: { display_name: input.display_name } });
  if (error || !data.user) {
    logger.warn("staff.create_failed", { code: error?.code ?? null });
    back(error?.message?.toLowerCase().includes("already") ? "An account with that email already exists. Find it in the list below." : "The account could not be created.");
  }
  const supabase = await createServerSupabaseClient();
  const granted = await supabase.rpc("wayne_admin_update_staff", { target_profile_id: data!.user!.id, role_code: input.role, active_value: true, display_name_value: input.display_name });
  if (granted.error) back(`Account created but left inactive: ${safe(granted.error.message)}`);
  await supabase.rpc("wayne_record_staff_account_event", { target_profile_id: data!.user!.id, event_type: "staff.account_created" });
  revalidatePath("/admin/staff");
  back(`${input.display_name} can now sign in with ${input.email}. Share the temporary password privately and ask them to change it.`, "saved");
}

export async function updateStaffMember(form: FormData) {
  await requirePermission("staff.manage", "/admin/staff");
  const parsed = updateStaffSchema.safeParse({ id: form.get("id"), role: form.get("role"), active: form.get("active") === "on", display_name: form.get("display_name") ?? "" });
  if (!parsed.success) back("Check the staff details.");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_admin_update_staff", { target_profile_id: parsed.data!.id, role_code: parsed.data!.role, active_value: parsed.data!.active, display_name_value: parsed.data!.display_name || null });
  if (error) back(safe(error.message));
  revalidatePath("/admin/staff");
  back("Staff access updated.", "saved");
}

export async function resetStaffPassword(form: FormData) {
  await requirePermission("staff.manage", "/admin/staff");
  const parsed = resetPasswordSchema.safeParse({ id: form.get("id"), password: form.get("password") });
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Enter a valid temporary password.");
  let service;
  try { service = createServiceSupabaseClient(); } catch { back("Password resets need SUPABASE_SERVICE_ROLE_KEY configured on the server."); }
  const { error } = await service!.auth.admin.updateUserById(parsed.data!.id, { password: parsed.data!.password });
  if (error) back("The password could not be reset.");
  const supabase = await createServerSupabaseClient();
  await supabase.rpc("wayne_record_staff_account_event", { target_profile_id: parsed.data!.id, event_type: "staff.password_reset" });
  back("Temporary password set. Share it privately.", "saved");
}
