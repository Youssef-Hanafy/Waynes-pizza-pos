import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getClientWorkspaceScope } from "@/lib/tenancy/client-scope";

/** Authorized revision-only events; sensitive content is read through its RPC. */
export function watchPosRefresh(topic: "runtime" | "display", key: string, changed: () => void, connection?: (ready: boolean) => void) {
  const client = createBrowserSupabaseClient();
  const scope = getClientWorkspaceScope();
  if (!client || !scope.workspaceId) { connection?.(false); return () => {}; }
  const channel = client.channel(`pos-refresh-${topic}-${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "pos_refresh_signals", filter: `workspace_id=eq.${scope.workspaceId}` }, payload => {
      const row = payload.new as Record<string, unknown>;
      if (row.topic === topic && row.signal_key === key) changed();
    })
    .subscribe(status => {
      const ready = status === "SUBSCRIBED";
      connection?.(ready);
      // Re-read after every successful (re)subscription, including the initial
      // handshake, to close the gap between the first read and subscription.
      if (ready) changed();
    });
  return () => { void client.removeChannel(channel); };
}
