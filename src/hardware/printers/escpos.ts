import { layoutToText, wrap, type PrintLayout } from "@/lib/printing/document";
import type { CutStyle } from "./models";

/**
 * ESC/POS encoding — used ONLY when Admin → Hardware sets a printer's protocol
 * to "escpos" after its model has been confirmed as ESC/POS compatible
 * (build sheet §2.7, §59: no protocol is assumed before then).
 *
 * Only the long-standing core commands are used: initialize (ESC @), justify
 * (ESC a), emphasis (ESC E), character size (GS !), feed (ESC d), partial cut
 * (GS V 66 n on the TM-T20III; ESC d then GS V 1 on the TM-U220B, whose
 * cutter sits below the print head), red ink (ESC r, two-colour ribbon on the
 * TM-U220B only), and the drawer pulse (ESC p) for a drawer wired to the
 * printer's kick port (§24, §60).
 */
const ESC = 0x1b;
const GS = 0x1d;

function latin1(text: string): number[] {
  return Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    // The printer's default code page is not Unicode: map what it cannot show.
    if (char === "×") return 0x78;
    if (char === "—" || char === "–") return 0x2d;
    if (char === "·") return 0x2e;
    return code < 0x20 ? 0x20 : code > 0xff ? 0x3f : code;
  });
}

export type EscPosOptions = {
  columns?: number;
  /** false = no cut (kept for older callers); otherwise the model's cut style. */
  cut?: boolean | CutStyle;
  feedBeforeCut?: number;
  /** Print highlighted lines in red (two-colour ribbon fitted). */
  red?: boolean;
};

export function encodeEscPos(layout: PrintLayout, options: EscPosOptions = {}): Uint8Array {
  const columns = options.columns ?? 42;
  const bytes: number[] = [ESC, 0x40];
  const align = (value: "left" | "center" | "right" = "left") => bytes.push(ESC, 0x61, value === "center" ? 1 : value === "right" ? 2 : 0);
  const style = (bold = false, large = false, highlight = false) => {
    bytes.push(ESC, 0x45, bold ? 1 : 0, GS, 0x21, large ? 0x11 : 0x00);
    if (options.red) bytes.push(ESC, 0x72, highlight ? 1 : 0);
  };
  for (const line of layout.lines) {
    if (line.kind === "feed") { bytes.push(ESC, 0x64, Math.min(line.lines, 10)); continue; }
    if (line.kind === "rule") { align(); style(); bytes.push(...latin1("-".repeat(columns)), 0x0a); continue; }
    if (line.kind === "pair") {
      align(); style(line.bold, line.large);
      const text = layoutToText({ title: "", lines: [line] }, columns)[0] ?? "";
      bytes.push(...latin1(text), 0x0a);
      continue;
    }
    align(line.align); style(line.bold, line.large, line.highlight);
    for (const chunk of wrap(line.text, line.large ? Math.floor(columns / 2) : columns)) bytes.push(...latin1(chunk), 0x0a);
  }
  style();
  const cut: CutStyle = options.cut === false ? "none" : options.cut === true || options.cut === undefined ? "feed_and_cut" : options.cut;
  if (cut === "feed_and_cut") bytes.push(GS, 0x56, 66, 3);
  else if (cut === "feed_then_cut") bytes.push(ESC, 0x64, Math.min(Math.max(options.feedBeforeCut ?? 4, 0), 10), GS, 0x56, 1);
  return Uint8Array.from(bytes);
}

/** Pulse drawer pin 2 (kick connector) — ESC p 0 t1 t2. */
export function encodeDrawerKick(): Uint8Array {
  return Uint8Array.from([ESC, 0x70, 0x00, 0x19, 0xfa]);
}
