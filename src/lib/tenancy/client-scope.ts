/**
 * The workspace/location the current browser screen belongs to (§37).
 *
 * Set from server-validated access by <WorkspaceScope> before any client
 * effect runs, and read by browser storage keys and realtime subscriptions so
 * that neither can mix two businesses on a shared device.  Switching
 * workspace is a full navigation, which resets this module.
 */
export type ClientWorkspaceScope = {
  workspaceId: string | null;
  locationId: string | null;
  legacyOperations: boolean;
  /** The location's own city/state, pre-filled on a new delivery address. */
  defaultCity?: string;
  defaultState?: string;
};

let scope: ClientWorkspaceScope = { workspaceId: null, locationId: null, legacyOperations: false };

export function setClientWorkspaceScope(next: ClientWorkspaceScope) {
  scope = next;
}

export function getClientWorkspaceScope(): ClientWorkspaceScope {
  return scope;
}

/** A postgres_changes filter limiting a realtime subscription to this workspace. */
export function workspaceRealtimeFilter(): { filter?: string } {
  return scope.workspaceId ? { filter: `workspace_id=eq.${scope.workspaceId}` } : {};
}
