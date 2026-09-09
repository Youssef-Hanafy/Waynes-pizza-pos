"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { uploadOptimizedImage } from "@/lib/images/upload";
import {
  menuItemPayloadSchema,
  parseMoneyToCents,
  parseSignedMoneyToCents,
} from "@/lib/menu/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const categorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000),
  image_alt: z.string().trim().max(300),
  sort_order: z.coerce.number().int().min(-100_000).max(100_000),
  customer_visible: z.boolean(),
});
const editorConfigSchema = z.object({
  variants: z
    .array(z.object({ name: z.string(), price: z.string(), sku: z.string() }))
    .max(100),
  modifier_groups: z
    .array(
      z.object({
        name: z.string(),
        customer_label: z.string(),
        min_select: z.number().int(),
        max_select: z.number().int(),
        required: z.boolean(),
        allow_quantities: z.boolean(),
        choices: z
          .array(
            z.object({
              name: z.string(),
              price: z.string(),
              default_selected: z.boolean(),
            }),
          )
          .max(100),
      }),
    )
    .max(50),
});

function text(formData: FormData, name: string) {
  return String(formData.get(name) ?? "");
}
function checkbox(formData: FormData, name: string) {
  return formData.get(name) === "on";
}
function cents(value: string) {
  return parseMoneyToCents(value) ?? Number.NaN;
}
function signedCents(value: string) {
  return parseSignedMoneyToCents(value) ?? Number.NaN;
}
function menuRedirect(error?: string): never {
  redirect(
    error
      ? `/admin/menu?error=${encodeURIComponent(error)}`
      : "/admin/menu?saved=1",
  );
}

export async function createCategoryAction(formData: FormData) {
  await requirePermission("menu.manage", "/admin/menu");
  const parsed = categorySchema.safeParse({
    name: text(formData, "name"),
    description: text(formData, "description"),
    image_alt: text(formData, "image_alt"),
    sort_order: text(formData, "sort_order"),
    customer_visible: checkbox(formData, "customer_visible"),
  });
  if (!parsed.success) menuRedirect(parsed.error.issues[0]?.message);
  let imagePath: string | null = null;
  try {
    const image = formData.get("image");
    if (image instanceof File)
      imagePath = await uploadOptimizedImage(image, "categories");
  } catch (error) {
    menuRedirect(
      error instanceof Error ? error.message : "Image upload failed",
    );
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("menu_categories")
    .insert({ ...parsed.data, image_path: imagePath });
  if (error) menuRedirect(error.message);
  revalidateMenu();
  menuRedirect();
}

export async function updateCategoryAction(id: string, formData: FormData) {
  await requirePermission("menu.manage", "/admin/menu");
  const categoryId = z.uuid().safeParse(id);
  const parsed = categorySchema.safeParse({
    name: text(formData, "name"),
    description: text(formData, "description"),
    image_alt: text(formData, "image_alt"),
    sort_order: text(formData, "sort_order"),
    customer_visible: checkbox(formData, "customer_visible"),
  });
  if (!categoryId.success || !parsed.success)
    menuRedirect(
      parsed.success ? "Invalid category" : parsed.error.issues[0]?.message,
    );
  let imagePath: string | null = null;
  try {
    const image = formData.get("image");
    if (image instanceof File)
      imagePath = await uploadOptimizedImage(image, "categories");
  } catch (error) {
    menuRedirect(
      error instanceof Error ? error.message : "Image upload failed",
    );
  }
  const supabase = await createServerSupabaseClient();
  const payload = imagePath
    ? { ...parsed.data, image_path: imagePath }
    : parsed.data;
  const { error } = await supabase
    .from("menu_categories")
    .update(payload)
    .eq("id", categoryId.data);
  if (error) menuRedirect(error.message);
  revalidateMenu();
  menuRedirect();
}

export async function setCategoryArchivedAction(id: string, archived: boolean) {
  await requirePermission("menu.manage", "/admin/menu");
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) menuRedirect("Invalid category");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("menu_categories")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", parsed.data);
  if (error) menuRedirect(error.message);
  revalidateMenu();
  menuRedirect();
}

