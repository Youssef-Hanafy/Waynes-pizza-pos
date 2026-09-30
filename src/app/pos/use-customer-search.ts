"use client";

import { useEffect, useState } from "react";
import { posCustomerSchema, type PosCustomer } from "@/lib/pos/schemas";

export type CustomerSearchState = {
  results: PosCustomer[];
  /** A request is in flight for the latest text. */
  busy: boolean;
  /** Set when the lookup itself failed (not when nothing matched). */
  error: string;
  /** The text the current results belong to ("" before any search ran). */
  searched: string;
};

/** Enough to be worth asking: two letters of a name, or three digits of a phone. */
export function isSearchable(query: string) {
  const text = query.trim();
  const digits = text.replace(/\D/g, "");
  return digits.length >= 3 || text.replace(/[^a-z]/gi, "").length >= 2 || text.length >= 3;
}

/**
 * Search customers while the cashier types (owner, 2026-09-30: matches should
 * appear as you type the name or number, not after pressing Find).
 *
 * Waits for a short pause in typing, cancels the previous request when the
 * text changes, and ignores any answer that arrives for older text, so the
 * list always matches what is in the box.
 */
export function useCustomerSearch(query: string, options: { delayMs?: number; enabled?: boolean } = {}): CustomerSearchState {
  const { delayMs = 250, enabled = true } = options;
  const [state, setState] = useState<CustomerSearchState>({ results: [], busy: false, error: "", searched: "" });
  const text = query.trim();
  const active = enabled && isSearchable(text);

  useEffect(() => {
    if (!active) {
      const reset = window.setTimeout(() => setState({ results: [], busy: false, error: "", searched: "" }), 0);
      return () => window.clearTimeout(reset);
    }
    const controller = new AbortController();
    const mark = window.setTimeout(() => setState((current) => ({ ...current, busy: true })), 0);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/pos/customers?q=${encodeURIComponent(text.slice(0, 100))}`, { cache: "no-store", signal: controller.signal });
        const body: unknown = await response.json().catch(() => null);
        const parsed = posCustomerSchema.array().safeParse(body);
        if (controller.signal.aborted) return;
        if (!response.ok || !parsed.success) {
          const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "Customer lookup failed.";
          setState({ results: [], busy: false, error: message, searched: text });
          return;
        }
        setState({ results: parsed.data, busy: false, error: "", searched: text });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setState({ results: [], busy: false, error: cause instanceof TypeError ? "No connection. Matches will show when it is back." : "Customer lookup failed.", searched: text });
      }
    }, delayMs);
    return () => { controller.abort(); window.clearTimeout(timer); window.clearTimeout(mark); };
  }, [active, delayMs, text]);

  return active ? state : { results: [], busy: false, error: "", searched: "" };
}
