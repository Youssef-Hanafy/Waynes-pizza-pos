import { z } from "zod";
import { ticketNumber } from "@/lib/orders/ticket-number";

/**
 * Receipts and kitchen tickets as layouts (build sheet §23, Phase 7).
 *
 * A layout is lines of text with alignment and emphasis — nothing about any
 * printer.  The printer layer turns it into browser print HTML today, and into
 * the confirmed printer's command language once the models are known (§2.7:
 * no protocol is assumed before then).
 */

export const printDocumentSchema = z.object({
  store: z.object({
    name: z.string(), address_line1: z.string(), address_line2: z.string().nullable().optional(),
    city: z.string(), state: z.string(), postal_code: z.string(), phone: z.string().nullable().optional(), timezone: z.string(),
  }),
  order: z.object({
    id: z.uuid(), order_number: z.string(), source: z.string(),
    /** The day's ticket number (#1, #2 …) — what the slips print big. */
    daily_number: z.number().int().nullable().optional().default(null),
    /** Items added after the order was paid: the W number of the order they belong to. */
    add_on_to: z.string().nullable().optional().default(null), fulfillment_type: z.string(), status: z.string(),
    payment_status: z.string(), payment_method: z.string(), placed_at: z.string().nullable(), promised_at: z.string().nullable(),
    phone_line: z.number().int().nullable(), customer_name: z.string(), customer_phone: z.string(),
    delivery_address: z.object({
      address1: z.string(), address2: z.string().optional().default(""), city: z.string(), state: z.string(),
      postal_code: z.string(), delivery_instructions: z.string().optional().default(""),
    }).nullable(),
    special_instructions: z.string(),
    subtotal_cents: z.number().int(), discount_cents: z.number().int(), delivery_fee_cents: z.number().int(),
    tax_cents: z.number().int(), tip_cents: z.number().int(), total_cents: z.number().int(),
    taken_by: z.string().nullable(),
  }),
  items: z.array(z.object({
    id: z.uuid(), name: z.string(), variant: z.string().nullable(), category: z.string().nullable(), station: z.string(),
    quantity: z.number().int(), line_total_cents: z.number().int(), instructions: z.string(),
    modifiers: z.array(z.object({ name: z.string(), group: z.string(), quantity: z.number().int() })),
  })),
});
export type PrintDocument = z.infer<typeof printDocumentSchema>;

export type PrintLine =
  /**
   * large = twice as tall AND wide (half the characters fit on a line) — the
   * PAID banner and the TOTAL; tall = twice as tall only, full width — the
   * order number and the kitchen's item lines (owner, 2026-10-13: "text is too
   * big and getting cut off … dial it down a little").
   */
  | { kind: "text"; text: string; align?: "left" | "center" | "right"; bold?: boolean; large?: boolean; tall?: boolean; highlight?: boolean }
  | { kind: "pair"; left: string; right: string; bold?: boolean; large?: boolean; tall?: boolean }
  | { kind: "rule" }
  | { kind: "feed"; lines: number };

export type PrintLayout = { title: string; lines: PrintLine[] };

/**
 * How big slips print (Admin → Hardware, per printer; owner 2026-10-12 "make
 * the text bigger").  normal = the printer's small font; large = every line
 * twice as tall (same characters per line); xlarge = every line twice as tall
 * and wide (half the characters per line).
 */
export type TextSize = "normal" | "large" | "xlarge";
export function textSizeFrom(value: unknown, fallback: TextSize = "large"): TextSize {
  return value === "normal" || value === "large" || value === "xlarge" ? value : fallback;
}

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

