import "server-only";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const auditEntrySchema = z.object({
  id: z.number().int(),
  occurred_at: z.string(),
  actor_user_id: z.uuid().nullable(),
  actor_name: z.string(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable(),
  summary: z.string(),
  changes: z.record(z.string(), z.object({ from: z.unknown().optional(), to: z.unknown().optional() })),
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const errorEventSchema = z.object({
  id: z.number().int(), occurred_at: z.string(), digest: z.string().nullable(), route_path: z.string().nullable(),
  route_type: z.string().nullable(), request_path: z.string().nullable(), method: z.string().nullable(), message: z.string(),
});

export const auditPageSize = 50;

export async function getAuditLog(filters: { entity?: string; q?: string; page: number }) {
  const supabase = await createServerSupabaseClient();
  const from = (filters.page - 1) * auditPageSize;
  let query = supabase.from("audit_log").select("*", { count: "exact" }).order("occurred_at", { ascending: false }).order("id", { ascending: false }).range(from, from + auditPageSize - 1);
  if (filters.entity) query = query.eq("entity_type", filters.entity);
  if (filters.q) query = query.or(`summary.ilike.%${filters.q}%,actor_name.ilike.%${filters.q}%`);
  const [{ data, error, count }, roles] = await Promise.all([query, supabase.from("roles").select("id,name")]);
  if (error) throw new Error(`Audit log failed: ${error.message}`);
  return {
    entries: auditEntrySchema.array().parse(data ?? []),
    total: count ?? 0,
    roleNames: Object.fromEntries((roles.data ?? []).map((role: { id: string; name: string }) => [role.id, role.name])) as Record<string, string>,
  };
}

export async function getRecentServerErrors() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("app_error_events").select("id,occurred_at,digest,route_path,route_type,request_path,method,message").order("occurred_at", { ascending: false }).limit(25);
  if (error) return { errors: [], unavailable: true };
  return { errors: errorEventSchema.array().parse(data ?? []), unavailable: false };
}
