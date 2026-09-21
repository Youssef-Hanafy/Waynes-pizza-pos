import { z } from "zod";

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
    id: z.uuid(), order_number: z.string(), source: z.string(), fulfillment_type: z.string(), status: z.string(),
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
  | { kind: "text"; text: string; align?: "left" | "center" | "right"; bold?: boolean; large?: boolean }
  | { kind: "pair"; left: string; right: string; bold?: boolean; large?: boolean }
  | { kind: "rule" }
  | { kind: "feed"; lines: number };

export type PrintLayout = { title: string; lines: PrintLine[] };

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

function when(iso: string | null, timeZone: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function phone(value: string) {
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : value;
}

function heading(doc: PrintDocument): PrintLine[] {
  const order = doc.order;
  const origin = order.source === "phone" ? `PHONE${order.phone_line ? ` · LINE ${order.phone_line}` : ""}` : order.source === "online" ? "ONLINE" : "COUNTER";
  const lines: PrintLine[] = [
    { kind: "text", text: `${order.fulfillment_type === "delivery" ? "DELIVERY" : "PICKUP"} · ${origin}`, align: "center", bold: true },
    { kind: "text", text: `Order ${order.order_number}`, align: "center", bold: true, large: true },
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
  const lines: PrintLine[] = [withPrice ? { kind: "pair", left: name, right: money(item.line_total_cents), bold: true } : { kind: "text", text: name, bold: true, large: true }];
  for (const modifier of item.modifiers) {
    // "NO <option>" lines are the ones a cook must not miss.
    const removed = modifier.name.toUpperCase().startsWith("NO ");
    lines.push({ kind: "text", text: `   ${removed ? modifier.name.toUpperCase() : `+ ${modifier.name}`}${modifier.quantity > 1 ? ` ×${modifier.quantity}` : ""}`, bold: removed });
  }
  if (item.instructions) lines.push({ kind: "text", text: `   Note: ${item.instructions}`, bold: true });
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
  return { title: `Receipt ${order.order_number}`, lines };
}

function paymentLine(method: string, status: string, fulfillment: string) {
  if (status === "paid") return method === "cash" ? "PAID — CASH" : "PAID";
  if (method === "test_manual") return "TEST / MANUAL — NOT PAID";
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

/** Kitchen ticket: big, no prices, only the items routed to this printer. */
export function buildKitchenTicket(doc: PrintDocument, routingCategories: readonly string[] = []): PrintLayout | null {
  const items = routeToKitchen(doc, routingCategories);
  if (!items.length) return null;
  return {
    title: `Kitchen ${doc.order.order_number}`,
    lines: [
      ...heading(doc),
      { kind: "rule" },
      ...items.flatMap((item) => [...itemLines(item, false), { kind: "feed" as const, lines: 1 }]),
      ...(doc.order.special_instructions ? [{ kind: "rule" as const }, { kind: "text" as const, text: `ORDER NOTE: ${doc.order.special_instructions}`, bold: true }] : []),
      { kind: "feed", lines: 3 },
    ],
  };
}

/** A fixed test page for Admin → Hardware → Test print. */
export function buildTestPage(printerName: string, now = new Date()): PrintLayout {
  return {
    title: "Test print",
    lines: [
      { kind: "text", text: "WAYNE'S PIZZA", align: "center", bold: true, large: true },
      { kind: "text", text: "Printer test", align: "center", bold: true },
      { kind: "rule" },
      { kind: "pair", left: "Printer", right: printerName || "Unnamed" },
      { kind: "pair", left: "Time", right: now.toLocaleString("en-US") },
      { kind: "text", text: "Left", align: "left" },
      { kind: "text", text: "Centre", align: "center" },
      { kind: "text", text: "Right", align: "right" },
      { kind: "text", text: "Bold line", bold: true },
      { kind: "text", text: "LARGE LINE", large: true },
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
      const room = Math.max(1, width - line.right.length - 1);
      const left = line.left.length > room ? line.left.slice(0, room) : line.left;
      out.push(`${left}${" ".repeat(width - left.length - line.right.length)}${line.right}`);
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
