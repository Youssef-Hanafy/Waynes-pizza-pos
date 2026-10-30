"use client";
import { useEffect, useState, type ReactNode } from "react";
import { holdRegister } from "@/lib/pos/register-owner";
import { logDevice } from "@/lib/pos/device-log";
/** Hold ownership for the entire mounted session. A newer tab cannot evict busy work. */
export function OneTab({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    if (!navigator.locks) { const timer = setTimeout(() => setSupported(false),0); return () => clearTimeout(timer); }
    return holdRegister(navigator.locks, () => setActive(true), () => {
      logDevice("app.competing_instance", "Another POS instance owns this browser register");
    });
  }, []);
  if (active) return <>{children}</>;
  return <div className="fixed inset-0 z-[200] flex items-center justify-center bg-wayne-cream-deep p-6">
    <section className="w-full max-w-lg rounded-3xl bg-white p-6 text-center shadow-xl">
      <h1 className="text-3xl font-black">{supported ? "Waiting for this register" : "Browser update required"}</h1>
      <p className="mt-2 text-wayne-muted">{supported ? "The POS may be open in another tab or window. Finish its active work, then close that tab. This screen will open automatically when the register is free." : "This browser cannot safely coordinate register ownership. Update Android System WebView or use a supported browser before opening the POS."}</p>
    </section>
  </div>;
}
