import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { secureTokenEquals, signHanafyEnvelope } from "@/lib/integrations/hanafy";

export const dynamic = "force-dynamic";
const maxJobs = 25;

export async function POST(request: Request) {
  const token = process.env.INTEGRATION_WORKER_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!token || !secureTokenEquals(supplied, token)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const supabase = createServiceSupabaseClient();
  let delivered = 0; let failed = 0;
  for (let index = 0; index < maxJobs; index += 1) {
    const { data: job, error: claimError } = await supabase.rpc("wayne_claim_hanafy_outbox", { worker_id: "next-hanafy-worker" });
    if (claimError) return Response.json({ error: claimError.message, delivered, failed }, { status: 500 });
    if (!job) break;
    const row = job as { id: string; lease_token: string; payload: Record<string, unknown> };
    const { data: destination, error: destinationError } = await supabase.from("integration_destinations").select("endpoint_url,signing_secret").eq("id", "hanafy").single();
    if (destinationError || !destination) { await finish(supabase, row, false, null, null, "Hanafy destination is not configured."); failed += 1; continue; }
    const body = JSON.stringify(row.payload); const timestamp = new Date().toISOString();
    const signature = signHanafyEnvelope(destination.signing_secret, timestamp, body);
    try {
      const response = await fetch(destination.endpoint_url, { method: "POST", headers: { "content-type": "application/json", "x-waynes-event-id": String(row.payload.event_id), "x-waynes-timestamp": timestamp, "x-waynes-signature": signature }, body, signal: AbortSignal.timeout(15_000) });
      const responseBody = (await response.text()).slice(0, 2000);
      await finish(supabase, row, response.ok, response.status, responseBody, response.ok ? null : `Hanafy returned HTTP ${response.status}.`);
      if (response.ok) delivered += 1; else failed += 1;
    } catch (error) { await finish(supabase, row, false, null, null, error instanceof Error ? error.message : "Delivery request failed."); failed += 1; }
  }
  return Response.json({ delivered, failed });
}

export { POST as GET };
async function finish(supabase: ReturnType<typeof createServiceSupabaseClient>, row: { id: string; lease_token: string }, succeeded: boolean, responseCode: number | null, responseBody: string | null, error: string | null) { const { error: finishError } = await supabase.rpc("wayne_finish_hanafy_outbox", { outbox_id: row.id, token: row.lease_token, succeeded, response_code_value: responseCode, response_body_value: responseBody, error_value: error }); if (finishError) throw new Error(finishError.message); }
