import type { HTMLAttributes } from "react";

export function Badge({ className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`inline-flex rounded-full bg-wayne-red/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-wayne-red ${className}`} {...props} />;
}
