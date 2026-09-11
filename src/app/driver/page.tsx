import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getDriverBoard } from "@/lib/delivery/queries";
import type { DriverBoard } from "@/lib/delivery/schemas";
import { DriverScreen } from "./driver-screen";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Deliveries", robots: { index: false, follow: false } };

export default async function DriverPage() {
  const access = await requirePermission("driver.access", "/driver");
  let board: DriverBoard = { assignments: [], available: [] };
  let initialError = "";
  try { board = await getDriverBoard(); } catch { initialError = "Deliveries are unavailable. Checking connection…"; }
  return <DriverScreen
    initialBoard={board}
    initialError={initialError}
    staffName={access.display_name}
    canOpenAdmin={hasPermission(access, "admin.access")}
    canOpenPos={hasPermission(access, "pos.access")}
  />;
}
