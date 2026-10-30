import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateManager, UPDATE_JOURNAL, UPDATE_HIGH_WATER, type UpdateDependencies } from "../src/lib/pos/update-manager";
import type { Release } from "../src/lib/pos/release";
const release = (build:string,day:number):Release=>({build,commit:"a".repeat(40),builtAt:`2026-10-${day}T00:00:00Z`,contract:1,minimumClient:0,minimumBridge:1});
const loaded=release("A",20), latest=release("B",21);
function fixture() {
 vi.useFakeTimers();
 const storage=new Map<string,string>(); storage.set("pos-drafts.v2",JSON.stringify({ticket:"offline order",amount:2000}));
 let blockers:string[]=[], revision=0, server:string[]=[], next=latest;
 const reload=vi.fn(); const read=vi.fn(async()=>next);
 const d:UpdateDependencies={loaded,read,safety:()=>({blockers,revision}),serverSafety:async()=>server,bridge:()=>1,persist:()=>true,get:k=>storage.get(k)??null,put:(k,v)=>{storage.set(k,v);},reload,changed:vi.fn()};
 const manager=new UpdateManager(d);
 return {manager,d,reload,read,storage,busy:(...values:string[])=>{blockers=values;revision++;},activity:()=>revision++,server:(values:string[])=>{server=values;},next:(r:Release)=>{next=r;},advance:()=>vi.advanceTimersByTimeAsync(901)};
}
afterEach(()=>vi.useRealTimers());
describe("controlled application updates",()=>{
 it("regression: idle when scheduled but busy before reload must not reload",async()=>{const f=fixture();await f.manager.check();f.busy("order open");await f.advance();expect(f.reload).not.toHaveBeenCalled();expect(f.manager.state.status).toBe("waiting");});
 for(const work of ["creating an order","editing an existing order","payment processing","tip selection","signature collection","printing","offline synchronization","pending financial operation","background app","offline connection"]) {
  it(`waits throughout ${work}, then updates when genuinely idle`,async()=>{const f=fixture();f.busy(work);await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();f.busy();f.manager.tick();await f.advance();expect(f.reload).toHaveBeenCalledExactlyOnceWith("B");});
 }
 it("idle update verifies alias again and reloads exactly once despite repeated polls/ticks",async()=>{const f=fixture();await Promise.all([f.manager.check(),f.manager.check()]);await f.advance();await f.manager.check();f.manager.tick();await f.advance();expect(f.read).toHaveBeenCalledTimes(2);expect(f.reload).toHaveBeenCalledExactlyOnceWith("B");});
 it("waits if work starts during asynchronous server verification",async()=>{const f=fixture();f.d.serverSafety=async()=>{f.busy("payment");return [];};await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();});
 it("rechecks after journal persistence immediately before reload",async()=>{const f=fixture();const put=f.d.put;f.d.put=(k,v)=>{put(k,v);if(k===UPDATE_JOURNAL)f.busy("printing");};await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();});
 it("activity that begins and finishes during verification still defers",async()=>{const f=fixture();f.d.serverSafety=async()=>{f.activity();return [];};await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();});
 it("checks authoritative durable operations",async()=>{const f=fixture();f.server(["pending tip hold release"]);await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();f.server([]);f.manager.tick();await f.advance();expect(f.reload).toHaveBeenCalledOnce();});
 it("offline version check does not reload; reconnection verifies before updating",async()=>{const f=fixture();f.read.mockRejectedValueOnce(Error("offline"));await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();await f.manager.check();await f.advance();expect(f.reload).toHaveBeenCalledOnce();});
 it("keeps saved offline orders byte-for-byte intact",async()=>{const f=fixture();const before=f.storage.get("pos-drafts.v2");await f.manager.check();await f.advance();expect(f.storage.get("pos-drafts.v2")).toBe(before);});
 it("rapid deployments use the latest verified target",async()=>{const f=fixture();await f.manager.check();f.next(release("C",22));await f.advance();expect(f.reload).toHaveBeenCalledExactlyOnceWith("C");});
 it("refuses an older deployment response",async()=>{const f=fixture();await f.manager.check();f.next(release("old",19));await f.advance();expect(f.reload).not.toHaveBeenCalled();expect(f.manager.state.status).toBe("blocked");});
 it("high water survives restarting and rejects alias rollback",async()=>{const f=fixture();f.storage.set(UPDATE_HIGH_WATER,JSON.stringify(release("C",22)));await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();expect(f.manager.state.status).toBe("blocked");});
 it("checks bridge compatibility",async()=>{const f=fixture();f.d.bridge=()=>0;await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();expect(f.manager.state.status).toBe("blocked");});
 it("requires durable storage before leaving",async()=>{const f=fixture();f.d.persist=()=>false;await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();});
 it("allows a compatible older client to update before requiring the next contract",async()=>{const f=fixture();f.next({...latest,contract:2,minimumClient:2});await f.manager.check();await f.advance();expect(f.reload).toHaveBeenCalledOnce();});
 it("asset failures recover only through the same idle verification",async()=>{const f=fixture();f.next(loaded);f.busy("tip");f.manager.request("asset load failed");await Promise.resolve();await f.advance();expect(f.reload).not.toHaveBeenCalled();f.busy();f.manager.tick();await f.advance();expect(f.reload).toHaveBeenCalledExactlyOnceWith("A");});
 it("bounds reload attempts even when broken same-build assets return again",async()=>{const f=fixture();f.storage.set(UPDATE_JOURNAL,JSON.stringify({target:"B",attempts:2,confirmed:true,at:new Date().toISOString(),reason:"asset"}));await f.manager.check();await f.advance();expect(f.reload).not.toHaveBeenCalled();expect(f.manager.state.status).toBe("blocked");});
 it("confirms the loaded target after navigation",()=>{const f=fixture();f.storage.set(UPDATE_JOURNAL,JSON.stringify({target:"A",attempts:1,at:new Date().toISOString(),reason:"deployment"}));const manager=new UpdateManager(f.d);expect(manager.state.lastReload?.confirmed).toBe(true);});
 it("unmount cancels scheduled reloads",async()=>{const f=fixture();await f.manager.check();f.manager.stop();await f.advance();expect(f.reload).not.toHaveBeenCalled();});
});
