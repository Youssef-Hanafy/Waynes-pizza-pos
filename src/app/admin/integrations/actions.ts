"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
const configSchema = z.object({ endpoint_url: z.url().refine((value) => value.startsWith("https://")), business_id: z.string().trim().min(2).max(100), signing_secret: z.string().min(32).max(500), active: z.literal("on").optional() });
export async function saveHanafyIntegration(formData: FormData) { await requirePermission("integrations.manage", "/admin/integrations"); const parsed = configSchema.safeParse(Object.fromEntries(formData)); if (!parsed.success) redirect("/admin/integrations?error=Enter+a+valid+HTTPS+endpoint+and+a+32-character+secret."); const supabase = await createServerSupabaseClient(); const { error } = await supabase.rpc("wayne_configure_hanafy_integration", { payload: { ...parsed.data, active: parsed.data.active === "on" } }); if (error) redirect(`/admin/integrations?error=${encodeURIComponent(error.message)}`); revalidatePath("/admin/integrations"); redirect("/admin/integrations?saved=1"); }
export async function replayHanafyEvent(formData: FormData) { await requirePermission("integrations.manage", "/admin/integrations"); const id = z.uuid().safeParse(formData.get("id")); if (!id.success) redirect("/admin/integrations?error=Invalid+event."); const supabase = await createServerSupabaseClient(); const { error } = await supabase.rpc("wayne_replay_hanafy_outbox", { outbox_id: id.data }); if (error) redirect(`/admin/integrations?error=${encodeURIComponent(error.message)}`); revalidatePath("/admin/integrations"); redirect("/admin/integrations?replayed=1"); }
