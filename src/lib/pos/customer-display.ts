import { z } from "zod";

/**
 * The customer-facing screen (owner, 2026-10-11): a second tablet at the counter
 * that shows the ticket as it is rung up, asks for a tip before a card is run
 * on the reader, and takes the customer's signature afterwards.
 *
 * The register "publishes" what the screen should show; the screen polls it and
 * sends back the customer's answer to the current request.
 */
export const displayLineSchema = z.object({
  name: z.string(),
  detail: z.string().default(""),
  quantity: z.number().int(),
  cents: z.number().int(),
});
export type DisplayLine = z.infer<typeof displayLineSchema>;

export const displayPhaseSchema = z.enum(["idle", "order", "pay", "tip", "sign", "thanks"]);
export type DisplayPhase = z.infer<typeof displayPhaseSchema>;

export const displayStateSchema = z.object({
  phase: displayPhaseSchema.default("idle"),
  request_id: z.string().default(""),
  order_number: z.string().default(""),
  lines: z.array(displayLineSchema).max(60).default([]),
  subtotal_cents: z.number().int().default(0),
  discount_cents: z.number().int().default(0),
  delivery_fee_cents: z.number().int().default(0),
  tax_cents: z.number().int().default(0),
  tip_cents: z.number().int().default(0),
  total_cents: z.number().int().default(0),
  /** Tip percentages offered (from Admin → Settings). */
  tip_percentages: z.array(z.number()).default([15, 18, 20, 25]),
  /** Dollar tip buttons, in cents (Admin → Settings; owner, 2026-10-12). */
  tip_amounts_cents: z.array(z.number().int()).max(6).default([100, 200, 300, 400, 500]),
  /** What the tip percentages apply to. */
  tip_base_cents: z.number().int().default(0),
  change_cents: z.number().int().nullable().default(null),
  message: z.string().default(""),
});
export type DisplayState = z.infer<typeof displayStateSchema>;

export const displayResponseSchema = z.union([
  z.object({ request_id: z.string(), kind: z.literal("tip"), tip_cents: z.number().int().min(0).max(100_000) }),
  z.object({ request_id: z.string(), kind: z.literal("signature"), signature_svg: z.string().min(20).max(200_000) }),
  z.object({}).strict(),
]);
export type DisplayResponse = z.infer<typeof displayResponseSchema>;

export const displayReadSchema = z.object({
  state: z.record(z.string(), z.unknown()).default({}),
  response: z.record(z.string(), z.unknown()).default({}),
  found: z.boolean().default(false),
  register_online: z.boolean().optional(),
});

export const displayPublishResultSchema = z.object({
  response: z.record(z.string(), z.unknown()).default({}),
  screen_online: z.boolean().default(false),
  /** False when another POS with the same register name is the one the screen shows. */
  showing: z.boolean().optional(),
});

export const displayRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("publish"), key: z.string().trim().min(1).max(60), state: z.record(z.string(), z.unknown()),
    /** Which copy of the POS is sending; a heartbeat from another copy never replaces the screen. */
    publisher: z.string().trim().max(80).optional().default(""),
    /** False for a heartbeat (nothing new to show). */
    changed: z.boolean().optional().default(true),
  }),
  z.object({ kind: z.literal("respond"), key: z.string().trim().min(1).max(60), answer: z.record(z.string(), z.unknown()) }),
]);

export function tipFromPercent(baseCents: number, percent: number) {
  return Math.round((baseCents * percent) / 100);
}

/** Strokes drawn with a finger → a small standalone SVG. */
export function signatureSvg(strokes: Array<Array<[number, number]>>, width: number, height: number) {
  const paths = strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const [first, ...rest] = stroke;
      const start = `M${first![0].toFixed(1)} ${first![1].toFixed(1)}`;
      const line = rest.length ? rest.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join("") : `l0.1 0.1`;
      return `<path d="${start}${line}"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" width="${Math.round(width)}" height="${Math.round(height)}"><g fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
}
