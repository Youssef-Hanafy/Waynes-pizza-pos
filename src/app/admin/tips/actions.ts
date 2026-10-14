"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** "1, 2, 3.50" or "$1 $2" → numbers, in the order typed. */
function numbers(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((part) => part.replace(/[$%]/g, "").trim())
    .filter(Boolean)
    .map(Number);
}

const tipsSchema = z.object({
  tips_enabled: z.boolean(),
  suggested_tip_percentages: z.array(z.number().int("Tip percentages must be whole numbers.").min(1).max(100)).max(4, "Up to 4 percentage buttons."),
  suggested_tip_amounts_cents: z.array(z.number().int().min(1, "Dollar tips must be more than $0.").max(100_000, "Dollar tips must be under $1,000.")).max(6, "Up to 6 dollar buttons."),
  tip_payout_name: z.string().trim().min(1, "Say who the card tips are paid out to.").max(60),
});

/** Tip buttons for the customer screen and website checkout (owner, 2026-10-12). */
export async function saveTips(formData: FormData) {
  const access = await requirePermission("content.manage", "/admin/tips");
  const parsed = tipsSchema.safeParse({
    tips_enabled: formData.get("tips_enabled") === "on",
    suggested_tip_percentages: numbers(formData.get("percentages")),
    suggested_tip_amounts_cents: numbers(formData.get("dollars")).map((dollars) => Math.round(dollars * 100)),
    tip_payout_name: String(formData.get("tip_payout_name") ?? ""),
  });
  if (!parsed.success) redirect(`/admin/tips?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Check the tip amounts.")}`);
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_save_location_settings", { payload: parsed.data, target_workspace_slug: access.workspace_slug ?? null });
  if (error) redirect(`/admin/tips?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/", "layout");
  redirect("/admin/tips?saved=1");
}
