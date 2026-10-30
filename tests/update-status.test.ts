import {beforeEach,expect,it,vi} from "vitest";
import {GET} from "@/app/api/pos/update-status/route";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/auth/access",()=>({getCurrentAccess:async()=>access}));
vi.mock("@/lib/auth/permissions",()=>({hasPermission:()=>allowed}));
vi.mock("@/lib/supabase/server",()=>({createServiceSupabaseClient:()=>db}));
let access:{workspace_id:string}|null={workspace_id:"workspace-a"},allowed=true,failed=false;
const counts:Record<string,number>={};const filters:Array<[string,string,unknown]>=[];
const db={from:(table:string)=>{
 const query={select:()=>query,eq:(key:string,value:unknown)=>{filters.push([table,key,value]);return query;},or:()=>query,in:()=>query,then:(resolve:(v:unknown)=>void)=>Promise.resolve(resolve({count:counts[table]??0,error:failed?{message:"offline"}:null}))};return query;
}};
beforeEach(()=>{access={workspace_id:"workspace-a"};allowed=true;failed=false;filters.length=0;for(const k of Object.keys(counts))delete counts[k];});
it("scopes every query to the authenticated workspace and includes pending finance",async()=>{counts.pos_tip_operations=1;const r=await GET(new Request("https://example.com/api/pos/update-status?printing=1"));expect(r.status).toBe(200);expect((await r.json()).blockers).toEqual(["pending tip or hold-release operation"]);expect(filters.filter(([,key])=>key==="workspace_id")).toEqual(["pos_tip_operations","refunds","payments","print_jobs"].map(table=>[table,"workspace_id","workspace-a"]));});
it("does not let another register's printer backlog block a non-printer device",async()=>{counts.print_jobs=4;const r=await GET(new Request("https://example.com/api/pos/update-status?printing=0"));expect((await r.json()).blockers).toEqual([]);expect(filters.some(([table])=>table==="print_jobs")).toBe(false);});
it("fails closed when pending operations cannot be read",async()=>{failed=true;expect((await GET(new Request("https://example.com/api/pos/update-status"))).status).toBe(503);});
it("requires POS access before any service-role query",async()=>{allowed=false;expect((await GET(new Request("https://example.com/api/pos/update-status"))).status).toBe(403);expect(filters).toEqual([]);});
