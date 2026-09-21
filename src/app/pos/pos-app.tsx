"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { StoreSettings } from "@/lib/content/schemas";
import type { HardwareSettings } from "@/lib/hardware/schemas";
import type { PublicMenu } from "@/lib/menu/schemas";
import { draftFromCall } from "@/lib/orders/drafts";
import type { PosCustomer } from "@/lib/pos/schemas";
import { useHardwareState } from "@/stores/hardware-store";
import { orderActions, useDrafts } from "@/stores/order-store";
import { getTerminalLabel, phoneActions, setTerminalLabel, usePhoneBadge } from "@/stores/phone-store";
import { useHardware } from "@/stores/use-hardware";
import { dismissNotice, useSyncState } from "@/stores/draft-sync";
import { useDraftSync } from "@/stores/use-draft-sync";
import { CustomersScreen } from "./customers-screen";
import { DrawerPanel } from "./drawer-panel";
import { OpenOrdersPanel } from "./open-orders-panel";
import { OrderScreen } from "./order-screen";
import { PhoneScreen, type StartPhoneOrder } from "./phone-screen";
import { SimulatorPanel } from "./simulator-panel";

type Section = "order" | "phone" | "orders" | "customers" | "delivery" | "more";

type Props = {
  menu: PublicMenu;
  settings: StoreSettings;
  hardware: HardwareSettings;
  staffName: string;
  profileId: string;
  canManageDiscount: boolean;
  canManageOrders: boolean;
  canOpenAdmin: boolean;
  canManageHardware: boolean;
};

/**
 * The POS shell (build sheet §6): a tablet-first landscape frame with the
 * permanent header and the sections staff move between.
 *
 * Sections are switched in place rather than by navigation, so the ticket
 * being entered, the phone state and the hardware connection all survive
 * moving around.  A ringing phone lights the PHONE button but never takes
 * the cashier away from what they are doing (§6, §34.1).
 */
