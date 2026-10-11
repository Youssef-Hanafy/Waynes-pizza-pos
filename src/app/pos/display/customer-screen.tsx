"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { formatCents } from "@/lib/menu/schemas";
import { displayReadSchema, displayStateSchema, signatureSvg, tipFromPercent, type DisplayState } from "@/lib/pos/customer-display";

const KEY_STORAGE = "wayne-customer-screen-register";

function readKey() {
  try { return window.localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; }
}
function saveKey(value: string) {
  try { window.localStorage.setItem(KEY_STORAGE, value); } catch { /* kept for this visit only */ }
}

/**
 * The customer-facing screen (owner, 2026-10-11) — the Fire tablet facing the
 * customer at the counter.  It mirrors one register: the order as it is rung
 * up, then a tip choice before the card is run, then a signature.
 */
export function CustomerScreen({ storeName }: { storeName: string }) {
  const [key, setKey] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [state, setState] = useState<DisplayState>(() => displayStateSchema.parse({}));
  const [registerOnline, setRegisterOnline] = useState(true);
  const [answered, setAnswered] = useState("");
  const [problem, setProblem] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => { const saved = readKey(); setKey(saved); setChoosing(!saved); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    async function poll() {
      try {
        const response = await fetch(`/api/pos/display?key=${encodeURIComponent(key)}`, { cache: "no-store", signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error();
        const parsed = displayReadSchema.safeParse(await response.json());
        if (!parsed.success || !alive) return;
        const next = displayStateSchema.safeParse(parsed.data.state);
        if (next.success) setState(next.data);
        setRegisterOnline(parsed.data.found && parsed.data.register_online !== false);
        setProblem("");
      } catch {
        if (alive) setProblem("Reconnecting…");
      }
    }
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 900);
    return () => { alive = false; window.clearInterval(timer); };
  }, [key]);

  const respond = useCallback(async (answer: Record<string, unknown>) => {
    setAnswered(String(answer.request_id ?? ""));
    try {
      const response = await fetch("/api/pos/display", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "respond", key, answer }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error();
    } catch {
      setAnswered("");
      setProblem("That didn't go through. Please tap again.");
    }
  }, [key]);

  if (choosing || !key) return <RegisterPicker current={key} onPick={(value) => { saveKey(value); setKey(value); setChoosing(false); }} />;

  const waitingOnRegister = answered && answered === state.request_id;

  return <div className="relative flex min-h-screen flex-col bg-wayne-cream text-wayne-ink">
    <button aria-label="Screen settings" className="absolute right-2 top-2 z-10 size-10 rounded-full text-xl text-wayne-muted opacity-40 hover:opacity-100" onClick={() => setChoosing(true)} type="button">⚙</button>
    {problem || !registerOnline ? <p className="absolute left-2 top-2 rounded-full bg-white/80 px-3 py-1 text-xs font-bold text-wayne-muted">{problem || "Waiting for the register…"}</p> : null}

    {state.phase === "idle" ? <Welcome storeName={storeName} />
      : state.phase === "tip" && !waitingOnRegister ? <TipChooser onAnswer={(tip) => { void respond({ request_id: state.request_id, kind: "tip", tip_cents: tip }); }} state={state} />
      : state.phase === "sign" && !waitingOnRegister ? <SignaturePad onAnswer={(svg) => { void respond({ request_id: state.request_id, kind: "signature", signature_svg: svg }); }} state={state} />
      : state.phase === "thanks" ? <Thanks state={state} storeName={storeName} />
      : waitingOnRegister ? <Centered><p className="text-4xl font-black">Thank you!</p><p className="mt-3 text-2xl">{state.phase === "tip" ? "Please follow the card reader." : "One moment…"}</p></Centered>
      : <OrderView state={state} />}
  </div>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">{children}</div>;
}

function Welcome({ storeName }: { storeName: string }) {
  return <Centered>
    <p className="text-sm font-black uppercase tracking-[0.3em] text-wayne-green">Welcome to</p>
    <p className="mt-2 text-6xl font-black leading-tight text-wayne-green">{storeName}</p>
    <p className="mt-6 text-2xl text-wayne-muted">Your order will show here.</p>
  </Centered>;
}

function Totals({ state, big = true }: { state: DisplayState; big?: boolean }) {
  const row = (label: string, cents: number, show = true) => show ? <div className="flex justify-between gap-4 py-1 text-xl"><span>{label}</span><span className="tabular-nums">{formatCents(cents)}</span></div> : null;
  const breakdown = state.subtotal_cents > 0;
  return <div>
    {row("Subtotal", state.subtotal_cents, breakdown)}
    {row("Discount", -state.discount_cents, breakdown && state.discount_cents > 0)}
    {row("Delivery", state.delivery_fee_cents, breakdown && state.delivery_fee_cents > 0)}
    {row("Tax", state.tax_cents, breakdown)}
    {row("Tip", state.tip_cents, state.tip_cents > 0)}
    <div className={`mt-2 flex justify-between gap-4 border-t-2 border-wayne-ink pt-3 font-black ${big ? "text-5xl" : "text-3xl"}`}><span>Total</span><span className="tabular-nums">{formatCents(state.total_cents)}</span></div>
  </div>;
}

