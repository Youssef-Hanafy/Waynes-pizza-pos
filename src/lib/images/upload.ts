import "server-only";

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export async function uploadOptimizedImage(file: File, folder: "categories" | "items" | "site") {
  if (file.size === 0) return null;
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be 5 MB or smaller.");
  if (!allowedTypes.has(file.type)) throw new Error("Use a JPEG, PNG, WebP, or AVIF image.");

  const output = await sharp(Buffer.from(await file.arrayBuffer()))
    .rotate()
    .resize({ width: 1600, height: 1200, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const path = `${folder}/${randomUUID()}.webp`;
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.storage.from("wayne-menu").upload(path, output, {
    cacheControl: "31536000",
    contentType: "image/webp",
    upsert: false
  });
  if (error) throw new Error(`Image upload failed: ${error.message}`);
  return path;
}
