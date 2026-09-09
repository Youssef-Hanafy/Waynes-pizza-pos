"use server";
import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function retryPrintJob(form: FormData) {
  await requirePermission("printing.manage", "/admin/printing");
  const parsed = z.object({ id: z.uuid(), reason: z.string().trim().min(3).max(500), inspected: z.literal("on") }).safeParse({ id: form.get("id"), reason: form.get("reason"), inspected: form.get("inspected") });
  if (!parsed.success) redirect("/admin/printing?error=Enter+a+retry+reason+and+confirm+printer+inspection.");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_retry_print_job", { target_job_id: parsed.data.id, retry_reason: parsed.data.reason });
  if (error) redirect("/admin/printing?error=The+job+changed+or+cannot+be+retried.+Refresh+and+check+its+status.");
  revalidatePath("/admin/printing");
  redirect("/admin/printing?saved=1");
}