function OrderView({ state }: { state: DisplayState }) {
  return <div className="grid flex-1 gap-4 p-4 md:grid-cols-[1fr_24rem] md:p-6">
    <section className="min-h-0 overflow-y-auto rounded-3xl bg-white p-5 shadow-sm">
      <h1 className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Your order{state.order_number ? ` · #${state.order_number.replace(/^W0*/, "")}` : ""}</h1>
      {state.lines.length ? <ul className="mt-3 divide-y divide-wayne-border">{state.lines.map((line, index) => <li className="flex justify-between gap-4 py-3" key={`${line.name}-${index}`}>
        <div className="min-w-0"><p className="text-2xl font-black">{line.quantity > 1 ? `${line.quantity} × ` : ""}{line.name}</p>{line.detail ? <p className="text-base text-wayne-muted">{line.detail}</p> : null}</div>
        <p className="text-2xl font-bold tabular-nums">{formatCents(line.cents)}</p>
      </li>)}</ul> : <p className="mt-6 text-2xl text-wayne-muted">{state.phase === "pay" ? "Ready to pay." : "Adding items…"}</p>}
    </section>
    <section className="flex flex-col justify-end rounded-3xl bg-white p-5 shadow-sm">
      {state.message ? <p className="mb-4 text-2xl font-bold">{state.message}</p> : null}
      <Totals state={state} />
    </section>
  </div>;
}

function TipChooser({ state, onAnswer }: { state: DisplayState; onAnswer: (tipCents: number) => void }) {
  const [custom, setCustom] = useState<string | null>(null);
  const base = state.tip_base_cents || state.total_cents;
  if (custom !== null) {
    const cents = custom ? Number.parseInt(custom, 10) : 0;
    const press = (key: string) => setCustom((value) => key === "back" ? (value ?? "").slice(0, -1) : ((value ?? "") + key).replace(/^0+/, "").slice(0, 6));
    return <Centered>
      <p className="text-3xl font-black">Enter a tip</p>
      <p className="mt-3 text-6xl font-black tabular-nums">{formatCents(cents)}</p>
      <div className="mt-6 grid w-full max-w-md grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "back"].map((key) => <button className="min-h-20 rounded-2xl bg-white text-3xl font-black shadow-sm active:translate-y-px" key={key} onClick={() => press(key)} type="button">{key === "back" ? "⌫" : key}</button>)}
      </div>
      <div className="mt-4 grid w-full max-w-md grid-cols-2 gap-3">
        <button className="min-h-16 rounded-2xl border-2 border-wayne-border bg-white text-xl font-black" onClick={() => setCustom(null)} type="button">Back</button>
        <button className="min-h-16 rounded-2xl bg-wayne-green text-xl font-black text-white" onClick={() => onAnswer(cents)} type="button">Add {formatCents(cents)}</button>
      </div>
    </Centered>;
  }
  return <Centered>
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Order total {formatCents(base)}</p>
    <p className="mt-2 text-5xl font-black">Add a tip?</p>
    <div className="mt-8 grid w-full max-w-3xl grid-cols-2 gap-4 md:grid-cols-4">
      {state.tip_percentages.slice(0, 4).map((percent) => <button className="flex min-h-32 flex-col items-center justify-center rounded-3xl bg-wayne-green text-white shadow-md active:scale-[0.98]" key={percent} onClick={() => onAnswer(tipFromPercent(base, percent))} type="button">
        <span className="text-4xl font-black">{percent}%</span>
        <span className="mt-1 text-xl font-bold text-white/85">{formatCents(tipFromPercent(base, percent))}</span>
      </button>)}
    </div>
    <div className="mt-4 grid w-full max-w-3xl grid-cols-2 gap-4">
      <button className="min-h-20 rounded-3xl border-2 border-wayne-green bg-white text-2xl font-black text-wayne-green" onClick={() => setCustom("")} type="button">Custom amount</button>
      <button className="min-h-20 rounded-3xl border-2 border-wayne-border bg-white text-2xl font-black text-wayne-muted" onClick={() => onAnswer(0)} type="button">No tip</button>
    </div>
  </Centered>;
}

