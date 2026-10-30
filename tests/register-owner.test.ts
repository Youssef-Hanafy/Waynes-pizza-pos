import {expect,it,vi} from "vitest";
import {holdRegister} from "../src/lib/pos/register-owner";
it("a competing tab waits, never evicts active work, and acquires after the owner closes",async()=>{
 let chain=Promise.resolve();
 const locks={request:vi.fn((_name:string,options:{signal:AbortSignal},callback:()=>Promise<void>)=>{
  const result=chain.then(async()=>{if(!options.signal.aborted)await callback();});chain=result;return result;
 })} as unknown as Pick<LockManager,"request">;
 const first=vi.fn(),second=vi.fn();
 const closeFirst=holdRegister(locks,first,vi.fn());await Promise.resolve();
 const closeSecond=holdRegister(locks,second,vi.fn());await Promise.resolve();
 expect(first).toHaveBeenCalledOnce();expect(second).not.toHaveBeenCalled();
 closeFirst();await new Promise(resolve=>setTimeout(resolve,0));expect(second).toHaveBeenCalledOnce();closeSecond();
});
