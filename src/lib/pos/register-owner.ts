/** Browser releases this exclusive lock on tab close/crash. Never steal a live register. */
export function holdRegister(locks: Pick<LockManager,"request">, acquired:()=>void, waiting:()=>void) {
 const controller = new AbortController(); let stopped=false; let release:(()=>void)|undefined;
 const lifetime = new Promise<void>(resolve=>{release=resolve;});
 const timer = setTimeout(()=>{if(!stopped)waiting();},1000);
 void locks.request("wayne-pos-register-v2",{signal:controller.signal},async()=>{
  clearTimeout(timer); if(stopped)return; acquired(); await lifetime;
 }).catch(()=>{if(!stopped)waiting();});
 return ()=>{stopped=true;clearTimeout(timer);controller.abort();release?.();};
}
