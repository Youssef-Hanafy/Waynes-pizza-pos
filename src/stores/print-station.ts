"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPrintDocument, type PrinterConfig, type PrinterProvider } from "@/hardware/printers/provider";
import type { PrinterAdapter } from "@/lib/printing/adapter";
import { createKitchenStationAdapter, createOnlineOrderStationAdapter, createStationRepository } from "@/lib/printing/station";
import { createSupabasePrintQueueRepository } from "@/lib/printing/supabase-repository";
import { processNextPrintJob } from "@/lib/printing/worker";
import { createStore, useStore } from "./create-store";
import { getDeviceId } from "./draft-sync";

/**
 * PRINT STATION (Phase 7).  Exactly one register — the Android app at the
 * counter, next to both printers' network — is switched to "Print station".
 * It prints, as they arrive:
 *   • a kitchen ticket for every order, on the kitchen printer (TM-U220B)
 *   • an order slip + tip & signature slip for every online order, on the
 *     receipt printer (TM-T20III)
 *
 * It is woken by Realtime the moment a job is queued, and checks every 20 s
 * as a safety net.  Several registers switched on by mistake can't double
 * print: the database hands each job to one of them only (row lock + lease).
 */

const STATION_KEY = "wayne.pos.printStation";
const POLL_MS = 20_000;
const OFFLINE_BACKOFF_MS = 30_000;
const JOB_TIMEOUT_MS = 45_000; // below the database's 2-minute lease

export type StationLane = "kitchen" | "receipt";
type LaneState = { state: "off" | "ready" | "printing" | "waiting_printer" | "error"; detail: string; printed: number; lastAt: string | null };
export type PrintStationState = { enabled: boolean; running: boolean; lanes: Record<StationLane, LaneState> };

const lane = (): LaneState => ({ state: "off", detail: "", printed: 0, lastAt: null });
const serverSnapshot: PrintStationState = { enabled: false, running: false, lanes: { kitchen: lane(), receipt: lane() } };
export const printStationStore = createStore<PrintStationState>(serverSnapshot);

export function isPrintStationDevice(): boolean {
  try {
    return window.localStorage.getItem(STATION_KEY) === "on";
  } catch {
    return false;
  }
}

export function setPrintStationDevice(on: boolean) {
  try {
    if (on) window.localStorage.setItem(STATION_KEY, "on");
    else window.localStorage.removeItem(STATION_KEY);
  } catch {
    // Without storage the switch lasts until the page reloads.
  }
  printStationStore.set((state) => ({ ...state, enabled: on }));
}

function setLane(name: StationLane, patch: Partial<LaneState>) {
  printStationStore.set((state) => ({ ...state, lanes: { ...state.lanes, [name]: { ...state.lanes[name], ...patch } } }));
}

type LaneSetup = { name: StationLane; destination: string; printer: PrinterConfig; provider: PrinterProvider };

function ready(config: PrinterConfig) {
  return config.enabled && config.protocol === "escpos" && Boolean(config.ip && config.port);
}

/**
 * Starts the station on this register.  Returns a stop function.  Does
 * nothing (and says why) outside the Android app or with a printer off.
 */
