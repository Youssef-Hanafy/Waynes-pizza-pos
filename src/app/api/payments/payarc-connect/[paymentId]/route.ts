import { z } from "zod";
import { payarcConnectCallbackAuthorized, payarcConnectConfig } from "@/lib/payments/payarc-connect";
import { reconcilePayarcConnectNotice, readPayarcConnectAttempt } from "@/lib/payments/payarc-connect-operation";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: Request, context: { params: Promise<{ paymentId: string }> }) {
  const paymentId = z.uuid().safeParse((await context.params).paymentId);
  if (!paymentId.success) return new Response(null, { status: 404 });
  const config = payarcConnectConfig();
  if (!config || !payarcConnectCallbackAuthorized(config, paymentId.data, new URL(request.url).searchParams.get("key"))) {
    return new Response(null, { status: 401 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > 131072) return new Response(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > 131072) return new Response(null, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); }
  catch { return new Response(null, { status: 400 }); }
  try {
    const service = createServiceSupabaseClient();
    const attempt = await readPayarcConnectAttempt(service, paymentId.data);
    if (!attempt) return new Response(null, { status: 404 });
    const settled = await reconcilePayarcConnectNotice(service, config, attempt, body);
    return new Response(null, { status: settled ? 204 : 503 });
  } catch {
    return new Response(null, { status: 503 });
  }
}
