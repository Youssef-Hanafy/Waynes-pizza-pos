import { timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logging/logger";
import { captureHeldCards, type TipRequest } from "@/lib/payments/tip-capture";
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
    .select("id, order_id, authorized_at, created_at, workspace_id, location_id")
    .eq("status", "authorized").eq("method", "card").in("provider", ["stripe", "test"])
    .lt("created_at", cutoff).limit(500);
  if (error) {
    logger.error("payments.tip_auto_load_failed", new Error(error.message));
    return Response.json({ error: "Held cards could not be loaded." }, { status: 503 });
  }

  // An unfinished operation keeps its original tip, even when recovery comes
  // from the zero-tip nightly job. Completed charges can still need hold release.
  const { data: recovery, error: recoveryError } = await service.from("pos_tip_operations")
    .select("payment_id, order_id, workspace_id, location_id, requested_tip_cents")
    .or("state.eq.pending,release_pending.eq.true").order("updated_at").limit(500);
  if (recoveryError) return Response.json({ error: "Tip recovery could not be loaded." }, { status: 503 });
  const groups = new Map<string, { workspaceId: string; locationId: string | null; payments: Map<string, TipRequest> }>();
  for (const row of [...(rows ?? []).map((row) => ({ ...row, payment_id: row.id, requested_tip_cents: 0 })), ...(recovery ?? [])]) {
    const key = `${row.workspace_id}:${row.location_id ?? ""}`;
    const group = groups.get(key) ?? { workspaceId: row.workspace_id as string, locationId: (row.location_id as string | null) ?? null, payments: new Map<string, TipRequest>() };
    group.payments.set(row.payment_id as string, { payment_id: row.payment_id as string, order_id: row.order_id as string, tip_cents: row.requested_tip_cents as number });
    groups.set(key, group);
  }

  let charged = 0;
  const problems: string[] = [];
  for (const group of groups.values()) {
    const result = await captureHeldCards({
      service, workspaceId: group.workspaceId, locationId: group.locationId,
      requests: [...group.payments.values()], keyPrefix: "auto",
    });
    problems.push(...result.problems);
    charged += result.captures.length;
  }
  if (problems.length) logger.warn("payments.tip_auto_problems", { count: problems.length, first: problems.slice(0, 5).join(" | ") });
  return Response.json({ charged, waiting: rows?.length ?? 0, problems }, { headers: { "Cache-Control": "no-store" } });
}