function when(iso: string | null, timeZone: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function phone(value: string) {
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : value;
}

/**
 * Paid or not, big, at the top of every slip (owner, 2026-10-12): the slip in
 * the bag says whether the customer still owes anything when they come back.
 */
export function paymentBanner(order: PrintDocument["order"], withAmount = true): PrintLine[] {
  const method = order.payment_method === "cash" ? "CASH" : order.payment_method === "card" ? "CARD" : "";
  switch (order.payment_status) {
    case "paid":
      return [{ kind: "text", text: `** PAID${method ? ` - ${method}` : ""} **`, align: "center", bold: true, large: true }];
    case "authorized":
      // Card approved and held for the tip on the signed slip (owner, 2026-10-13).
      return order.fulfillment_type === "delivery"
        ? [
          { kind: "text", text: "** PAID - CARD **", align: "center", bold: true, large: true },
          { kind: "text", text: "Don't collect - get the slip signed", align: "center", bold: true },
        ]
        : [
          { kind: "text", text: "** PAID - CARD **", align: "center", bold: true, large: true },
          { kind: "text", text: "Tip can be added on the slip", align: "center" },
        ];
    case "refunded":
    case "partially_refunded":
      return [{ kind: "text", text: order.payment_status === "refunded" ? "REFUNDED" : "PART REFUNDED", align: "center", bold: true, large: true }];
    default: {
      const amount = withAmount ? ` ${money(order.total_cents)}` : "";
      const due = order.fulfillment_type === "delivery" && order.payment_method === "cash" ? `COLLECT${amount} AT THE DOOR` : `COLLECT${amount || " PAYMENT"}`;
      return [
        { kind: "text", text: "!! NOT PAID !!", align: "center", bold: true, large: true, highlight: true },
        { kind: "text", text: due, align: "center", bold: true, highlight: true },
      ];
    }
  }
}

function heading(doc: PrintDocument, withPrices = true): PrintLine[] {
  const order = doc.order;
  const origin = order.source === "phone" ? `PHONE${order.phone_line ? ` · LINE ${order.phone_line}` : ""}` : order.source === "online" ? "ONLINE" : "COUNTER";
  const lines: PrintLine[] = [
    ...paymentBanner(order, withPrices),
    { kind: "rule" },
    { kind: "text", text: `${order.fulfillment_type === "delivery" ? "DELIVERY" : "PICKUP"} · ${origin}`, align: "center", bold: true },
    // The day's number, #1, #2, #3 … (owner, 2026-10-13: "order numbers are too big on the slips, every day start at 1, 2, 3").
    { kind: "text", text: `${order.add_on_to ? "ADD-ON TO " : "ORDER "}#${ticketNumber(order)}`, align: "center", bold: true, tall: true },
    { kind: "text", text: `Placed ${when(order.placed_at, doc.store.timezone)}${order.promised_at ? ` · Ready ${when(order.promised_at, doc.store.timezone)}` : ""}`, align: "center" },
  ];
  if (order.customer_name) lines.push({ kind: "text", text: order.customer_name, bold: true });
  if (order.customer_phone) lines.push({ kind: "text", text: phone(order.customer_phone) });
  const address = order.delivery_address;
  if (order.fulfillment_type === "delivery" && address) {
    lines.push({ kind: "text", text: `${address.address1}${address.address2 ? `, ${address.address2}` : ""}`, bold: true });
    lines.push({ kind: "text", text: `${address.city}, ${address.state} ${address.postal_code}` });
    if (address.delivery_instructions) lines.push({ kind: "text", text: `Driver: ${address.delivery_instructions}` });
  }
  return lines;
}

function itemLines(item: PrintDocument["items"][number], withPrice: boolean): PrintLine[] {
  const name = `${item.quantity}× ${item.variant ? `${item.variant} ` : ""}${item.name}`;
  const lines: PrintLine[] = [withPrice ? { kind: "pair", left: name, right: money(item.line_total_cents), bold: true } : { kind: "text", text: name, bold: true, tall: true }];
  for (const modifier of item.modifiers) {
    // "NO <option>" lines are the ones a cook must not miss.
    const removed = modifier.name.toUpperCase().startsWith("NO ");
    // Modifiers print twice as tall (owner, 2026-10-19: "make modifiers text on printed slips bigger"); same width, so nothing is cut off.
    lines.push({ kind: "text", text: `   ${removed ? modifier.name.toUpperCase() : `+ ${modifier.name}`}${modifier.quantity > 1 ? ` ×${modifier.quantity}` : ""}`, bold: removed, highlight: removed, tall: true });
  }
  if (item.instructions) lines.push({ kind: "text", text: `   Note: ${item.instructions}`, bold: true, highlight: true });
  return lines;
}

/** Customer receipt: everything, with prices and totals. */
export function buildReceipt(doc: PrintDocument): PrintLayout {
  const store = doc.store;
  const order = doc.order;
  const lines: PrintLine[] = [
    { kind: "text", text: store.name, align: "center", bold: true, large: true },
    { kind: "text", text: store.address_line1, align: "center" },
    { kind: "text", text: `${store.city}, ${store.state} ${store.postal_code}`, align: "center" },
    ...(store.phone ? [{ kind: "text" as const, text: phone(store.phone), align: "center" as const }] : []),
    { kind: "rule" },
    ...heading(doc),
    { kind: "rule" },
    ...doc.items.flatMap((item) => itemLines(item, true)),
    { kind: "rule" },
    { kind: "pair", left: "Subtotal", right: money(order.subtotal_cents) },
  ];
  if (order.discount_cents) lines.push({ kind: "pair", left: "Discount", right: money(-order.discount_cents) });
  if (order.delivery_fee_cents) lines.push({ kind: "pair", left: "Delivery fee", right: money(order.delivery_fee_cents) });
  lines.push({ kind: "pair", left: "Tax", right: money(order.tax_cents) });
  if (order.tip_cents) lines.push({ kind: "pair", left: "Tip", right: money(order.tip_cents) });
  lines.push({ kind: "pair", left: "TOTAL", right: money(order.total_cents), bold: true, large: true });
  lines.push({ kind: "text", text: paymentLine(order.payment_method, order.payment_status, order.fulfillment_type), align: "center", bold: true });
  if (order.special_instructions) lines.push({ kind: "text", text: `Notes: ${order.special_instructions}` });
  if (order.taken_by) lines.push({ kind: "text", text: `Taken by ${order.taken_by}`, align: "center" });
  lines.push({ kind: "text", text: "Thank you!", align: "center", bold: true }, { kind: "feed", lines: 3 });
  return { title: `Receipt ${order.order_number}`, lines: readableSlipLines(lines) };
}

export function readableSlipLines(lines: PrintLine[]): PrintLine[] {
  return lines.map((line) => line.kind === "text" || line.kind === "pair" ? { ...line, large: false, tall: true } : line);
}

/**
 * Online order slip (receipt printer): the full receipt under a banner that
 * can't be mistaken for a register receipt.  It goes in the bag / to the driver.
 */
export function buildOnlineOrderSlip(doc: PrintDocument): PrintLayout {
  const receipt = buildReceipt(doc);
  return {
    title: `Online order ${doc.order.order_number}`,
    lines: readableSlipLines([
      { kind: "text", text: "*** ONLINE ORDER ***", align: "center", bold: true, large: true },
      { kind: "feed", lines: 1 },
      ...receipt.lines,
    ]),
  };
}

/**
 * Tip & signature slip (receipt printer): the copy the customer or driver
 * signs, with blank Tip and Total lines — what Wayne's printer produces for
 * every online order today.  A tip already added online is shown, and the
 * blank line is then for anything extra.
 */
export function buildTipSignatureSlip(doc: PrintDocument): PrintLayout {
  const store = doc.store;
  const order = doc.order;
  const lines: PrintLine[] = [
    { kind: "text", text: store.name, align: "center", bold: true, large: true },
    { kind: "text", text: store.address_line1, align: "center" },
    { kind: "text", text: `${store.city}, ${store.state} ${store.postal_code}`, align: "center" },
    { kind: "rule" },
    { kind: "text", text: "TIP & SIGNATURE - STORE COPY", align: "center", bold: true },
    ...heading(doc),
    { kind: "rule" },
    { kind: "pair", left: "Subtotal", right: money(order.subtotal_cents) },
  ];
  if (order.discount_cents) lines.push({ kind: "pair", left: "Discount", right: money(-order.discount_cents) });
  if (order.delivery_fee_cents) lines.push({ kind: "pair", left: "Delivery fee", right: money(order.delivery_fee_cents) });
  lines.push({ kind: "pair", left: "Tax", right: money(order.tax_cents) });
  if (order.tip_cents) lines.push({ kind: "pair", left: order.source === "online" ? "Tip added online" : "Tip already added", right: money(order.tip_cents) });
  lines.push(
    { kind: "pair", left: "AMOUNT", right: money(order.total_cents), bold: true, large: true },
    { kind: "text", text: paymentLine(order.payment_method, order.payment_status, order.fulfillment_type), align: "center", bold: true },
    { kind: "feed", lines: 2 },
    { kind: "pair", left: order.tip_cents ? "Extra tip:" : "Tip:", right: "______________", bold: true },
    { kind: "feed", lines: 2 },
    { kind: "pair", left: "Total:", right: "______________", bold: true },
    { kind: "feed", lines: 3 },
    { kind: "text", text: "X______________________________" },
    { kind: "text", text: order.customer_name || "Signature", align: "center" },
    { kind: "feed", lines: 1 },
    { kind: "text", text: "I agree to pay the above total amount.", align: "center" },
    { kind: "feed", lines: 3 },
  );
  return { title: `Tip & signature ${order.order_number}`, lines: readableSlipLines(lines) };
}

function paymentLine(method: string, status: string, fulfillment: string) {
  if (status === "paid") return method === "cash" ? "PAID — CASH" : "PAID";
  if (status === "authorized") return "CARD APPROVED — ADD TIP BELOW";
  // "test_manual" is the old internal name for "pay at the counter / in Payments" — a real order not paid yet.
  if (method === "test_manual") return "NOT PAID YET";
  if (method === "cash") return fulfillment === "delivery" ? "CASH — COLLECT ON DELIVERY" : "CASH — DUE AT PICKUP";
  return status.toUpperCase();
}

/**
 * Which items go to the kitchen printer (§23 "Pizza → kitchen, drinks → front").
 * With no routing chosen yet, everything goes — the same as today's print queue.
 */
export function routeToKitchen(doc: PrintDocument, routingCategories: readonly string[]) {
  if (!routingCategories.length) return doc.items;
  const routed = new Set(routingCategories.map((name) => name.trim().toLowerCase()));
  return doc.items.filter((item) => item.category !== null && routed.has(item.category.trim().toLowerCase()));
}

/** How many things are on a ticket: quantities added up (2× Coke counts 2). */
export function itemCount(items: readonly PrintDocument["items"][number][]) {
  return items.reduce((sum, item) => sum + Math.max(item.quantity, 0), 0);
}

/**
 * Kitchen ticket: big, only the items routed to this printer, how many items
 * are on it, and the order's totals at the bottom (owner, 2026-10-13: "totals
 * for the orders should also be printed on the tickets for the kitchen"; "on
 * the ticket it should write how many items are on the ticket").  Item lines
 * stay without prices so the cook reads only what to make.
 */
export function buildKitchenTicket(doc: PrintDocument, routingCategories: readonly string[] = [], options: { onlyItemIds?: readonly string[]; updated?: boolean } = {}): PrintLayout | null {
  // Items added to an order whose ticket already printed (owner, 2026-10-13): only those go.
  const only = options.onlyItemIds ? new Set(options.onlyItemIds) : null;
  const items = routeToKitchen(doc, routingCategories).filter((item) => !only || only.has(item.id));
  if (!items.length) return null;
  const order = doc.order;
  const count = itemCount(items);
  const wholeOrder = itemCount(doc.items);
  /*
   * Kitchen ticket (owner, 2026-10-26: "food at the top … reduce the slip size
   * overall and only keep essential information on the kitchen slips; if it's
   * a receipt then include all of the information"), like the old system's
   * ticket but shorter: one line saying which order, the food, then one line
   * each for who, where, and time · items · total.  Paid or not stays (the
   * bag must say if the customer still owes).  Subtotal / tax / delivery, the
   * phone line and the ready time are on the receipt only.  Every line still
   * prints at the same (tall) size — only lines are gone.
   */
  const payment = order.payment_status === "paid" || order.payment_status === "authorized" ? "PAID"
    : order.payment_status === "refunded" ? "REFUNDED" : order.payment_status === "partially_refunded" ? "PART REFUNDED" : "NOT PAID";
  const number = `#${ticketNumber(order)}`;
  const header = [order.add_on_to ? `ADD-ON TO ${number}` : number, order.fulfillment_type === "delivery" ? "DELIVERY" : "PICKUP", payment].join(" · ");
  const banner: PrintLine[] = only
    ? [{ kind: "text", text: `ADDED TO ${number} - SAME ORDER`, align: "center", bold: true, highlight: true }]
    : options.updated
      ? [{ kind: "text", text: `UPDATED ORDER ${number} - USE THIS ONE`, align: "center", bold: true, highlight: true }]
      : [];
  const lines: PrintLine[] = [
    ...banner,
    { kind: "text", text: header, align: "center", bold: true, highlight: payment === "NOT PAID" },
    { kind: "rule" },
    ...items.flatMap((item) => kitchenItemLines(item)),
    ...(order.special_instructions ? [{ kind: "text" as const, text: `ORDER NOTE: ${order.special_instructions}`, bold: true, highlight: true }] : []),
    { kind: "rule" },
  ];
  const tel = order.customer_phone ? phone(order.customer_phone) : "";
  if (order.customer_name && tel) lines.push({ kind: "pair", left: order.customer_name, right: tel });
  else if (order.customer_name || tel) lines.push({ kind: "text", text: order.customer_name || tel });
  const address = order.delivery_address;
  if (order.fulfillment_type === "delivery" && address) {
    lines.push({ kind: "text", text: `${address.address1}${address.address2 ? `, ${address.address2}` : ""}, ${address.city}` });
    if (address.delivery_instructions) lines.push({ kind: "text", text: `Driver: ${address.delivery_instructions}` });
  }
  const placed = clock(order.placed_at, doc.store.timezone);
  const counted = only ? `${count} added (${wholeOrder} on order)` : count !== wholeOrder ? `${count} of ${wholeOrder} items` : `${count} item${count === 1 ? "" : "s"}`;
  lines.push({ kind: "pair", left: [placed, counted].filter(Boolean).join(" · "), right: money(order.total_cents) }, { kind: "feed", lines: 3 });
  return { title: `Kitchen ${number}`, lines: readableSlipLines(lines) };
}

/** Time only (7:51 pm) — the kitchen slip prints the same day it's made. */
function clock(iso: string | null, timeZone: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso)).replace(/\s?([AP])M$/, (_, half: string) => ` ${half.toLowerCase()}m`);
}

