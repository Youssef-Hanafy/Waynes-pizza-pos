"use client";

import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * Makes a screen fit the space it has, so ringing up an order needs as little
 * scrolling as possible (owner, 2026-10-29: "have it fit the page … readjust
 * the page … everything shrink in unison together … once it gets super tiny,
 * then you have to scroll").
 *
 * It measures what is inside against the box it sits in.  When the content
 * is taller, the whole content is scaled down together (CSS zoom) — text,
 * buttons, gaps and boxes alike — and, because a scaled-down screen has more
 * room across, rows and grids re-flow into more columns, which shortens it
 * further.  It picks the largest size that fits.  Below `min` it stops
 * shrinking and the box scrolls instead.  Content that already fits is left at
 * full size.  Re-fits by itself whenever the content or the box changes (a
 * line added to the ticket, a customer match list appearing, the on-screen
 * keyboard opening, a window resize).
 *
 * The box must get its height from its parent (e.g. flex-1 min-h-0).  On
 * narrow screens (phones, < 768px wide) nothing is scaled and the box scrolls.
 */
export function FitToSpace({ children, className = "", innerClassName = "", min = 0.75, scrollRef, label }: {
  children: ReactNode;
  /** Classes for the box (it always keeps overflow-y: auto as the last resort). */
  className?: string;
  /** Classes for the content inside the box. */
  innerClassName?: string;
  /** Smallest size before it scrolls instead (0.75 = three quarters size). */
  min?: number;
  /** The scrolling box, for callers that scroll it (e.g. to the newest ticket line). */
  scrollRef?: RefObject<HTMLDivElement | null>;
  label?: string;
}) {
  const outer = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    let frame = 0;
    let busy = false;
    const wide = window.matchMedia("(min-width: 768px)");
    const room = () => box.clientHeight + 1;
    const fitsAt = (zoom: number) => {
      content.style.zoom = zoom === 1 ? "" : String(zoom);
      return content.getBoundingClientRect().height <= room();
    };
    const fit = () => {
      frame = 0;
      if (busy) return;
      busy = true;
      try {
        if (!wide.matches || box.clientHeight < 40) {
          content.style.zoom = "";
          box.dataset.fit = "scroll";
          return;
        }
        let zoom = 1;
        if (!fitsAt(1)) {
          if (!fitsAt(min)) zoom = min;
          else {
            // Largest size that fits (to 1%).
            let low = min;
            let high = 1;
            while (high - low > 0.01) {
              const middle = (low + high) / 2;
              if (fitsAt(middle)) low = middle; else high = middle;
            }
            zoom = Math.floor(low * 100) / 100;
          }
          content.style.zoom = String(zoom);
        }
        box.dataset.fit = content.getBoundingClientRect().height <= room() ? String(zoom) : "scroll";
      } finally {
        busy = false;
      }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(fit); };
    fit();
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resized?.observe(box);
    resized?.observe(content);
    const changed = new MutationObserver(schedule);
    changed.observe(content, { childList: true, subtree: true, characterData: true });
    wide.addEventListener("change", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resized?.disconnect();
      changed.disconnect();
      wide.removeEventListener("change", schedule);
      window.removeEventListener("resize", schedule);
      content.style.zoom = "";
    };
  }, [min]);

  return <div aria-label={label} className={`min-h-0 overflow-y-auto ${className}`} ref={(element) => { outer.current = element; if (scrollRef) scrollRef.current = element; }}>
    <div className={innerClassName} ref={inner}>{children}</div>
  </div>;
}
