import { z } from "zod";

/**
 * Caller ID for a pizza shop is a box, not an API.
 *
 * Thrive answers the phone by reading a "Whozz Calling?" unit from
 * CallerID.com — the store's phone lines pass through it, and every time one
 * rings it broadcasts a UDP packet on port 3520 describing the ring.  Wayne's
 * uses the same hardware, so the shape below is that unit's record.
 *
 * A browser cannot listen for UDP, so `scripts/callerid-bridge.mjs` runs on the
 * store's computer, catches the broadcast, and posts it here.  The bridge is
 * deliberately dumb: it forwards the raw record and lets the server parse it,
 * so a firmware quirk is fixed by deploying the site rather than by walking
 * into the store.
 */

export const phoneCallEventSchema = z.enum(["start", "end"]);

/** What the ingest route accepts. Either a raw record, or already-parsed fields. */
export const phoneCallIngestSchema = z
  .object({
    raw: z.string().max(400).optional(),
    line_number: z.coerce.number().int().min(1).max(8).optional(),
    caller_number: z.string().max(40).optional(),
    caller_name: z.string().max(80).optional(),
    unit_number: z.string().max(20).optional(),
    direction: z.enum(["inbound", "outbound"]).optional(),
    event: phoneCallEventSchema.optional(),
    occurred_at: z.iso.datetime().optional(),
  })
  .refine((value) => Boolean(value.raw) || typeof value.line_number === "number", {
    message: "Send either a raw caller ID record or a line_number.",
  });

export type PhoneCallIngest = z.infer<typeof phoneCallIngestSchema>;

export const phoneLineCallSchema = z.object({
  id: z.uuid(),
  caller_number: z.string().nullable(),
  caller_number_raw: z.string(),
  caller_name: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  customer_id: z.uuid().nullable(),
  customer: z
    .object({
      id: z.uuid(),
      first_name: z.string(),
      last_name: z.string(),
      order_count: z.number().int(),
      last_order_at: z.string().nullable(),
      lifetime_spend_cents: z.number().int(),
    })
    .nullable(),
});

export const phoneLineSchema = z.object({
  line_number: z.number().int(),
  label: z.string(),
  phone_number: z.string(),
  active: z.boolean(),
  call: phoneLineCallSchema.nullable(),
});
export const phoneLineBoardSchema = z.array(phoneLineSchema);
export type PhoneLine = z.infer<typeof phoneLineSchema>;

/**
 * A Whozz Calling? record, in either of the two shapes the unit emits.
 *
 * Ethernet (UDP, 83 bytes):
 *   ^^<U>nnnnnn<S>nnnnnn$01 I S 0000 G A2 12/17 04:54 PM 5085551212 SMITH JOHN
 * Serial:
 *   the same record from the `$` onward.
 *
 * The fields after `$` are: line, direction (I/O), start/end (S/E), duration,
 * checksum, ring count, date, time, number, name.  Parsing is by token rather
 * than by fixed column so that a unit configured for a different name width, or
 * a number the carrier sent with dashes, still reads correctly.
 */
export function parseWhozzCallingRecord(raw: string): {
  line_number: number;
  direction: "inbound" | "outbound";
  event: "start" | "end";
  caller_number: string;
  caller_name: string;
  unit_number: string;
} | null {
  const text = raw.replace(/\0/g, "").trim();
  if (!text) return null;

  // Strip the Ethernet Link header (^^<U>unit<S>serial) if it is present, and
  // keep the unit number: a store with two boxes needs to know which rang.
  let unitNumber = "";
  const header = /\^\^<U>(\d{1,6})<S>(\d{1,6})\$/.exec(text);
  if (header) unitNumber = header[1]!.replace(/^0+(?=\d)/, "");

  const dollar = text.indexOf("$");
  const body = dollar >= 0 ? text.slice(dollar + 1) : text;

  const match =
    /^\s*(\d{1,2})\s+([IO])\s+([SE-])\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})\s*([AP]M)?\s+(\S+)\s*(.*)$/i.exec(
      body,
    );
  if (!match) return null;

  const [, line, direction, phase, , , , , , , number, name] = match;
  return {
    line_number: Number(line),
    direction: direction!.toUpperCase() === "O" ? "outbound" : "inbound",
    event: phase!.toUpperCase() === "E" ? "end" : "start",
    // The unit pads the name field with underscores or spaces; neither belongs
    // on a ticket.
    caller_number: number!.replace(/[^0-9+]/g, ""),
    caller_name: name!.replace(/[_\s]+/g, " ").trim().slice(0, 80),
    unit_number: unitNumber,
  };
}
