"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { PosRuntime } from "@/lib/pos/runtime";
import { currentRelease } from "@/lib/pos/release";
import { updateSafety } from "@/lib/pos/update-activity";
import { requestAppUpdate } from "@/stores/app-update";
/** Refresh data only. RSC refresh can hard-navigate on skew, so it is never used in a running register. */
export function PosAutoRefresh({ isSafe, onData, intervalMs=180_000 }: { isSafe:()=>boolean; onData:(data:PosRuntime)=>void; intervalMs?:number }) {
 const safe=useRef(isSafe), apply=useRef(onData);
 useLayoutEffect(()=>{safe.current=isSafe;apply.current=onData;});
 useEffect(()=>{
  let stopped=false, running=false, last=Date.now();
  const check=async()=>{
   if(stopped||running||Date.now()-last<intervalMs||!safe.current())return;
   const before=updateSafety(); if(before.blockers.length)return;
   running=true;
   try{
    const r=await fetch("/api/pos/runtime",{cache:"no-store",signal:AbortSignal.timeout(15000)});
    if(!r.ok)return;
    const body=await r.json() as {build:string;data:PosRuntime};
    if(body.build!==currentRelease().build){requestAppUpdate();return;}
    const after=updateSafety();
    if(!stopped&&safe.current()&&!after.blockers.length&&before.revision===after.revision){apply.current(body.data);last=Date.now();}
   }catch{/* offline: preserve the loaded menu and retry, never navigate */}finally{running=false;}
  };
  const timer=window.setInterval(()=>{void check();},15000);
  return()=>{stopped=true;window.clearInterval(timer);};
 },[intervalMs]);
 return null;
}
