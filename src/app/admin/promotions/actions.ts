"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { getStoreSettings } from "@/lib/content/queries";
import { parsePromotionForm } from "@/lib/promotions/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const back = (message: string, key: "error" | "saved" = "error") => redirect(`/admin/promotions?${key}=${encodeURIComponent(message)}`);
const fields = ["code", "description", "discount_type", "discount_amount", "minimum_order", "fulfillment_type", "starts_at", "ends_at", "total_usage_limit", "per_customer_limit", "active", "members_only", "code_mode", "delivery", "audience_segment_id", "code_valid_days", "reissue_after_days", "crm_event_name"];
const dbError = (message: string) => message.includes("promotions_active_code_idx") || message.includes("duplicate key") ? "Another active promotion already uses that code." : "The promotion could not be saved.";

export async function savePromotion(form: FormData) {
  await requirePermission("promotions.manage", "/admin/promotions");
  const settings = await getStoreSettings();
  const result = parsePromotionForm(Object.fromEntries(fields.map((field) => [field, form.get(field)])), settings.timezone);
  if (!result.ok) back(result.error);
  const row = result.ok ? result.row : null;
  const id = z.uuid().safeParse(form.get("id"));
  const supabase = await createServerSupabaseClient();
  // Every insert/update is written to the audit log by a database trigger.
  const { error } = id.success
    ? await supabase.from("promotions").update(row!).eq("id", id.data).is("archived_at", null)
    : await supabase.from("promotions").insert(row!);
  if (error) back(dbError(error.message));
  revalidatePath("/admin/promotions");
  back(id.success ? `${row!.code} updated.` : `${row!.code} created.`, "saved");
}

export async function archivePromotion(form: FormData) {
  await requirePermission("promotions.manage", "/admin/promotions");
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) back("Promotion not found.");
  const supabase = await createServerSupabaseClient();
  // Archived codes stop working immediately; past orders keep their discount snapshot.
  const { error } = await supabase.from("promotions").update({ active: false, archived_at: new Date().toISOString() }).eq("id", id.data!);
  if (error) back("The promotion could not be archived.");
  revalidatePath("/admin/promotions");
  back("Promotion archived. Past orders keep their discount.", "saved");
}

/**
 * Publish an offer.  Personal offers get a code made for every member in the
 * audience; with "text" on, each member is texted a link to their own offers
 * page (at most one such text a day).  An automatic offer sends itself to the
 * customers already in its segment, exactly as if they had just entered it.
 */
export async function publishOffer(form: FormData) {
  await requirePermission("promotions.manage", "/admin/promotions");
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) back("Offer not found.");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_publish_offer", { offer_id: id.data!, send_text: form.get("send_text") === "on" });
  if (error) back(error.message.includes("permission") ? "You need promotion access to publish." : error.message || "The offer could not be published.");
  const result = z.object({ issued: z.number(), texted: z.number() }).parse(data);
  revalidatePath("/admin/promotions");
  back(`Published. ${result.issued} new personal code${result.issued === 1 ? "" : "s"} made, ${result.texted} text${result.texted === 1 ? "" : "s"} queued to the Hanafy CRM.`, "saved");
}
