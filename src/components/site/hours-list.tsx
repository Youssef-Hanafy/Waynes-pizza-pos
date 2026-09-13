import { dayKeys, formatTime, type StoreSettings } from "@/lib/content/schemas";

export function HoursList({ settings }: { settings: StoreSettings }) {
  return <div className="grid gap-2">{dayKeys.map((day) => { const hours = settings.business_hours[day]; return <div className="grid grid-cols-[7rem_1fr] gap-4 text-sm" key={day}><span className="font-bold capitalize">{day}</span><span>{hours.closed ? "Closed" : `${formatTime(hours.open)} – ${formatTime(hours.close)}`}</span></div>; })}{settings.special_hours.map((special) => <div className="mt-2 rounded-xl bg-wayne-warn-soft p-3 text-sm" key={special.id}><strong>{special.label || special.service_date}:</strong>{" "}{special.closed ? "Closed" : `${formatTime(special.opens_at ?? "00:00")} – ${formatTime(special.closes_at ?? "00:00")}`}{special.public_note ? ` — ${special.public_note}` : ""}</div>)}</div>;
}
