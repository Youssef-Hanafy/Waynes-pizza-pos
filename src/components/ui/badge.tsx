import type { HTMLAttributes } from "react";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  /** Leave unset for the brand badge; the rest carry a state a cook or cashier reads at a glance. */
  tone?: "brand" | "neutral" | "ok" | "warn" | "alert";
};

const tones = {
  brand: "bg-wayne-red-soft text-wayne-red",
  neutral: "bg-wayne-cream-deep text-wayne-muted",
  ok: "bg-wayne-ok-soft text-wayne-ok",
  warn: "bg-wayne-warn-soft text-wayne-warn",
  alert: "bg-wayne-alert-soft text-wayne-alert",
};

export function Badge({ className = "", tone = "brand", ...props }: BadgeProps) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${tones[tone]} ${className}`} {...props} />;
}
