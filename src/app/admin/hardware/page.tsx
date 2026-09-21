import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requirePermission } from "@/lib/auth/access";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { printerModelKeys, printerModels } from "@/hardware/printers/models";
import { getHardwareSettings } from "@/lib/hardware/queries";
import { getPosMenu } from "@/lib/pos/queries";
import { saveHardwareSettings } from "./actions";
import { HardwareLive } from "./hardware-live";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Hardware" };

const providerLabels = {
  simulated: "Simulated — test calls only",
  cloud: "Store bridge (cloud) — scripts/callerid-bridge.mjs on a counter computer",
  android_native: "Android app — native caller ID listener (future)",
} as const;

/**
 * ADMIN → HARDWARE (build sheet §28, §64).  The one place real hardware will
 * be configured.  Until the Android app exists, caller ID runs on the
 * simulator (or the store bridge) and printers, drawer and terminal say
 * plainly that they are not connected.
 */
export default async function HardwarePage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requirePermission("hardware.manage", "/admin/hardware");
  const params = await searchParams;
  const [{ settings, unavailable }, menu] = await Promise.all([getHardwareSettings(), getPosMenu().catch(() => [])]);
  const receipt = settings.receipt_printer;
  const kitchen = settings.kitchen_printers[0] ?? {};
  const routed = new Set(kitchen.routing_categories ?? []);
  const drawer = settings.cash_drawer as { connection?: string; model?: string };

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <p className="text-sm font-black uppercase tracking-widest text-wayne-red">Setup</p>
    <h1 className="mt-3 text-4xl font-black">Hardware</h1>
    <p className="mt-3 max-w-3xl text-wayne-muted">Caller ID, printers, the cash drawer and the card terminal. The POS talks to all of them through one layer, so connecting the real equipment later changes nothing about how orders are taken.</p>
    {params.saved ? <p role="status" className="mt-5 rounded-xl bg-wayne-ok-soft p-4">{params.saved}</p> : null}
    {params.error || unavailable ? <p role="alert" className="mt-5 rounded-xl bg-wayne-alert-soft p-4">{params.error || "Hardware settings could not be read, so safe defaults are shown. Check that the latest database migration is applied."}</p> : null}

    <HardwareLive settings={settings} />

    <form action={saveHardwareSettings} className="mt-8 grid gap-6">
      <Card className="p-6">
        <h2 className="text-2xl font-black">Caller ID</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-bold" htmlFor="caller_id_provider">Caller ID provider
            <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={settings.caller_id_provider} id="caller_id_provider" name="caller_id_provider">
              {Object.entries(providerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <Input defaultValue={settings.caller_device_model} label="Device" name="caller_device_model" required />
          <Input defaultValue={settings.caller_line_count} hint="Wayne's has two physical lines." label="Lines" max={8} min={1} name="caller_line_count" required type="number" />
          <Input defaultValue={settings.call_expire_minutes} hint="An unanswered call card goes quiet after this long. It stays in Recent calls." label="Call card expires after (minutes)" max={240} min={1} name="call_expire_minutes" required type="number" />
          <Input defaultValue={settings.caller_udp_port} hint="CallerID.com factory default is 3520. Used by the Android app and the store bridge." label="UDP port" max={65535} min={1} name="caller_udp_port" required type="number" />
          <Input defaultValue={settings.caller_bind_address} hint="0.0.0.0 listens on every network the tablet is on." label="Bind address" name="caller_bind_address" required />
          <Input defaultValue={settings.caller_device_ip} hint="Optional. Leave blank to accept broadcasts from the box wherever it is on the LAN." label="Caller ID box IP" name="caller_device_ip" placeholder="Auto" />
          <label className="flex min-h-11 items-center gap-3 text-sm font-bold"><input className="h-5 w-5" defaultChecked={settings.simulator_enabled} name="simulator_enabled" type="checkbox" />Allow test calls from the simulator</label>
        </div>
        <p className="mt-4 text-sm text-wayne-muted">Protocol UDP · the box&apos;s DIP switches and factory settings are left as they are while Thrive still uses it. A web browser cannot listen for UDP, which is why real caller ID needs either the store bridge or the Android app.</p>
      </Card>

      <Card className="p-6">
        <h2 className="text-2xl font-black">Printers</h2>
        <p className="mt-1 text-sm text-wayne-muted">Wayne&apos;s has two Epson printers. The <strong>TM-T20III</strong> (thermal &quot;box&quot;) at the front prints customer receipts, every online order slip and its tip &amp; signature slip, and opens the cash drawer. The <strong>TM-U220B</strong> (impact, round top) prints kitchen tickets only. Both are on the network, port 9100. They&apos;re reached from the Wayne&apos;s POS Android app; a web browser cannot open a printer connection. Turn a printer on once its IP address is in, then press its test button below.</p>
        <div className="mt-5 grid gap-5">
          <PrinterPanel
            enabled={receipt.enabled ?? false}
            prefix="receipt"
            subtitle="Front counter · customer receipts, online order slips, tip & signature slips, cash drawer"
            title="Receipt & online orders"
          >
            <PrinterFields defaultPaper={80} namePlaceholder="Front receipt" printer={receipt} prefix="receipt" />
            <div className="grid gap-4 md:grid-cols-2">
              <SelectField defaultValue={receipt.tip_slip === "card" || receipt.tip_slip === "never" ? receipt.tip_slip : "always"} id="receipt_tip_slip" label="Tip & signature slip for online orders"
                options={[["always", "Every online order"], ["card", "Only card orders"], ["never", "Never"]]} />
              <label className="flex min-h-11 items-center gap-3 self-end text-sm font-bold"><input className="h-5 w-5 shrink-0" defaultChecked={receipt.online_order_slips !== false} name="receipt_online_slips" type="checkbox" />Print every online order automatically</label>
            </div>
          </PrinterPanel>

          <PrinterPanel
            enabled={kitchen.enabled ?? false}
            prefix="kitchen"
            subtitle="Kitchen · food tickets for every order, no prices"
            title="Kitchen tickets"
          >
            <PrinterFields defaultPaper={76} namePlaceholder="Kitchen" printer={kitchen} prefix="kitchen" />
            <label className="flex min-h-11 items-center gap-3 text-sm font-bold"><input className="h-5 w-5 shrink-0" defaultChecked={kitchen.two_color === true} name="kitchen_two_color" type="checkbox" />Black/red ribbon fitted (print &quot;NO …&quot; toppings and notes in red)</label>
            {menu.length ? <div className="border-t border-wayne-border pt-4">
              <p className="text-sm font-bold">Categories that print in the kitchen</p>
              <p className="text-xs text-wayne-muted">Leave all unticked to print the whole order.</p>
              <div className="mt-3 flex flex-wrap gap-2">{menu.map((category) => <label className="flex min-h-11 items-center gap-2 rounded-xl border border-wayne-border bg-white px-3 text-sm" key={category.id}><input defaultChecked={routed.has(category.name)} name="kitchen_categories" type="checkbox" value={category.name} />{category.name}</label>)}</div>
            </div> : null}
          </PrinterPanel>
        </div>
        <p className="mt-4 text-sm text-wayne-muted">Automatic printing (kitchen tickets for every order, online order slips) runs on the one register switched to <strong>Print station</strong> on the POS screen. If that register is off, tickets wait in Admin → Printing and print when it comes back (anything over an hour old is held there instead, so nothing old prints by surprise).</p>
      </Card>

      <Card className="p-6">
        <h2 className="text-2xl font-black">Cash drawer</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-bold" htmlFor="drawer_connection">Connection
            <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={drawer.connection ?? "none"} id="drawer_connection" name="drawer_connection">
              <option value="none">Not configured — open with the key</option>
              <option value="receipt_printer">Through the receipt printer&apos;s drawer port</option>
            </select>
          </label>
          <Input defaultValue={drawer.model ?? ""} label="Drawer model" name="drawer_model" />
        </div>
        <p className="mt-3 text-sm text-wayne-muted">Counting cash in and out stays in Admin → Cash and the POS Register button.</p>
      </Card>

      <Card className="p-6">
        <h2 className="text-2xl font-black">Payment terminal</h2>
        <p className="mt-2">External — integration pending. The POS shows the amount to run on the store&apos;s own card terminal. Direct terminal payments are switched on in Admin → Payments once a processor is connected.</p>
      </Card>

      <div><Button size="lg" type="submit">Save hardware settings</Button></div>
    </form>
  </main>;
}

type PrinterSettingsValue = { name?: string; model?: string; model_key?: string; ip?: string; port?: number | null; protocol?: string; paper_width_mm?: number; columns?: number | null };

/** One printer: a full-width panel with its on/off switch in the header. */
function PrinterPanel({ children, enabled, prefix, subtitle, title }: { children: ReactNode; enabled: boolean; prefix: string; subtitle: string; title: string }) {
  return <div className="min-w-0 rounded-2xl border border-wayne-border bg-wayne-cream/40 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-wayne-border pb-4">
      <div className="min-w-0">
        <h3 className="text-lg font-black">{title}</h3>
        <p className="text-sm text-wayne-muted">{subtitle}</p>
      </div>
      <label className="flex min-h-11 shrink-0 items-center gap-3 rounded-xl border border-wayne-border bg-white px-4 text-sm font-black">
        <input className="h-5 w-5" defaultChecked={enabled} name={`${prefix}_enabled`} type="checkbox" />Printer on
      </label>
    </div>
    <div className="mt-4 grid gap-4">{children}</div>
  </div>;
}

/** The fields every printer has, on a grid that folds down cleanly on a tablet or phone. */
function PrinterFields({ defaultPaper, namePlaceholder, prefix, printer }: { defaultPaper: number; namePlaceholder: string; prefix: string; printer: PrinterSettingsValue }) {
  const paper = printer.paper_width_mm === 58 || printer.paper_width_mm === 76 || printer.paper_width_mm === 80 ? printer.paper_width_mm : defaultPaper;
  return <>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Input className="min-w-0" inputClassName="w-full min-w-0" defaultValue={printer.name ?? ""} label="Name" name={`${prefix}_name`} placeholder={namePlaceholder} />
      <SelectField defaultValue={printer.model_key && printer.model_key in printerModels ? printer.model_key : "generic"} id={`${prefix}_model_key`} label="Printer type"
        options={printerModelKeys.map((key) => [key, printerModels[key].label])} />
      <Input className="min-w-0 sm:col-span-2 lg:col-span-1" inputClassName="w-full min-w-0" defaultValue={printer.model ?? ""} label="Exact model" name={`${prefix}_model`} placeholder="e.g. TM-T20III L (M352A)" />
    </div>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <Input className="min-w-0" inputClassName="w-full min-w-0" defaultValue={printer.ip ?? ""} inputMode="decimal" label="IP address" name={`${prefix}_ip`} placeholder="10.10.10.x" />
      <Input className="min-w-0" inputClassName="w-full min-w-0" defaultValue={printer.port ?? ""} label="Port" max={65535} min={1} name={`${prefix}_port`} placeholder="9100" type="number" />
      <SelectField defaultValue={["", "browser", "escpos"].includes(printer.protocol ?? "") ? printer.protocol ?? "" : ""} id={`${prefix}_protocol`} label="How to print"
        options={[["", "Not chosen yet"], ["browser", "Device print dialog"], ["escpos", "Network (ESC/POS)"]]} />
      <SelectField defaultValue={String(paper)} id={`${prefix}_paper`} label="Paper" options={[["80", "80 mm"], ["76", "76 mm"], ["58", "58 mm"]]} />
      <Input className="min-w-0" inputClassName="w-full min-w-0" defaultValue={printer.columns ?? ""} label="Chars / line" max={64} min={24} name={`${prefix}_columns`} placeholder="Auto" type="number" />
    </div>
  </>;
}

function SelectField({ defaultValue, id, label, options }: { defaultValue: string; id: string; label: string; options: readonly (readonly [string, string])[] }) {
  return <label className="grid min-w-0 content-start gap-1.5 text-sm font-bold tracking-tight" htmlFor={id}>{label}
    <select className="min-h-11 w-full min-w-0 truncate rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={defaultValue} id={id} name={id}>
      {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>
  </label>;
}
