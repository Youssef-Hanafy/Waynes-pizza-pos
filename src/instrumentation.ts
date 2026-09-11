import type { Instrumentation } from "next";

/**
 * Error monitoring without a third-party service: every server-side error is written
 * to the structured log (visible in the host's log viewer) and, when the service-role
 * key is configured, to public.app_error_events, which owners review at /admin/audit.
 * Reporting must never throw or slow the failing request down noticeably.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const [{ buildErrorEvent }, { logger }, { tryGetServerSupabaseEnvironment }, { createClient }] = await Promise.all([
      import("@/lib/monitoring/error-event"),
      import("@/lib/logging/logger"),
      import("@/lib/supabase/env"),
      import("@supabase/supabase-js"),
    ]);
    const event = buildErrorEvent(error, request, context);
    logger.error("server.request_error", error, { route: event.route_path, route_type: event.route_type, digest: event.digest });
    const environment = tryGetServerSupabaseEnvironment();
    if (!environment) return;
    const supabase = createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    await Promise.race([
      supabase.from("app_error_events").insert(event),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {
    // Monitoring is best-effort; the original error is still handled by Next.js.
  }
};
