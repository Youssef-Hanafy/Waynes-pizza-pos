import type { PrintLayout, TextSize } from "@/lib/printing/document";

function escape(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/**
 * A layout as a printable HTML page sized for receipt paper.  Used by the
 * browser print fallback today and for on-screen previews.
 */
export function renderLayoutHtml(layout: PrintLayout, paperWidthMm = 80, textSize: TextSize = "large"): string {
  const base = textSize === "xlarge" ? 20 : textSize === "large" ? 15 : 12;
  const large = textSize === "xlarge" ? base : Math.round(base * 1.45);
  const tall = textSize === "xlarge" ? base : Math.round(base * 1.25);
  const body = layout.lines.map((line) => {
    if (line.kind === "rule") return '<hr>';
    if (line.kind === "feed") return '<div class="feed"></div>'.repeat(line.lines);
    const classes = [line.bold ? "b" : "", line.large ? "l" : line.tall ? "t" : "", line.kind === "text" && line.highlight ? "h" : ""].filter(Boolean).join(" ");
    if (line.kind === "pair") return `<div class="pair ${classes}"><span>${escape(line.left)}</span><span>${escape(line.right)}</span></div>`;
    return `<div class="${classes}" style="text-align:${line.align ?? "left"}">${escape(line.text)}</div>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(layout.title)}</title><style>
@page { size: ${paperWidthMm}mm auto; margin: 3mm; }
body { font: ${base}px/1.35 ui-monospace, Menlo, Consolas, monospace; color: #000; margin: 0; width: ${paperWidthMm - 6}mm; }
.b { font-weight: 700; } .h { text-decoration: underline; } .l { font-size: ${large}px; } .t { font-size: ${tall}px; } hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
body > div { overflow-wrap: anywhere; }
.pair { display: flex; flex-wrap: wrap; justify-content: space-between; column-gap: 8px; }
.pair span { max-width: 100%; } .pair span:last-child { margin-left: auto; text-align: right; }
.feed { height: 1.35em; }
</style></head><body>${body}</body></html>`;
}
