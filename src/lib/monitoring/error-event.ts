export type ErrorRequest = { path: string; method: string };
export type ErrorContext = { routePath: string; routeType: string };

const secretPattern = /(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+|sk_(live|test)_\w+|(password|secret|token|key)=[^&\s]+)/gi;

/** Removes credentials and query strings (which can carry customer data) before storage. */
export function scrub(value: string, limit: number) {
  return value.replace(secretPattern, "[redacted]").slice(0, limit);
}

/** Converts a Next.js onRequestError call into the app_error_events row shape. */
export function buildErrorEvent(error: unknown, request: ErrorRequest, context: ErrorContext) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown server error";
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : null;
  return {
    digest: digest ? digest.slice(0, 200) : null,
    route_path: context.routePath.slice(0, 500),
    route_type: context.routeType.slice(0, 40),
    request_path: scrub(request.path.split("?")[0] ?? request.path, 1000),
    method: request.method.slice(0, 16),
    message: scrub(message, 2000),
    stack: error instanceof Error && error.stack ? scrub(error.stack, 8000) : null,
  };
}
