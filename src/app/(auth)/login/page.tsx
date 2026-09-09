import type { Metadata } from "next";
import { safeNextPath } from "@/lib/auth/routes";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Owner sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const nextPath = safeNextPath(typeof params.next === "string" ? params.next : null);
  const error = typeof params.error === "string" ? params.error : "";

  return (
    <main className="mx-auto grid min-h-screen max-w-lg place-items-center px-6 py-12">
      <section className="w-full rounded-2xl border border-wayne-border bg-white p-7 shadow-lg sm:p-10">
        <p className="text-sm font-black uppercase tracking-widest text-wayne-red">Wayne&apos;s Pizza</p>
        <h1 className="mt-3 text-3xl font-black">Staff sign in</h1>
        <p className="mt-2 text-wayne-muted">Use the account assigned by the owner.</p>
        <LoginForm initialError={error} nextPath={nextPath} />
      </section>
    </main>
  );
}