export function PosApp(props: Props) {
  const { menu, settings, hardware, staffName, profileId, canManageDiscount, canManageOrders, canOpenAdmin, canManageHardware } = props;
  const [section, setSection] = useState<Section>("order");
  const [customerFocus, setCustomerFocus] = useState<PosCustomer | null>(null);
  const badge = usePhoneBadge();
  const hardwareState = useHardwareState();
  const { drafts } = useDrafts();
  const heldCount = drafts.filter((draft) => draft.held).length;

  const runtimeReady = useHardware(hardware);
  useDraftSync();
  const { notices } = useSyncState();
  const pendingCount = drafts.filter((draft) => draft.submitPending).length;

  /** startOrderFromCall (§32): claim it, carry the caller in, open the order screen. */
  const startPhoneOrder: StartPhoneOrder = async (call, customer, options = {}) => {
    const result = await phoneActions.startOrderFromCall(call.key, options.force ?? false);
    if (!result.ok && result.reason === "claimed") return { ok: false, claimed: true, message: result.message };
    if (!result.ok && result.reason === "closed") return { ok: false, message: result.message };
    // Offline: the order is still taken; the call links when the order is sent.
    const current = result.ok ? result.call : call;
    orderActions.startOrResumeForCall(call.key, draftFromCall({
      callKey: call.key, callId: current.serverId, line: call.line, phoneNumber: call.phoneNumber,
      callerName: call.callerName, customer, withoutProfile: options.withoutProfile,
    }));
    setSection("order");
    return { ok: true };
  };

  function startCustomerOrder(customer: PosCustomer) {
    const preferred = customer.addresses.find((address) => address.is_default) ?? customer.addresses[0];
    orderActions.start({
      source: "pos", customerMode: "identified", customer, firstName: customer.first_name, lastName: customer.last_name,
      phone: customer.phone, email: customer.email ?? "", addressId: preferred?.id ?? "",
    });
    setSection("order");
  }

  const callerStatus = hardwareState.statuses.caller_id;
  const syncStatus = hardwareState.statuses.caller_sync;
  const warning = !hardwareState.online
    ? `No internet — tickets are saved on this register${pendingCount ? `; ${pendingCount} will send when it is back` : ""}`
    : pendingCount ? `${pendingCount} ticket${pendingCount === 1 ? "" : "s"} waiting to send`
    : callerStatus && ["error", "unavailable"].includes(callerStatus.state) ? `Caller ID: ${callerStatus.detail ?? callerStatus.label}`
    : syncStatus && syncStatus.state === "disconnected" && runtimeReady ? "Live phone updates reconnecting" : "";

  const tabs: { id: Section; label: string }[] = [
    { id: "order", label: heldCount ? `New Order · ${heldCount} held` : "New Order" },
    { id: "phone", label: badge.waiting ? `Phone (${badge.waiting})` : "Phone" },
    ...(canManageOrders ? [{ id: "orders" as const, label: "Orders" }] : []),
    { id: "customers", label: "Customers" },
    ...(canManageOrders && settings.delivery_enabled ? [{ id: "delivery" as const, label: "Deliveries" }] : []),
    { id: "more", label: "More" },
  ];

  return <div className="flex min-h-screen flex-col bg-wayne-cream-deep lg:h-screen lg:overflow-hidden">
    <header className="flex shrink-0 flex-wrap items-center gap-2 bg-wayne-green px-3 py-2 text-wayne-cream">
      <strong className="mr-auto text-lg font-black uppercase tracking-[0.08em]">Wayne&apos;s Pizza</strong>
      <button aria-label={badge.waiting ? `Phone lines, ${badge.waiting} waiting` : "Phone lines"} className={`min-h-11 rounded-xl px-4 text-base font-black uppercase tracking-wider transition ${badge.ringing ? "animate-pulse bg-wayne-ok text-white ring-4 ring-white/60" : badge.waiting ? "bg-wayne-cream text-wayne-green" : "bg-white/10 text-wayne-cream hover:bg-white/20"}`} onClick={() => setSection("phone")} type="button">☎ Phone{badge.waiting ? ` (${badge.waiting})` : ""}</button>
      <DrawerPanel timeZone={settings.timezone} />
      <span className="hidden text-sm font-bold text-wayne-cream/80 sm:inline">{staffName}</span>
      {canOpenAdmin ? <Button asChild size="sm" variant="secondary"><Link href="/admin">Admin</Link></Button> : null}
    </header>
    {warning ? <p className="shrink-0 bg-wayne-warn-soft px-3 py-1.5 text-sm font-bold" role="status">⚠ {warning}</p> : null}
    {notices.map((notice) => <div className={`flex shrink-0 items-center justify-between gap-3 px-3 py-1.5 text-sm font-bold ${notice.tone === "warn" ? "bg-wayne-alert-soft text-wayne-alert" : "bg-wayne-ok-soft text-wayne-ok"}`} key={notice.id} role="status"><span>{notice.text}</span><button aria-label="Dismiss" className="min-h-9 px-2" onClick={() => dismissNotice(notice.id)} type="button">×</button></div>)}
    <nav aria-label="POS sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-wayne-border bg-white px-2 py-1.5">
      {tabs.map((tab) => <button aria-current={section === tab.id ? "page" : undefined} className={`min-h-11 whitespace-nowrap rounded-xl px-4 text-sm font-black transition ${section === tab.id ? "bg-wayne-green text-wayne-cream" : tab.id === "phone" && badge.ringing ? "bg-wayne-ok-soft text-wayne-ok" : "text-wayne-ink hover:bg-wayne-cream"}`} key={tab.id} onClick={() => setSection(tab.id)} type="button">{tab.label}</button>)}
    </nav>

    {section === "order" ? <OrderScreen canManageDiscount={canManageDiscount} menu={menu} onOpenPhone={() => setSection("phone")} settings={settings} /> : null}
    {section === "phone" ? <PhoneScreen onOpenCustomer={(customer) => { setCustomerFocus(customer); setSection("customers"); }} onStartOrder={startPhoneOrder} profileId={profileId} simulatorAvailable={runtimeReady && hardware.simulator_enabled} timeZone={settings.timezone} /> : null}
    {section === "orders" && canManageOrders ? <div className="min-h-0 flex-1 overflow-y-auto p-4"><OpenOrdersPanel inline timeZone={settings.timezone} /></div> : null}
    {section === "delivery" && canManageOrders ? <div className="min-h-0 flex-1 overflow-y-auto p-4"><OpenOrdersPanel fulfillment="delivery" inline timeZone={settings.timezone} />{canOpenAdmin ? <p className="mt-4 text-sm"><Link className="font-bold underline" href="/admin/delivery">Assign drivers in Admin → Delivery</Link></p> : null}</div> : null}
    {section === "customers" ? <CustomersScreen focus={customerFocus} key={customerFocus?.id ?? "search"} onStartOrder={startCustomerOrder} timeZone={settings.timezone} /> : null}
    {section === "more" ? <MoreScreen canManageHardware={canManageHardware} hardware={hardware} runtimeReady={runtimeReady} /> : null}
  </div>;
}

