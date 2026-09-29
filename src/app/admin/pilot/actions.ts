"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/access";
import { pilotRecordSchema } from "@/lib/pilot/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Record one pilot check. Owner or manager; audited in the database. */
export async function recordPilotCheck(form: FormData) {
  await requirePermission("pilot.manage", "/admin/pilot");
  const parsed = pilotRecordSchema.safeParse({ key: form.get("key"), result: form.get("result") ?? "", note: form.get("note") ?? "" });
  if (!parsed.success) redirect(`/admin/pilot?error=${encodeURIComponent("Check the result and note.")}`);
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_record_pilot_check", {
    target_key: parsed.data!.key, result_value: parsed.data!.result || null, note_value: parsed.data!.note,
  });
  if (error) {
    const message = error.message.includes("not applicable") ? "A required check cannot be skipped — it has to pass." : error.code === "42501" ? "Only the owner or a manager can record pilot results." : "The result could not be saved.";
    redirect(`/admin/pilot?error=${encodeURIComponent(message)}#${parsed.data!.key}`);
  }
  revalidatePath("/admin/pilot");
  redirect(`/admin/pilot#${parsed.data!.key}`);
}
