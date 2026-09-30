/**
 * Which web address serves what.
 *
 *   Software (Hanafy Platform): app.hanafymedia.com — Platform Admin, business
 *   workspaces, back office, POS, kitchen, driver, staff sign-in.
 *   Storefronts: each business's own address (waynespizzaofworcester.com…) —
 *   the customer website, ordering, Rewards/SMS sign-up, offers.
 *
 * The split turns on only when NEXT_PUBLIC_SOFTWARE_HOST is set, so a
 * deployment keeps working exactly as before until that address is live.
 * API routes are never redirected: webhooks, the caller-ID bridge and the
 * print station keep posting to whatever address they were given.
 */

const softwarePrefixes = ["/platform", "/w", "/admin", "/pos", "/kitchen", "/driver", "/login", "/unauthorized", "/auth"] as const;

export function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().split(",")[0]!.trim().replace(/:\d+$/, "").replace(/\.+$/, "");
}

/** The software address, e.g. "app.hanafymedia.com", or null while the split is off. */
export function softwareHost(env: Record<string, string | undefined> = process.env): string | null {
  const host = normalizeHost(env.NEXT_PUBLIC_SOFTWARE_HOST);
  return host ? host : null;
}

function matches(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isSoftwarePath(pathname: string) {
  return softwarePrefixes.some((prefix) => matches(pathname, prefix));
}

/** Local development and preview addresses are never split. */
function isDevelopmentHost(host: string) {
  // 10.0.2.2 is this computer as seen from the Android emulator.
  return host === "localhost" || host === "127.0.0.1" || host === "10.0.2.2" || host.endsWith(".local");
}

export type HostDecision =
  | { action: "continue" }
  | { action: "redirect"; location: string }
  | { action: "not_found" };

/**
 * Decide what to do with a page request.  Software pages asked for on a
 * storefront go to the software address; storefront pages asked for on the
 * software address don't exist there (its home goes to the workspace picker).
 */
export function routeByHost(input: { host: string; pathname: string; search: string; softwareHost: string | null }): HostDecision {
  const host = normalizeHost(input.host);
  const target = input.softwareHost;
  if (!target || !host || isDevelopmentHost(host) || input.pathname.startsWith("/api/") || input.pathname.startsWith("/_next/")) {
    return { action: "continue" };
  }
  const software = isSoftwarePath(input.pathname);
  if (host === target) {
    if (software) return { action: "continue" };
    if (input.pathname === "/") return { action: "redirect", location: `https://${target}/w` };
    return { action: "not_found" };
  }
  if (software) return { action: "redirect", location: `https://${target}${input.pathname}${input.search}` };
  return { action: "continue" };
}
