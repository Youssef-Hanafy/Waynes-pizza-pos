"use server";

import { cookies } from "next/headers";
import { ADMIN_UNLOCK_COOKIE, adminUnlockCookieOptions } from "@/lib/auth/admin-lock";
import { getWorkspaceAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Check a manager PIN; on success remember the unlock in an httpOnly cookie. */
export async function unlockAdminWithPin(pin: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const access = await getWorkspaceAccess();
  if (!access || !hasPermission(access, "admin.access")) return { ok: false, error: "This sign-in can't open Admin." };
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) return { ok: false, error: "Wrong PIN." };
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_admin_pin_unlock", { pin_value: pin });
  if (error || !data || typeof data !== "object") return { ok: false, error: "The PIN could not be checked. Try again." };
  const result = data as { ok?: boolean; token?: string; error?: string };
  if (!result.ok || !result.token) return { ok: false, error: result.error ?? "Wrong PIN." };
  (await cookies()).set(ADMIN_UNLOCK_COOKIE, result.token, adminUnlockCookieOptions);
  return { ok: true };
}

/** Lock Admin again on this device. */
export async function lockAdmin() {
  const store = await cookies();
  store.delete(ADMIN_UNLOCK_COOKIE);
  const supabase = await createServerSupabaseClient();
  await supabase.rpc("wayne_admin_lock");
}