export async function setItemStateAction(
  id: string,
  field: "sold_out" | "archived_at",
  enabled: boolean,
) {
  await requirePermission("menu.manage", "/admin/menu");
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) menuRedirect("Invalid menu item");
  const value =
    field === "archived_at"
      ? enabled
        ? new Date().toISOString()
        : null
      : enabled;
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("menu_items")
    .update({ [field]: value })
    .eq("id", parsed.data);
  if (error) menuRedirect(error.message);
  revalidateMenu();
  menuRedirect();
}

export async function createMenuItemAction(formData: FormData) {
  await writeMenuItem(null, formData);
}
export async function updateMenuItemAction(id: string, formData: FormData) {
  await writeMenuItem(id, formData);
}

async function writeMenuItem(id: string | null, formData: FormData) {
  await requirePermission(
    "menu.manage",
    id ? `/admin/menu/items/${id}` : "/admin/menu/new",
  );
  let rawConfiguration: unknown;
  try {
    rawConfiguration = JSON.parse(text(formData, "configuration") || "{}");
  } catch {
    menuRedirect("Invalid variants or modifiers");
  }
  const configuration = editorConfigSchema.safeParse(rawConfiguration);
  if (!configuration.success)
    menuRedirect(
      configuration.error.issues[0]?.message ?? "Invalid variants or modifiers",
    );
  const image = formData.get("image");
  let imagePath: string | null = null;
  try {
    if (image instanceof File)
      imagePath = await uploadOptimizedImage(image, "items");
  } catch (error) {
    menuRedirect(
      error instanceof Error ? error.message : "Image upload failed",
    );
  }
  const payload = menuItemPayloadSchema.safeParse({
    category_id: text(formData, "category_id"),
    name: text(formData, "name"),
    description: text(formData, "description"),
    image_path: imagePath,
    image_alt: text(formData, "image_alt"),
    base_price_cents: cents(text(formData, "base_price")),
    tax_category: text(formData, "tax_category"),
    included_count_label: text(formData, "included_count_label"),
    sold_out: checkbox(formData, "sold_out"),
    customer_visible: checkbox(formData, "customer_visible"),
    pos_visible: checkbox(formData, "pos_visible"),
    featured: checkbox(formData, "featured"),
    kitchen_route: text(formData, "kitchen_route"),
    available_days: [0, 1, 2, 3, 4, 5, 6].filter((day) =>
      checkbox(formData, `available_day_${day}`),
    ),
    available_start: text(formData, "available_start"),
    available_end: text(formData, "available_end"),
    sort_order: Number(text(formData, "sort_order")),
    variants: configuration.data.variants
      .filter((variant) => variant.name.trim())
      .map((variant, sort_order) => ({
        name: variant.name,
        price_cents: cents(variant.price),
        sku: variant.sku,
        sort_order,
      })),
    modifier_groups: configuration.data.modifier_groups
      .filter((group) => group.name.trim())
      .map((group) => ({
        ...group,
        choices: group.choices
          .filter((choice) => choice.name.trim())
          .map((choice) => ({
            ...choice,
            price_delta_cents: signedCents(choice.price),
          })),
      })),
  });
  if (!payload.success) {
    if (imagePath) await removeUploadedImage(imagePath);
    menuRedirect(payload.error.issues[0]?.message ?? "Invalid menu item");
  }
  const supabase = await createServerSupabaseClient();
  const result = id
    ? await supabase.rpc("wayne_update_menu_item", {
        target_item_id: id,
        payload: payload.data,
      })
    : await supabase.rpc("wayne_create_menu_item", { payload: payload.data });
  if (result.error) {
    if (imagePath) await removeUploadedImage(imagePath);
    menuRedirect(result.error.message);
  }
  revalidateMenu();
  menuRedirect();
}

async function removeUploadedImage(path: string) {
  const supabase = await createServerSupabaseClient();
  await supabase.storage.from("wayne-menu").remove([path]);
}
function revalidateMenu() {
  revalidatePath("/");
  revalidatePath("/menu");
  revalidatePath("/admin/menu");
}
