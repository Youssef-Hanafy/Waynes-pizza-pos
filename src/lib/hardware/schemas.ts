import { z } from "zod";

export const callerIdProviderSchema = z.enum(["simulated", "cloud", "android_native"]);
export type CallerIdProviderKind = z.infer<typeof callerIdProviderSchema>;

const printerSchema = z.object({
  name: z.string().max(80).optional().default(""),
  model: z.string().max(120).optional().default(""),
  ip: z.string().max(64).optional().default(""),
  port: z.number().int().min(1).max(65535).nullable().optional().default(null),
  protocol: z.string().max(40).optional().default(""),
  enabled: z.boolean().optional().default(false),
  routing_categories: z.array(z.string().max(80)).optional().default([]),
  paper_width_mm: z.number().int().optional(),
});

/** How a printer is spoken to. Nothing is assumed until the owner picks one for a confirmed model (§2.7). */
export const printerProtocolSchema = z.enum(["", "browser", "escpos"]);

/** The store's hardware configuration (build sheet §28, §50, §64). */
export const hardwareSettingsSchema = z.object({
  caller_id_provider: callerIdProviderSchema,
  caller_device_model: z.string(),
  caller_line_count: z.number().int().min(1).max(8),
  caller_udp_port: z.number().int().min(1).max(65535),
  caller_bind_address: z.string(),
  caller_device_ip: z.string(),
  call_expire_minutes: z.number().int().min(1).max(240),
  simulator_enabled: z.boolean(),
  receipt_printer: printerSchema.partial().passthrough(),
  kitchen_printers: z.array(printerSchema.partial().passthrough()),
  cash_drawer: z.record(z.string(), z.unknown()),
  payment_terminal_mode: z.enum(["manual_external", "integrated"]),
  updated_at: z.string(),
});
export type HardwareSettings = z.infer<typeof hardwareSettingsSchema>;

/** Safe defaults when the settings row cannot be read: simulator, two lines. */
export const defaultHardwareSettings: HardwareSettings = {
  caller_id_provider: "simulated",
  caller_device_model: "CallerID.com Whozz Calling? Basic POS 2 Ethernet",
  caller_line_count: 2,
  caller_udp_port: 3520,
  caller_bind_address: "0.0.0.0",
  caller_device_ip: "",
  call_expire_minutes: 10,
  simulator_enabled: true,
  receipt_printer: {},
  kitchen_printers: [],
  cash_drawer: {},
  payment_terminal_mode: "manual_external",
  updated_at: new Date(0).toISOString(),
};

const ipLike = /^$|^(\d{1,3}\.){3}\d{1,3}$/;

/** What the owner can change on Admin → Hardware. Validated before the database sees it. */
export const hardwareSettingsFormSchema = z.object({
  caller_id_provider: callerIdProviderSchema,
  caller_line_count: z.coerce.number().int().min(1, "At least one line.").max(8, "The box supports up to 8 lines here."),
  caller_udp_port: z.coerce.number().int().min(1).max(65535, "Ports run 1–65535."),
  caller_bind_address: z.string().trim().max(64).regex(/^(\d{1,3}\.){3}\d{1,3}$/, "Enter an IPv4 address such as 0.0.0.0."),
  caller_device_ip: z.string().trim().max(64).regex(ipLike, "Leave blank or enter an IPv4 address."),
  caller_device_model: z.string().trim().min(1).max(120),
  call_expire_minutes: z.coerce.number().int().min(1, "At least one minute.").max(240, "At most four hours."),
  simulator_enabled: z.boolean(),
  receipt_printer: z.object({
    name: z.string().trim().max(80), model: z.string().trim().max(120),
    ip: z.string().trim().max(64).regex(ipLike, "Leave blank or enter an IPv4 address."),
    port: z.number().int().min(1).max(65535).nullable(), protocol: printerProtocolSchema, enabled: z.boolean(),
    paper_width_mm: z.union([z.literal(58), z.literal(80)]),
  }).refine((printer) => printer.protocol !== "escpos" || (printer.model && printer.ip && printer.port), { message: "ESC/POS needs the confirmed printer model, its IP address and port (usually 9100)." }),
  kitchen_printer: z.object({
    name: z.string().trim().max(80), model: z.string().trim().max(120),
    ip: z.string().trim().max(64).regex(ipLike, "Leave blank or enter an IPv4 address."),
    port: z.number().int().min(1).max(65535).nullable(), protocol: printerProtocolSchema, enabled: z.boolean(),
    paper_width_mm: z.union([z.literal(58), z.literal(80)]),
    routing_categories: z.array(z.string().trim().max(80)).max(40),
  }).refine((printer) => printer.protocol !== "escpos" || (printer.model && printer.ip && printer.port), { message: "ESC/POS needs the confirmed printer model, its IP address and port (usually 9100)." }),
  cash_drawer: z.object({ connection: z.enum(["none", "receipt_printer"]), model: z.string().trim().max(120) }),
});
export type HardwareSettingsForm = z.infer<typeof hardwareSettingsFormSchema>;
