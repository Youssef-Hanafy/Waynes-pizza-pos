import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Admin" };

const areas = [
  { href: "/kitchen", title: "Kitchen", description: "Live tickets, preparation timers, and accept, start, and ready actions." },
  { href: "/admin/printing", title: "Print queue", description: "Review pending and failed kitchen tickets and retry after checking the printer." },
  { href: "/pos", title: "Front POS", description: "Enter fast walk-in pickup and identified phone pickup or delivery orders." },
  { href: "/admin/orders", title: "Orders", description: "Search order history and inspect customer, item, totals, and timeline snapshots." },
  { href: "/admin/calendar", title: "Order calendar", description: "Review daily order counts and active sales, then drill into any business date." },
  { href: "/admin/menu", title: "Menu", description: "Categories, items, variants, modifiers, photos, visibility, and sold-out status." },
  { href: "/admin/settings", title: "Website & business settings", description: "Hours, public details, page copy, notices, social links, SEO, and ordering configuration." },
];

export default function AdminPage() {
  return <main className="mx-auto max-w-6xl px-5 py-10"><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Administration</p><h1 className="mt-3 text-4xl font-black tracking-tight">Manage Wayne&apos;s Pizza</h1><p className="mt-3 max-w-2xl text-wayne-muted">Manage your menu, website, orders, and kitchen operations. Payments remain in the configured test or manual mode.</p><div className="mt-8 grid gap-5 md:grid-cols-2">{areas.map((area) => <Link href={area.href} key={area.href}><Card className="h-full p-6 transition hover:-translate-y-0.5 hover:shadow-md"><h2 className="text-2xl font-black">{area.title}</h2><p className="mt-2 text-wayne-muted">{area.description}</p><span className="mt-5 inline-block font-bold text-wayne-red">Open →</span></Card></Link>)}</div></main>;
}
