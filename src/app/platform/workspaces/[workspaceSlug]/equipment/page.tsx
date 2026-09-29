import type { Metadata } from "next";
import { recordBillingPayment, saveEquipment } from "../../../actions";
import { Flash, first } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { paymentMethodLabels, paymentMethods } from "@/lib/platform/billing";
import { ownershipLabels } from "@/lib/platform/hardware";
import { formatMoney } from "@/lib/platform/money";
import { getPlatformWorkspace, getPlatformWorkspaceBilling } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Equipment" };
export const dynamic = "force-dynamic";

const select = "min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal";
const suppliedOwnership = ["financed", "hanafy_owned", "leased", "customer_owned"] as const;

/**
 * Equipment tab (§11.3 Equipment, §23.4).  Hardware Hanafy supplied, what it
 * cost, what the business was charged and has paid.  The balance is always
 * charges minus payments; nothing is typed in twice.
 */
export default async function PlatformWorkspaceEquipmentPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [workspace, data] = await Promise.all([getPlatformWorkspace(workspaceSlug), getPlatformWorkspaceBilling(workspaceSlug)]);
  const hidden = <><input name="workspace" type="hidden" value={workspace.slug} /><input name="tab" type="hidden" value="equipment" /></>;
  const businessOwned = data.devices.filter((device) => !device.has_asset && device.ownership_type === "customer_owned");

  return (
    <div className="mt-6">
      <Flash error={first(query.error)} saved={first(query.saved)} />
      <Card className="mt-2 p-5">
        <p className="text-sm text-wayne-muted">Owed to Hanafy on equipment</p>
        <strong className={`mt-1 block text-4xl ${data.totals.equipment_balance_cents ? "text-wayne-warn" : ""}`}>{formatMoney(data.totals.equipment_balance_cents)}</strong>
        <p className="mt-1 text-sm text-wayne-muted">
          {data.equipment.length === 0
            ? `Hanafy has not supplied any equipment to ${workspace.name}.${businessOwned.length ? ` ${businessOwned.length} device${businessOwned.length === 1 ? " is" : "s are"} owned by the business itself.` : ""}`
            : `${data.equipment.length} item${data.equipment.length === 1 ? "" : "s"} supplied by Hanafy.`}
        </p>
      </Card>

      <div className="mt-6 grid gap-3">
        {data.equipment.map((asset) => (
          <Card className="p-5" key={asset.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong className="text-lg">{asset.name}</strong>
                <span className="ml-2 text-sm text-wayne-muted">{[asset.vendor, asset.model].filter(Boolean).join(" · ")}{asset.serial_number ? ` · serial ${asset.serial_number}` : ""}</span>
              </div>
              <div className="flex gap-2">
                <Badge tone="neutral">{ownershipLabels[asset.ownership_type]}</Badge>
                {asset.status !== "active" ? <Badge tone="neutral">{asset.status.replace("_", " ")}</Badge> : null}
                <Badge tone={asset.balance_due_cents > 0 ? "warn" : "ok"}>{asset.balance_due_cents > 0 ? `${formatMoney(asset.balance_due_cents)} owed` : "Paid off"}</Badge>
              </div>
            </div>
            <div className="mt-3 grid gap-1 text-sm md:grid-cols-3">
              <p>Hanafy&apos;s cost: <strong>{asset.hanafy_cost_cents === null ? "—" : formatMoney(asset.hanafy_cost_cents)}</strong></p>
              <p>Price to the business: <strong>{asset.customer_price_cents === null ? "—" : formatMoney(asset.customer_price_cents)}</strong></p>
              <p>Charged / paid: <strong>{formatMoney(asset.charged_cents)} / {formatMoney(asset.paid_cents)}</strong></p>
              <p>Device: <strong>{asset.device_name ?? "not linked"}</strong>{asset.location_name ? ` · ${asset.location_name}` : ""}</p>
              <p>Schedule: <strong>{asset.payment_schedule ?? "—"}</strong></p>
              <p>Assigned: <strong>{asset.assigned_at ?? "—"}</strong>{asset.purchased_at ? ` · bought ${asset.purchased_at}` : ""}</p>
              {asset.notes ? <p className="text-wayne-muted md:col-span-3">{asset.notes}</p> : null}
            </div>
            <ul className="mt-3 grid gap-1 text-sm">
              {asset.charges.map((charge) => <li key={charge.id}>{charge.charged_on} · {charge.description} · <strong>{formatMoney(charge.amount_cents)}</strong></li>)}
              {asset.payments.map((payment) => (
                <li className="flex flex-wrap items-center gap-2" key={payment.id}>
                  <span className={payment.voided_at ? "line-through text-wayne-muted" : ""}>{payment.paid_on} · payment ({paymentMethodLabels[payment.method]}{payment.reference ? `, ${payment.reference}` : ""}) · <strong>−{formatMoney(payment.amount_cents)}</strong></span>
                  {payment.voided_at ? <span className="text-wayne-muted">voided: {payment.void_reason}</span> : data.can_manage ? (
                    <form action={recordBillingPayment} className="flex items-center gap-2">
                      {hidden}<input name="target" type="hidden" value="equipment" /><input name="void_payment_id" type="hidden" value={payment.id} />
                      <input aria-label="Reason to void" className="min-h-9 rounded-lg border border-wayne-border px-2" minLength={5} name="reason" placeholder="Reason to void" required />
                      <Button size="sm" variant="ghost">Void</Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
            {data.can_manage ? (
              <div className="mt-4 grid gap-3">
                {asset.balance_due_cents > 0 ? (
                  <form action={recordBillingPayment} className="grid gap-3 md:grid-cols-6 md:items-end">
                    {hidden}<input name="target" type="hidden" value="equipment" /><input name="target_id" type="hidden" value={asset.id} />
                    <Input inputMode="decimal" label="Amount paid ($)" name="amount" required />
                    <label className="grid gap-1.5 text-sm font-bold">How
                      <select className={select} defaultValue="check" name="method">{paymentMethods.map((method) => <option key={method} value={method}>{paymentMethodLabels[method]}</option>)}</select>
                    </label>
                    <Input label="Paid on" name="paid_on" type="date" />
                    <Input label="Reference" maxLength={120} name="reference" />
                    <Input label="Reason" minLength={5} name="reason" placeholder="Installment received" required />
                    <Button variant="brand">Record payment</Button>
                  </form>
                ) : null}
                <details>
                  <summary className="cursor-pointer text-sm font-bold">Add a charge or credit</summary>
                  <form action={saveEquipment} className="mt-3 grid gap-3 md:grid-cols-4 md:items-end">
                    {hidden}<input name="id" type="hidden" value={asset.id} />
                    <Input inputMode="decimal" label="Amount ($, negative for a credit)" name="charge" required />
                    <Input label="What for" maxLength={300} name="charge_description" placeholder="Replacement cable" />
                    <Input label="Date" name="charged_on" type="date" />
                    <Input label="Reason" minLength={5} name="reason" required />
                    <div className="md:col-span-4"><Button variant="secondary">Save charge</Button></div>
                  </form>
                </details>
                <details>
                  <summary className="cursor-pointer text-sm font-bold">Change details</summary>
                  <form action={saveEquipment} className="mt-3 grid gap-3 md:grid-cols-3">
                    {hidden}<input name="id" type="hidden" value={asset.id} />
                    <Input defaultValue={asset.name} label="Name" name="name" />
                    <Input defaultValue={asset.serial_number ?? ""} label="Serial number" name="serial_number" />
                    <Input defaultValue={asset.payment_schedule ?? ""} label="Payment schedule" name="payment_schedule" />
                    <label className="grid gap-1.5 text-sm font-bold">Status
                      <select className={select} defaultValue={asset.status} name="status"><option value="active">Active</option><option value="returned">Returned</option><option value="written_off">Written off</option></select>
                    </label>
                    <Input defaultValue={asset.notes ?? ""} label="Notes" name="notes" />
                    <Input label="Reason" minLength={5} name="reason" required />
                    <div className="md:col-span-3"><Button variant="secondary">Save</Button></div>
                  </form>
                </details>
              </div>
            ) : null}
          </Card>
        ))}
      </div>

      {data.can_manage ? (
        <Card className="mt-6 p-5">
          <h2 className="text-xl font-black">Record equipment Hanafy supplied</h2>
          <p className="mt-1 text-sm text-wayne-muted">The price to the business becomes the first charge, so the balance starts right. Link it to its device on the Hardware tab if it is installed.</p>
          <form action={saveEquipment} className="mt-4 grid gap-4 md:grid-cols-3">
            {hidden}
            <label className="grid gap-1.5 text-sm font-bold">Device (optional)
              <select className={select} defaultValue="" name="hardware_device_id">
                <option value="">Not installed / not in the device list</option>
                {data.devices.filter((device) => !device.has_asset).map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
              </select>
            </label>
            <Input label="Name" maxLength={160} name="name" placeholder="Samsung Galaxy Tab A9+" />
            <label className="grid gap-1.5 text-sm font-bold">Who owns it
              <select className={select} defaultValue="financed" name="ownership_type">{suppliedOwnership.map((type) => <option key={type} value={type}>{ownershipLabels[type]}</option>)}</select>
            </label>
            <Input label="Vendor" name="vendor" />
            <Input label="Model" name="model" />
            <Input label="Serial number" name="serial_number" />
            <Input inputMode="decimal" label="Hanafy's cost ($)" name="hanafy_cost" />
            <Input inputMode="decimal" label="Price to the business ($)" name="customer_price" />
            <Input label="Payment schedule" name="payment_schedule" placeholder="3 monthly payments" />
            <Input label="Bought on" name="purchased_at" type="date" />
            <Input label="Given to the business on" name="assigned_at" type="date" />
            <Input label="Reason" minLength={5} name="reason" required />
            <div className="md:col-span-3"><Button variant="brand">Save equipment</Button></div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
