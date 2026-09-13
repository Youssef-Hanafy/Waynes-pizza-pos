"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Group = { name: string; links: [string, string][] };

/**
 * One scrollable row of grouped links, with the current section marked. Knowing
 * where you are matters more in the admin than anywhere else in the app: every
 * screen here is a table of numbers and they look alike at a glance.
 */
export function AdminNav({ groups }: { groups: Group[] }) {
  const pathname = usePathname();
  const isCurrent = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav aria-label="Admin navigation" className="mx-auto max-w-7xl overflow-x-auto px-5">
      <div className="flex w-max items-center gap-2 pb-2.5 sm:gap-3">
        {groups.map((group, index) => (
          <div className="flex items-center gap-1" key={group.name}>
            {index ? <span aria-hidden className="mr-2 h-5 w-px bg-wayne-border" /> : null}
            <span className="mr-1 hidden text-[10px] font-black uppercase tracking-[0.18em] text-wayne-muted lg:inline">
              {group.name}
            </span>
            {group.links.map(([href, label]) => (
              <Link
                aria-current={isCurrent(href) ? "page" : undefined}
                className={`rounded-lg px-2.5 py-1.5 text-sm font-bold transition ${
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
        ))}
      </div>
    </nav>
  );
}
