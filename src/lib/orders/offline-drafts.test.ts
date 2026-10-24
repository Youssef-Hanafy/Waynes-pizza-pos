import { describe, expect, it } from "vitest";
import { posOrderInputSchema } from "@/lib/pos/schemas";
import { drawerActionSchema } from "@/lib/cash/schemas";
import { blankDraft, draftToOrderPayload, parseSavedDrafts, type OfflineOrder } from "./drafts";

const line = { line_id: "l1", menu_item_id: "64000000-0000-4000-8000-000000000001", variant_id: null, quantity: 1, special_instructions: "", modifiers: [] };
const offline: OfflineOrder = {
  takenAt: "2026-10-24T22:10:00.000Z", localNumber: "O3", totalCents: 1599, printed: true,
  payment: { kind: "cash", amountCents: 1599, tenderedCents: 2000, changeCents: 401, at: "2026-10-24T22:11:00.000Z" },
  orderId: null, orderNumber: null, dailyNumber: null, paymentRecorded: false, problem: "",
};

describe("orders taken offline (owner, 2026-10-24)", () => {
  it("a normal ticket sends exactly what it always did — no offline flags", () => {
    const payload = draftToOrderPayload(blankDraft({ cart: [line] }));
    expect(payload).not.toHaveProperty("offline_printed");
    expect(posOrderInputSchema.parse(payload).offline_printed).toBe(false);
  });

  it("an offline order tells the server the counter already printed it", () => {
    const payload = draftToOrderPayload(blankDraft({ cart: [line], offline }));
    expect(payload).toMatchObject({ offline_printed: true, offline_taken_at: offline.takenAt, offline_local_number: "O3" });
    const parsed = posOrderInputSchema.parse(payload);
    expect(parsed.offline_printed).toBe(true);
    expect(parsed.offline_local_number).toBe("O3");
  });

  it("offline orders survive the app closing (saved and read back)", () => {
    const draft = blankDraft({ cart: [line], offline, submitPending: true });
    const restored = parseSavedDrafts(JSON.stringify({ activeId: draft.id, drafts: [draft] }));
    expect(restored?.drafts[0]?.offline).toEqual(offline);
    // Tickets saved before offline orders existed still load.
    const legacy = { ...draft } as Record<string, unknown>;
    delete legacy.offline;
    expect(parseSavedDrafts(JSON.stringify({ activeId: draft.id, drafts: [legacy] }))?.drafts[0]?.offline).toBeNull();
  });

  it("cash taken offline is recorded with its flag; normal cash is unchanged", () => {
    const base = { action: "cash_payment", order_id: "64000000-0000-4000-8000-000000000002", tendered_cents: 2000, idempotency_key: "pos-offline-cash-0001" };
    const normal = drawerActionSchema.parse(base);
    expect(normal).toMatchObject({ offline: false });
    expect(drawerActionSchema.parse({ ...base, offline: true, offline_taken_at: offline.takenAt })).toMatchObject({ offline: true });
  });
});
