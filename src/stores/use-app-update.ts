"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { registerScreenSafety, retainAppUpdates } from "./app-update";
/** Every screen contributes a guard to one shared lifecycle manager. */
export function useAppUpdate(isSafe: () => boolean) {
 const safe = useRef(isSafe);
 useLayoutEffect(() => { safe.current = isSafe; });
 useEffect(() => {
  const key = `screen:${Math.random().toString(36).slice(2)}`;
  const off = registerScreenSafety(key,()=>safe.current()); const release = retainAppUpdates();
  return () => { off(); release(); };
 },[]);
}
