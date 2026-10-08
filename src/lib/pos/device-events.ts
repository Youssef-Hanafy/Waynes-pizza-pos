import "server-only";

import { logger } from "@/lib/logging/logger";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/**
 * Counter-device diagnostics (2026-10-08).  The Elo tablet has no developer
 * tools, so each Stripe Reader M2 step and every POS page script error is
 * written to public.pos_device_events, where it can be read back exactly.
 *
 * Never throws and never slows a payment: a missing table (migration not yet
 * applied) or any write error only goes to the server log.
 */
export type DeviceEvent = { kind: string; message?: string; detail?: Record<string, unknown> };

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function safeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  try {
    const text = JSON.stringify(detail ?? {});
    return text.length <= 8000 ? (JSON.parse(text) as Record<string, unknown>) : { truncated: text.slice(0, 8000) };
  } catch {
    return { unserializable: true };
  }
}

export async function recordDeviceEvents(scope: { workspaceId: string; profileId?: string | null; userAgent?: string | null; source: "client" | "server" }, events: DeviceEvent[]) {
  if (!events.length) return;
  const rows = events.slice(0, 40).map((event) => ({
    workspace_id: scope.workspaceId,
    profile_id: scope.profileId ?? null,
    source: scope.source,
    kind: clip(event.kind || "unknown", 80),
    message: clip(event.message ?? "", 2000),
    detail: safeDetail(event.detail),
    user_agent: scope.userAgent ? clip(scope.userAgent, 500) : null,
  }));
  try {
    const service = createServiceSupabaseClient();
    const { error } = await service.from("pos_device_events").insert(rows);
    if (error) logger.warn("pos_device_events.insert_failed", { code: error.code, kinds: rows.map((row) => row.kind).join(",") });
    // Keep a rolling 30 days.
    if (Math.random() < 0.02) await service.from("pos_device_events").delete().lt("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString());
  } catch (cause) {
    logger.warn("pos_device_events.unavailable", { error: cause instanceof Error ? cause.message : "unknown" });
  }
}
