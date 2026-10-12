"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Wayne's own on-screen keyboard for the counter tablet (owner, 2026-10-11).
 *
 * The tablet's built-in keyboard covered half the screen and split itself in
 * two with a gap down the middle.  On the POS every text box now opens this
 * keyboard instead: one compact block along the bottom, letters or a number
 * pad depending on the field, and the page shrinks above it so the box being
 * typed in (and the buttons under it) never jump or hide.
 *
 * How: each text box gets inputmode="none" (the system keyboard stays away),
 * and each key writes into the focused box the same way typing does, so every
 * form on the POS works unchanged.  Per register it can be switched off in
 * More → This register (then the tablet's own keyboard is used again).
 */
const STORAGE = "wayne-pos-keyboard";
type Setting = "auto" | "on" | "off";
const listeners = new Set<() => void>();

function readSetting(): Setting {
  try {
    const value = window.localStorage.getItem(STORAGE);
    return value === "on" || value === "off" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function getPosKeyboardSetting(): Setting {
  return typeof window === "undefined" ? "auto" : readSetting();
}

export function setPosKeyboardSetting(value: Setting) {
  try { window.localStorage.setItem(STORAGE, value); } catch { /* this visit only */ }
  for (const listener of listeners) listener();
}

/**
 * Auto: on for the Android register app and touch-only tablets; off with a
 * mouse, and off on phones (a driver's or the owner's own phone keeps its
 * normal keyboard).  The choice in More → This register applies to every
 * staff screen on that device — POS, Admin, Kitchen, Driver, sign-in.
 */
export function posKeyboardEnabled(setting: Setting = getPosKeyboardSetting()) {
  if (typeof window === "undefined") return false;
  if (setting !== "auto") return setting === "on";
  if ((window as unknown as { WaynesAndroid?: unknown }).WaynesAndroid) return true;
  const touchOnly = window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
  const tablet = Math.min(window.screen.width, window.screen.height) >= 560;
  return touchOnly && tablet;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

type Field = HTMLInputElement | HTMLTextAreaElement;
const TEXT_TYPES = new Set(["", "text", "search", "tel", "email", "number", "url", "password"]);

function isField(node: unknown): node is Field {
  if (node instanceof HTMLTextAreaElement) return !node.readOnly && !node.disabled;
  if (!(node instanceof HTMLInputElement)) return false;
  return TEXT_TYPES.has((node.getAttribute("type") ?? "").toLowerCase()) && !node.readOnly && !node.disabled;
}

/** The field really focused, looking inside open shadow roots (e.g. Google's address box). */
function deepActive(): Element | null {
  let element: Element | null = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

function originalMode(field: Field) {
  if (field.dataset.posIm !== undefined) return field.dataset.posIm;
  const attribute = field.getAttribute("inputmode");
  if (attribute && attribute !== "none") return attribute;
  const type = (field.getAttribute("type") ?? "").toLowerCase();
  return type === "tel" ? "tel" : type === "number" ? "decimal" : type === "email" ? "email" : "";
}

function quiet(field: Field) {
  if (field.dataset.posIm === undefined) field.dataset.posIm = originalMode(field);
  if (field.getAttribute("inputmode") !== "none") field.setAttribute("inputmode", "none");
}

function restore(field: Field) {
  if (field.dataset.posIm === undefined) return;
  const mode = field.dataset.posIm;
  delete field.dataset.posIm;
  if (mode) field.setAttribute("inputmode", mode); else field.removeAttribute("inputmode");
}

function quietAll(root: ParentNode) {
  if (isField(root)) quiet(root);
  root.querySelectorAll?.("input, textarea").forEach((node) => { if (isField(node)) quiet(node); });
}

function setValue(field: Field, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
}

function selection(field: Field): [number, number] {
  try {
    if (field.selectionStart !== null && field.selectionEnd !== null) return [field.selectionStart, field.selectionEnd];
  } catch { /* email / number boxes have no caret position */ }
  return [field.value.length, field.value.length];
}

function write(field: Field, change: (value: string, start: number, end: number) => { value: string; caret: number } | null) {
  const [start, end] = selection(field);
  const next = change(field.value, start, end);
  if (!next) return;
  const max = field.maxLength;
  if (max > 0 && next.value.length > max) return;
  setValue(field, next.value);
  try { field.setSelectionRange(next.caret, next.caret); } catch { /* no caret on this type */ }
  field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

type Layout = "letters" | "symbols" | "numbers";
const LETTER_ROWS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "'"],
  ["z", "x", "c", "v", "b", "n", "m", ",", ".", "-"],
];
const SYMBOL_ROWS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["@", "#", "$", "&", "*", "(", ")", "/", ":", ";"],
  ["!", "?", "+", "=", "%", "_", "\"", "'", "~", "^"],
  ["<", ">", "[", "]", "{", "}", "|", ",", ".", "-"],
];

export function PosKeyboard() {
  const setting = useSyncExternalStore(subscribe, getPosKeyboardSetting, () => "auto" as Setting);
  const [enabled, setEnabled] = useState(false);
  const [field, setField] = useState<Field | null>(null);
  const [layout, setLayout] = useState<Layout>("letters");
  const [shift, setShift] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setEnabled(posKeyboardEnabled(setting)), 0);
    return () => window.clearTimeout(timer);
  }, [setting]);

  // Keep the system keyboard away from every text box while this is on.
  useEffect(() => {
    if (!enabled) return;
    quietAll(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && isField(record.target)) {
          if (record.target.getAttribute("inputmode") !== "none") { delete record.target.dataset.posIm; quiet(record.target); }
          continue;
        }
        record.addedNodes.forEach((node) => { if (node instanceof Element) quietAll(node); });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["inputmode", "type"] });

    // A touch on a box (also inside Google's address box) quiets it before it takes focus.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.composedPath()[0];
      if (isField(target)) quiet(target);
    };
    const pick = () => {
      const active = deepActive();
      if (isField(active)) {
        quiet(active);
        setField(active);
        const mode = active.dataset.posIm ?? "";
        setLayout(mode === "tel" || mode === "numeric" || mode === "decimal" ? "numbers" : "letters");
        setShift(false);
        window.setTimeout(() => active.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
      } else if (!panel.current?.contains(document.activeElement)) {
        setField(null);
      }
    };
    const onFocusIn = () => pick();
    const onFocusOut = () => window.setTimeout(pick, 0);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    const first = window.setTimeout(pick, 0);
    return () => {
      window.clearTimeout(first);
      observer.disconnect();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.querySelectorAll("input, textarea").forEach((node) => { if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) restore(node); });
      setField(null);
    };
  }, [enabled]);

  // The page shrinks above the keyboard (nothing hides behind it, nothing jumps).
  useEffect(() => {
    const root = document.documentElement;
    if (!field || !panel.current) { root.style.removeProperty("--pos-kb-h"); return; }
    const element = panel.current;
    const apply = () => root.style.setProperty("--pos-kb-h", `${element.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => { observer.disconnect(); root.style.removeProperty("--pos-kb-h"); };
  }, [field, layout]);

  const type = useCallback((text: string) => {
    if (!field) return;
    // Names start with a capital letter.
    const mode = field.dataset.posIm ?? "";
    const autoCap = layout === "letters" && mode !== "email" && (field.getAttribute("type") ?? "text") !== "email"
      && (field.value.length === 0 || / $/.test(field.value)) && field.autocapitalize !== "off" && field.autocapitalize !== "none";
    const out = shift || autoCap ? text.toUpperCase() : text;
    write(field, (value, start, end) => ({ value: value.slice(0, start) + out + value.slice(end), caret: start + out.length }));
    if (shift) setShift(false);
  }, [field, layout, shift]);

  const backspace = useCallback(() => {
    if (!field) return;
    write(field, (value, start, end) => {
      if (start !== end) return { value: value.slice(0, start) + value.slice(end), caret: start };
      if (start === 0) return null;
      return { value: value.slice(0, start - 1) + value.slice(start), caret: start - 1 };
    });
  }, [field]);

  /** Next box on the page (like the keyboard's Next key); the last one closes the keyboard. */
  const next = useCallback(() => {
    if (!field) return;
    if (field instanceof HTMLTextAreaElement) { type("\n"); return; }
    const scope: ParentNode = field.form ?? document;
    const fields = Array.from(scope.querySelectorAll("input, textarea")).filter((node): node is Field => isField(node) && (node as HTMLElement).offsetParent !== null);
    const index = fields.indexOf(field);
    const following = index >= 0 ? fields[index + 1] : undefined;
    if (following) following.focus(); else field.blur();
  }, [field, type]);

  if (!enabled || !field) return null;

  // Keys never take the focus away from the box being typed in.
  const hold = (event: ReactPointerEvent | ReactMouseEvent) => event.preventDefault();
  const key = (label: string, onPress: () => void, className = "", aria?: string) => (
    <button aria-label={aria ?? label} className={`flex min-h-[3.1rem] select-none items-center justify-center rounded-lg bg-white text-xl font-bold text-wayne-ink shadow-[0_1px_0_rgba(0,0,0,0.25)] active:translate-y-px active:bg-wayne-cream ${className}`} key={`${aria ?? label}`} onClick={onPress} onMouseDown={hold} onPointerDown={hold} tabIndex={-1} type="button">{label}</button>
  );

  const rows = layout === "symbols" ? SYMBOL_ROWS : LETTER_ROWS;
  const isEmail = (field.dataset.posIm ?? "") === "email" || (field.getAttribute("type") ?? "") === "email";

  return <div aria-label="Keyboard" className="fixed inset-x-0 bottom-0 z-[100] border-t border-wayne-border-strong bg-[#d7d9dd] px-2 pb-2 pt-1.5 shadow-[0_-6px_20px_rgba(0,0,0,0.15)]" onMouseDown={hold} onPointerDown={hold} ref={panel} role="group">
    {layout === "numbers" ? <div className="mx-auto grid max-w-md grid-cols-4 gap-1.5">
      {["1", "2", "3"].map((digit) => key(digit, () => type(digit)))}
      {key("⌫", backspace, "bg-[#b9bcc2]", "Delete")}
      {["4", "5", "6"].map((digit) => key(digit, () => type(digit)))}
      {key("ABC", () => setLayout("letters"), "bg-[#b9bcc2] text-base", "Letters")}
      {["7", "8", "9"].map((digit) => key(digit, () => type(digit)))}
      {key("Next", next, "bg-[#b9bcc2] text-base")}
      {key(".", () => type("."))}
      {key("0", () => type("0"))}
      {key("-", () => type("-"))}
      {key("Done", () => field.blur(), "bg-wayne-green text-base text-white", "Hide keyboard")}
    </div> : <div className="mx-auto grid max-w-5xl gap-1.5">
      {rows.map((row, index) => <div className="grid grid-cols-10 gap-1.5" key={index}>
        {row.map((character) => key(shift && layout === "letters" ? character.toUpperCase() : character, () => type(character)))}
      </div>)}
      <div className="grid grid-cols-[1.4fr_1.2fr_1fr_4fr_1fr_1.4fr_1.4fr] gap-1.5">
        {key(shift ? "⇧ ON" : "⇧", () => setShift((value) => !value), `bg-[#b9bcc2] text-base ${shift ? "!bg-wayne-green text-white" : ""}`, "Shift")}
        {key(layout === "symbols" ? "ABC" : "#+=", () => setLayout(layout === "symbols" ? "letters" : "symbols"), "bg-[#b9bcc2] text-base", "Symbols")}
        {key(isEmail ? "@" : "123", () => (isEmail ? type("@") : setLayout("numbers")), "bg-[#b9bcc2] text-base", isEmail ? "@" : "Numbers")}
        {key("space", () => type(" "), "text-base text-wayne-muted", "Space")}
        {key("⌫", backspace, "bg-[#b9bcc2]", "Delete")}
        {key("Next", next, "bg-[#b9bcc2] text-base")}
        {key("Done", () => field.blur(), "bg-wayne-green text-base text-white", "Hide keyboard")}
      </div>
    </div>}
  </div>;
}
