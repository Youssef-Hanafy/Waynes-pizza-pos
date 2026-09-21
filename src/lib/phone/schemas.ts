import { z } from "zod";
import { posCustomerSchema } from "@/lib/pos/schemas";

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
 * Ethernet (UDP, 83 bytes) — verbatim from CallerID.com's Ethernet Link manual:
 *   ^^<U>nnnnnn<S>nnnnnn$01 I E 0000 G A2 12/17 04:54 PM 770-263-7111 CALLERID.COM___
 *   ^^<U>xxxxxx<S>xxxxxx$03 I S 0000 G A0 03/26 02:47 PM 555-867-5309 JOHN DOE
 * Serial:
 *   the same record from the `$` onward.
 *
 * "Full-featured" units also send 52-character detail records (R ring,
 * F off-hook, N on-hook).  Wayne's Basic unit reports inbound caller ID only;
 * a detail record does not match below and is returned as null, which the
 * ingest route logs and ignores rather than popping a card.
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
  // Only trailing whitespace is trimmed before the header is read: the header's
  // unit and serial fields may be raw bytes, NULs included.
  const text = raw.replace(/^[\r\n ]+/, "").trimEnd();
  if (!text) return null;

  // Strip the Ethernet Link header.  CallerID.com's Ethernet Link manual
  // (EL_Manual.pdf) says every packet starts "^^<U>nnnnnn<S>nnnnnn$" — 21
  // characters — and warns that finding the first "$" is unreliable because
  // the unit and serial fields can contain one; it says to start reading after
  // the 21st character.  The unit number is kept when it reads as digits, so
  // a store with two boxes can tell which one rang.
  let unitNumber = "";
  let body: string;
  if (text.startsWith("^^<U>") && text.length > 21 && text.charAt(20) === "$") {
    const unit = /^\^\^<U>(\d{6})<S>/.exec(text);
    if (unit) unitNumber = unit[1]!.replace(/^0+(?=\d)/, "");
    body = text.slice(21);
  } else {
    // Serial / already-stripped records: the manual's "$01 I S ..." form.
    const dollar = text.indexOf("$");
    body = dollar >= 0 ? text.slice(dollar + 1) : text;
  }
  body = body.replace(/\0/g, "").trim();

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

// ---------------------------------------------------------------------------
// Phone-line build: caller events with status and claims (§15, §22, §32).
// ---------------------------------------------------------------------------

export const callStatusSchema = z.enum(["incoming", "selected", "order_started", "dismissed", "expired", "completed"]);
export type CallStatus = z.infer<typeof callStatusSchema>;

/** One ring as the server records it, with every customer its number matches. */
export const phoneCallSchema = z.object({
  id: z.uuid(),
  event_key: z.string(),
  line_number: z.number().int(),
  device_id: z.string().optional().default(""),
  caller_number: z.string().nullable(),
  caller_number_raw: z.string(),
  caller_name: z.string(),
  started_at: z.string(),
  surfaced_at: z.string().optional(),
  ended_at: z.string().nullable(),
  status: callStatusSchema,
  simulated: z.boolean(),
  customer_id: z.uuid().nullable(),
  claimed_by_id: z.uuid().nullable(),
  claimed_by_name: z.string().nullable(),
  claimed_terminal: z.string(),
  claimed_at: z.string().nullable(),
  order_id: z.uuid().nullable(),
  order_number: z.string().nullable(),
  matches: z.array(posCustomerSchema),
});
export type PhoneCall = z.infer<typeof phoneCallSchema>;

export const recentCallSchema = z.object({
  id: z.uuid(),
  event_key: z.string(),
  line_number: z.number().int(),
  caller_number: z.string().nullable(),
  caller_number_raw: z.string(),
  caller_name: z.string(),
  started_at: z.string(),
  status: callStatusSchema,
  simulated: z.boolean(),
  customer_name: z.string().nullable(),
  order_id: z.uuid().nullable(),
  order_number: z.string().nullable(),
});
export type RecentCall = z.infer<typeof recentCallSchema>;

export const phoneBoardSchema = z.object({
  expire_minutes: z.number().int(),
  server_time: z.string(),
  lines: z.array(z.object({
    line_number: z.number().int(),
    label: z.string(),
    phone_number: z.string(),
    call: phoneCallSchema.nullable(),
  })),
  recent: z.array(recentCallSchema),
});
export type PhoneBoard = z.infer<typeof phoneBoardSchema>;

/** What an in-store provider (simulator now, Android later) reports. */
export const posCallReportSchema = z.object({
  event_key: z.string().trim().min(8).max(120),
  line_number: z.number().int().min(1).max(8),
  caller_number: z.string().trim().max(40),
  caller_name: z.string().trim().max(80).optional().default(""),
  device_id: z.string().trim().max(80).optional().default(""),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  raw_record: z.string().max(400).optional().default(""),
  source: z.enum(["simulated", "android_native"]),
});
export type PosCallReport = z.input<typeof posCallReportSchema>;

export const posCallRecordedSchema = z.object({
  ok: z.boolean(),
  duplicate: z.boolean().optional().default(false),
  call_id: z.uuid().nullable().optional(),
  call: phoneCallSchema.optional(),
});

export const callActionSchema = z.object({
  action: z.enum(["claim", "release", "start_order", "dismiss", "expire", "reopen", "complete"]),
  terminal: z.string().trim().max(60).optional().default(""),
  force: z.boolean().optional().default(false),
});
export type CallAction = z.input<typeof callActionSchema>["action"];

export const callActionResultSchema = z.object({
  ok: z.boolean(),
  reason: z.enum(["claimed", "closed"]).optional(),
  call: phoneCallSchema,
});
export type CallActionResult = z.infer<typeof callActionResultSchema>;
