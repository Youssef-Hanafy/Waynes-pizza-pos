"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { automationErrorMessage, definitionFromForm } from "@/lib/automations/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

function back(path: string, message: string, key: "error" | "saved" = "error"): never {
  redirect(`${path}?${new URLSearchParams({ [key]: message }).toString()}`);
}

/** Saving always stores a new version; running automations keep the version they started with. */
export async function saveAutomation(form: FormData) {
  const access = await requirePermission("automations.manage", "/admin/automations");
  const parsed = definitionFromForm(form);
  const path = text(form, "id") ? `/admin/automations/${text(form, "id")}` : "/admin/automations";
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the automation.");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_automation_save", { target_workspace_slug: access.workspace_slug, payload: parsed.data });
  if (error) back(path, automationErrorMessage(error.message));
  revalidatePath("/admin/automations");
  redirect(`/admin/automations/${String(data)}?saved=${encodeURIComponent("Saved as a new version.")}`);
}

export async function setAutomationStatus(form: FormData) {
  const access = await requirePermission("automations.manage", "/admin/automations");
  const id = z.uuid().safeParse(text(form, "id"));
  const status = z.enum(["active", "paused", "archived", "draft"]).safeParse(text(form, "status"));
  if (!id.success || !status.success) back("/admin/automations", "Automation not found.");
  const path = `/admin/automations/${id.data}`;
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_automation_set_status", { target_workspace_slug: access.workspace_slug, target_automation_id: id.data, new_status: status.data });
  if (error) back(path, automationErrorMessage(error.message));
  revalidatePath("/admin/automations");
  back(path, status.data === "active" ? "Automation is on." : status.data === "paused" ? "Automation paused. Waiting runs resume when it is switched back on." : `Automation is ${status.data}.`, "saved");
}

export async function replayEvent(form: FormData) {
  const access = await requirePermission("automations.manage", "/admin/automations");
  const id = z.uuid().safeParse(text(form, "id"));
  const eventId = z.uuid().safeParse(text(form, "event_id").trim());
  if (!id.success) back("/admin/automations", "Automation not found.");
  const path = `/admin/automations/${id.data}`;
  if (!eventId.success) back(path, "Paste a valid event id.");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_automation_replay_event", {
    target_workspace_slug: access.workspace_slug, target_automation_id: id.data, target_event_id: eventId.data, change_reason: text(form, "reason"),
  });
  if (error) back(path, automationErrorMessage(error.message));
  const result = data as { created: boolean };
  back(path, result.created ? "Event replayed: a run was created." : "Nothing new: that event was already handled or does not match.", result.created ? "saved" : "error");
}