/** "1 Large Cheese Pizza", then its options and note — what the cook needs, no prices. */
function kitchenItemLines(item: PrintDocument["items"][number]): PrintLine[] {
  const [first, ...rest] = itemLines(item, false);
  const name = `${item.quantity} ${item.variant ? `${item.variant} ` : ""}${item.name}`;
  return [first && first.kind === "text" ? { ...first, text: name } : { kind: "text", text: name, bold: true, tall: true }, ...rest];
}

/** A fixed test page for Admin → Hardware → Test print. */
function ruler(columns: number) {
  let text = "";
  for (let index = 1; index <= columns; index += 1) text += index % 10 === 0 ? String((index / 10) % 10) : index % 5 === 0 ? "+" : "-";
  return text;
}

export function buildTestPage(printerName: string, now = new Date(), columns = 42, receiptHeader = "Store"): PrintLayout {
  return {
    title: "Test print",
    lines: [
      { kind: "text", text: receiptHeader, align: "center", bold: true, large: true },
      { kind: "text", text: "Printer test", align: "center", bold: true },
      { kind: "rule" },
      { kind: "pair", left: "Printer", right: printerName || "Unnamed" },
      { kind: "pair", left: "Time", right: now.toLocaleString("en-US") },
      { kind: "text", text: "Left", align: "left" },
      { kind: "text", text: "Centre", align: "center" },
      { kind: "text", text: "Right", align: "right" },
      { kind: "text", text: "Bold line", bold: true },
      { kind: "text", text: "LARGE LINE", large: true },
      { kind: "text", text: "NO ONIONS (red with a black/red ribbon)", bold: true, highlight: true },
      { kind: "rule" },
      { kind: "text", text: "Line width ruler (should fill one line):" },
      { kind: "text", text: ruler(columns) },
      { kind: "rule" },
      { kind: "text", text: "If every line above is readable, the printer is set up.", align: "center" },
      { kind: "feed", lines: 3 },
    ],
  };
}

