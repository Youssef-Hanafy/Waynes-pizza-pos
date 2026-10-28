import { z } from "zod";

/**
 * Tips typed from the signed slips, kept the moment they are typed (owner,
 * 2026-10-28: the tips he entered were missing when he came back to close
 * them out).
 *
 * A tip goes through three states, and the screens say which one it is in:
 *   1. saved on this register   — written to the device the instant it is typed
 *                                 (survives leaving the screen, a reload, a restart)
 *   2. saved                    — the server has it too (another register, or
 *                                 this one after a reset, gets it back)
 *   3. charged                  — Charge / Cash out captured the card; only then
 *                                 is it a real tip on the order
 * Nothing in this file charges anything.
 *
 * Newest edit wins.  Every entry carries the time it was typed; an older copy
 * (a register that was offline, or another register) never replaces a newer one,
 * here or on the server (wayne_pos_save_tip_drafts).
 */

export type TipScreen = "tips" | "delivery";

export type LocalTipDraft = {
  /** What was typed ("4.50"; "" = no tip). */
  raw: string;
  cents: number;
  screen: TipScreen;
  /** When it was typed on a register (ISO). */
  updatedAt: string;
  /** When the server confirmed this exact value; null = only on this register so far. */
  syncedAt: string | null;
  /** Which register last typed it, when it came from the server. */
  terminal?: string;
  /** The last save attempt was refused (not "no connection"): why. */
  error?: string;
};

export type LocalTipDrafts = Record<string, LocalTipDraft>;

export const serverTipDraftSchema = z.object({
  order_id: z.uuid(),
  tip_cents: z.number().int().min(0),
  raw: z.string(),
  screen: z.enum(["tips", "delivery"]).catch("tips"),
  client_updated_at: z.string(),
  terminal: z.string().optional().default(""),
  updated_at: z.string().optional(),
  applied: z.boolean().optional(),
});
export type ServerTipDraft = z.infer<typeof serverTipDraftSchema>;

export const tipDraftSaveRequestSchema = z.object({
  drafts: z.array(z.object({
    order_id: z.uuid(),
    tip_cents: z.number().int().min(0).max(100_000),
    raw: z.string().max(20),
    screen: z.enum(["tips", "delivery"]),
    client_updated_at: z.iso.datetime({ offset: true }),
    device_id: z.string().max(80),
    terminal: z.string().max(60),
  })).min(1).max(200),
});

const time = (iso: string | null | undefined) => {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : 0;
};

/** A parsed copy of what the device saved (anything unreadable is left out, never thrown). */
export function parseLocalTipDrafts(raw: string | null): LocalTipDrafts {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: LocalTipDrafts = {};
    for (const [orderId, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const draft = entry as Partial<LocalTipDraft>;
      if (typeof draft.raw !== "string" || typeof draft.cents !== "number" || typeof draft.updatedAt !== "string") continue;
      out[orderId] = {
        raw: draft.raw, cents: draft.cents, screen: draft.screen === "delivery" ? "delivery" : "tips", updatedAt: draft.updatedAt,
        syncedAt: typeof draft.syncedAt === "string" ? draft.syncedAt : null,
        ...(typeof draft.terminal === "string" ? { terminal: draft.terminal } : {}),
        ...(typeof draft.error === "string" ? { error: draft.error } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Typed on this register: a new unsynced entry stamped now (never older than the one it replaces). */
export function editTipDraft(drafts: LocalTipDrafts, orderId: string, raw: string, cents: number, screen: TipScreen, now = new Date()): LocalTipDrafts {
  const previous = drafts[orderId];
  // Keep the order of edits even if the tablet clock jumped back.
  const stamp = new Date(Math.max(now.getTime(), time(previous?.updatedAt) + 1)).toISOString();
  return { ...drafts, [orderId]: { raw, cents, screen, updatedAt: stamp, syncedAt: null } };
}

/**
 * Merge what the server has (only orders still waiting for their tip) into
 * what this register has.
 *   * server newer → the server's value (typed on another register later)
 *   * this register newer and not yet saved → kept; it will be sent
 *   * saved here before but no longer on the server → that order was charged /
 *     cashed out (or cleared): dropped
 *   * never saved and not on the server → kept (it is sent next), unless it is
 *     older than keepUnsyncedMs (an order long gone)
 */
export function mergeServerTipDrafts(local: LocalTipDrafts, server: ServerTipDraft[], now = new Date(), keepUnsyncedMs = 3 * 86_400_000): LocalTipDrafts {
  const out: LocalTipDrafts = {};
  const onServer = new Map(server.map((entry) => [entry.order_id, entry]));
  for (const [orderId, draft] of Object.entries(local)) {
    const remote = onServer.get(orderId);
    if (remote) {
      if (time(remote.client_updated_at) > time(draft.updatedAt)) out[orderId] = fromServer(remote, now);
      else if (draft.syncedAt === null) out[orderId] = draft;
      else out[orderId] = { ...draft, syncedAt: draft.syncedAt };
      continue;
    }
    if (draft.syncedAt !== null) continue;
    if (now.getTime() - time(draft.updatedAt) > keepUnsyncedMs) continue;
    out[orderId] = draft;
  }
  for (const remote of server) {
    if (!out[remote.order_id] && !(remote.order_id in local)) out[remote.order_id] = fromServer(remote, now);
  }
  return out;
}

function fromServer(remote: ServerTipDraft, now: Date): LocalTipDraft {
  return {
    raw: remote.raw, cents: remote.tip_cents, screen: remote.screen, updatedAt: remote.client_updated_at,
    syncedAt: now.toISOString(), ...(remote.terminal ? { terminal: remote.terminal } : {}),
  };
}

/** Entries only on this register (to send). */
export function unsyncedTipDrafts(drafts: LocalTipDrafts) {
  return Object.entries(drafts).filter(([, draft]) => draft.syncedAt === null);
}

/**
 * The server answered a save.  Each returned row is what the server now holds:
 *   applied → it took the value sent; marked saved only if nothing was typed
 *             here since (a newer local edit stays unsynced and goes next)
 *   not applied → the server had a newer value; that value is taken
 */
export function applySaveResult(drafts: LocalTipDrafts, sent: Record<string, string>, rows: ServerTipDraft[], now = new Date()): LocalTipDrafts {
  const out = { ...drafts };
  for (const row of rows) {
    const current = out[row.order_id];
    if (row.applied) {
      if (current && current.updatedAt === sent[row.order_id]) out[row.order_id] = { ...current, syncedAt: now.toISOString(), error: undefined };
    } else if (!current || time(row.client_updated_at) >= time(current.updatedAt)) {
      out[row.order_id] = fromServer(row, now);
    }
  }
  for (const key of Object.keys(out)) if (out[key]!.error === undefined) delete out[key]!.error;
  return out;
}

/** After Charge / Cash out: those orders' entries are done. */
export function removeTipDrafts(drafts: LocalTipDrafts, orderIds: string[]): LocalTipDrafts {
  if (!orderIds.some((id) => id in drafts)) return drafts;
  const out = { ...drafts };
  for (const id of orderIds) delete out[id];
  return out;
}

export type TipSaveState = "none" | "local" | "saved" | "error";

export function tipSaveState(draft: LocalTipDraft | undefined): TipSaveState {
  if (!draft) return "none";
  if (draft.error) return "error";
  return draft.syncedAt ? "saved" : "local";
}
