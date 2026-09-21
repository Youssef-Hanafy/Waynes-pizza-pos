"use client";

import type { HardwareEventBus } from "@/hardware/event-bus";
import type { HardwareRuntime } from "@/hardware/runtime";
import type { HardwareDevice, HardwareStatus } from "@/hardware/types";
import { createStore, useStore } from "./create-store";

/**
 * What every piece of hardware last said about itself (§29), plus the
 * connection state the POS needs to be honest about (§30).
 */
export type HardwareStoreState = {
  statuses: Partial<Record<HardwareDevice, HardwareStatus>>;
  online: boolean;
};

const serverSnapshot: HardwareStoreState = { statuses: {}, online: true };
export const hardwareStore = createStore<HardwareStoreState>(serverSnapshot);

let runtime: HardwareRuntime | null = null;

/** The running providers, for screens that need to act (the simulator, a print). */
export function getHardwareRuntime() {
  return runtime;
}

export function setHardwareRuntime(next: HardwareRuntime | null) {
  runtime = next;
}

export function connectHardwareStore(bus: HardwareEventBus) {
  const off = bus.on("hardware.status", ({ payload }) => {
    hardwareStore.set((state) => ({ ...state, statuses: { ...state.statuses, [payload.device]: payload.status } }));
  });
  const setOnline = () => hardwareStore.set((state) => ({ ...state, online: navigator.onLine }));
  setOnline();
  window.addEventListener("online", setOnline);
  window.addEventListener("offline", setOnline);
  return () => {
    off();
    window.removeEventListener("online", setOnline);
    window.removeEventListener("offline", setOnline);
  };
}

export function useHardwareState() {
  return useStore(hardwareStore, (state) => state, serverSnapshot);
}
