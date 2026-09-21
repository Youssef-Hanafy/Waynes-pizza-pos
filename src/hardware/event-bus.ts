import type { HardwareEvent } from "./types";

type Listener<E> = (event: E) => void;

/**
 * The single place hardware events enter the POS (§5).
 *
 *   provider → hardware event bus → stores → screens
 *
 * Synchronous and in-memory: a ring shows the moment a provider reports it,
 * with no round trip (§55).  A listener that throws is logged and skipped so
 * one broken screen cannot stop the phone store hearing a call.
 */
export function createHardwareEventBus() {
  const listeners = new Set<Listener<HardwareEvent>>();

  function emit(event: HardwareEvent) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("[hardware-bus] listener failed", error);
      }
    }
  }

  function subscribe(listener: Listener<HardwareEvent>) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function on<T extends HardwareEvent["type"]>(type: T, listener: Listener<Extract<HardwareEvent, { type: T }>>) {
    return subscribe((event) => {
      if (event.type === type) listener(event as Extract<HardwareEvent, { type: T }>);
    });
  }

  return { emit, subscribe, on, listenerCount: () => listeners.size };
}

export type HardwareEventBus = ReturnType<typeof createHardwareEventBus>;

/** The POS's one bus. Tests create their own with createHardwareEventBus(). */
export const hardwareEventBus = createHardwareEventBus();
