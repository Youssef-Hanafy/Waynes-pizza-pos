import { loadPosRuntime } from "@/lib/pos/runtime";
import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/access";
import { SupportPill } from "@/components/ops/support-banner";
import { WorkspaceScope } from "@/components/ops/workspace-scope";
import { OneTab } from "./one-tab";
import { PosApp } from "./pos-app";

export const metadata: Metadata = { title: "Front POS", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PosPage() {
  const access = await requirePermission("pos.access", "/pos");
  const runtime = await loadPosRuntime(access);
  const { settings } = runtime;
  // The menu (sold-out items, prices) refreshes in the background every 3 minutes, but only while the register is
  // idle (PosAutoRefresh inside PosApp, owner 2026-10-28); the server still refuses a sold-out item on submit.
  return <>
    <WorkspaceScope defaultCity={settings.city} defaultState={settings.state} legacyOperations={access.legacy_operations ?? false} locationId={access.location_id ?? null} workspaceId={access.workspace_id ?? null} />
    <OneTab><PosApp {...runtime} /></OneTab>
    <SupportPill access={access} />
  </>;
}
