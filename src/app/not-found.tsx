import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div>
        <p className="text-sm font-bold uppercase tracking-widest text-wayne-red">404</p>
        <h1 className="mt-3 text-3xl font-black">Page not found</h1>
        <Link className="mt-6 inline-block font-semibold text-wayne-red underline" href="/">Return home</Link>
      </div>
    </main>
  );
}
