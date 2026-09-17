import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { secureTokenEquals } from "@/lib/integrations/hanafy";
import { logger } from "@/lib/logging/logger";
import { parseWhozzCallingRecord, phoneCallIngestSchema } from "@/lib/phone/schemas";

/**
 * Where the store's caller ID box reports a ring.
 *
 * The bridge on the store's computer presents CALLER_ID_INGEST_TOKEN.  Without
 * that token configured the route stays closed, because an open endpoint here
 * would let anyone make Wayne's phone appear to ring.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = process.env.CALLER_ID_INGEST_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!token || !secureTokenEquals(supplied, token)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }

  const parsed = phoneCallIngestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid call record." }, { status: 400 });
  }

  const input = parsed.data;
  const decoded = input.raw ? parseWhozzCallingRecord(input.raw) : null;
  if (input.raw && !decoded && typeof input.line_number !== "number") {
    // A record the unit sent that we could not read is worth knowing about, but
    // it is not the bridge's fault, so it is accepted rather than retried.
    logger.error("phone.record_unreadable", { raw: input.raw.slice(0, 200) });
    return Response.json({ ok: false, reason: "unreadable" }, { status: 202 });
  }

  const payload = {
    line_number: input.line_number ?? decoded?.line_number ?? 1,
    caller_number: input.caller_number ?? decoded?.caller_number ?? "",
    caller_name: input.caller_name ?? decoded?.caller_name ?? "",
    unit_number: input.unit_number ?? decoded?.unit_number ?? "",
    direction: input.direction ?? decoded?.direction ?? "inbound",
    event: input.event ?? decoded?.event ?? "start",
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    raw_record: input.raw ?? "",
  };

  // Only a ring on one of the store's lines belongs on the POS. An outbound call
  // the staff placed is recorded for the call log but never pops a card.
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_record_phone_call", { payload });
  if (error) {
    logger.error("phone.record_failed", { message: error.message });
    return Response.json({ error: "The call could not be recorded." }, { status: 500 });
  }
  return Response.json(data ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
}
