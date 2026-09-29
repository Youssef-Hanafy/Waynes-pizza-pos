"use client";

import { setClientWorkspaceScope } from "@/lib/tenancy/client-scope";

/**
 * Records which business this screen belongs to before any child effect runs
 * (render happens before effects), so realtime channels and saved drafts are
 * scoped from their first use.  Renders nothing.
 */
export function WorkspaceScope({ workspaceId, locationId, legacyOperations = false, defaultCity = "", defaultState = "" }: { workspaceId: string | null; locationId: string | null; legacyOperations?: boolean; defaultCity?: string; defaultState?: string }) {
  // Browser only: on the server a module variable would be shared between
  // requests for different businesses.
  if (typeof window !== "undefined") setClientWorkspaceScope({ workspaceId, locationId, legacyOperations, defaultCity, defaultState });
  return null;
}
