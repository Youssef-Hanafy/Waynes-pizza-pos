"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { RewardsSignup } from "./rewards-signup";

export function RewardsButton({ children, className }: { children: ReactNode; className?: string }) {
  return <button type="button" className={className} onClick={() => window.dispatchEvent(new Event("waynes:rewards"))}>{children}</button>;
}
export function RewardsExperience() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("waynes:rewards", show);
    let dismissed = false;
    try { dismissed = Boolean(sessionStorage.getItem("waynes-rewards-dismissed")); } catch {}
    const timer = !dismissed && ["/", "/menu", "/rewards"].includes(pathname) ? window.setTimeout(show, 1800) : undefined;
    return () => { window.removeEventListener("waynes:rewards", show); window.clearTimeout(timer); };
  }, [pathname]);
  return <RewardsSignup open={open} onClose={() => { setOpen(false); try { sessionStorage.setItem("waynes-rewards-dismissed", "1"); } catch {} }} />;
}
