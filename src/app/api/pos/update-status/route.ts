import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { currentRelease } from "@/lib/pos/release";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
/** Read-only, workspace-scoped quiescence check. Never reconciles or moves money. */
export async function GET(request: Request) {
 const access = await getCurrentAccess();
 if (!hasPermission(access,"pos.access") || !access?.workspace_id) return Response.json({ error: "Sign in to verify pending work." },{status:403});
 const db = createServiceSupabaseClient();
 const [tips,refunds,payments,printing] = await Promise.all([
  db.from("pos_tip_operations").select("id",{head:true,count:"exact"}).eq("workspace_id",access.workspace_id).or("state.eq.pending,release_pending.eq.true"),
  db.from("refunds").select("id",{head:true,count:"exact"}).eq("workspace_id",access.workspace_id).eq("status","pending"),
  db.from("payments").select("id",{head:true,count:"exact"}).eq("workspace_id",access.workspace_id).eq("status","pending"),
  new URL(request.url).searchParams.get("printing") === "1" ? db.from("print_jobs").select("id",{head:true,count:"exact"}).eq("workspace_id",access.workspace_id).in("status",["pending","processing"]) : Promise.resolve({error:null,count:0}),
 ]);
 const results = [tips,refunds,payments,printing];
 if (results.some(r=>r.error || r.count===null)) return Response.json({ error: "Pending operations could not be verified. Keep this register open." },{status:503});
 const labels = ["pending tip or hold-release operation", "pending refund", "pending payment", "receipt or kitchen jobs waiting to finish"];
 return Response.json({ build: currentRelease().build, blockers: results.flatMap((r,i)=>r.count ? [labels[i]] : []) },{headers:{"Cache-Control":"no-store"}});
}
