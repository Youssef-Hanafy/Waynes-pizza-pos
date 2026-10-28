import { describe, expect, it } from "vitest";
import { applySaveResult, editTipDraft, mergeServerTipDrafts, parseLocalTipDrafts, removeTipDrafts, tipSaveState, unsyncedTipDrafts, type LocalTipDrafts, type ServerTipDraft } from "./drafts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const t = (iso: string) => new Date(iso);

function server(orderId: string, cents: number, at: string, extra: Partial<ServerTipDraft> = {}): ServerTipDraft {
  return { order_id: orderId, tip_cents: cents, raw: String(cents / 100), screen: "tips", client_updated_at: at, terminal: "Register 2", ...extra };
}

describe("tip drafts (owner 2026-10-28: tips must never disappear)", () => {
  it("a typed tip is saved on the register at once, as not-yet-synced", () => {
    const drafts = editTipDraft({}, A, "5", 500, "tips", t("2026-10-28T01:00:00Z"));
    expect(drafts[A]).toMatchObject({ raw: "5", cents: 500, syncedAt: null });
    expect(tipSaveState(drafts[A])).toBe("local");
    expect(unsyncedTipDrafts(drafts).map(([id]) => id)).toEqual([A]);
  });

  it("survives a reload: what was written to the device reads back the same", () => {
    const drafts = editTipDraft(editTipDraft({}, A, "5", 500, "tips"), B, "3.25", 325, "delivery");
    expect(parseLocalTipDrafts(JSON.stringify(drafts))).toEqual(drafts);
    expect(parseLocalTipDrafts("not json")).toEqual({});
    expect(parseLocalTipDrafts(JSON.stringify({ [A]: { raw: 5 } }))).toEqual({});
  });

  it("an edit is always newer than the one before, even if the tablet clock jumps back", () => {
    const first = editTipDraft({}, A, "5", 500, "tips", t("2026-10-28T01:00:00Z"));
    const second = editTipDraft(first, A, "6", 600, "tips", t("2026-10-28T00:00:00Z"));
    expect(Date.parse(second[A]!.updatedAt)).toBeGreaterThan(Date.parse(first[A]!.updatedAt));
  });

  it("the newest value wins when merging with the server", () => {
    const local = editTipDraft({}, A, "5", 500, "tips", t("2026-10-28T01:00:00Z"));
    // Another register typed 7 later.
    const merged = mergeServerTipDrafts(local, [server(A, 700, "2026-10-28T01:05:00Z")], t("2026-10-28T01:06:00Z"));
    expect(merged[A]).toMatchObject({ cents: 700, terminal: "Register 2" });
    // The server only has an older value: this register's newer, unsynced one stays (and is sent).
    const kept = mergeServerTipDrafts(local, [server(A, 300, "2026-10-28T00:30:00Z")], t("2026-10-28T01:06:00Z"));
    expect(kept[A]).toMatchObject({ cents: 500, syncedAt: null });
  });

  it("stale offline copies never overwrite a newer saved value (save answer not applied)", () => {
    const local = editTipDraft({}, A, "3", 300, "tips", t("2026-10-28T00:00:00Z"));
    const sent = { [A]: local[A]!.updatedAt };
    const after = applySaveResult(local, sent, [{ ...server(A, 900, "2026-10-28T02:00:00Z"), applied: false }], t("2026-10-28T02:01:00Z"));
    expect(after[A]).toMatchObject({ cents: 900 });
    expect(tipSaveState(after[A])).toBe("saved");
  });

  it("a save is marked saved only for the exact value that was sent", () => {
    const local = editTipDraft({}, A, "5", 500, "tips", t("2026-10-28T01:00:00Z"));
    const sent = { [A]: local[A]!.updatedAt };
    // Typed again while the save was on its way.
    const retyped = editTipDraft(local, A, "6", 600, "tips", t("2026-10-28T01:00:01Z"));
    const after = applySaveResult(retyped, sent, [{ ...server(A, 500, local[A]!.updatedAt), applied: true }]);
    expect(after[A]).toMatchObject({ cents: 600, syncedAt: null });
    const done = applySaveResult(local, sent, [{ ...server(A, 500, local[A]!.updatedAt), applied: true }]);
    expect(tipSaveState(done[A])).toBe("saved");
  });

  it("drops a saved entry once its order is no longer waiting (charged / cashed out), keeps unsynced ones", () => {
    const now = t("2026-10-28T03:00:00Z");
    const local: LocalTipDrafts = {
      [A]: { raw: "5", cents: 500, screen: "tips", updatedAt: "2026-10-28T01:00:00Z", syncedAt: "2026-10-28T01:00:01Z" },
      [B]: { raw: "2", cents: 200, screen: "delivery", updatedAt: "2026-10-28T02:00:00Z", syncedAt: null },
    };
    const merged = mergeServerTipDrafts(local, [], now);
    expect(Object.keys(merged)).toEqual([B]);
    // An unsynced entry days old (its order long gone) is let go.
    expect(mergeServerTipDrafts(local, [], t("2026-11-05T00:00:00Z"))).toEqual({});
  });

  it("brings back a tip typed on another register (or before this register was reset)", () => {
    const merged = mergeServerTipDrafts({}, [server(A, 450, "2026-10-28T01:00:00Z")]);
    expect(merged[A]).toMatchObject({ cents: 450, raw: "4.5" });
    expect(tipSaveState(merged[A])).toBe("saved");
  });

  it("charged orders' entries are removed", () => {
    const drafts = editTipDraft(editTipDraft({}, A, "5", 500, "tips"), B, "1", 100, "tips");
    expect(Object.keys(removeTipDrafts(drafts, [A]))).toEqual([B]);
    expect(removeTipDrafts(drafts, ["nope"])).toBe(drafts);
  });
});
