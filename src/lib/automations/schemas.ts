import { z } from "zod";

/** Automation builder (Phase 8, §17.2): Trigger → Conditions → Timing → Actions. */

export const triggerEvents = [
  { code: "customer.created", label: "New customer created" },
  { code: "customer.segment.entered", label: "Customer enters a segment" },
  { code: "customer.segment.exited", label: "Customer leaves a segment" },
  { code: "customer.reward.issued", label: "Rewards member gets a welcome code" },
  { code: "customer.offer.winback", label: "Win-back code issued" },
  { code: "customer.offers.published", label: "New member offers published" },
  { code: "customer.consent.changed", label: "Customer's text/email consent changed" },
  { code: "order.created", label: "Order placed" },
  { code: "order.completed", label: "Order completed" },
  { code: "order.cancelled", label: "Order cancelled" },
  { code: "delivery.completed", label: "Delivery completed" },
  { code: "promo.redeemed", label: "Promo code redeemed" },
] as const;

export const triggerLabel = (code: string) => triggerEvents.find((event) => event.code === code)?.label ?? code;

export const conditionFields = [
  { code: "sms_marketing_opt_in", label: "Subscribed to texts", kind: "boolean" },
  { code: "order_count", label: "Number of orders", kind: "number" },
  { code: "lifetime_spend_cents", label: "Lifetime spend (cents)", kind: "number" },
  { code: "days_since_last_order", label: "Days since last order", kind: "number" },
  { code: "has_tag", label: "Has tag", kind: "tag" },
  { code: "in_segment", label: "Is in segment (segment id)", kind: "segment" },
] as const;
export type ConditionField = (typeof conditionFields)[number]["code"];

export const conditionSchema = z.object({
  field: z.enum(["sms_marketing_opt_in", "order_count", "lifetime_spend_cents", "days_since_last_order", "has_tag", "in_segment"]),
  operator: z.enum(["=", "!=", ">=", "<=", ">", "<"]),
  value: z.string().trim().min(1).max(80),
});

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send_sms"), body: z.string().trim().min(1, "Write the text message.").max(1600), message_type: z.enum(["marketing", "transactional"]).default("marketing") }),
  z.object({ type: z.literal("add_tag"), tag: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Tags are lowercase letters, numbers, - or _.") }),
  z.object({ type: z.literal("remove_tag"), tag: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Tags are lowercase letters, numbers, - or _.") }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

export const automationDefinitionSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Name the automation.").max(120),
  description: z.string().max(500).default(""),
  trigger_event_type: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/, "Pick what starts the automation."),
  trigger_filters: z.record(z.string(), z.string()).default({}),
  conditions: z.array(conditionSchema).max(10).default([]),
  delay_minutes: z.coerce.number().int().min(0).max(43_200).default(0),
  actions: z.array(actionSchema).min(1, "Add at least one action.").max(5),
  cooldown_hours: z.coerce.number().int().min(0).max(8_760).default(0),
  once_per_customer: z.boolean().default(false),
});
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

const timestamp = z.string();

export const automationSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["draft", "active", "paused", "archived"]),
  executor: z.enum(["platform", "legacy_crm"]),
  updated_at: timestamp,
  version: z.number().int().nullable(),
  trigger_event_type: z.string().nullable(),
  trigger_filters: z.record(z.string(), z.string()).nullable(),
  conditions: z.array(conditionSchema).nullable(),
  delay_minutes: z.number().int().nullable(),
  actions: z.array(actionSchema).nullable(),
  cooldown_hours: z.number().int().nullable(),
  once_per_customer: z.boolean().nullable(),
  runs_30d: z.record(z.string(), z.number()).nullable(),
});
export type AutomationSummary = z.infer<typeof automationSummarySchema>;

export const automationsOverviewSchema = z.object({
  can_manage: z.boolean(),
  dispatch_mode: z.enum(["platform", "legacy_crm_bridge"]).nullable(),
  automations: z.array(automationSummarySchema),
  event_types: z.array(z.string()),
  segments: z.array(z.object({ id: z.uuid(), name: z.string() })),
  recent_events: z.array(z.object({ event_id: z.uuid(), event_type: z.string(), occurred_at: timestamp, automation_status: z.string(), has_customer: z.boolean() })),
});
export type AutomationsOverview = z.infer<typeof automationsOverviewSchema>;

export const automationDetailSchema = z.object({
  versions: z.array(z.object({
    id: z.uuid(), version: z.number().int(), trigger_event_type: z.string(), trigger_filters: z.record(z.string(), z.string()),
    conditions: z.array(conditionSchema), delay_minutes: z.number().int(), actions: z.array(actionSchema),
    cooldown_hours: z.number().int(), once_per_customer: z.boolean(), created_at: timestamp,
  })).nullable(),
  runs: z.array(z.object({
    id: z.uuid(), status: z.string(), event_id: z.uuid(), event_type: z.string().nullable(), customer_name: z.string().nullable(),
    version: z.number().int().nullable(), due_at: timestamp, finished_at: timestamp.nullable(), outcome: z.string().nullable(),
    created_at: timestamp, replayed: z.boolean(),
    steps: z.array(z.object({ step: z.number().int(), action: z.string(), status: z.string(), detail: z.string().nullable() })),
  })),
  log: z.array(z.object({ at: timestamp, level: z.enum(["info", "skip", "error"]), code: z.string(), message: z.string() })),
});
export type AutomationDetail = z.infer<typeof automationDetailSchema>;

/** Reads the builder form (flat fields) into a definition. */
export function definitionFromForm(form: FormData): ReturnType<typeof automationDefinitionSchema.safeParse> {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : "";
  };
  const conditions = [0, 1, 2]
    .map((index) => ({ field: text(`condition_${index}_field`), operator: text(`condition_${index}_operator`), value: text(`condition_${index}_value`) }))
    .filter((condition) => condition.field && condition.value.trim());
  const actions: unknown[] = [];
  if (text("sms_body").trim()) actions.push({ type: "send_sms", body: text("sms_body"), message_type: text("sms_message_type") || "marketing" });
  if (text("tag_action") && text("tag").trim()) actions.push({ type: text("tag_action"), tag: text("tag").trim().toLowerCase() });
  const segment = text("segment_filter");
  return automationDefinitionSchema.safeParse({
    id: text("id") || undefined,
    name: text("name"),
    description: text("description"),
    trigger_event_type: text("trigger_event_type"),
    trigger_filters: segment ? { segment_id: segment } : {},
    conditions,
    delay_minutes: text("delay_minutes") || 0,
    actions,
    cooldown_hours: text("cooldown_hours") || 0,
    once_per_customer: text("once_per_customer") === "yes",
  });
}

export function automationErrorMessage(message: string) {
  if (message.includes("LEGACY_CRM_SENDS")) return "This business's texts still go out from the Hanafy CRM, so a texting automation can't be switched on here yet.";
  if (message.includes("runs in the Hanafy CRM")) return "This automation still runs in the Hanafy CRM. Change it there until Hanafy moves it to the platform.";
  if (message.includes("permission")) return "You do not have permission to do that.";
  return message.length < 200 ? message : "That did not work. Try again.";
}