/** Plain text of a layout at a fixed width — used by both renderers and by tests. */
export function layoutToText(layout: PrintLayout, columns = 42): string[] {
  const out: string[] = [];
  for (const line of layout.lines) {
    if (line.kind === "rule") out.push("-".repeat(columns));
    else if (line.kind === "feed") for (let index = 0; index < line.lines; index += 1) out.push("");
    else if (line.kind === "pair") {
      const width = line.large ? Math.floor(columns / 2) : columns;
      if (line.left.length + line.right.length + 1 <= width) {
        out.push(`${line.left}${" ".repeat(width - line.left.length - line.right.length)}${line.right}`);
      } else {
        out.push(...wrap(line.left, width));
        for (const chunk of wrap(line.right, width)) out.push(`${" ".repeat(width - chunk.length)}${chunk}`);
      }
    } else {
      const width = line.large ? Math.floor(columns / 2) : columns;
      for (const chunk of wrap(line.text, width)) {
        const pad = width - chunk.length;
        out.push(line.align === "center" ? `${" ".repeat(Math.floor(pad / 2))}${chunk}` : line.align === "right" ? `${" ".repeat(pad)}${chunk}` : chunk);
      }
    }
  }
  return out;
}

export function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else { lines.push(current); current = word; }
    while (current.length > width) { lines.push(current.slice(0, width)); current = current.slice(width); }
  }
  if (current) lines.push(current);
  return lines;
}
