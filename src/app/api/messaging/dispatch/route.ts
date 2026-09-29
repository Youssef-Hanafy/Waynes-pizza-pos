import { secureTokenEquals } from "@/lib/integrations/hanafy";
import { logger } from "@/lib/logging/logger";
import { dispatchDueMessages } from "@/lib/messaging/dispatch";

export const dynamic = "force-dynamic";

/**
 * Hanafy Platform message dispatcher (Phase 7).  Called on a schedule (Vercel
 * cron with CRON_SECRET, or any scheduler with MESSAGING_DISPATCH_TOKEN).  It
 * only ever sends for businesses whose messaging is set to the platform
 * sender; businesses still on the old Hanafy CRM are never touched.
 */
export async function POST(request: Request) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const tokens = [process.env.MESSAGING_DISPATCH_TOKEN, process.env.CRON_SECRET].filter((token): token is string => Boolean(token && token.length >= 16));
  if (!tokens.length || !tokens.some((token) => secureTokenEquals(supplied, token))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const summary = await dispatchDueMessages();
    return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error("messaging.dispatch_failed", error);
    return Response.json({ error: "Dispatch failed." }, { status: 500 });
  }
}

export { POST as GET };
