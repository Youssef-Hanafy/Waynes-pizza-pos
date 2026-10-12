"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { PosKeyboard } from "@/app/pos/pos-keyboard";

/** Staff screens that get Wayne's keyboard.  The POS mounts its own. */
const STAFF_PREFIXES = ["/admin", "/kitchen", "/driver", "/platform", "/w", "/login", "/auth", "/pos/admin-pin"];

function isStaffPath(pathname: string) {
  return STAFF_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Wayne's on-screen keyboard on every staff screen, not just the POS (owner,
 * 2026-10-12) — the tablet's split keyboard was still showing up in Admin.
 * Never on the customer website.  The page gets bottom padding the height of
 * the keyboard so nothing hides behind it.
 */
export function StaffKeyboard() {
  const pathname = usePathname() ?? "";
  const active = isStaffPath(pathname);

  useEffect(() => {
    if (!active) return;
    document.body.classList.add("wayne-kb-pad");
    return () => document.body.classList.remove("wayne-kb-pad");
  }, [active]);

  return active ? <PosKeyboard /> : null;
}
