"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Unhandled application error", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-6">
      <section className="rounded-2xl border border-wayne-border bg-white p-8 shadow-sm" role="alert">
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="mt-3 text-wayne-muted">The error was recorded. Try the request again.</p>
        <Button className="mt-6" onClick={reset}>Try again</Button>
      </section>
    </main>
  );
}