function SignaturePad({ state, onAnswer }: { state: DisplayState; onAnswer: (svg: string) => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const strokes = useRef<Array<Array<[number, number]>>>([]);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = element.clientWidth * ratio;
    element.height = element.clientHeight * ratio;
    const context = element.getContext("2d");
    if (context) { context.scale(ratio, ratio); context.lineWidth = 3; context.lineCap = "round"; context.lineJoin = "round"; context.strokeStyle = "#111"; }
  }, []);

  function point(event: ReactPointerEvent<HTMLCanvasElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }
  function down(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const [x, y] = point(event);
    strokes.current.push([[x, y]]);
    const context = canvas.current?.getContext("2d");
    context?.beginPath(); context?.moveTo(x, y);
  }
  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const [x, y] = point(event);
    strokes.current[strokes.current.length - 1]!.push([x, y]);
    const context = canvas.current?.getContext("2d");
    context?.lineTo(x, y); context?.stroke();
    if (!hasInk) setHasInk(true);
  }
  function up() { drawing.current = false; }
  function clear() {
    strokes.current = [];
    const element = canvas.current;
    element?.getContext("2d")?.clearRect(0, 0, element.width, element.height);
    setHasInk(false);
  }
  function done() {
    const element = canvas.current;
    if (!element || !hasInk) return;
    onAnswer(signatureSvg(strokes.current, element.clientWidth, element.clientHeight));
  }

  return <div className="flex flex-1 flex-col p-4 md:p-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="text-4xl font-black">Please sign</p>
      <p className="text-3xl font-black tabular-nums">Total {formatCents(state.total_cents)}</p>
    </div>
    <canvas className="mt-4 min-h-64 w-full flex-1 touch-none rounded-3xl border-4 border-dashed border-wayne-border-strong bg-white" onPointerCancel={up} onPointerDown={down} onPointerLeave={up} onPointerMove={move} onPointerUp={up} ref={canvas} />
    <div className="mt-4 grid grid-cols-2 gap-4">
      <button className="min-h-20 rounded-3xl border-2 border-wayne-border bg-white text-2xl font-black" onClick={clear} type="button">Clear</button>
      <button className="min-h-20 rounded-3xl bg-wayne-green text-2xl font-black text-white disabled:opacity-40" disabled={!hasInk} onClick={done} type="button">Done</button>
    </div>
  </div>;
}

function Thanks({ state, storeName }: { state: DisplayState; storeName: string }) {
  return <Centered>
    <p className="text-6xl font-black text-wayne-green">Thank you!</p>
    {state.change_cents !== null && state.change_cents > 0 ? <p className="mt-6 text-4xl font-black">Your change: {formatCents(state.change_cents)}</p> : null}
    <p className="mt-6 text-2xl text-wayne-muted">{state.message || `Enjoy your food from ${storeName}.`}</p>
  </Centered>;
}

function RegisterPicker({ current, onPick }: { current: string; onPick: (key: string) => void }) {
  const [registers, setRegisters] = useState<string[]>([]);
  const [typed, setTyped] = useState(current);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const response = await fetch("/api/pos/display", { cache: "no-store" });
        const body: unknown = await response.json();
        if (alive && Array.isArray(body)) setRegisters(body.map((row) => (row && typeof row === "object" && "display_key" in row ? String((row as { display_key: unknown }).display_key) : "")).filter(Boolean));
      } catch { /* keep the list */ }
    }
    void load();
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return <div className="flex min-h-screen items-center justify-center bg-wayne-cream-deep p-6">
    <section className="w-full max-w-xl rounded-3xl bg-white p-6 shadow-xl">
      <h1 className="text-3xl font-black">Customer screen</h1>
      <p className="mt-2 text-wayne-muted">Which register does this screen face? Registers show up here once they are open (their name is in POS → More → This register).</p>
      <div className="mt-4 grid gap-2">
        {registers.map((name) => <button className={`min-h-16 rounded-2xl border-2 px-4 text-left text-xl font-black ${name === current ? "border-wayne-green bg-wayne-green/5" : "border-wayne-border"}`} key={name} onClick={() => onPick(name)} type="button">🖥 {name}</button>)}
        {!registers.length ? <p className="rounded-2xl bg-wayne-cream p-4 text-sm font-bold">No register found yet. Open the POS on the counter tablet, then wait a few seconds.</p> : null}
      </div>
      <form className="mt-4 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (typed.trim()) onPick(typed.trim()); }}>
        <input className="min-h-12 flex-1 rounded-xl border border-wayne-border px-3" onChange={(event) => setTyped(event.target.value)} placeholder="Or type the register name" value={typed} />
        <button className="min-h-12 rounded-xl bg-wayne-green px-4 font-black text-white" type="submit">Use</button>
      </form>
      <button className="mt-4 min-h-12 w-full rounded-xl border border-wayne-border font-bold" onClick={() => { void document.documentElement.requestFullscreen?.().catch(() => undefined); }} type="button">Full screen</button>
    </section>
  </div>;
}
