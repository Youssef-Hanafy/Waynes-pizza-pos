import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { getPublicAssetUrl } from "@/lib/images/public-url";
import { formatCents } from "@/lib/menu/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  createCategoryAction,
  setCategoryArchivedAction,
  setItemStateAction,
  updateCategoryAction,
} from "./actions";

export const metadata: Metadata = { title: "Menu admin" };
export const dynamic = "force-dynamic";

type Category = {
  id: string;
  name: string;
  description: string;
  image_path: string | null;
  image_alt: string;
  sort_order: number;
  customer_visible: boolean;
  archived_at: string | null;
};
type Item = {
  id: string;
  category_id: string;
  name: string;
  base_price_cents: number;
  sold_out: boolean;
  customer_visible: boolean;
  archived_at: string | null;
};

export default async function MenuAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  await requirePermission("menu.manage", "/admin/menu");
  const supabase = await createServerSupabaseClient();
  const [{ data: categoryData }, { data: itemData }, params] =
    await Promise.all([
      supabase
        .from("menu_categories")
        .select(
          "id,name,description,image_path,image_alt,sort_order,customer_visible,archived_at",
        )
        .order("sort_order")
        .order("name"),
      supabase
        .from("menu_items")
        .select(
          "id,category_id,name,base_price_cents,sold_out,customer_visible,archived_at",
        )
        .order("sort_order")
        .order("name"),
      searchParams,
    ]);
  const categories = (categoryData ?? []) as Category[];
  const items = (itemData ?? []) as Item[];
  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">
            Menu
          </p>
          <h1 className="mt-3 text-4xl font-black">Categories & items</h1>
          <p className="mt-3 text-wayne-muted">
            Archive records instead of deleting them so future order history
            remains safe.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="secondary">
            <Link href="/admin/menu/photos">Menu photos</Link>
          </Button>
          {categories.some((category) => !category.archived_at) ? (
            <Button asChild>
              <Link href="/admin/menu/new">Create menu item</Link>
            </Button>
          ) : null}
        </div>
      </div>
      {params.saved ? (
        <Notice kind="success">Menu changes saved.</Notice>
      ) : null}
      {params.error ? <Notice kind="error">{params.error}</Notice> : null}
      <div className="mt-8 grid gap-8 lg:grid-cols-[22rem_1fr]">
        <aside>
          <Card className="p-5">
            <h2 className="text-2xl font-black">New category</h2>
            <CategoryForm action={createCategoryAction} />
          </Card>
        </aside>
        <div className="grid gap-6">
          {categories.length ? (
            categories.map((category) => (
              <CategoryCard
                category={category}
                items={items.filter((item) => item.category_id === category.id)}
                key={category.id}
              />
            ))
          ) : (
            <Card className="p-8 text-center">
              <h2 className="text-2xl font-black">Create the first category</h2>
              <p className="mt-2 text-wayne-muted">
                Items need a category before they can be added.
              </p>
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}

function CategoryCard({
  category,
  items,
}: {
  category: Category;
  items: Item[];
}) {
  const archive = setCategoryArchivedAction.bind(
    null,
    category.id,
    !category.archived_at,
  );
  const update = updateCategoryAction.bind(null, category.id);
  const imageUrl = getPublicAssetUrl(category.image_path);
  return (
    <Card className={category.archived_at ? "p-6 opacity-60" : "p-6"}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {imageUrl ? (
            <span className="mb-2 block text-xs font-bold text-wayne-muted">
              Image uploaded
            </span>
          ) : null}
          <h2 className="text-2xl font-black">{category.name}</h2>
          <p className="mt-1 text-wayne-muted">{category.description}</p>
          <p className="mt-2 text-xs font-bold uppercase tracking-wide text-wayne-muted">
            {category.archived_at
              ? "Archived"
              : category.customer_visible
                ? "Public"
                : "Hidden"}{" "}
            · Sort {category.sort_order}
          </p>
        </div>
        <div className="flex gap-2">
          <details>
            <summary className="cursor-pointer list-none rounded-lg border border-wayne-border bg-white px-4 py-2 text-sm font-bold">
              Edit
            </summary>
            <div className="mt-3 min-w-72 rounded-xl border border-wayne-border bg-wayne-cream p-4">
              <CategoryForm action={update} category={category} />
            </div>
          </details>
          <form action={archive}>
            <Button
              type="submit"
              variant={category.archived_at ? "secondary" : "danger"}
            >
              {category.archived_at ? "Restore" : "Archive"}
            </Button>
          </form>
        </div>
      </div>
      <div className="mt-5 divide-y divide-wayne-border border-t border-wayne-border">
        {items.length ? (
          items.map((item) => <ItemRow item={item} key={item.id} />)
        ) : (
          <p className="py-5 text-sm text-wayne-muted">
            No items in this category.
          </p>
        )}
      </div>
    </Card>
  );
}

function ItemRow({ item }: { item: Item }) {
  const soldOut = setItemStateAction.bind(
    null,
    item.id,
    "sold_out",
    !item.sold_out,
  );
  const archive = setItemStateAction.bind(
    null,
    item.id,
    "archived_at",
    !item.archived_at,
  );
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-4 py-4 ${item.archived_at ? "opacity-50" : ""}`}
    >
      <div>
        <Link
          className="font-black hover:text-wayne-red"
          href={`/admin/menu/items/${item.id}`}
        >
          {item.name}
        </Link>
        <p className="text-sm text-wayne-muted">
          {formatCents(item.base_price_cents)} ·{" "}
          {item.archived_at
            ? "Archived"
            : item.customer_visible
              ? "Public"
              : "Hidden"}
          {item.sold_out ? " · Sold out" : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <form action={soldOut}>
          <Button type="submit" variant="secondary">
            {item.sold_out ? "Mark available" : "Mark sold out"}
          </Button>
        </form>
        <Button asChild variant="secondary">
          <Link href={`/admin/menu/items/${item.id}`}>Edit</Link>
        </Button>
        <form action={archive}>
          <Button
            type="submit"
            variant={item.archived_at ? "secondary" : "danger"}
          >
            {item.archived_at ? "Restore" : "Archive"}
          </Button>
        </form>
      </div>
    </div>
  );
}
function CategoryForm({
  action,
  category,
}: {
  action: (formData: FormData) => void | Promise<void>;
  category?: Category;
}) {
  return (
    <form action={action} className="mt-4 grid gap-3">
      <Input defaultValue={category?.name} label="Name" name="name" required />
      <label className="grid gap-2 text-sm font-semibold">
        Description
        <textarea
          className="rounded-lg border border-wayne-border p-3 font-normal"
          defaultValue={category?.description}
          name="description"
          rows={3}
        />
      </label>
      <Input
        defaultValue={category?.sort_order ?? 0}
        label="Sort order"
        name="sort_order"
        type="number"
      />
      <Input
        defaultValue={category?.image_alt}
        label="Image alt text"
        name="image_alt"
      />
      <Input
        accept="image/jpeg,image/png,image/webp,image/avif"
        label={category ? "Replace image (optional)" : "Image (optional)"}
        name="image"
        type="file"
      />
      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input
          className="h-5 w-5 accent-wayne-red"
          defaultChecked={category?.customer_visible ?? true}
          name="customer_visible"
          type="checkbox"
        />
        Visible to customers
      </label>
      <Button type="submit">
        {category ? "Save category" : "Create category"}
      </Button>
    </form>
  );
}
function Notice({
  children,
  kind,
}: {
  children: React.ReactNode;
  kind: "success" | "error";
}) {
  return (
    <div
      className={`mt-5 rounded-xl border p-4 font-semibold ${kind === "success" ? "border-wayne-ok/30 bg-wayne-ok-soft text-wayne-ok" : "border-wayne-alert/30 bg-wayne-alert-soft text-wayne-alert"}`}
    >
      {children}
    </div>
  );
}
