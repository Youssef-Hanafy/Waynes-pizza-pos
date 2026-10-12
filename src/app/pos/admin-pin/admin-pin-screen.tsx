"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PinPad } from "@/components/ui/pin-pad";
import { unlockAdminWithPin } from "./actions";

export function AdminPinScreen({ next }: { next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(pin: string) {
    setBusy(true); setError("");
    const result = await unlockAdminWithPin(pin).catch(() => ({ ok: false as const, error: "No connection. Try again." }));
    if (result.ok) { router.replace(next); return; }
    setBusy(false);
    setError(result.error);
  }

  return <main className="grid min-h-screen place-items-center bg-wayne-cream-deep p-4">
    <section className="w-full max-w-md rounded-3xl border border-wayne-border bg-white p-6 shadow-xl">
      <p className="mb-4 text-center text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Admin is locked</p>
      <PinPad busy={busy} error={error} note="Owner or manager only." onCancel={() => router.replace("/pos")} onSubmit={(pin) => void submit(pin)} submitLabel="Open Admin" title="Enter manager PIN" />
    </section>
  </main>;
}
