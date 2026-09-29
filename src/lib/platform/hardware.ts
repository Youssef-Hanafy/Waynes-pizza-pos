import { z } from "zod";

/** Platform Admin → Hardware (Phase 10, build sheet §21, §22, §11.3 Hardware). */
const timestamp = z.string();
const count = z.coerce.number().int().nonnegative();

export const deviceTypes = [
  "pos_tablet", "kitchen_display", "caller_id", "receipt_printer", "kitchen_printer",
  "cash_drawer", "payment_terminal", "router", "access_point", "ups", "other",
] as const;
export const ownershipTypes = ["customer_owned", "hanafy_owned", "financed", "leased", "unknown"] as const;
export const connectionTypes = ["ethernet", "wifi", "usb", "serial", "bluetooth", "printer_port", "other"] as const;
export const deviceStatuses = ["planned", "active", "inactive", "retired"] as const;
export const deviceHealths = ["ok", "stale", "error", "unknown", "not_monitored", "off"] as const;

export const deviceTypeLabels: Record<(typeof deviceTypes)[number], string> = {
  pos_tablet: "POS tablet",
  kitchen_display: "Kitchen display",
  caller_id: "Caller ID box",
  receipt_printer: "Receipt printer",
  kitchen_printer: "Kitchen printer",
  cash_drawer: "Cash drawer",
  payment_terminal: "Card terminal",
  router: "Router",
  access_point: "Wi-Fi access point",
  ups: "Battery backup (UPS)",
  other: "Other",
};

export const ownershipLabels: Record<(typeof ownershipTypes)[number], string> = {
  customer_owned: "Business owns it",
  hanafy_owned: "Hanafy owns it",
  financed: "Financed through Hanafy",
  leased: "Leased",
  unknown: "Not recorded",
};

export const healthLabels: Record<(typeof deviceHealths)[number], string> = {
  ok: "Seen in the last 24 hours",
  stale: "Not seen for over a day",
  error: "Reporting a problem",
  unknown: "Never seen yet",
  not_monitored: "Not monitored",
  off: "Off",
};

export const healthTone = (health: (typeof deviceHealths)[number]) =>
  health === "ok" ? "ok" : health === "error" ? "alert" : health === "stale" || health === "unknown" ? "warn" : "neutral";

export const hardwareDeviceSchema = z.object({
  id: z.uuid(),
  location_id: z.uuid().nullable(),
  location_name: z.string().nullable(),
  device_type: z.enum(deviceTypes),
  name: z.string(),
  vendor: z.string().nullable(),
  model: z.string().nullable(),
  serial_number: z.string().nullable(),
  asset_tag: z.string().nullable(),
  status: z.enum(deviceStatuses),
  ownership_type: z.enum(ownershipTypes),
  connection_type: z.enum(connectionTypes).nullable(),
  ip_address: z.string().nullable(),
  mac_address: z.string().nullable(),
  protocol: z.string().nullable(),
  port: z.number().int().nullable(),
  assigned_service: z.string().nullable(),
  monitoring: z.enum(["telemetry", "not_monitored"]),
  health: z.enum(deviceHealths),
  last_seen_at: timestamp.nullable(),
  last_success_at: timestamp.nullable(),
  last_error_at: timestamp.nullable(),
  last_error_summary: z.string().nullable(),
  error_count: count,
  configuration: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().nullable(),
  source_key: z.string().nullable().optional(),
  managed_by_settings: z.boolean(),
  caller_lines: z.array(z.object({ line_number: z.number().int(), label: z.string(), active: z.boolean() })),
  payment_terminal: z.object({ id: z.uuid(), label: z.string(), type: z.string(), status: z.string() }).nullable(),
  retired_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  // Phase 11: what the business still owes Hanafy for this device, if Hanafy supplied it.
  equipment: z.object({ asset_id: z.uuid(), balance_due_cents: z.number().int(), charged_cents: z.number().int(), paid_cents: z.number().int() }).nullable().optional(),
});
export type HardwareDevice = z.infer<typeof hardwareDeviceSchema>;

export const hardwareCountsSchema = z.object({ devices: count, monitored: count, problems: count, never_seen: count });

export const platformHardwareSchema = z.object({
  can_manage: z.boolean(),
  counts: hardwareCountsSchema,
  devices: z.array(hardwareDeviceSchema),
  locations: z.array(z.object({ id: z.uuid(), name: z.string() })),
  caller_lines: z.array(z.object({
    id: z.uuid(), location_id: z.uuid(), line_number: z.number().int(), label: z.string(), active: z.boolean(), caller_id_device_id: z.uuid().nullable(),
  })),
  payment_terminals: z.array(z.object({ id: z.uuid(), label: z.string(), type: z.string(), status: z.string(), hardware_device_id: z.uuid().nullable() })),
  registers: count,
});
export type PlatformHardware = z.infer<typeof platformHardwareSchema>;

export const workspaceDevicesSchema = z.array(hardwareDeviceSchema);

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optionalText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());

export const saveHardwareInputSchema = z.object({
  workspace: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500),
  payload: z.object({
    id: z.preprocess(blank, z.uuid().optional()),
    device_type: z.preprocess(blank, z.enum(deviceTypes).optional()),
    name: optionalText(120),
    vendor: optionalText(120),
    model: optionalText(160),
    serial_number: optionalText(120),
    asset_tag: optionalText(60),
    status: z.preprocess(blank, z.enum(deviceStatuses).optional()),
    ownership_type: z.preprocess(blank, z.enum(ownershipTypes).optional()),
    connection_type: z.preprocess(blank, z.enum(connectionTypes).optional()),
    ip_address: z.preprocess(blank, z.union([z.ipv4(), z.ipv6()], { error: "Enter a valid IP address." }).optional()),
    mac_address: z.preprocess(blank, z.string().regex(/^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$/, "Enter a valid MAC address.").optional()),
    protocol: z.preprocess(blank, z.string().regex(/^[a-z0-9_-]{1,40}$/i, "Protocol is a short word like escpos or udp.").optional()),
    port: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).optional()),
    assigned_service: z.preprocess(blank, z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional()),
    monitoring: z.preprocess(blank, z.enum(["telemetry", "not_monitored"]).optional()),
    location_id: z.preprocess(blank, z.uuid().optional()),
    notes: optionalText(1000),
    caller_lines: z.array(z.coerce.number().int().min(1).max(8)).max(8).optional(),
    payment_terminal_id: z.preprocess((value) => (value === "none" ? "" : value), z.union([z.uuid(), z.literal("")]).optional()),
  }).refine((value) => value.id || value.device_type, { message: "Pick a device type." }),
});
export type SaveHardwareInput = z.infer<typeof saveHardwareInputSchema>;
