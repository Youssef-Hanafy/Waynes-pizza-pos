import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/access";
import { getPublicAssetUrl } from "@/lib/images/public-url";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { setMenuPhotoAction } from "../actions";

export const metadata: Metadata = { title: "Menu photos" };
export const dynamic = "force-dynamic";

type Category = {
  id: string;
  name: string;
  image_path: string | null;
  image_alt: string;
  sort_order: number;
};
type Item = {
  id: string;
  category_id: string;
  name: string;
  image_path: string | null;
  image_alt: string;
};

export default async function MenuPhotosPage({
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
        .select("id,name,image_path,image_alt,sort_order")
        .is("archived_at", null)
        .order("sort_order")
        .order("name"),
      supabase
        .from("menu_items")
        .select("id,category_id,name,image_path,image_alt")
        .is("archived_at", null)
        .order("sort_order")
        .order("name"),
      searchParams,
    ]);

  const categories = (categoryData ?? []) as Category[];
  const items = (itemData ?? []) as Item[];
  const total = categories.length + items.length;
  const done =
    categories.filter((row) => row.image_path).length +
    items.filter((row) => row.image_path).length;

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">
            Menu
          </p>
          <h1 className="mt-3 text-4xl font-black">Menu photos</h1>
          <p className="mt-3 max-w-2xl text-wayne-muted">
            Every picture on the website comes from here. Upload one and it
            appears on the storefront right away — no code change, no deploy.
            Category photos drive the big tiles on the home and menu pages;
            item photos show on the item cards.
          </p>
        </div>
        <Link className="font-bold underline" href="/admin/menu">
          Back to menu admin
        </Link>
      </div>

      <div className="mt-6 rounded-xl border border-wayne-border bg-wayne-surface p-4">
        <div className="flex items-center justify-between text-sm font-bold">
          <span>
            {done} of {total} photos added
          </span>
          <span className="text-wayne-muted">
            JPEG, PNG, WebP or AVIF · up to 5 MB · landscape works best
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-wayne-cream-deep">
          <div
            className="h-full rounded-full bg-wayne-red"
            style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}
          />
        </div>
      </div>

      {params.error ? (
        <p className="mt-5 rounded-xl border border-wayne-alert/40 bg-wayne-alert-soft p-4 font-semibold">
          {params.error}
        </p>
      ) : null}
      {params.saved ? (
        <p className="mt-5 rounded-xl border border-wayne-ok/40 bg-wayne-ok-soft p-4 font-semibold">
          Photo saved.
        </p>
      ) : null}

      <h2 className="mt-10 text-2xl font-black">Category photos</h2>
      <p className="mt-1 text-sm text-wayne-muted">
        These are the tiles customers tap first, so pick the most appetising
        shot you have of each section.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => (
          <PhotoTile
            alt={category.image_alt}
            id={category.id}
            key={category.id}
            kind="category"
            name={category.name}
            path={category.image_path}
          />
        ))}
      </div>

      {categories.map((category) => {
        const categoryItems = items.filter(
          (item) => item.category_id === category.id,
        );
        if (!categoryItems.length) return null;
        return (
          <section key={category.id}>
            <h2 className="mt-10 text-2xl font-black">{category.name}</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {categoryItems.map((item) => (
                <PhotoTile
                  alt={item.image_alt}
                  id={item.id}
                  key={item.id}
                  kind="item"
                  name={item.name}
                  path={item.image_path}
                />
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}

function PhotoTile({
  alt,
  id,
  kind,
  name,
  path,
}: {
  alt: string;
  id: string;
  kind: "category" | "item";
  name: string;
  path: string | null;
}) {
  const url = getPublicAssetUrl(path);
  const save = setMenuPhotoAction.bind(null, kind, id);
  return (
    <div className="overflow-hidden rounded-xl border border-wayne-border bg-wayne-surface">
      <div className="relative aspect-[3/2] bg-wayne-cream-deep">
        {url ? (
          <Image
            alt={alt || name}
            className="object-cover"
            fill
            sizes="(max-width: 640px) 90vw, 320px"
            src={url}
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-sm font-bold text-wayne-muted">
            No photo yet
          </span>
        )}
      </div>
      <form action={save} className="grid gap-3 p-4">
        <strong className="text-base">{name}</strong>
        <input
          accept="image/jpeg,image/png,image/webp,image/avif"
          aria-label={`Photo for ${name}`}
          className="text-sm"
          name="image"
          required
          type="file"
        />
        <input
          aria-label={`Photo description for ${name}`}
          className="w-full rounded-lg border border-wayne-border px-3 py-2 text-sm"
          defaultValue={alt}
          maxLength={300}
          name="image_alt"
          placeholder="Describe the photo (for screen readers)"
        />
        <button
          className="rounded-lg bg-wayne-red px-4 py-2 font-bold text-white"
          type="submit"
        >
          {url ? "Replace photo" : "Upload photo"}
        </button>
      </form>
      {url ? (
        <form action={save} className="border-t border-wayne-border px-4 py-3">
          <input name="remove" type="hidden" value="1" />
          <button className="text-sm font-bold underline" type="submit">
            Remove photo
          </button>
        </form>
      ) : null}
    </div>
  );
}
