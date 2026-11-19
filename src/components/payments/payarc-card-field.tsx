"use client";

import { useEffect, useRef, useState } from "react";
import type { CheckoutPaymentConfig } from "@/lib/payments/schemas";
import type { Tokenizer } from "./square-card-field";
import { payarcFieldsDocument } from "@/lib/payments/payarc-fields";
import { uuid } from "@/lib/uuid";

export function PayarcCardField({ config, onReady, onStatus }: {
  config: Extract<CheckoutPaymentConfig, { provider: "payarc" }>;
  onReady: (tokenizer: Tokenizer | null) => void; onStatus?: (message: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [document, setDocument] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const channel = uuid();
    let pending: { resolve: (value: { token: string; verificationToken: null }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
    function message(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin || event.data?.channel !== channel) return;
      if (event.data.type === "ready") {
        onReady(() => new Promise((resolve, reject) => {
          if (pending) { reject(new Error("Card entry is already processing.")); return; }
          const timer = setTimeout(() => { pending = null; reject(new Error("Card entry timed out. Check the details and try again.")); }, 30_000);
          pending = { resolve, reject, timer };
          frame.current?.contentWindow?.postMessage({ channel, type: "tokenize" }, window.location.origin);
        }));
      } else if (event.data.type === "token" && typeof event.data.token === "string" && pending) {
        clearTimeout(pending.timer); pending.resolve({ token: event.data.token, verificationToken: null }); pending = null;
      } else if (event.data.type === "error") {
        const text = typeof event.data.message === "string" ? event.data.message : "Check the card details.";
        if (pending) { clearTimeout(pending.timer); pending.reject(new Error(text)); pending = null; }
        setError(text); onStatus?.(text);
      }
    }
    window.addEventListener("message", message);
    queueMicrotask(() => setDocument(payarcFieldsDocument(config.client_id, config.environment, channel, window.location.origin)));
    return () => { window.removeEventListener("message", message); onReady(null); if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Card entry closed.")); } };
  }, [config.client_id, config.environment, onReady, onStatus]);
  return <div><iframe className="h-80 w-full rounded-xl border border-wayne-border bg-white p-2" ref={frame} srcDoc={document || undefined} title="Secure Payarc card details" />{error ? <p role="alert" className="text-sm font-bold text-wayne-alert">{error}</p> : null}<p className="mt-2 text-xs text-wayne-muted">Card details go directly to Payarc. Wayne&apos;s receives a payment token.</p></div>;
}
