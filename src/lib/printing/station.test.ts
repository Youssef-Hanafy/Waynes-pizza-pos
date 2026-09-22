import { describe, expect, it, vi } from "vitest";
import type { PrinterJob } from "./adapter";
import type { PrintDocument } from "./document";
import { createKitchenStationAdapter, createOnlineOrderStationAdapter, createStationRepository, isStale, tipSlipWanted, type StationPrinter } from "./station";
import { processNextPrintJob, type PrintQueueRepository } from "./worker";

const now = Date.parse("2026-09-21T18:00:00Z");
const job = (patch: Partial<PrinterJob> = {}): PrinterJob => ({
  id: "job-1", order_id: "66000000-0000-4000-8000-000000000001", destination: "kitchen", job_type: "kitchen_ticket",
  payload: { payment_method: "card" }, attempts: 1, lease_token: "lease-1", created_at: "2026-09-21T17:55:00Z", ...patch,
});

const doc = {
  store: { name: "Wayne's Pizza", address_line1: "93 West Boylston St", city: "Worcester", state: "MA", postal_code: "01606", timezone: "America/New_York" },
  order: {
    id: "66000000-0000-4000-8000-000000000001", order_number: "W1", source: "online", fulfillment_type: "pickup", status: "placed",
    payment_status: "paid", payment_method: "card", placed_at: null, promised_at: null, phone_line: null, customer_name: "A", customer_phone: "",
    delivery_address: null, special_instructions: "", subtotal_cents: 100, discount_cents: 0, delivery_fee_cents: 0, tax_cents: 0, tip_cents: 0, total_cents: 100, taken_by: null,
  },
  items: [{ id: "66000000-0000-4000-8000-000000000011", name: "Coke", variant: null, category: "Drinks", station: "kitchen", quantity: 1, line_total_cents: 100, instructions: "", modifiers: [] }],
} as PrintDocument;

function printer(result: Awaited<ReturnType<StationPrinter["printLayout"]>>): StationPrinter {
  return { printLayout: vi.fn().mockResolvedValue(result), printOnlineOrder: vi.fn().mockResolvedValue(result), printReceipt: vi.fn().mockResolvedValue(result) };
}

function queue(claimed: PrinterJob | null) {
  const base: PrintQueueRepository = { claim: vi.fn().mockResolvedValue(claimed), complete: vi.fn().mockResolvedValue(undefined), fail: vi.fn().mockResolvedValue(undefined) };
  const release = vi.fn().mockResolvedValue(undefined);
  return { base, release, station: createStationRepository(base, release) };
}

describe("print station", () => {
  it("prints a kitchen ticket and marks it printed", async () => {
    const out = printer({ ok: true, jobId: "10.0.0.5:9100" });
    const { base, station } = queue(job());
    const adapter = station.watch(createKitchenStationAdapter({ printer: out, routingCategories: [], loadDocument: async () => doc, now: () => now }));
    expect((await processNextPrintJob({ repository: station.repository, adapter, destination: "kitchen", workerId: "w" })).status).toBe("printed");
    expect(out.printLayout).toHaveBeenCalledOnce();
    expect(base.complete).toHaveBeenCalledOnce();
  });

  it("finishes without printing when nothing on the order goes to the kitchen", async () => {
    const out = printer({ ok: true });
    const { station } = queue(job());
    const adapter = station.watch(createKitchenStationAdapter({ printer: out, routingCategories: ["Pizza"], loadDocument: async () => doc, now: () => now }));
    expect((await processNextPrintJob({ repository: station.repository, adapter, destination: "kitchen", workerId: "w" })).status).toBe("printed");
    expect(out.printLayout).not.toHaveBeenCalled();
  });

  it("hands the job back to wait when the printer isn't answering (nothing sent)", async () => {
    const { base, release, station } = queue(job());
    const adapter = station.watch(createKitchenStationAdapter({ printer: printer({ ok: false, reason: "Printer is not answering.", notSent: true }), routingCategories: [], loadDocument: async () => doc, now: () => now }));
    await processNextPrintJob({ repository: station.repository, adapter, destination: "kitchen", workerId: "w" });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }), "Printer is not answering.");
    expect(base.fail).not.toHaveBeenCalled();
    expect(station.takeOffline()).toBe("Printer is not answering.");
    expect(station.takeOffline()).toBeNull();
  });

  it("never reprints automatically when the print may have gone out", async () => {
    const { base, release, station } = queue(job());
    const adapter = station.watch(createKitchenStationAdapter({ printer: printer({ ok: false, reason: "stopped mid-print", notSent: false }), routingCategories: [], loadDocument: async () => doc, now: () => now }));
    const result = await processNextPrintJob({ repository: station.repository, adapter, destination: "kitchen", workerId: "w" });
    expect(result.status).toBe("acknowledgement_pending");
    expect(release).not.toHaveBeenCalled();
    expect(base.fail).not.toHaveBeenCalled();
    expect(base.complete).not.toHaveBeenCalled();
  });

  it("holds back jobs over an hour old instead of printing them", async () => {
    const out = printer({ ok: true });
    const old = job({ created_at: "2026-09-21T16:30:00Z" });
    expect(isStale(old, now)).toBe(true);
    const { base, station } = queue(old);
    const adapter = station.watch(createKitchenStationAdapter({ printer: out, routingCategories: [], loadDocument: async () => doc, now: () => now }));
    expect((await processNextPrintJob({ repository: station.repository, adapter, destination: "kitchen", workerId: "w" })).status).toBe("failed");
    expect(out.printLayout).not.toHaveBeenCalled();
    expect(base.fail).toHaveBeenCalledOnce();
  });

  it("prints online orders with the tip & signature slip per the setting", async () => {
    expect(tipSlipWanted("always", "cash")).toBe(true);
    expect(tipSlipWanted("card", "cash")).toBe(false);
    expect(tipSlipWanted("card", "card")).toBe(true);
    expect(tipSlipWanted("never", "card")).toBe(false);
    const out = printer({ ok: true });
    const adapter = createOnlineOrderStationAdapter({ printer: out, tipSlip: "card", now: () => now });
    await adapter.print(job({ destination: "receipt", job_type: "online_order" }), {});
    expect(out.printOnlineOrder).toHaveBeenCalledWith(doc.order.id, { tipSlip: true });
  });

  it("prints the customer receipt for delivery orders and for receipts someone asked for", async () => {
    const out = printer({ ok: true });
    const adapter = createOnlineOrderStationAdapter({ printer: out, tipSlip: "always", now: () => now });
    await adapter.print(job({ destination: "receipt", job_type: "delivery_receipt" }), {});
    await adapter.print(job({ destination: "receipt", job_type: "receipt_request" }), {});
    expect(out.printReceipt).toHaveBeenCalledTimes(2);
    expect(out.printOnlineOrder).not.toHaveBeenCalled();
  });
});
