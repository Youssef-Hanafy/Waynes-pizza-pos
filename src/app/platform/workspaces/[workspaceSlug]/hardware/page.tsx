import type { Metadata } from "next";
import { saveHardwareDevice } from "../../../actions";
import { Flash, first, serviceName, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  connectionTypes,
  deviceTypeLabels,
  deviceTypes,
  healthLabels,
  healthTone,
  ownershipLabels,
  ownershipTypes,
  type HardwareDevice,
  type PlatformHardware,
} from "@/lib/platform/hardware";
import { getPlatformWorkspace, getPlatformWorkspaceHardware } from "@/lib/platform/queries";
import { formatMoney } from "@/lib/platform/money";

export const metadata: Metadata = { title: "Hardware" };
export const dynamic = "force-dynamic";

const select = "min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal";

function Stat({ label, value, tone }: { label: string; value: number; tone?: "alert" | "warn" }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-wayne-muted">{label}</p>
      <strong className={`mt-1 block text-3xl ${tone === "alert" && value ? "text-wayne-alert" : tone === "warn" && value ? "text-wayne-warn" : ""}`}>{value}</strong>
    </Card>
  );
}

function DeviceFields({ device, data }: { device?: HardwareDevice; data: PlatformHardware }) {
  const managed = device?.managed_by_settings ?? false;
  const lines = device ? data.caller_lines.filter((line) => line.location_id === device.location_id) : [];
  return (
    <>
      {device ? null : (
        <label className="grid gap-1.5 text-sm font-bold">Type
          <select className={select} defaultValue="pos_tablet" name="device_type">
            {deviceTypes.map((type) => <option key={type} value={type}>{deviceTypeLabels[type]}</option>)}
          </select>
        </label>
      )}
      <Input defaultValue={device?.name} label="Name" maxLength={120} name="name" placeholder="Front counter tablet" required={!device} />
      <Input defaultValue={device?.vendor ?? ""} label="Vendor" maxLength={120} name="vendor" placeholder="Epson" />
      {managed ? null : <Input defaultValue={device?.model ?? ""} label="Model" maxLength={160} name="model" />}
      <Input defaultValue={device?.serial_number ?? ""} label="Serial number" maxLength={120} name="serial_number" />
      <Input defaultValue={device?.asset_tag ?? ""} label="Asset tag" maxLength={60} name="asset_tag" placeholder="HM-0001" />
      <label className="grid gap-1.5 text-sm font-bold">Who owns it
        <select className={select} defaultValue={device?.ownership_type ?? "customer_owned"} name="ownership_type">
          {ownershipTypes.map((type) => <option key={type} value={type}>{ownershipLabels[type]}</option>)}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-bold">Status
        <select className={select} defaultValue={device?.status ?? "active"} name="status">
          <option value="planned">Planned (not installed yet)</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </select>
      </label>
      {managed ? null : (
        <>
          <label className="grid gap-1.5 text-sm font-bold">Location
            <select className={select} defaultValue={device?.location_id ?? data.locations[0]?.id ?? ""} name="location_id">
              {data.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-bold">Connection
            <select className={select} defaultValue={device?.connection_type ?? ""} name="connection_type">
              <option value="">Not recorded</option>{connectionTypes.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
            </select>
          </label>
          <Input defaultValue={device?.ip_address ?? ""} label="IP address" name="ip_address" placeholder="10.10.10.50" />
          <Input defaultValue={device?.port ?? ""} label="Port" max={65535} min={1} name="port" type="number" />
          <Input defaultValue={device?.protocol ?? ""} label="Protocol" name="protocol" placeholder="escpos, udp, https" />
          <label className="grid gap-1.5 text-sm font-bold">Health reporting
            <select className={select} defaultValue={device?.monitoring ?? "not_monitored"} name="monitoring">
              <option value="not_monitored">Not monitored (nothing reports on it)</option>
              <option value="telemetry">Reports in (app, bridge or print station)</option>
            </select>
          </label>
        </>
      )}
      <Input defaultValue={device?.mac_address ?? ""} label="MAC address" name="mac_address" placeholder="50:57:9C:06:47:43" />
      <label className="grid gap-1.5 text-sm font-bold">Used by
        <select className={select} defaultValue={device?.assigned_service ?? ""} name="assigned_service">
          <option value="">Not recorded</option>
          {["pos", "caller_id", "online_ordering", "delivery", "hardware_management"].map((code) => <option key={code} value={code}>{serviceName(code)}</option>)}
        </select>
      </label>
      {device?.device_type === "payment_terminal" ? (
        <label className="grid gap-1.5 text-sm font-bold">Card terminal record
          <select className={select} defaultValue={device.payment_terminal?.id ?? "none"} name="payment_terminal_id">
            <option value="none">Not linked</option>
            {data.payment_terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.label}</option>)}
          </select>
        </label>
      ) : null}
      {device?.device_type === "caller_id" && lines.length ? (
        <fieldset className="grid gap-1.5 text-sm font-bold">
          <legend>Phone lines it serves</legend>
          <input name="caller_lines_present" type="hidden" value="yes" />
          <div className="flex flex-wrap gap-3 font-normal">
            {lines.map((line) => (
              <label className="flex items-center gap-2" key={line.id}>
                <input defaultChecked={line.caller_id_device_id === device.id} name="caller_lines" type="checkbox" value={line.line_number} /> {line.label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <Input className="md:col-span-2" defaultValue={device?.notes ?? ""} label="Notes" maxLength={1000} name="notes" />
    </>
  );
}

/**
 * Hardware tab (§11.3 Hardware, §21).  Devices by location with ownership,
 * connection details and health that only ever comes from real activity.
 */
export default async function PlatformWorkspaceHardwarePage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [workspace, data] = await Promise.all([getPlatformWorkspace(workspaceSlug), getPlatformWorkspaceHardware(workspaceSlug)]);
  const tz = workspace.timezone;
  const live = data.devices.filter((device) => device.status !== "retired");
  const retired = data.devices.filter((device) => device.status === "retired");
  const byLocation = data.locations.map((location) => ({ location, devices: live.filter((device) => device.location_id === location.id) }));
  const equipmentOwed = live.reduce((sum, device) => sum + (device.equipment?.balance_due_cents ?? 0), 0);

  return (
    <div className="mt-6">
      <Flash error={first(query.error)} saved={first(query.saved)} />
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Devices" value={data.counts.devices} />
        <Stat label="Reporting health" value={data.counts.monitored} />
        <Stat label="Reporting a problem" tone="alert" value={data.counts.problems} />
        <Stat label="Never seen yet" tone="warn" value={data.counts.never_seen} />
        <Card className="p-5">
          <p className="text-sm text-wayne-muted">Owed to Hanafy for equipment</p>
          <strong className={`mt-1 block text-3xl ${equipmentOwed ? "text-wayne-warn" : ""}`}>{formatMoney(equipmentOwed)}</strong>
        </Card>
      </div>
      <p className="mt-3 max-w-4xl text-sm text-wayne-muted">
        Health comes only from real activity: printed or failed tickets, real caller-ID rings and bridge check-ins. A router, access point or a
        processor&apos;s own card terminal is listed as <em>not monitored</em>, never as online. Printers, the cash drawer and the caller-ID box follow the
        business&apos;s Admin → Hardware settings; their address and port are changed there.
      </p>

      {byLocation.map(({ location, devices }) => (
        <section className="mt-8" key={location.id}>
          <h2 className="text-2xl font-black">{location.name}</h2>
          <div className="mt-3 grid gap-3">
            {devices.map((device) => (
              <Card className="p-5" key={device.id}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <strong className="text-lg">{device.name}</strong>
                    <span className="ml-2 text-sm text-wayne-muted">{deviceTypeLabels[device.device_type]}{device.status !== "active" ? ` · ${device.status}` : ""}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone="neutral">{ownershipLabels[device.ownership_type]}</Badge>
                    <Badge tone={healthTone(device.health)}>{healthLabels[device.health]}</Badge>
                  </div>
                </div>
                <div className="mt-3 grid gap-1 text-sm md:grid-cols-3">
                  <p>Model: <strong>{[device.vendor, device.model].filter(Boolean).join(" · ") || "—"}</strong></p>
                  <p>Serial / tag: <strong>{[device.serial_number, device.asset_tag].filter(Boolean).join(" · ") || "—"}</strong></p>
                  <p>Network: <strong>{device.ip_address ? `${device.ip_address}${device.port ? `:${device.port}` : ""}` : device.connection_type?.replace("_", " ") ?? "—"}</strong>{device.protocol ? ` (${device.protocol})` : ""}</p>
                  {device.mac_address ? <p>MAC: <strong>{device.mac_address}</strong></p> : null}
                  {device.assigned_service ? <p>Used by: <strong>{serviceName(device.assigned_service)}</strong></p> : null}
                  {device.monitoring === "telemetry" ? <p>Last seen: <strong>{when(device.last_seen_at, tz)}</strong></p> : null}
                  {device.caller_lines.length ? <p>Lines: <strong>{device.caller_lines.map((line) => line.label).join(", ")}</strong></p> : null}
                  {device.payment_terminal ? <p>Card terminal: <strong>{device.payment_terminal.label}</strong> ({device.payment_terminal.type === "external_manual" ? "run by hand" : "POS reader"})</p> : null}
                  {device.equipment ? <p>Equipment balance: <strong>{formatMoney(device.equipment.balance_due_cents)}</strong> of {formatMoney(device.equipment.charged_cents)}</p> : null}
                  {device.last_error_summary ? <p className="text-wayne-alert md:col-span-3">Last problem {when(device.last_error_at, tz)}: {device.last_error_summary} ({device.error_count} total)</p> : null}
                  {device.notes ? <p className="text-wayne-muted md:col-span-3">{device.notes}</p> : null}
                  {device.managed_by_settings ? <p className="text-xs text-wayne-muted md:col-span-3">Follows the business&apos;s Admin → Hardware settings.</p> : null}
                </div>
                {data.can_manage ? (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <details className="w-full">
                      <summary className="cursor-pointer text-sm font-bold">Change details</summary>
                      <form action={saveHardwareDevice} className="mt-3 grid gap-4 md:grid-cols-3">
                        <input name="workspace" type="hidden" value={workspace.slug} /><input name="id" type="hidden" value={device.id} />
                        <DeviceFields data={data} device={device} />
                        <Input label="Reason" minLength={5} name="reason" required />
                        <div className="md:col-span-3"><Button variant="brand">Save device</Button></div>
                      </form>
                    </details>
                    <form action={saveHardwareDevice} className="flex flex-wrap items-end gap-2">
                      <input name="workspace" type="hidden" value={workspace.slug} /><input name="id" type="hidden" value={device.id} /><input name="status" type="hidden" value="retired" />
                      <Input label="Reason to retire" minLength={5} name="reason" required />
                      <Button size="sm" variant="ghost">Retire</Button>
                    </form>
                  </div>
                ) : null}
              </Card>
            ))}
            {devices.length === 0 ? <Card className="p-5 text-wayne-muted">No devices recorded at this location.</Card> : null}
          </div>
        </section>
      ))}

      {data.can_manage ? (
        <Card className="mt-8 p-5">
          <h2 className="text-xl font-black">Add a device</h2>
          <p className="mt-1 text-sm text-wayne-muted">For hardware that isn&apos;t in the business&apos;s printer or caller-ID settings: tablets, displays, network gear, a UPS. If Hanafy supplied it, record the charge on the Equipment tab.</p>
          <form action={saveHardwareDevice} className="mt-4 grid gap-4 md:grid-cols-3">
            <input name="workspace" type="hidden" value={workspace.slug} />
            <DeviceFields data={data} />
            <Input label="Reason" minLength={5} name="reason" required />
            <div className="md:col-span-3"><Button variant="brand">Add device</Button></div>
          </form>
        </Card>
      ) : null}

      {retired.length ? (
        <section className="mt-8">
          <h2 className="text-xl font-black">Retired</h2>
          <div className="mt-3 grid gap-2">
            {retired.map((device) => (
              <Card className="p-4 text-sm" key={device.id}>
                <strong>{device.name}</strong> · {deviceTypeLabels[device.device_type]} · retired {when(device.retired_at, tz)}{device.serial_number ? ` · serial ${device.serial_number}` : ""}
              </Card>
            ))}
          </div>
        </section>
      ) : null}
      <p className="mt-6 text-sm text-wayne-muted">{data.registers} active register{data.registers === 1 ? "" : "s"} set up in the POS.</p>
    </div>
  );
}
