import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/access";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getPrintQueue } from "@/lib/printing/queries";
import { retryPrintJob } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Print queue" };

export default async function PrintingPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; view?: string }> }) {
  await requirePermission("printing.manage", "/admin/printing");
  const params = await searchParams;
  const { jobs, unavailable: error, readAt } = await getPrintQueue(params.view === "printed");
  return <main className="mx-auto max-w-6xl px-5 py-10"><p className="text-sm font-black uppercase tracking-widest text-wayne-red">Kitchen operations</p><h1 className="mt-3 text-4xl font-black">Print queue</h1>
    <p className="mt-3 max-w-3xl text-wayne-muted">Kitchen tickets (every order) and online order slips wait here until the register switched to <strong>Print station</strong> prints them. While a printer isn&apos;t answering they stay pending and print when it&apos;s back. Anything more than an hour old, or whose print result is unknown, is held here for you to check before reprinting.</p>
    <div className="mt-5 flex flex-wrap gap-3"><Button asChild variant="secondary"><Link href="/admin/printing">Pending & exceptions</Link></Button><Button asChild variant="secondary"><Link href="/admin/printing?view=printed">Printed history</Link></Button><Button asChild variant="secondary"><Link href="/kitchen">Open kitchen</Link></Button></div>
    <p className="mt-4 text-sm text-wayne-muted">Showing up to 200 jobs. Refresh this page for the latest printer status.</p>
    {params.saved ? <p role="status" className="mt-5 rounded-xl bg-wayne-ok-soft p-4">Job returned to the pending queue. Retry reason recorded.</p> : null}
    {params.error || error ? <p role="alert" className="mt-5 rounded-xl bg-wayne-alert-soft p-4">{params.error || "Print queue unavailable. Check the database migrations and connection."}</p> : null}
    <div className="mt-6 grid gap-4">{jobs?.map((job) => {
      const expired = job.status === "processing" && job.lease_expires_at !== null && new Date(job.lease_expires_at).getTime() <= readAt;
      const orderNumber = typeof job.payload.order_number === "string" ? job.payload.order_number : job.order_id;
      return <Card className="p-5" key={job.id}><div className="flex flex-wrap justify-between gap-4"><div><Link className="text-xl font-black underline" href={`/admin/orders/${job.order_id}`}>{orderNumber}</Link><p>{job.job_type === "online_order" ? "Online order slip · receipt printer" : `Kitchen ticket · ${job.destination}`} · {job.attempts} attempt{job.attempts === 1 ? "" : "s"}</p></div><strong className="capitalize">{expired ? "Needs inspection — expired lease" : job.status}</strong></div>
      {job.last_error ? <p className="mt-3 text-sm text-wayne-alert">Last error: {job.last_error}</p> : null}
      {job.status === "failed" || expired ? <form action={retryPrintJob} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]"><input name="id" type="hidden" value={job.id} /><Input label="Retry reason" name="reason" required minLength={3} maxLength={500} /><Button className="self-end">Retry job</Button><label className="flex items-start gap-2 text-sm sm:col-span-2"><input name="inspected" type="checkbox" required className="mt-1" />I checked the printer and understand that retrying a ticket already printed can produce a duplicate.</label></form> : null}</Card>;
    })}{jobs?.length === 0 ? <Card className="p-8 text-center">No print jobs in this view.</Card> : null}</div>
  </main>;
}
