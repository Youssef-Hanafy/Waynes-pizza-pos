"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const payloadSchema = z.object({ id: z.uuid().optional(), name: z.string().trim().min(2).max(100), description: z.string().trim().max(1000), rules_json: z.record(z.string(), z.unknown()), active: z.boolean(), sort_order: z.number().int().min(-10000).max(10000) });
export async function saveSegment(formData: FormData) { await requirePermission("segments.manage", "/admin/segments"); const parsedRules = JSON.parse(String(formData.get("rules_json") ?? "")); const payload = payloadSchema.parse({ id: String(formData.get("id") ?? "") || undefined, name: formData.get("name"), description: formData.get("description"), rules_json: parsedRules, active: formData.get("active") === "on", sort_order: Number(formData.get("sort_order") ?? 0) }); const supabase = await createServerSupabaseClient(); const { error } = await supabase.rpc("wayne_save_customer_segment", { payload }); if (error) throw new Error(error.message); revalidatePath("/admin/segments"); revalidatePath("/admin/customers"); }
export async function runInactivityEvaluation() { await requirePermission("segments.manage", "/admin/segments"); const supabase = await createServerSupabaseClient(); const { error } = await supabase.rpc("wayne_run_nightly_inactivity_evaluator"); if (error) throw new Error(error.message); revalidatePath("/admin/segments"); revalidatePath("/admin/customers"); }
