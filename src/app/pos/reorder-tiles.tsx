"use client";

import { createPortal } from "react-dom";
import { cloneElement, useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type HTMLAttributes } from "react";

const changed = "wayne:tile-order";
const subscribe = (notify: () => void) => {
  window.addEventListener(changed, notify);
  window.addEventListener("storage", notify);
  return () => { window.removeEventListener(changed, notify); window.removeEventListener("storage", notify); };
};
function read(key: string) {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function parse(value: string): string[] {
  try { const ids: unknown = JSON.parse(value); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
}

/** Reorders the real tiles, preserving the parent grid's sizing and existing controls.
 * Layout is local to this register; it never changes menu data or ticket contents.
 * Native non-passive touch listeners let a normal swipe scroll until a hold activates.
 */
export function ReorderTiles({ children, scope, label, enabled = true }: { children: ReactElement<HTMLAttributes<HTMLElement>>[]; scope: string; label: string; enabled?: boolean }) {
  const storageKey = `wayne-pos-tile-order:v1:${scope}`;
  const saved = useSyncExternalStore(subscribe, () => read(storageKey), () => "");
  const [draft, setDraft] = useState<string[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const byId = new Map(children.map((card) => [String(card.key), card]));
  const ids = [...new Set([...(draft ?? parse(saved)), ...byId.keys()])].filter((id) => byId.has(id));
  const current = useRef(ids);
  useEffect(() => { current.current = ids; });
  const finish = useRef<() => void>(() => {});

  useEffect(() => {
    const container = root.current;
    if (!container || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let edit = false;
    let active: { id: string; x: number; y: number; touch: boolean; started: boolean } | null = null;
    let suppressClick = false;
    let suppressTimer: ReturnType<typeof setTimeout> | undefined;
    let focusBefore: HTMLElement | null = null;
    let scrollFrame = 0;
    let pointer = { x: 0, y: 0 };
    const tile = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-reorder-id]") : null;
    const save = () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(current.current));
        window.dispatchEvent(new Event(changed));
        setMessage("Position saved on this register.");
      } catch { setMessage("Position changed, but this register could not save it. It will reset after reload."); }
    };
    const stop = (cancel = false) => {
      clearTimeout(timer);
      cancelAnimationFrame(scrollFrame);
      if (active?.started) {
        if (cancel) { current.current = parse(read(storageKey)); setDraft(null); }
        else save();
        // Touch browsers may synthesize a click after touchend.
        suppressClick = true;
        clearTimeout(suppressTimer);
        suppressTimer = setTimeout(() => { suppressClick = false; }, 500);
      }
      active = null;
      setDragging(null);
    };
    const done = () => {
      stop(true);
      clearTimeout(suppressTimer);
      suppressClick = false;
      edit = false;
      setEditing(false);
      focusBefore?.focus({ preventScroll: true });
    };
    finish.current = done;
    const start = (target: EventTarget | null, x: number, y: number, touch: boolean) => {
      const card = tile(target);
      if (!card || !container.contains(card)) return;
      clearTimeout(suppressTimer);
      suppressClick = false;
      active = { id: card.dataset.reorderId!, x, y, touch, started: false };
      pointer = { x, y };
      const activate = () => {
        if (!active) return;
        window.dispatchEvent(new CustomEvent("wayne:rearrange", { detail: container }));
        active.started = true;
        edit = true;
        focusBefore = card;
        suppressClick = true;
        setEditing(true);
        setDragging(active.id);
        const scroll = () => {
          if (!active?.started) return;
          let parent = container.parentElement;
          while (parent) {
            if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
              const bounds = parent.getBoundingClientRect();
              const delta = pointer.y < bounds.top + 35 ? -8 : pointer.y > bounds.bottom - 35 ? 8 : 0;
              if (delta) { parent.scrollTop += delta; move(pointer.x, pointer.y); }
              break;
            }
            parent = parent.parentElement;
          }
          scrollFrame = requestAnimationFrame(scroll);
        };
        scrollFrame = requestAnimationFrame(scroll);
        setMessage("Drag to a new spot. Tap Done when finished. Keyboard: Alt + arrow keys moves a focused tile.");
      };
      if (edit) activate();
      else timer = setTimeout(activate, 550);
    };
    const move = (x: number, y: number) => {
      if (!active) return;
      pointer = { x, y };
      if (!active.started) {
        if (Math.hypot(x - active.x, y - active.y) > 10) { clearTimeout(timer); active = null; }
        return;
      }
      const over = tile(document.elementFromPoint(x, y));
      if (!over || !container.contains(over) || over.dataset.reorderId === active.id) return;
      const next = [...current.current];
      const from = next.indexOf(active.id);
      const to = next.indexOf(over.dataset.reorderId!);
      if (from < 0 || to < 0) return;
      next.splice(to, 0, ...next.splice(from, 1));
      current.current = next;
      setDraft(next);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0 || !event.isPrimary) return;
      start(event.target, event.clientX, event.clientY, false);
    };
    const pointerMove = (event: PointerEvent) => { if (active && !active.touch) { if (active.started) event.preventDefault(); move(event.clientX, event.clientY); } };
    const pointerUp = (event: PointerEvent) => { if (event.pointerType !== "touch" && active && !active.touch) stop(event.type === "pointercancel"); };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { stop(true); return; }
      const touch = event.touches[0];
      start(event.target, touch.clientX, touch.clientY, true);
    };
    const touchMove = (event: TouchEvent) => {
      if (!active?.touch) return;
      if (active.started && event.cancelable) event.preventDefault();
      const touch = event.touches[0];
      if (touch) move(touch.clientX, touch.clientY);
    };
    const touchEnd = (event: TouchEvent) => { if (active?.touch) stop(event.type === "touchcancel"); };
    const click = (event: MouseEvent) => {
      if (edit || suppressClick) { event.preventDefault(); event.stopPropagation(); }
    };
    const context = (event: Event) => { if (tile(event.target)) event.preventDefault(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && edit) { event.preventDefault(); done(); return; }
      if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const card = tile(event.target);
      if (!card || !container.contains(card)) return;
      event.preventDefault();
      const from = current.current.indexOf(card.dataset.reorderId!);
      const boxes = Array.from(container.querySelectorAll<HTMLElement>("[data-reorder-id]"));
      const row = boxes.filter((box) => Math.abs(box.getBoundingClientRect().top - card.getBoundingClientRect().top) < 4).length || 1;
      const offset = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -row : row;
      const to = Math.max(0, Math.min(current.current.length - 1, from + offset));
      const next = [...current.current];
      next.splice(to, 0, ...next.splice(from, 1));
      current.current = next; setDraft(next); save();
      card.focus({ preventScroll: true });
    };
    const blur = () => stop(true);
    const otherGrid = (event: Event) => { if (edit && (event as CustomEvent).detail !== container) done(); };
    window.addEventListener("wayne:rearrange", otherGrid);
    container.addEventListener("pointerdown", pointerDown);
    container.addEventListener("touchstart", touchStart, { passive: true });
    container.addEventListener("click", click, true);
    container.addEventListener("contextmenu", context);
    container.addEventListener("keydown", key);
    window.addEventListener("pointermove", pointerMove, { passive: false });
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerUp);
    window.addEventListener("touchmove", touchMove, { passive: false });
    window.addEventListener("touchend", touchEnd);
    window.addEventListener("touchcancel", touchEnd);
    window.addEventListener("blur", blur);
    return () => {
      clearTimeout(timer); clearTimeout(suppressTimer); cancelAnimationFrame(scrollFrame);
      container.removeEventListener("pointerdown", pointerDown);
      container.removeEventListener("touchstart", touchStart);
      container.removeEventListener("click", click, true);
      container.removeEventListener("contextmenu", context);
      container.removeEventListener("keydown", key);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("touchmove", touchMove);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", touchEnd);
      window.removeEventListener("blur", blur);
      window.removeEventListener("wayne:rearrange", otherGrid);
    };
  }, [enabled, storageKey]);

  return <div className="contents" data-reorder-editing={editing || undefined} ref={root}>
    {(enabled ? ids.map((id) => byId.get(id)!) : children).map((card) => cloneElement(card, {
      "data-reorder-id": String(card.key),
      "data-reorder-dragging": dragging === String(card.key) || undefined,
      ...(enabled ? { title: "Hold to rearrange · Alt + arrow keys to move", tabIndex: card.props.tabIndex ?? 0 } : {}),
    } as HTMLAttributes<HTMLElement>))}
    {editing ? createPortal(<div className="fixed left-1/2 top-3 z-[80] flex max-w-[95vw] -translate-x-1/2 items-center gap-3 rounded-xl border-2 border-wayne-green bg-white p-3 text-sm font-bold shadow-xl" role="status"><span>Rearrange {label} · drag to move</span><button className="min-h-11 rounded-lg bg-wayne-green px-5 text-white" onClick={() => finish.current()} type="button">Done</button></div>, document.body) : null}
    <span aria-live="polite" className="sr-only">{message}</span>
  </div>;
}
