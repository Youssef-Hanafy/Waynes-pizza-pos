"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Lays tiles out so a whole set fits the space it is given, with no
 * scrolling (owner request 2026-10-08: "it has to be very quick… have it all
 * fit on the screen"). It measures its own box and picks the column count that
 * gives the biggest tiles. Only when even the smallest allowed tile would not
 * fit (or the box has no fixed height, e.g. on a phone) does it fall back to a
 * normal scrolling grid.
 */
export function useFit(count: number, options: { minWidth: number; minHeight: number; ratio: number; gap: number; maxCols?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [bounded, setBounded] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const query = window.matchMedia("(min-width: 1024px)");
    const measure = () => {
      setBounded(query.matches);
      const box = element.getBoundingClientRect();
      setSize((current) => (current && Math.abs(current.width - box.width) < 1 && Math.abs(current.height - box.height) < 1 ? current : { width: box.width, height: box.height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    query.addEventListener("change", measure);
    return () => { observer.disconnect(); query.removeEventListener("change", measure); };
  }, []);

  const layout = (() => {
    if (!size || !bounded || !count || size.height < options.minHeight) return null;
    let best: { cols: number; rows: number; cellHeight: number; score: number } | null = null;
    const maxCols = Math.min(count, options.maxCols ?? 12);
    for (let cols = 1; cols <= maxCols; cols += 1) {
      const rows = Math.ceil(count / cols);
      const cellWidth = (size.width - options.gap * (cols - 1)) / cols;
      const cellHeight = (size.height - options.gap * (rows - 1)) / rows;
      if (cellWidth < options.minWidth || cellHeight < options.minHeight) continue;
      // The usable size of a tile: whichever side runs out first at the target shape.
      const score = Math.min(cellWidth / options.ratio, cellHeight);
      if (!best || score > best.score + 0.5) best = { cols, rows, cellHeight, score };
    }
    return best;
  })();

  const style: CSSProperties | undefined = layout
    ? { display: "grid", gap: options.gap, gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))` }
    : undefined;
  return { ref, layout, style };
}

export function FitGrid({ children, className = "", count, fallbackClassName, gap = 8, maxCols, minHeight, minWidth, ratio, label }: {
  children: (cellHeight: number | null) => ReactNode;
  className?: string;
  count: number;
  /** Classes for the scrolling grid used when the tiles can't all fit. */
  fallbackClassName: string;
  gap?: number;
  maxCols?: number;
  minHeight: number;
  minWidth: number;
  ratio: number;
  label?: string;
}) {
  const { ref, layout, style } = useFit(count, { gap, maxCols, minHeight, minWidth, ratio });
  return (
    <div aria-label={label} className={`min-h-0 ${className} ${layout ? "overflow-hidden" : `overflow-y-auto ${fallbackClassName}`}`} data-fit={layout ? `${layout.cols}x${layout.rows}` : "scroll"} ref={ref} style={style}>
      {children(layout ? layout.cellHeight : null)}
    </div>
  );
}
