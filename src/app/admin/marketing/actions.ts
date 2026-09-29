"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { campaignFormSchema, messagingErrorMessage, normalizeUsPhone, templateFormSchema } from "@/lib/messaging/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { zonedLocalToUtcIso } from "@/lib/time/zoned";

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};
const optional = (form: FormData, key: string) => text(form, key).trim() || undefined;

function back(path: string, message: string, key: "error" | "saved" = "error"): never {
  redirect(`${path}?${new URLSearchParams({ [key]: message }).toString()}`);
}

/** The workspace comes from the signed-in session, never from the form. */
async function workspaceFor(permission: "campaigns.manage" | "messaging.manage", path: string) {
  const access = await requirePermission(permission, path);
  if (!access.workspace_slug) back(path, "Choose a business first.");
  return access;
}

export async function saveCampaign(form: FormData) {
  const access = await workspaceFor("campaigns.manage", "/admin/marketing");
  const parsed = campaignFormSchema.safeParse({
    id: optional(form, "id"),
    name: text(form, "name"),
    audience_type: text(form, "audience_type") || "all_subscribers",
    segment_id: optional(form, "segment_id"),
    template_id: optional(form, "template_id"),
    body: text(form, "body"),
  });
  const origin = parsed.success && parsed.data.id ? `/admin/marketing/campaigns/${parsed.data.id}` : "/admin/marketing";
  if (!parsed.success) back(origin, parsed.error.issues[0]?.message ?? "Check the campaign.");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_campaign_save", { target_workspace_slug: access.workspace_slug, payload: parsed.data });
  if (error) back(origin, messagingErrorMessage(error.message));
  revalidatePath("/admin/marketing");
  redirect(`/admin/marketing/campaigns/${String(data)}?saved=${encodeURIComponent("Campaign saved.")}`);
}

export async function sendCampaign(form: FormData) {
  const access = await workspaceFor("campaigns.manage", "/admin/marketing");
  const id = z.uuid().safeParse(text(form, "id"));
  if (!id.success) back("/admin/marketing", "Campaign not found.");
  const path = `/admin/marketing/campaigns/${id.data}`;
  if (text(form, "confirm") !== "yes") back(path, "Tick the box to confirm the send.");
  const when = text(form, "send_at").trim();
  let sendAt: string | null = null;
  if (when) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when)) back(path, "Pick a valid date and time.");
    sendAt = zonedLocalToUtcIso(when, text(form, "timezone") || "America/New_York");
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_campaign_send", { target_workspace_slug: access.workspace_slug, target_campaign_id: id.data, send_at: sendAt });
  if (error) back(path, messagingErrorMessage(error.message));
  const result = data as { queued: number; skipped: number };
  revalidatePath("/admin/marketing");
  back(path, `${sendAt ? "Scheduled" : "Sending"} to ${result.queued} customers${result.skipped ? ` (${result.skipped} skipped)` : ""}.`, "saved");
}

export async function cancelCampaign(form: FormData) {
  const access = await workspaceFor("campaigns.manage", "/admin/marketing");
  const id = z.uuid().safeParse(text(form, "id"));
  if (!id.success) back("/admin/marketing", "Campaign not found.");
  const path = `/admin/marketing/campaigns/${id.data}`;
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_campaign_cancel", { target_workspace_slug: access.workspace_slug, target_campaign_id: id.data });
  if (error) back(path, messagingErrorMessage(error.message));
  revalidatePath("/admin/marketing");
  back(path, "Campaign cancelled. Texts not yet sent will not go out.", "saved");
}

export async function sendTestText(form: FormData) {
  const access = await workspaceFor("campaigns.manage", "/admin/marketing");
  const id = z.uuid().safeParse(text(form, "id"));
  if (!id.success) back("/admin/marketing", "Campaign not found.");
  const path = `/admin/marketing/campaigns/${id.data}`;
  const phone = normalizeUsPhone(text(form, "phone"));
  if (!phone) back(path, "Enter a valid US mobile number for the test.");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_campaign_test_send", { target_workspace_slug: access.workspace_slug, target_campaign_id: id.data, test_phone: phone });
  if (error) back(path, messagingErrorMessage(error.message));
  const result = data as { status: string; skip_reason: string | null };
  back(path, result.status === "skipped" ? `Test not sent: ${result.skip_reason === "suppressed" ? "that number has opted out" : result.skip_reason}.` : "Test text queued.", result.status === "skipped" ? "error" : "saved");
}

export async function saveTemplate(form: FormData) {
  const access = await workspaceFor("campaigns.manage", "/admin/marketing");
  const parsed = templateFormSchema.safeParse({ id: optional(form, "id"), name: text(form, "name"), body: text(form, "body"), message_type: text(form, "message_type") || "marketing" });
  if (!parsed.success) back("/admin/marketing", parsed.error.issues[0]?.message ?? "Check the template.");
  const supabase = await createServerSupabaseClient();
  const payload = { ...parsed.data, ...(text(form, "archive") === "yes" ? { status: "archived" } : {}) };
  const { error } = await supabase.rpc("hanafy_template_save", { target_workspace_slug: access.workspace_slug, payload });
  if (error) back("/admin/marketing", messagingErrorMessage(error.message));
  revalidatePath("/admin/marketing");
  back("/admin/marketing", text(form, "archive") === "yes" ? "Template archived." : "Template saved.", "saved");
}

export async function setSuppression(form: FormData) {
  const access = await workspaceFor("messaging.manage", "/admin/marketing");
  const action = text(form, "action") === "lift" ? "lift" : "add";
  let payload: Record<string, string>;
  if (action === "lift") {
    const id = z.uuid().safeParse(text(form, "id"));
    const reason = text(form, "reason").trim();
    if (!id.success || reason.length < 3) back("/admin/marketing", "Say why the opt-out is being removed (the customer asked to be texted again).");
    payload = { action, id: id.data, reason };
  } else {
    const phone = normalizeUsPhone(text(form, "address"));
    if (!phone) back("/admin/marketing", "Enter a valid US mobile number.");
    payload = { action, address: phone, note: text(form, "note").slice(0, 500) };
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_suppression_set", { target_workspace_slug: access.workspace_slug, payload });
  if (error) back("/admin/marketing", messagingErrorMessage(error.message));
  revalidatePath("/admin/marketing");
  back("/admin/marketing", action === "lift" ? "Opt-out removed." : "Number opted out. It will not get texts from this business.", "saved");
}
