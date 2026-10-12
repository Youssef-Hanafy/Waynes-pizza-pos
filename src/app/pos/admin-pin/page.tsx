import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getWorkspaceAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { AdminPinScreen } from "./admin-pin-screen";

export const metadata: Metadata = { title: "Manager PIN", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminPinPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const access = await getWorkspaceAccess();
  if (!access) redirect("/login?next=/admin");
  if (!hasPermission(access, "admin.access")) redirect("/unauthorized");
  const { next } = await searchParams;
  const target = next && (next === "/admin" || next.startsWith("/admin/")) && !next.startsWith("//") ? next : "/admin";
  return <AdminPinScreen next={target} />;
}