export function startPrintStation(options: {
  client: SupabaseClient;
  receipt: { config: PrinterConfig; provider: PrinterProvider };
  kitchen: { config: PrinterConfig; provider: PrinterProvider };
}): () => void {
  const workerId = `station-${getDeviceId()}`.slice(0, 100);
  const base = createSupabasePrintQueueRepository(options.client);
  const release = async (job: { id: string; lease_token: string }, reason: string) => {
    const { error } = await options.client.rpc("wayne_release_print_job", { target_job_id: job.id, target_lease_token: job.lease_token, release_reason: reason.slice(0, 500) });
    if (error) throw new Error("The print job could not be handed back. It will show in Admin → Printing.");
  };
  const native = typeof window !== "undefined" && Boolean(window.WaynesNativeHardware?.printer);

  const lanes: (LaneSetup & { adapter: PrinterAdapter; station: ReturnType<typeof createStationRepository>; pausedUntil: number; busy: boolean })[] = [];
  const setups: LaneSetup[] = [
    { name: "kitchen", destination: "kitchen", printer: options.kitchen.config, provider: options.kitchen.provider },
    { name: "receipt", destination: "receipt", printer: options.receipt.config, provider: options.receipt.provider },
  ];
  for (const setup of setups) {
    if (!native) { setLane(setup.name, { state: "off", detail: "Printing runs in the Wayne's POS Android app." }); continue; }
    if (!ready(setup.printer)) { setLane(setup.name, { state: "off", detail: "Printer is off or has no IP address (Admin → Hardware)." }); continue; }
    const station = createStationRepository(base, release);
    const adapter = setup.name === "kitchen"
      ? createKitchenStationAdapter({ printer: setup.provider, routingCategories: setup.printer.routingCategories, loadDocument: fetchPrintDocument })
      : createOnlineOrderStationAdapter({ printer: setup.provider, tipSlip: setup.printer.tipSlip });
    lanes.push({ ...setup, adapter: station.watch(adapter), station, pausedUntil: 0, busy: false });
    setLane(setup.name, { state: "ready", detail: `${setup.printer.name || setup.name} at ${setup.printer.ip}` });
  }
  printStationStore.set((state) => ({ ...state, enabled: true, running: lanes.length > 0 }));
  if (!lanes.length) return () => printStationStore.set((state) => ({ ...state, running: false }));

  const controller = new AbortController();

  async function drain(entry: (typeof lanes)[number]) {
    if (entry.busy || controller.signal.aborted || Date.now() < entry.pausedUntil) return;
    entry.busy = true;
    try {
      // A burst (Friday night) drains in one go; the cap stops a runaway loop.
      for (let count = 0; count < 25 && !controller.signal.aborted; count += 1) {
        const result = await processNextPrintJob({
          repository: entry.station.repository, adapter: entry.adapter, destination: entry.destination,
          workerId, timeoutMs: JOB_TIMEOUT_MS, signal: controller.signal,
        });
        if (result.status === "idle") { entry.pausedUntil = 0; setLane(entry.name, { state: "ready", detail: `${entry.printer.name || entry.name} at ${entry.printer.ip}` }); break; }
        const offline = entry.station.takeOffline();
        if (offline) {
          entry.pausedUntil = Date.now() + OFFLINE_BACKOFF_MS;
          setLane(entry.name, { state: "waiting_printer", detail: `${offline} Tickets are waiting and will print when it answers.` });
          break;
        }
        entry.pausedUntil = 0;
        if (result.status === "printed") {
          setLane(entry.name, { state: "printing", detail: "Printing…", printed: printStationStore.get().lanes[entry.name].printed + 1, lastAt: new Date().toISOString() });
        } else {
          setLane(entry.name, { state: "error", detail: `${result.error} See Admin → Printing.` });
        }
      }
    } catch (error) {
      setLane(entry.name, { state: "error", detail: error instanceof Error ? error.message : "The print queue could not be reached." });
    } finally {
      entry.busy = false;
    }
  }

  const kick = () => { for (const entry of lanes) void drain(entry); };
  const channel = options.client
    .channel(`wayne-print-station-${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "print_jobs" }, kick)
    .subscribe((state) => { if (state === "SUBSCRIBED") kick(); });
  const poll = window.setInterval(kick, POLL_MS);
  const online = () => { for (const entry of lanes) entry.pausedUntil = 0; kick(); };
  window.addEventListener("online", online);
  kick();

  return () => {
    controller.abort();
    window.clearInterval(poll);
    window.removeEventListener("online", online);
    void options.client.removeChannel(channel);
    printStationStore.set((state) => ({ ...state, running: false }));
  };
}

export function usePrintStation() {
  return useStore(printStationStore, (state) => state, serverSnapshot);
}
