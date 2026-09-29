import "server-only";

import { getStorefront, type Storefront } from "@/lib/content/queries";
import { serviceLabels, type ServiceCode } from "./services";

type PublicServiceResult = { ok: true; storefront: Storefront } | { ok: false; response: Response };

/**
 * Public write endpoints (online orders, card checkout, Rewards signup) act for
 * the business that owns the request host, only while it has the service, and
 * only where the pre-platform order functions serve that business.  An
 * unknown host is refused rather than falling back to any business.
 */
export async function requirePublicService(service: ServiceCode): Promise<PublicServiceResult> {
  const storefront = await getStorefront();
  if (!storefront.known || !storefront.workspace) {
    return { ok: false, response: Response.json({ error: "This website is not set up for ordering." }, { status: 404, headers: { "Cache-Control": "no-store" } }) };
  }
  if (!storefront.services.includes(service)) {
    return { ok: false, response: Response.json({ error: `${serviceLabels[service]} is not available here.`, code: "SERVICE_DISABLED", service }, { status: 403, headers: { "Cache-Control": "no-store" } }) };
  }
  if (!storefront.workspace.legacy_operations) {
    return { ok: false, response: Response.json({ error: `${serviceLabels[service]} is not available here yet.`, code: "SERVICE_NOT_MIGRATED", service }, { status: 403, headers: { "Cache-Control": "no-store" } }) };
  }
  return { ok: true, storefront };
}
