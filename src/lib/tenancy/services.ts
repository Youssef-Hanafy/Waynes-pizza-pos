/**
 * Hanafy Platform service map (Phase 5).
 *
 * The database decides entitlement: a permission owned by a service is only
 * effective while that service is on (service_permissions + the permission
 * predicates).  This file is the application side of the same map, used to
 * build module-aware navigation and to explain a blocked page.  It never
 * grants anything; removing an entry here can only hide more.
 */

export const serviceCodes = [
  "pos",
  "online_ordering",
  "crm",
  "sms",
  "email",
  "automations",
  "customer_segments",
  "caller_id",
  "analytics",
  "delivery",
  "staff_management",
  "website_storefront",
  "hardware_management",
] as const;
export type ServiceCode = (typeof serviceCodes)[number];

export const serviceLabels: Record<ServiceCode, string> = {
  pos: "Point of sale",
  online_ordering: "Online ordering",
  crm: "CRM",
  sms: "SMS",
  email: "Email",
  automations: "Automations",
  customer_segments: "Customer segments",
  caller_id: "Caller ID",
  analytics: "Analytics",
  delivery: "Delivery",
  staff_management: "Staff management",
  website_storefront: "Website storefront",
  hardware_management: "Hardware management",
};

/**
 * Staff routes and the services that switch them on (any one is enough).
 * Longest prefix wins.  Routes that are not listed (overview, settings,
 * audit) are core workspace administration and are never gated.
 */
const routeServices: ReadonlyArray<readonly [string, readonly ServiceCode[]]> = [
  ["/pos", ["pos"]],
  ["/kitchen", ["pos"]],
  ["/driver", ["delivery"]],
  ["/admin/orders", ["pos", "online_ordering", "delivery", "analytics"]],
  ["/admin/calendar", ["pos", "online_ordering"]],
  ["/admin/delivery", ["delivery"]],
  ["/admin/reports", ["analytics"]],
  ["/admin/cash", ["pos"]],
  ["/admin/payments", ["pos", "online_ordering"]],
  ["/admin/customers", ["crm"]],
  ["/admin/segments", ["customer_segments"]],
  ["/admin/promotions", ["pos", "online_ordering"]],
  ["/admin/menu", ["pos", "online_ordering"]],
  ["/admin/settings", ["website_storefront"]],
  ["/admin/printing", ["pos", "hardware_management"]],
  ["/admin/hardware", ["hardware_management"]],
  ["/admin/pilot", ["pos"]],
  ["/admin/integrations", ["crm"]],
  ["/admin/staff", ["staff_management"]],
];

function matchesPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The services that enable a staff route, or null for an ungated route. */
export function servicesForPath(path: string): readonly ServiceCode[] | null {
  const clean = path.split(/[?#]/)[0] ?? "";
  let best: readonly [string, readonly ServiceCode[]] | null = null;
  for (const entry of routeServices) {
    if (matchesPrefix(clean, entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

/** True when the route is ungated or at least one of its services is on. */
export function isPathEnabled(path: string, enabledServices: readonly string[]) {
  const required = servicesForPath(path);
  return !required || required.some((service) => enabledServices.includes(service));
}

/** The first service a blocked route needs, for an honest "not enabled" message. */
export function missingServiceForPath(path: string, enabledServices: readonly string[]): ServiceCode | null {
  const required = servicesForPath(path);
  if (!required || required.some((service) => enabledServices.includes(service))) return null;
  return required[0] ?? null;
}

export function isServiceCode(value: string): value is ServiceCode {
  return (serviceCodes as readonly string[]).includes(value);
}

/**
 * Public storefront surfaces and the service each needs.  The storefront is
 * resolved from the request host; an unknown host has no services at all.
 */
export const storefrontServices = {
  site: "website_storefront",
  ordering: "online_ordering",
  rewards: "sms",
} as const satisfies Record<string, ServiceCode>;
