import { z } from "zod";
import { spokenDatabaseMessage } from "@/lib/errors/database";

export const cashMovementKinds = ["paid_in", "paid_out", "drop", "driver_cash"] as const;
export const cashMovementKindSchema = z.enum(cashMovementKinds);
export type CashMovementKind = z.infer<typeof cashMovementKindSchema>;

export const cashMovementLabels: Record<CashMovementKind, string> = {
  paid_in: "Paid in",
  paid_out: "Paid out",
  drop: "Dropped to the safe",
  driver_cash: "Driver cash handed in",
};

/** Whether a movement adds to or takes from the drawer. */
export const cashMovementDirection: Record<CashMovementKind, 1 | -1> = {
  paid_in: 1, driver_cash: 1, paid_out: -1, drop: -1,
};

export const registerSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  open: z.boolean().default(false),
});
export type Register = z.infer<typeof registerSchema>;

export const cashMovementSchema = z.object({
  id: z.uuid(),
  kind: cashMovementKindSchema,
  amount_cents: z.number().int(),
  reason: z.string(),
  created_at: z.string(),
  actor_name: z.string().nullable(),
});

export const drawerShiftSchema = z.object({
  id: z.uuid(),
  register_id: z.uuid(),
  register_label: z.string(),
  status: z.enum(["open", "closed"]),
  opened_by_name: z.string().nullable(),
  opened_at: z.string(),
  opening_cash_cents: z.number().int(),
  cash_sales_cents: z.number().int(),
  cash_refunds_cents: z.number().int(),
  paid_in_cents: z.number().int(),
  paid_out_cents: z.number().int(),
  drop_cents: z.number().int(),
  driver_cash_cents: z.number().int(),
  expected_cash_cents: z.number().int(),
  movements: z.array(cashMovementSchema).default([]),
});
export type DrawerShift = z.infer<typeof drawerShiftSchema>;

export const posDrawerSchema = z.object({
  registers: z.array(registerSchema).default([]),
  shift: drawerShiftSchema.nullable(),
});
export type PosDrawer = z.infer<typeof posDrawerSchema>;

export const closeoutShiftSchema = z.object({
  id: z.uuid(),
  register_label: z.string(),
  status: z.enum(["open", "closed"]),
  opened_by_name: z.string(),
  opened_at: z.string(),
  closed_by_name: z.string().nullable(),
  closed_at: z.string().nullable(),
  opening_cash_cents: z.number().int(),
  cash_sales_cents: z.number().int().nullable(),
  cash_refunds_cents: z.number().int().nullable(),
  paid_in_cents: z.number().int().nullable(),
  paid_out_cents: z.number().int().nullable(),
  driver_cash_cents: z.number().int().nullable(),
  expected_cash_cents: z.number().int().nullable(),
  counted_cash_cents: z.number().int().nullable(),
  variance_cents: z.number().int().nullable(),
  close_note: z.string().default(""),
});

export const cashCloseoutSchema = z.object({
  totals: z.object({
    shift_count: z.number().int(), open_count: z.number().int(),
    opening_cash_cents: z.number().int(), cash_sales_cents: z.number().int(),
    cash_refunds_cents: z.number().int(), paid_in_cents: z.number().int(),
    paid_out_cents: z.number().int(), driver_cash_cents: z.number().int(),
    counted_cash_cents: z.number().int(), expected_cash_cents: z.number().int(),
    variance_cents: z.number().int(), over_count: z.number().int(), short_count: z.number().int(),
  }),
  shifts: z.array(closeoutShiftSchema).default([]),
  movements: z.array(z.object({
    register_label: z.string(), kind: cashMovementKindSchema, amount_cents: z.number().int(),
    reason: z.string(), created_at: z.string(), actor_name: z.string(),
  })).default([]),
});
export type CashCloseout = z.infer<typeof cashCloseoutSchema>;

export const drawerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), register_id: z.uuid(), opening_cash_cents: z.number().int().min(0).max(1_000_000) }),
  z.object({
    action: z.literal("movement"), shift_id: z.uuid(), kind: cashMovementKindSchema,
    amount_cents: z.number().int().positive().max(1_000_000), reason: z.string().trim().min(3).max(500),
  }),
  z.object({
    action: z.literal("close"), shift_id: z.uuid(),
    counted_cash_cents: z.number().int().min(0).max(10_000_000), close_note: z.string().trim().max(1000).default(""),
  }),
  z.object({
    action: z.literal("cash_payment"), shift_id: z.uuid(), order_id: z.uuid(),
    tendered_cents: z.number().int().min(0).max(10_000_000), idempotency_key: z.string().min(16).max(160),
  }),
]);

/**
 * Parses a counted amount. Unlike a refund or a payment, zero is a real answer here:
 * an empty drawer counts as nothing.
 */
export function parseCashCountInput(raw: string) {
  const cleaned = (raw ?? "").replace(/[$,\s]/g, "");
  if (!cleaned) return { ok: false as const, error: "Enter the amount, or 0." };
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false as const, error: "Enter an amount such as 150.00." };
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents) || cents > 10_000_000) return { ok: false as const, error: "That amount is too large." };
  return { ok: true as const, cents };
}

/** Expected cash, worked out the same way the database does it. */
export function expectedCashCents(shift: Pick<DrawerShift,
  "opening_cash_cents" | "cash_sales_cents" | "cash_refunds_cents" | "paid_in_cents" | "paid_out_cents" | "drop_cents" | "driver_cash_cents">) {
  return shift.opening_cash_cents + shift.cash_sales_cents - shift.cash_refunds_cents
    + shift.paid_in_cents + shift.driver_cash_cents - shift.paid_out_cents - shift.drop_cents;
}

/** Counted minus expected. Negative is short, positive is over. */
export function varianceCents(countedCents: number, expected: number) {
  return countedCents - expected;
}

export function varianceLabel(variance: number) {
  if (variance === 0) return "Balanced";
  return variance > 0 ? "Over" : "Short";
}

/** A drawer out by five dollars or more has to be explained before it closes. */
export const VARIANCE_EXPLANATION_THRESHOLD_CENTS = 500;
export function needsVarianceNote(variance: number, note: string) {
  return Math.abs(variance) >= VARIANCE_EXPLANATION_THRESHOLD_CENTS && note.trim().length < 3;
}

/** Maps database errors from the cash RPCs to something the counter can act on. */
export function cashErrorMessage(error: { code?: string; message: string }) {
  if (error.code === "40001") return error.message.includes("open drawer")
    ? "That register already has an open drawer."
    : "Something changed on another screen. Refresh and try again.";
  if (error.code === "42501") return "Your account is not allowed to do that. Ask a manager.";
  return spokenDatabaseMessage(error, "That could not be saved. Check the drawer before retrying.");
}
