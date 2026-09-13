"use client";

import { type FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

export function LoginForm({ initialError, nextPath }: { initialError: string; nextPath: string }) {
  const router = useRouter();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialError);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");

    if (!supabase) {
      setError("Supabase is not configured for this environment.");
      setPending(false);
      return;
    }

    const result = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (result.error) {
      setError(result.error.message);
      setPending(false);
      return;
    }

    router.replace(nextPath);
    router.refresh();
  }

  return (
    <form className="mt-7 grid gap-5" onSubmit={handleSubmit}>
      <Input autoComplete="email" label="Email" name="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
      <Input autoComplete="current-password" label="Password" name="password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
      {error ? <p className="rounded-lg bg-wayne-alert-soft p-3 text-sm font-semibold text-wayne-alert" role="alert">{error}</p> : null}
      <Button disabled={pending} type="submit">{pending ? "Signing in…" : "Sign in"}</Button>
    </form>
  );
}
