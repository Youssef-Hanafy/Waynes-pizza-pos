import { timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logging/logger";
import { captureHeldCards } from "@/lib/payments/tip-capture";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/**
 * The 4:30 am safety net (owner, 2026-10-13).  A card held for its tip must be
 * captured before Stripe lets the approval run out, so anything still waiting
 * (approved more than 4 hours ago) is charged for the order with no added
 * tip.  Called by the database's own scheduler (pg_cron, job
 * "wayne-tip-auto-capture") with a token only the database knows.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  const service = createServiceSupabaseClient();
  const presented = request.headers.get("x-wayne-job-token") ?? "";
  const { data: secret } = await service.from("scheduled_job_tokens").select("token").eq("name", "tip_auto_capture").maybeSingle();
  if (!secret?.token || presented.length < 32 || !same(presented, secret.token)) return Response.json({ error: "Not allowed." }, { status: 401 });

  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await service.from("payments")
    .select("order_id, authorized_at, created_at, workspace_id, location_id")
    .eq("status", "authorized").eq("method", "card").in("provider", ["stripe", "test"])
    .lt("created_at", cutoff).limit(500);
  if (error) {
    logger.error("payments.tip_auto_load_failed", new Error(error.message));
    return Response.json({ error: "Held cards could not be loaded." }, { status: 503 });
  }

  const groups = new Map<string, { workspaceId: string; locationId: string | null; orders: string[] }>();
  for (const row of rows ?? []) {
    const key = `${row.workspace_id}:${row.location_id ?? ""}`;
    const group = groups.get(key) ?? { workspaceId: row.workspace_id as string, locationId: (row.location_id as string | null) ?? null, orders: [] };
    group.orders.push(row.order_id as string);
    groups.set(key, group);
  }

  let charged = 0;
  const problems: string[] = [];
  for (const group of groups.values()) {
    const result = await captureHeldCards({
      service, workspaceId: group.workspaceId, locationId: group.locationId,
      requests: group.orders.map((orderId) => ({ order_id: orderId, tip_cents: 0 })), keyPrefix: "auto",
    });
    problems.push(...result.problems);
    if (!result.captures.length) continue;
    const { data, error: applyError } = await service.rpc("wayne_pos_apply_card_tips", { captures: result.captures, via: "auto_nightly" });
    if (applyError) { logger.error("payments.tip_auto_apply_failed", applyError, { workspace_id: group.workspaceId }); problems.push(applyError.message); continue; }
    charged += (data as { count?: number } | null)?.count ?? result.captures.length;
  }
  if (problems.length) logger.warn("payments.tip_auto_problems", { count: problems.length, first: problems.slice(0, 5).join(" | ") });
  return Response.json({ charged, waiting: rows?.length ?? 0, problems }, { headers: { "Cache-Control": "no-store" } });
}
