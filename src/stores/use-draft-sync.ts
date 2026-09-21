"use client";

import { useEffect } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { draftSync } from "./draft-sync";
import { loadSavedDrafts, orderStore } from "./order-store";

/**
 * Runs Phase 6 on the POS screen: mirrors tickets to the server as they
 * change, listens (Supabase Realtime) for tickets held or taken over on other
 * registers, and resends anything that failed while offline.  Event driven:
 * the only timer is the short save debounce.
 */
export function useDraftSync() {
  useEffect(() => {
    loadSavedDrafts();
    const offStore = orderStore.subscribe(() => draftSync.schedule());
    const client = createBrowserSupabaseClient();
    const channel = client?.channel(`wayne-drafts-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "pos_drafts" }, () => void draftSync.refreshRemote())
      .subscribe((state) => { if (state === "SUBSCRIBED") void draftSync.refreshRemote(); });

    const back = () => { void draftSync.retryPending().then(() => draftSync.pushNow()).then(() => draftSync.refreshRemote()); };
    const visible = () => { if (document.visibilityState === "visible") back(); };
    // A ticket that could not be sent is still on this register; closing the
    // tab would not lose it, but it would not be sent until the POS reopens.
    const leaving = (event: BeforeUnloadEvent) => {
      if (draftSync.pendingCount() > 0) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("online", back);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("beforeunload", leaving);
    back();
    return () => {
      offStore();
      window.removeEventListener("online", back);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("beforeunload", leaving);
      if (client && channel) void client.removeChannel(channel);
    };
  }, []);
}
