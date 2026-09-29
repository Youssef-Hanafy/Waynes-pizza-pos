"use client";

import { useEffect, useRef, useState } from "react";
import type { CheckoutPaymentConfig } from "@/lib/payments/schemas";

type StripeCard = { mount(target: HTMLElement | string): void; unmount(): void };
type StripeResult = { error?: { message?: string }; paymentIntent?: { status?: string } };
type StripeClient = {
  elements(): { create(type: "card", options?: unknown): StripeCard };
  confirmCardPayment(clientSecret: string, input: { payment_method: { card: StripeCard; billing_details: { name: string; email?: string; phone?: string; address?: { postal_code?: string } } } }): Promise<StripeResult>;
};
declare global { interface Window { Stripe?: (publishableKey: string) => StripeClient } }

export type StripeCardConfirm = (input: { clientSecret: string; name: string; email?: string; phone?: string; postalCode?: string }) => Promise<StripeResult>;

let sdkPromise: Promise<void> | null = null;
function loadStripeSdk() {
  if (typeof window === "undefined") return Promise.reject(new Error("No browser"));
  if (window.Stripe) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://js.stripe.com/v3/";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { sdkPromise = null; reject(new Error("Secure card entry could not load.")); };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/** Stripe owns this iframe; card numbers never enter the application. */
export function StripeCardField({ config, onReady, onStatus }: {
  config: Extract<CheckoutPaymentConfig, { provider: "stripe" }>;
  onReady: (confirm: StripeCardConfirm | null) => void;
  onStatus?: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let card: StripeCard | null = null;
    void (async () => {
      try {
        await loadStripeSdk();
        if (cancelled || !container.current || !window.Stripe) return;
        const stripe = window.Stripe(config.publishable_key);
        card = stripe.elements().create("card", { hidePostalCode: true });
        card.mount(container.current);
        if (cancelled) { card.unmount(); return; }
        setLoaded(true);
        onReady(async ({ clientSecret, name, email, phone, postalCode }) => stripe.confirmCardPayment(clientSecret, {
          payment_method: { card: card!, billing_details: { name, email, phone, address: postalCode ? { postal_code: postalCode } : undefined } },
        }));
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "Secure card entry could not load.";
        setError(message);
        onStatus?.(message);
        onReady(null);
      }
    })();
    return () => { cancelled = true; onReady(null); card?.unmount(); };
  }, [config.publishable_key, onReady, onStatus]);

  return <div>
    <div aria-label="Card details" className="min-h-14 rounded-xl border border-wayne-border bg-white p-3" ref={container} />
    {!loaded && !error ? <p className="mt-2 text-sm text-wayne-muted">Loading secure card entry…</p> : null}
    {error ? <p className="mt-2 text-sm font-bold text-wayne-alert" role="alert">{error}</p> : null}
    <p className="mt-2 text-xs text-wayne-muted">Card details are entered directly with Stripe. Wayne&apos;s never sees or stores your card number.</p>
  </div>;
}
