import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { conditionFields, triggerEvents, type AutomationSummary } from "@/lib/automations/schemas";
import { campaignPlaceholders } from "@/lib/messaging/schemas";
import { saveAutomation } from "./actions";

const select = "min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal";

/** Trigger → Conditions → Timing → Actions (§17.2).  Saving stores a new version. */
export function AutomationForm({ automation, segments, eventTypes }: { automation?: AutomationSummary; segments: Array<{ id: string; name: string }>; eventTypes: string[] }) {
  const known = new Set<string>(triggerEvents.map((event) => event.code));
  const extra = eventTypes.filter((code) => !known.has(code));
  const sms = automation?.actions?.find((action) => action.type === "send_sms");
  const tag = automation?.actions?.find((action) => action.type === "add_tag" || action.type === "remove_tag");
  const conditions = automation?.conditions ?? [];

  return (
    <form action={saveAutomation} className="grid gap-5">
      {automation ? <input name="id" type="hidden" value={automation.id} /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Input defaultValue={automation?.name ?? ""} label="Name" maxLength={120} name="name" placeholder="30-day win-back" required />
        <Input defaultValue={automation?.description ?? ""} label="Note (optional)" maxLength={500} name="description" />
      </div>

      <fieldset className="grid gap-4 rounded-xl border border-wayne-border p-4 md:grid-cols-2">
        <legend className="px-1 text-sm font-black">1. Trigger</legend>
        <label className="grid gap-1.5 text-sm font-bold">When this happens
          <select className={select} defaultValue={automation?.trigger_event_type ?? "customer.segment.entered"} name="trigger_event_type" required>
            {triggerEvents.map((event) => <option key={event.code} value={event.code}>{event.label}</option>)}
            {extra.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-bold">Only for this segment (segment events)
          <select className={select} defaultValue={automation?.trigger_filters?.segment_id ?? ""} name="segment_filter">
            <option value="">Any segment</option>
            {segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
          </select>
        </label>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-wayne-border p-4">
        <legend className="px-1 text-sm font-black">2. Conditions (all must be true)</legend>
        {[0, 1, 2].map((index) => (
          <div className="grid gap-3 md:grid-cols-[1fr_8rem_1fr]" key={index}>
            <select aria-label={`Condition ${index + 1} field`} className={select} defaultValue={conditions[index]?.field ?? (index === 0 && !automation ? "sms_marketing_opt_in" : "")} name={`condition_${index}_field`}>
              <option value="">—</option>
              {conditionFields.map((field) => <option key={field.code} value={field.code}>{field.label}</option>)}
            </select>
            <select aria-label={`Condition ${index + 1} comparison`} className={select} defaultValue={conditions[index]?.operator ?? "="} name={`condition_${index}_operator`}>
              {["=", "!=", ">=", "<=", ">", "<"].map((operator) => <option key={operator} value={operator}>{operator}</option>)}
            </select>
            <input aria-label={`Condition ${index + 1} value`} className={select} defaultValue={conditions[index]?.value ?? (index === 0 && !automation ? "true" : "")} name={`condition_${index}_value`} placeholder="true, 3, vip…" />
          </div>
        ))}
      </fieldset>

      <fieldset className="grid gap-4 rounded-xl border border-wayne-border p-4 md:grid-cols-3">
        <legend className="px-1 text-sm font-black">3. Timing and frequency</legend>
        <Input defaultValue={String(automation?.delay_minutes ?? 0)} hint="0 = right away" label="Wait (minutes)" max={43200} min={0} name="delay_minutes" type="number" />
        <Input defaultValue={String(automation?.cooldown_hours ?? 0)} hint="Don't repeat for the same customer within this time" label="Cooldown (hours)" max={8760} min={0} name="cooldown_hours" type="number" />
        <label className="flex items-center gap-2 pt-7 text-sm font-bold"><input defaultChecked={automation?.once_per_customer ?? false} name="once_per_customer" type="checkbox" value="yes" /> Once per customer, ever</label>
      </fieldset>

      <fieldset className="grid gap-4 rounded-xl border border-wayne-border p-4">
        <legend className="px-1 text-sm font-black">4. Actions</legend>
        <label className="grid gap-1.5 text-sm font-bold">Send this text
          <textarea className="min-h-24 rounded-xl border border-wayne-border bg-white p-3 font-normal" defaultValue={sms?.type === "send_sms" ? sms.body : ""} maxLength={1600} name="sms_body" placeholder="{{business_name}}: We miss you, {{first_name}}! Reply STOP to opt out" />
          <span className="text-xs font-normal text-wayne-muted">Fills in {campaignPlaceholders.join(", ")} and event details such as {"{{reward_code}}"}. Only sent to customers who agreed to texts and have not replied STOP.</span>
        </label>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="grid gap-1.5 text-sm font-bold">Text type
            <select className={select} defaultValue={sms?.type === "send_sms" ? sms.message_type : "marketing"} name="sms_message_type"><option value="marketing">Marketing</option><option value="transactional">Transactional (order updates)</option></select>
          </label>
          <label className="grid gap-1.5 text-sm font-bold">Tag
            <select className={select} defaultValue={tag?.type ?? ""} name="tag_action"><option value="">No tag change</option><option value="add_tag">Add tag</option><option value="remove_tag">Remove tag</option></select>
          </label>
          <Input defaultValue={tag?.tag ?? ""} label="Tag name" name="tag" placeholder="winback" />
        </div>
      </fieldset>
      <div><Button type="submit">{automation ? "Save as new version" : "Create automation"}</Button></div>
    </form>
  );
}
