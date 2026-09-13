import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createMenuItemAction } from "../actions";
import { MenuItemForm } from "../menu-item-form";

export const metadata: Metadata = { title: "New menu item" };
export default async function NewMenuItemPage() { await requirePermission("menu.manage", "/admin/menu/new"); const supabase = await createServerSupabaseClient(); const { data } = await supabase.from("menu_categories").select("id,name").is("archived_at", null).order("sort_order"); const categories = (data ?? []) as { id: string; name: string }[]; return <main className="mx-auto max-w-5xl px-5 py-10"><Link className="font-bold text-wayne-red" href="/admin/menu">← Menu</Link><h1 className="mt-4 text-4xl font-black">Create menu item</h1>{categories.length ? <div className="mt-8"><MenuItemForm action={createMenuItemAction} categories={categories} submitLabel="Create menu item" /></div> : <p className="mt-6 rounded-xl bg-wayne-warn-soft p-4">Create a category before adding an item.</p>}</main>; }
