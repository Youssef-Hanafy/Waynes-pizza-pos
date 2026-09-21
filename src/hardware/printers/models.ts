/**
 * The printer models Wayne's actually has (photographed at the counter),
 * with exactly the settings that differ between them.  Anything not listed
 * falls back to "generic" — plain ESC/POS with conservative settings.
 *
 *   Epson TM-T20III L (M352A)  thermal "box" printer at the front.  Customer
 *     receipts, online order slips and the tip & signature slip; the cash
 *     drawer is wired to its DK port.  80 mm paper, Font A = 48 columns.
 *   Epson TM-U220B (M188B) + UB-E04 Ethernet card  impact "roundish" printer
 *     for kitchen tickets.  76 mm paper, 40 columns (7x9 font), slower, and
 *     its cutter sits several lines below the print head.  With a black/red
 *     ribbon (ERC-38 B/R) it can print the lines a cook must not miss in red.
 *
 * Sources: Epson ESC/POS command reference for the TM-U220 and TM-T20III.
 */
export type CutStyle = "feed_and_cut" | "feed_then_cut" | "none";

export type PrinterModelProfile = {
  key: string;
  label: string;
  kind: "thermal" | "impact";
  paperWidthMm: number;
  /** Characters per line at normal size with the printer's default font. */
  columns: number;
  cut: CutStyle;
  /** Lines to feed before cutting on printers whose cutter sits below the head. */
  feedBeforeCut: number;
  /** Can print a second colour (needs a two-colour ribbon on impact printers). */
  supportsRed: boolean;
  /** Has a drawer kick (DK) port. */
  drawerKick: boolean;
  defaultPort: number;
};

export const printerModels: Record<string, PrinterModelProfile> = {
  "epson-tm-t20iii": {
    key: "epson-tm-t20iii", label: "Epson TM-T20III (thermal, 80 mm)", kind: "thermal",
    paperWidthMm: 80, columns: 48, cut: "feed_and_cut", feedBeforeCut: 0, supportsRed: false, drawerKick: true, defaultPort: 9100,
  },
  "epson-tm-u220b": {
    key: "epson-tm-u220b", label: "Epson TM-U220B (impact, 76 mm)", kind: "impact",
    paperWidthMm: 76, columns: 40, cut: "feed_then_cut", feedBeforeCut: 4, supportsRed: true, drawerKick: true, defaultPort: 9100,
  },
  generic: {
    key: "generic", label: "Other ESC/POS printer", kind: "thermal",
    paperWidthMm: 80, columns: 42, cut: "feed_and_cut", feedBeforeCut: 0, supportsRed: false, drawerKick: true, defaultPort: 9100,
  },
};

export const printerModelKeys = ["epson-tm-t20iii", "epson-tm-u220b", "generic"] as const;
export type PrinterModelKey = (typeof printerModelKeys)[number];

export function printerModel(key: string | undefined | null): PrinterModelProfile {
  return (key && printerModels[key]) || printerModels.generic;
}

/** Characters per line: the owner's override if set, otherwise the model's, narrower on 58 mm paper. */
export function columnsFor(profile: PrinterModelProfile, paperWidthMm: number, override: number | null) {
  if (override && override >= 24 && override <= 64) return override;
  if (paperWidthMm <= 58) return 32;
  return profile.columns;
}
