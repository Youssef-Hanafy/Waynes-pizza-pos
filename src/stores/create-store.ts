import { useSyncExternalStore } from "react";

/**
 * A tiny external store: state outside React so hardware events can reach it
 * from anywhere (the event bus, a timer, a Realtime callback), and components
 * re-render only when the slice they read changes.
 */
export function createStore<S>(initial: S) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: S | ((current: S) => S)) {
      const value = typeof next === "function" ? (next as (current: S) => S)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type Store<S> = ReturnType<typeof createStore<S>>;

export function useStore<S, T>(store: Store<S>, select: (state: S) => T, serverState?: S): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(serverState ?? store.get()),
  );
}
