"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Group = { name: string; links: [string, string][] };

/**
 * Every section, visible at once.
 *
 * This used to be one horizontal strip that scrolled sideways, which meant
 * everything past Customers — the whole Setup group, Menu included — was off the
 * edge of the screen until you found the scrollbar. In the middle of a dinner
 * rush that is a section you cannot reach.
 *
 * So it wraps instead of scrolling. The groups stay visually separate, each with
 * its own heading, and on a narrow screen they stack rather than disappear.
 * Knowing where you are matters more here than anywhere else in the app: every
 * screen is a table of numbers and they look alike at a glance.
 */
export function AdminNav({ groups }: { groups: Group[] }) {
  const pathname = usePathname();
  const isCurrent = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav aria-label="Admin navigation" className="mx-auto max-w-7xl px-5 pb-3">
      <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
        {groups.map((group) => (
          <div className="flex min-w-0 flex-col gap-1" key={group.name}>
            <span className="px-1 text-[10px] font-black uppercase tracking-[0.18em] text-wayne-muted">
              {group.name}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {group.links.map(([href, label]) => (
                <Link
                  aria-current={isCurrent(href) ? "page" : undefined}
                  className={`rounded-lg px-2.5 py-1.5 text-sm font-bold whitespace-nowrap transition ${
                    isCurrent(href)
                      ? "bg-wayne-green text-wayne-cream"
                      : "text-wayne-ink hover:bg-wayne-cream-deep hover:text-wayne-green"
                  }`}
                  href={href}
                  key={href}
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}