const deviceNames: Record<string, string> = {
  caller_id: "Caller ID", caller_sync: "Live phone updates", receipt_printer: "Receipt printer",
  kitchen_printer: "Kitchen printer", cash_drawer: "Cash drawer", payment_terminal: "Card terminal",
};

function MoreScreen({ canManageHardware, hardware, runtimeReady }: { canManageHardware: boolean; hardware: HardwareSettings; runtimeReady: boolean }) {
  const { statuses, online } = useHardwareState();
  const [terminal, setTerminal] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setTerminal(getTerminalLabel()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  return <div className="min-h-0 flex-1 overflow-y-auto p-4">
    <div className="mx-auto grid max-w-3xl gap-4">
      <section className="rounded-3xl bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">This register</h2>
        <p className="mt-1 text-sm text-wayne-muted">Other registers see this name when you take a call.</p>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); setTerminalLabel(terminal); setSaved(true); }}>
          <label className="grid flex-1 gap-1.5 text-sm font-bold" htmlFor="terminal-name">Register name<input className="min-h-11 rounded-xl border border-wayne-border px-3 font-normal" id="terminal-name" maxLength={60} onChange={(event) => { setTerminal(event.target.value); setSaved(false); }} value={terminal} /></label>
          <Button type="submit">{saved ? "Saved" : "Save"}</Button>
        </form>
      </section>
      <section className="rounded-3xl bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Hardware</h2>
        <ul className="mt-3 divide-y divide-wayne-border">
          <li className="flex justify-between gap-3 py-2"><span className="font-bold">Internet</span><span>{online ? "✓ Online" : "⚠ Offline"}</span></li>
          {Object.entries(deviceNames).map(([device, name]) => {
            const status = statuses[device as keyof typeof statuses];
            return <li className="flex flex-wrap justify-between gap-3 py-2" key={device}><span className="font-bold">{name}</span><span className="text-right text-sm">{status ? <><strong>{status.label}</strong>{status.detail ? <span className="block text-wayne-muted">{status.detail}</span> : null}</> : runtimeReady ? "—" : "Starting…"}</span></li>;
          })}
        </ul>
        <p className="mt-3 text-sm text-wayne-muted">Caller ID provider: <strong>{hardware.caller_id_provider === "simulated" ? "Simulated" : hardware.caller_id_provider === "cloud" ? "Store bridge (cloud)" : "Android app"}</strong> · {hardware.caller_line_count} lines</p>
        {canManageHardware ? <Button asChild className="mt-3" variant="secondary"><Link href="/admin/hardware">Admin → Hardware</Link></Button> : null}
      </section>
      {hardware.simulator_enabled ? <section className="rounded-3xl bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Test calls</h2><p className="mb-3 mt-1 text-sm text-wayne-muted">Rings a line through the same path the real caller ID box will use.</p><SimulatorPanel lineCount={hardware.caller_line_count} /></section> : null}
    </div>
  </div>;
}
