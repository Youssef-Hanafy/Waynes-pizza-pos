import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Admin is PIN-locked (owner, 2026-10-12): the store tablet stays signed in,
 * so workers could otherwise tap Admin.  An owner or manager types their PIN,
 * the database hands back a one-time token, and this httpOnly cookie carries
 * it.  The unlock slides 15 idle minutes and is dropped when the POS opens.
 */
export const ADMIN_UNLOCK_COOKIE = "wayne_admin_unlock";

export const adminUnlockCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 12,
};

export const adminUnlockState = cache(async (): Promise<{ unlocked: boolean; name: string | null }> => {
  const token = (await cookies()).get(ADMIN_UNLOCK_COOKIE)?.value ?? "";
  if (!token) return { unlocked: false, name: null };
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_admin_unlock_check", { token_value: token });
  if (error || !data || typeof data !== "object") return { unlocked: false, name: null };
  const value = data as { unlocked?: unknown; name?: unknown };
  return { unlocked: value.unlocked === true, name: typeof value.name === "string" ? value.name : null };
});

/** Where Admin sends someone who hasn't typed a manager PIN yet. */
export function adminPinPath(nextPath: string) {
  return `/pos/admin-pin?next=${encodeURIComponent(nextPath.startsWith("/admin") ? nextPath : "/admin")}`;
}
