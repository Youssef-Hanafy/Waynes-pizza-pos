"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Search and jump for Admin → Menu (owner, 2026-10-12).  Typing "dinner"
 * shows the Dinners category; typing an item name shows only the categories
 * that hold it, with just the matching items.  Works on the rendered list, so
 * every form and button on it stays a normal server form.
 */
export function MenuSearch({ categories, children }: { categories: { id: string; name: string }[]; children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const needle = query.trim().toLowerCase();
    let count = 0;
    root.querySelectorAll<HTMLElement>("[data-menu-category]").forEach((card) => {
      const categoryHit = !needle || (card.dataset.search ?? "").includes(needle);
      let itemHits = 0;
      card.querySelectorAll<HTMLElement>("[data-menu-item]").forEach((row) => {
        const hit = categoryHit || (row.dataset.search ?? "").includes(needle);
        row.hidden = !hit;
        if (hit) itemHits += 1;
      });
      const visible = categoryHit || itemHits > 0;
      card.hidden = !visible;
      if (visible) count += 1;
    });
    // Archived categories open up when the search finds something inside them.
    root.querySelectorAll<HTMLDetailsElement>("details[data-menu-archived]").forEach((box) => {
      const any = Array.from(box.querySelectorAll<HTMLElement>("[data-menu-category]")).some((card) => !card.hidden);
      box.hidden = Boolean(needle) && !any;
      if (needle && any) box.open = true;
    });
    const frame = window.requestAnimationFrame(() => setShown(needle ? count : null));
    return () => window.cancelAnimationFrame(frame);
  }, [query]);

  function jump(id: string) {
    setQuery("");
    window.requestAnimationFrame(() => document.getElementById(`category-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return <div className="grid gap-4">
    <div className="sticky top-[7.5rem] z-30 grid gap-3 rounded-2xl border border-wayne-border bg-white/95 p-3 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2">
        <input
          aria-label="Search the menu"
          className="min-h-12 w-full rounded-xl border border-wayne-border px-4 text-base"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search categories or items — e.g. dinners, chicken parm, 2 liter"
          type="search"
          value={query}
        />
        {query ? <button className="min-h-12 rounded-xl border border-wayne-border px-4 text-sm font-bold" onClick={() => setQuery("")} type="button">Clear</button> : null}
      </div>
      {shown !== null ? <p className="text-sm font-bold text-wayne-muted" role="status">{shown ? `${shown} categor${shown === 1 ? "y" : "ies"} match` : "Nothing matches that."}</p> : null}
      <nav aria-label="Jump to a category" className="flex gap-2 overflow-x-auto pb-1">
        {categories.map((category) => <button className="min-h-10 shrink-0 rounded-full border border-wayne-border bg-wayne-cream px-3 text-sm font-bold hover:border-wayne-green" key={category.id} onClick={() => jump(category.id)} type="button">{category.name}</button>)}
      </nav>
    </div>
    <div className="grid gap-6" ref={listRef}>{children}</div>
  </div>;
}
