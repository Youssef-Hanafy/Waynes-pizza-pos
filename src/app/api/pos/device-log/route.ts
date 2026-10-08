import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { recordDeviceEvents } from "@/lib/pos/device-events";

const noStore = { "Cache-Control": "no-store" };
const bodySchema = z.object({
  events: z.array(z.object({
    kind: z.string().min(1).max(80),
    message: z.string().max(4000).optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
    at: z.string().max(40).optional(),
  })).min(1).max(40),
});

/** The POS page reports card-reader steps and script errors here (see src/lib/pos/device-log.ts). */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !access?.workspace_id) return Response.json({ error: "POS access required." }, { status: 403, headers: noStore });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers: noStore });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid log." }, { status: 400, headers: noStore });
  await recordDeviceEvents(
    { workspaceId: access.workspace_id, profileId: access.profile_id, userAgent: request.headers.get("user-agent"), source: "client" },
    parsed.data.events.map((event) => ({ kind: event.kind, message: event.message, detail: { ...(event.detail ?? {}), ...(event.at ? { client_at: event.at } : {}) } })),
  );
  return Response.json({ ok: true }, { headers: noStore });
}
