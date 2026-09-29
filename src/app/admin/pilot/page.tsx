import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { pilotCheckSchema, pilotDecision, type PilotCheck } from "@/lib/pilot/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { recordPilotCheck } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Store pilot" };

const resultLabels = { pass: "Pass", fail: "Fail", not_applicable: "N/A" } as const;

/**
 * The store pilot (build sheet Phase 9): the new POS runs beside Thrive, every
 * check here is done for real in the store, and Thrive stays until this page
 * says GO.
 */
export default async function PilotPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const access = await requirePermission("admin.access", "/admin/pilot");
  const canRecord = hasPermission(access, "pilot.manage");
  const params = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pilot_checklist");
  const parsed = pilotCheckSchema.array().safeParse(data);
  const checks: PilotCheck[] = parsed.success ? parsed.data : [];
  const decision = pilotDecision(checks);
  const sections = [...new Set(checks.map((check) => check.section))];

  return <main className="mx-auto max-w-5xl px-5 py-10">
    <p className="text-sm font-black uppercase tracking-widest text-wayne-red">Go-live</p>
    <h1 className="mt-3 text-4xl font-black">Store pilot</h1>
    <p className="mt-3 max-w-3xl text-wayne-muted">Run the new POS beside Thrive and check each item in the store, for real. Thrive and its computers stay until this page says GO.</p>
    {params.error || error || !parsed.success ? <p className="mt-5 rounded-xl bg-wayne-alert-soft p-4" role="alert">{params.error || "The pilot checklist could not be read. Check that the latest database migration is applied."}</p> : null}

    <Card className={`mt-6 p-6 ${decision.go ? "border-wayne-ok bg-wayne-ok-soft" : ""}`}>
      <p className="text-sm font-black uppercase tracking-[0.2em]">{decision.go ? "Decision" : "Decision so far"}</p>
      <p className={`mt-1 text-4xl font-black ${decision.go ? "text-wayne-ok" : "text-wayne-red"}`}>{decision.go ? "GO — ready to retire Thrive" : "NO-GO — keep Thrive running"}</p>
      <p className="mt-2 font-bold">{decision.passed} of {decision.required} required checks passed{decision.failed.length ? ` · ${decision.failed.length} failed` : ""}.</p>
      {decision.failed.length ? <ul className="mt-2 list-disc pl-6 text-sm">{decision.failed.map((check) => <li key={check.key}><a className="underline" href={`#${check.key}`}>{check.label}</a></li>)}</ul> : null}
    </Card>

    {sections.map((section) => <section className="mt-8" key={section}>
      <h2 className="text-2xl font-black">{section}</h2>
      <div className="mt-3 grid gap-3">{checks.filter((check) => check.section === section).map((check) => <Card className="scroll-mt-24 p-4" id={check.key} key={check.key}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-bold">{check.label}{check.required ? "" : <span className="ml-2 text-xs font-bold text-wayne-muted">optional</span>}</p>
            {check.detail ? <p className="mt-1 text-sm text-wayne-muted">{check.detail}</p> : null}
            {check.result ? <p className="mt-1 text-xs font-bold text-wayne-muted">{resultLabels[check.result]}{check.checked_by ? ` · ${check.checked_by}` : ""}{check.checked_at ? ` · ${new Date(check.checked_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}{check.note ? ` · ${check.note}` : ""}</p> : null}
          </div>
          <span className={`rounded-full px-3 py-1 text-sm font-black ${check.result === "pass" ? "bg-wayne-ok text-white" : check.result === "fail" ? "bg-wayne-alert text-white" : "bg-wayne-cream"}`}>{check.result ? resultLabels[check.result] : "Not done"}</span>
        </div>
        {canRecord ? <form action={recordPilotCheck} className="mt-3 flex flex-wrap items-end gap-2">
          <input name="key" type="hidden" value={check.key} />
          <label className="grid min-w-48 flex-1 gap-1 text-sm font-bold" htmlFor={`note-${check.key}`}>Note<input className="min-h-11 rounded-xl border border-wayne-border px-3 font-normal" defaultValue={check.note} id={`note-${check.key}`} maxLength={1000} name="note" /></label>
          <Button name="result" size="sm" type="submit" value="pass">Pass</Button>
          <Button name="result" size="sm" type="submit" value="fail" variant="danger">Fail</Button>
          {!check.required ? <Button name="result" size="sm" type="submit" value="not_applicable" variant="secondary">N/A</Button> : null}
          {check.result ? <Button name="result" size="sm" type="submit" value="" variant="ghost">Clear</Button> : null}
        </form> : null}
      </Card>)}</div>
    </section>)}
  </main>;
}
