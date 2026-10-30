import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { loadPosRuntime } from "@/lib/pos/runtime";
import { currentRelease } from "@/lib/pos/release";
export const dynamic = "force-dynamic";
export async function GET() {
 const access = await getCurrentAccess();
 if (!hasPermission(access,"pos.access") || !access) return Response.json({error:"POS access required"},{status:403});
 return Response.json({build:currentRelease().build,data:await loadPosRuntime(access)},{headers:{"Cache-Control":"no-store"}});
}
