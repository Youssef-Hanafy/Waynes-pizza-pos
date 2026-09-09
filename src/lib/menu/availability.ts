import type { PublicMenu } from "./schemas";

type PublicMenuItem = PublicMenu[number]["items"][number];

const dayIndex: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function zonedParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: dayIndex[value("weekday")] ?? 0,
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function isMenuItemAvailableNow(
  item: Pick<
    PublicMenuItem,
    "available_days" | "available_start" | "available_end"
  >,
  timezone: string,
  now = new Date(),
) {
  const { day, minutes } = zonedParts(now, timezone);
  if (!item.available_start || !item.available_end)
    return item.available_days.includes(day);
  const start = timeToMinutes(item.available_start);
  const end = timeToMinutes(item.available_end);
  if (start <= end)
    return (
      item.available_days.includes(day) && minutes >= start && minutes < end
    );
  if (minutes >= start) return item.available_days.includes(day);
  return minutes < end && item.available_days.includes((day + 6) % 7);
}
