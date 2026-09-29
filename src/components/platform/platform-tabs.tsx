"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Tab strip for Platform Admin; the current tab is marked for screen readers too. */
export function PlatformTabs({ label, tabs, exact = [] }: { label: string; tabs: Array<[string, string]>; exact?: string[] }) {
  const pathname = usePathname();
  const isCurrent = (href: string) => pathname === href || (!exact.includes(href) && pathname.startsWith(`${href}/`));
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1">
      {tabs.map(([href, text]) => (
        <Link
          aria-current={isCurrent(href) ? "page" : undefined}
          className={`rounded-lg px-3 py-1.5 text-sm font-bold whitespace-nowrap transition ${
            isCurrent(href) ? "bg-wayne-ink text-white" : "text-wayne-ink hover:bg-wayne-cream-deep"
          }`}
          href={href}
          key={href}
        >
          {text}
        </Link>
      ))}
    </nav>
  );
}
