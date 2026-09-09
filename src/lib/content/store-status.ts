import { dayKeys, type StoreSettings } from "./schemas";

type StatusSettings = Pick<
  StoreSettings,
  "business_hours" | "ordering_open" | "special_hours" | "timezone"
>;

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function isStoreOpenNow(settings: StatusSettings, now = new Date()) {
  if (!settings.ordering_open) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    part("weekday"),
  );
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const currentMinutes = Number(part("hour")) * 60 + Number(part("minute"));
  const special = settings.special_hours.find(
    (entry) => entry.service_date === date,
  );
  if (special)
    return (
      !special.closed &&
      special.opens_at !== null &&
      special.closes_at !== null &&
      inCurrentWindow(special.opens_at, special.closes_at, currentMinutes)
    );
  const today = settings.business_hours[dayKeys[dayIndex]];
  if (
    !today.closed &&
    today.open &&
    today.close &&
    inCurrentWindow(today.open, today.close, currentMinutes)
  )
    return true;
  const yesterday = settings.business_hours[dayKeys[(dayIndex + 6) % 7]];
  return (
    !yesterday.closed &&
    yesterday.open !== "" &&
    yesterday.close !== "" &&
    minutes(yesterday.open) > minutes(yesterday.close) &&
    currentMinutes < minutes(yesterday.close)
  );
}

function inCurrentWindow(open: string, close: string, current: number) {
  const start = minutes(open);
  const end = minutes(close);
  return start <= end ? current >= start && current < end : current >= start;
}
