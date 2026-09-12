"use client";

import { useEffect, useRef, useState } from "react";
import { squareWebSdkUrl, type CheckoutPaymentConfig } from "@/lib/payments/schemas";

type TokenizeResult = { token: string; verificationToken: string | null };
export type Tokenizer = (verification: { amountCents: number; billingPostalCode?: string }) => Promise<TokenizeResult>;

type SquareTokenResponse = { status: string; token?: string; errors?: Array<{ message?: string }> };
type SquareCardInstance = {
  attach(target: HTMLElement | string): Promise<void>;
  tokenize(details?: unknown): Promise<SquareTokenResponse>;
  destroy(): Promise<void>;
};
type SquarePayments = {
  card(options?: unknown): Promise<SquareCardInstance>;
  verifyBuyer(token: string, details: unknown): Promise<{ token?: string } | null>;
};
declare global {
  interface Window { Square?: { payments(applicationId: string, locationId: string): SquarePayments } }
}

let sdkPromise: Promise<void> | null = null;
function loadSquareSdk(environment: string) {
  if (typeof window === "undefined") return Promise.reject(new Error("No browser"));
  if (window.Square) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = squareWebSdkUrl(environment);
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { sdkPromise = null; reject(new Error("Card payment could not load.")); };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/**
 * Hosts the processor's own card fields. Card numbers are entered inside the
 * provider's iframe and never touch this application, this browser's form state, or
 * Wayne's database — the server only ever sees a single-use token.
 */
export function SquareCardField({ config, onReady, onStatus }: {
  config: CheckoutPaymentConfig;
  onReady: (tokenizer: Tokenizer | null) => void;
  onStatus?: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let card: SquareCardInstance | null = null;

    async function mount() {
      try {
        await loadSquareSdk(config.environment);
        if (cancelled || !container.current || !window.Square) return;
        const payments = window.Square.payments(config.application_id, config.location_id);
        card = await payments.card();
        if (cancelled) { await card.destroy().catch(() => undefined); return; }
        await card.attach(container.current);
        if (cancelled) return;
        setLoaded(true);
        onReady(async ({ amountCents, billingPostalCode }) => {
          if (!card) throw new Error("Card entry is not ready yet.");
          const result = await card.tokenize(
            billingPostalCode ? { billingContact: { postalCode: billingPostalCode } } : undefined,
          );
          if (result.status !== "OK" || !result.token) {
            throw new Error(result.errors?.[0]?.message ?? "Check the card details and try again.");
          }
          // Buyer verification (3-D Secure where the card requires it). A provider
          // that cannot verify still returns the payment token; the charge decides.
          let verificationToken: string | null = null;
          try {
            const verification = await payments.verifyBuyer(result.token, {
              amount: (amountCents / 100).toFixed(2),
              currencyCode: "USD",
              intent: "CHARGE",
              billingContact: billingPostalCode ? { postalCode: billingPostalCode } : {},
            });
            verificationToken = verification?.token ?? null;
          } catch {
            verificationToken = null;
          }
          return { token: result.token, verificationToken };
        });
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "Card payment could not load.";
        setError(message);
        onStatus?.(message);
        onReady(null);
      }
    }
    void mount();
    return () => {
      cancelled = true;
      onReady(null);
      if (card) void card.destroy().catch(() => undefined);
    };
    // The configuration is fixed for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.application_id, config.location_id, config.environment]);

  return (
    <div>
      <div aria-label="Card details" className="min-h-14 rounded-xl border border-wayne-border bg-white p-3" ref={container} />
      {!loaded && !error ? <p className="mt-2 text-sm text-wayne-muted">Loading secure card entry…</p> : null}
      {error ? <p className="mt-2 text-sm font-bold text-red-800" role="alert">{error}</p> : null}
      <p className="mt-2 text-xs text-wayne-muted">Card details are entered directly with Wayne&apos;s payment processor. Wayne&apos;s never sees or stores your card number.</p>
    </div>
  );
}
