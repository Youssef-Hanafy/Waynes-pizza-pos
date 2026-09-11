import { addDays } from "@/lib/time/zoned";

export const dashboardPresets = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["this_week", "This week"], ["last_week", "Last week"], ["month", "Month to date"], ["custom", "Custom"],
] as const;
export type DashboardPreset = (typeof dashboardPresets)[number][0];

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** Resolves a §14 time filter to inclusive business dates. Weeks start on Monday. */
export function resolveDashboardRange(preset: string | undefined, today: string, from?: string, to?: string) {
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const monday = addDays(today, -weekday);
  switch (preset) {
    case "yesterday": { const day = addDays(today, -1); return { preset: "yesterday" as const, from: day, to: day }; }
    case "this_week": return { preset: "this_week" as const, from: monday, to: today };
    case "last_week": return { preset: "last_week" as const, from: addDays(monday, -7), to: addDays(monday, -1) };
    case "month": return { preset: "month" as const, from: `${today.slice(0, 8)}01`, to: today };
    case "custom":
      if (from && to && isoDate.test(from) && isoDate.test(to) && from <= to && Date.parse(to) - Date.parse(from) <= 400 * 86_400_000)
        return { preset: "custom" as const, from, to };
      return { preset: "today" as const, from: today, to: today };
    default: return { preset: "today" as const, from: today, to: today };
  }
}
