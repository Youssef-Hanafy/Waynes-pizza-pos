import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/access";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
        <p className="mt-1 text-sm text-wayne-muted">Enter each printer once its exact model is confirmed. No printer protocol is assumed before then. Kitchen tickets keep printing through the existing print queue.</p>
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <fieldset className="grid gap-3 rounded-2xl border border-wayne-border p-4">
            <legend className="px-1 font-black">Receipt printer {receipt.enabled ? "" : "· Not configured"}</legend>
            <Input defaultValue={receipt.name ?? ""} label="Name" name="receipt_name" placeholder="Front receipt" />
            <Input defaultValue={receipt.model ?? ""} label="Model" name="receipt_model" placeholder="Exact model number" />
            <div className="grid grid-cols-[1fr_7rem] gap-3"><Input defaultValue={receipt.ip ?? ""} label="IP address" name="receipt_ip" /><Input defaultValue={receipt.port ?? ""} label="Port" max={65535} min={1} name="receipt_port" type="number" /></div>
            <Input defaultValue={receipt.protocol ?? ""} label="Protocol" name="receipt_protocol" placeholder="Confirm from the model" />
            <label className="flex items-center gap-3 text-sm font-bold"><input className="h-5 w-5" defaultChecked={receipt.enabled ?? false} name="receipt_enabled" type="checkbox" />Enabled</label>
          </fieldset>
          <fieldset className="grid gap-3 rounded-2xl border border-wayne-border p-4">
            <legend className="px-1 font-black">Kitchen printer {kitchen.enabled ? "" : "· Not configured"}</legend>
            <Input defaultValue={kitchen.name ?? ""} label="Name" name="kitchen_name" placeholder="Kitchen" />
            <Input defaultValue={kitchen.model ?? ""} label="Model" name="kitchen_model" placeholder="Exact model number" />
            <div className="grid grid-cols-[1fr_7rem] gap-3"><Input defaultValue={kitchen.ip ?? ""} label="IP address" name="kitchen_ip" /><Input defaultValue={kitchen.port ?? ""} label="Port" max={65535} min={1} name="kitchen_port" type="number" /></div>
            <Input defaultValue={kitchen.protocol ?? ""} label="Protocol" name="kitchen_protocol" placeholder="Confirm from the model" />
            <label className="flex items-center gap-3 text-sm font-bold"><input className="h-5 w-5" defaultChecked={kitchen.enabled ?? false} name="kitchen_enabled" type="checkbox" />Enabled</label>
            {menu.length ? <div><p className="text-sm font-bold">Categories that print in the kitchen</p><div className="mt-2 flex flex-wrap gap-2">{menu.map((category) => <label className="flex min-h-11 items-center gap-2 rounded-xl border border-wayne-border px-3 text-sm" key={category.id}><input defaultChecked={routed.has(category.name)} name="kitchen_categories" type="checkbox" value={category.name} />{category.name}</label>)}</div></div> : null}
          </fieldset>
        </div>
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
