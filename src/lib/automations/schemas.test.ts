import { describe, expect, it } from "vitest";
import { definitionFromForm } from "./schemas";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("automation builder form", () => {
  it("reads trigger, segment filter, conditions, timing and actions", () => {
    const parsed = definitionFromForm(form({
      name: "Win-back",
      trigger_event_type: "customer.segment.entered",
      segment_filter: "97800000-0000-4000-8000-0000000000d1",
      condition_0_field: "sms_marketing_opt_in", condition_0_operator: "=", condition_0_value: "true",
      condition_1_field: "order_count", condition_1_operator: ">=", condition_1_value: "",
      delay_minutes: "30",
      sms_body: "We miss you {{first_name}}",
      tag_action: "add_tag", tag: "WinBack",
      cooldown_hours: "720",
      once_per_customer: "yes",
    }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      trigger_filters: { segment_id: "97800000-0000-4000-8000-0000000000d1" },
      conditions: [{ field: "sms_marketing_opt_in", operator: "=", value: "true" }],
      delay_minutes: 30,
      actions: [{ type: "send_sms", body: "We miss you {{first_name}}", message_type: "marketing" }, { type: "add_tag", tag: "winback" }],
      cooldown_hours: 720,
      once_per_customer: true,
    });
  });

  it("needs a trigger and at least one action", () => {
    expect(definitionFromForm(form({ name: "x", trigger_event_type: "customer.created" })).success).toBe(false);
    expect(definitionFromForm(form({ name: "x", sms_body: "hi" })).success).toBe(false);
  });
});
