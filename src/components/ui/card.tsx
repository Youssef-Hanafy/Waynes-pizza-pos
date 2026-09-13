import type { HTMLAttributes } from "react";

export function Card({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`rounded-2xl border border-wayne-border bg-wayne-surface shadow-card ${className}`} {...props} />;
}
