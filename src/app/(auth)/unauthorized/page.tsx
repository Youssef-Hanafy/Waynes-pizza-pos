import Link from "next/link";
import { Card } from "@/components/ui/card";

export default function UnauthorizedPage() {
  return (
    <main className="mx-auto grid min-h-screen max-w-lg place-items-center px-6">
      <Card className="p-8 text-center">
        <p className="text-sm font-bold uppercase tracking-widest text-wayne-red">Access denied</p>
        <h1 className="mt-3 text-3xl font-black">Your role cannot open this area.</h1>
        <p className="mt-3 text-wayne-muted">Ask an owner to review your assigned role.</p>
        <Link className="mt-6 inline-block font-bold text-wayne-red underline" href="/">Return home</Link>
      </Card>
    </main>
  );
}
