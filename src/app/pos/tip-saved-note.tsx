"use client";

import type { LocalTipDrafts, TipSaveState } from "@/lib/tips/drafts";

/**
 * Where a typed tip is (owner, 2026-10-28): saved on this register, saved, or
 * not saved — and, above the list, that saved tips are NOT charged until
 * Charge / Cash out is pressed.
 */
export function TipSavedNote({ state, terminal, error }: { state: TipSaveState; terminal?: string; error?: string }) {
  if (state === "none") return null;
  if (state === "error") return <span className="block text-xs font-bold normal-case tracking-normal text-wayne-alert" role="alert">Not saved: {error}</span>;
  if (state === "local") return <span className="block text-xs font-bold normal-case tracking-normal text-wayne-muted">Saved on this register · sending…</span>;
  return <span className="block text-xs font-bold normal-case tracking-normal text-wayne-ok">✓ Saved{terminal ? ` (${terminal})` : ""} · not charged yet</span>;
}

export function TipsSavedBanner({ drafts, orderIds, saveError }: { drafts: LocalTipDrafts; orderIds: string[]; saveError: string }) {
  const typed = orderIds.filter((id) => drafts[id] && drafts[id]!.raw.trim() !== "");
  const waiting = typed.filter((id) => drafts[id]!.syncedAt === null);
  if (!typed.length && !saveError) return null;
  return <p className={`rounded-xl p-3 text-sm font-bold ${saveError ? "bg-wayne-alert-soft text-wayne-alert" : "bg-wayne-cream"}`} role="status">
    {typed.length ? `${typed.length} tip${typed.length === 1 ? "" : "s"} typed and saved — not charged until you press Charge / Cash out.` : ""}
    {waiting.length ? ` ${waiting.length} still only on this register (no connection yet); they send by themselves.` : ""}
    {saveError ? ` ${saveError}` : ""}
  </p>;
}
